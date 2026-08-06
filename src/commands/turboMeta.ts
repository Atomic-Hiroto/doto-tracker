import fs from 'fs';
import { EmbedBuilder, Message } from 'discord.js';
import { dotaDataService } from '../services/dotaDataService';
import { logger } from '../services/loggerService';
import { fetchStratzTurboMetaByPosition, fetchStratzRankedBaselineByPosition, TURBO_META_BRACKETS, TurboMetaPositionHero, TurboRankedBaseline } from '../services/stratzClient';
import { safeFields } from '../utils/embedFields';

// Pos 1..5 display labels.
const POSITION_LABELS: Record<number, string> = {
  1: '🛡️ Pos 1 — Safelane Carry',
  2: '⚔️ Pos 2 — Mid',
  3: '🪓 Pos 3 — Offlane',
  4: '🎯 Pos 4 — Soft Support',
  5: '💉 Pos 5 — Hard Support',
};

const TOP_N = 8;
/**
 * A hero in the top list that wins at least this much MORE in Turbo than in same-role Ranked is
 * flagged a "turbo specialist" — genuinely turbo-favoured, not just strong everywhere.
 *
 * This is the *practical* floor: a gap smaller than 3pp is not worth a reader's attention even
 * when it is real. It is not sufficient on its own — see `specialistThreshold`.
 */
const SPECIALIST_DELTA = 0.03;

/** z for a 95% two-sided test, used by both the specialist tag and the trend arrow. */
const Z_95 = 1.96;

/**
 * A flag has to clear *both* a practical floor and its own statistical error.
 *
 * On the default all-brackets view these gates never bind: the per-role sample gate lands around
 * 37k games, where a win rate's standard error is 0.23pp and a 3pp difference is over ten SE. They
 * exist for the filtered views. `+turbometa immortal` or `+turbometa patch divine+` shrink the pool
 * far enough that the gate falls to a couple of hundred games, where the SE is ~3.7pp — and a flat
 * 3pp threshold would be flagging a coin flip. Taking the max means narrow filters silently get
 * stricter instead of louder.
 */
function stdErr(p: number, n: number): number {
  return n > 0 ? Math.sqrt(Math.max(0, p * (1 - p)) / n) : Infinity;
}

/** Minimum turbo-vs-ranked gap worth a 🔥, given how well both sides are measured. */
function specialistThreshold(turboWR: number, turboN: number, rankedWR: number, rankedN: number): number {
  const se = Math.sqrt(stdErr(turboWR, turboN) ** 2 + stdErr(rankedWR, rankedN) ** 2);
  return Math.max(SPECIALIST_DELTA, Z_95 * se);
}
// Absolute floor so a hero with a handful of games never tops a role (full pool).
const MIN_GAMES_FLOOR = 2000;
// Lower floor when a rank/patch filter shrinks the pool, so narrow filters still return heroes.
// Wilson keeps these honest: at ~100 games it shrinks a 70% hero well below a proven 60% one.
const FILTERED_GAMES_FLOOR = 100;
// Dynamic gate: also require at least this fraction of the role's total games.
const MIN_GAMES_FRACTION = 0.0015;

interface RankedHero {
  heroId: number;
  matchCount: number;
  winRate: number;
  wilson: number;
}

/** Wilson score lower bound of the win rate at 95% confidence. */
function wilsonLowerBound(wins: number, n: number): number {
  if (n === 0) return 0;
  const z = 1.96;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return (centre - margin) / denom;
}

function rankPosition(rows: TurboMetaPositionHero[], floor: number): { ranked: RankedHero[]; gate: number; totalGames: number } {
  const totalGames = rows.reduce((sum, r) => sum + r.matchCount, 0);
  const gate = Math.max(floor, Math.round(totalGames * MIN_GAMES_FRACTION));
  const ranked = rows
    .filter((r) => r.matchCount >= gate)
    .map((r) => ({
      heroId: r.heroId,
      matchCount: r.matchCount,
      winRate: r.winCount / r.matchCount,
      wilson: wilsonLowerBound(r.winCount, r.matchCount),
    }))
    .sort((a, b) => b.wilson - a.wilson);
  return { ranked, gate, totalGames };
}

function fmtGames(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

const BRACKET_ALIASES: Record<string, string> = {
  herald: 'HERALD', guardian: 'GUARDIAN', crusader: 'CRUSADER', archon: 'ARCHON',
  legend: 'LEGEND', ancient: 'ANCIENT', divine: 'DIVINE', immortal: 'IMMORTAL',
  immo: 'IMMORTAL', leg: 'LEGEND', arc: 'ARCHON',
};
// Convenience groups.
const BRACKET_GROUPS: Record<string, string[]> = {
  low: ['HERALD', 'GUARDIAN', 'CRUSADER'],
  mid: ['ARCHON', 'LEGEND', 'ANCIENT'],
  high: ['ANCIENT', 'DIVINE', 'IMMORTAL'],
};

const ORDER = TURBO_META_BRACKETS as readonly string[];

/** Parse a single rank token into bracket enum names. Supports `divine`, `divine+`, `archon-divine`, groups. */
function parseRankToken(token: string): string[] | null {
  const t = token.toLowerCase();
  if (BRACKET_GROUPS[t]) return BRACKET_GROUPS[t];
  // range "a-b"
  if (t.includes('-')) {
    const [a, b] = t.split('-').map((s) => BRACKET_ALIASES[s.trim()]);
    if (a && b) {
      const i = ORDER.indexOf(a), j = ORDER.indexOf(b);
      if (i >= 0 && j >= 0) return ORDER.slice(Math.min(i, j), Math.max(i, j) + 1);
    }
    return null;
  }
  // "divine+" → divine and above
  if (t.endsWith('+')) {
    const base = BRACKET_ALIASES[t.slice(0, -1)];
    if (base) return ORDER.slice(ORDER.indexOf(base));
    return null;
  }
  const single = BRACKET_ALIASES[t];
  return single ? [single] : null;
}

// ── Trend tracking ───────────────────────────────────────────────────────────
// Persist the displayed top-N (heroId → win rate) per window+rank key, so each run can
// show ▲/▼ movement and 🆕 newcomers vs an earlier snapshot. The baseline only advances
// every ~12h, so deltas reflect real meta movement rather than same-day noise.
const META_HISTORY_FILE = 'turboMetaHistory.json';
const META_SNAPSHOT_REFRESH_MS = 12 * 60 * 60 * 1000;
const META_WR_DELTA_MIN = 0.01; // 1.0pp — below this a hero is "stable", no arrow.

type MetaSnapshot = { ts: number; byPosition: Record<number, Record<number, number>>; samples?: Record<number, Record<number, number>> };
type MetaHistory = Record<string, MetaSnapshot>;

function loadMetaHistory(): MetaHistory {
  try { return JSON.parse(fs.readFileSync(META_HISTORY_FILE, 'utf8')); } catch { return {}; }
}
function saveMetaHistory(hist: MetaHistory): void {
  try { fs.writeFileSync(META_HISTORY_FILE, JSON.stringify(hist, null, 2)); } catch { /* ignore */ }
}
function relativeAge(ms: number): string {
  const hours = Math.floor((Date.now() - ms) / 3_600_000);
  if (hours < 1) return 'under 1h ago';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
/**
 * Trend marker for a hero vs the previous snapshot: ` 🆕` new to board, ` ▲/▼x.x` WR move, '' stable.
 *
 * Same two-part gate as the specialist tag. The practical floor dominates on the default view — at
 * 37k+ games a 0.3pp wobble is detectable but not interesting — while the statistical floor takes
 * over on filtered views, where a 1pp move can be a fifth of a standard error.
 *
 * The two windows overlap (a 7-day window compared against one from hours or days ago), which makes
 * the true SE of the difference *smaller* than the independent-sample formula used here. Erring
 * that way costs a few missed arrows and never invents one.
 */
function trendMarker(
  prev: Record<number, number> | undefined,
  prevSamples: Record<number, number> | undefined,
  heroId: number,
  curWR: number,
  curN: number,
): string {
  if (!prev) return '';
  const prevWR = prev[heroId];
  if (prevWR == null) return ' 🆕';
  const d = curWR - prevWR;
  const prevN = prevSamples?.[heroId] ?? curN;
  const se = Math.sqrt(stdErr(curWR, curN) ** 2 + stdErr(prevWR, prevN) ** 2);
  if (Math.abs(d) < Math.max(META_WR_DELTA_MIN, Z_95 * se)) return '';
  return d > 0 ? ` ▲${(d * 100).toFixed(1)}` : ` ▼${(Math.abs(d) * 100).toFixed(1)}`;
}

interface ParsedArgs {
  patch: boolean;
  brackets: string[];
  rankLabel: string | null;
  unknown: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  let patch = false;
  let brackets: string[] = [];
  let rankLabel: string | null = null;
  const unknown: string[] = [];
  for (const raw of args) {
    const t = raw.toLowerCase();
    if (t === 'patch' || t === 'latest' || t === 'thispatch') { patch = true; continue; }
    const parsed = parseRankToken(t);
    if (parsed) { brackets = parsed; rankLabel = raw; continue; }
    unknown.push(raw);
  }
  return { patch, brackets, rankLabel, unknown };
}

export async function turboMeta(message: Message, args: string[] = []) {
  const opts = parseArgs(args);
  if (opts.unknown.length) {
    return message.reply(
      `Didn't recognise: \`${opts.unknown.join(' ')}\`. Usage: \`+turbometa [patch] [rank]\`\n` +
      'Ranks: `herald guardian crusader archon legend ancient divine immortal`, ranges like `divine+` or `archon-divine`, or groups `low`/`mid`/`high`.\n' +
      'Examples: `+turbometa immortal`, `+turbometa patch divine+`, `+turbometa patch`.',
    );
  }

  const windowHint = opts.patch ? 'last 30 days' : 'last 7 days';
  const rankHint = opts.brackets.length ? `, ${opts.rankLabel}` : '';
  const loading = await message.reply(`⏳ Pulling the live Turbo meta from STRATZ (per position, ${windowHint}${rankHint})…`);
  try {
    const [{ byPosition, windowLabel }, rankedBaseline] = await Promise.all([
      fetchStratzTurboMetaByPosition({ patch: opts.patch, brackets: opts.brackets }),
      // Additive only: if this fails, the meta still renders, just without specialist tags.
      fetchStratzRankedBaselineByPosition({ patch: opts.patch, brackets: opts.brackets })
        .catch(() => ({ byPosition: {} } as TurboRankedBaseline)),
    ]);
    const hasRankedBaseline = Object.values(rankedBaseline.byPosition ?? {}).some((o) => Object.keys(o).length > 0);
    const hasData = Object.values(byPosition).some((rows) => rows && rows.length > 0);
    if (!hasData) {
      return loading.edit('Could not fetch the Turbo meta from STRATZ right now (no data, or that filter is too narrow). Try again or widen the rank.');
    }

    // Preload hero names for every hero we might render.
    const heroIds = new Set<number>();
    for (let pos = 1; pos <= 5; pos++) {
      for (const r of (byPosition[pos] ?? [])) heroIds.add(r.heroId);
    }
    const nameMap = new Map<number, string>();
    await Promise.all([...heroIds].map(async (id) => {
      nameMap.set(id, await dotaDataService.getHeroName(id).catch(() => `Hero ${id}`));
    }));

    const rankScope = opts.brackets.length
      ? `**${opts.rankLabel}** bracket${opts.brackets.length > 1 ? 's' : ''}`
      : 'all brackets';

    // Trend baseline for this exact window+rank view.
    const histKey = `${opts.patch ? 'winMonth' : 'winWeek'}|${[...opts.brackets].sort().join(',')}`;
    const history = loadMetaHistory();
    const prev = history[histKey];
    const curSnap: MetaSnapshot = { ts: Date.now(), byPosition: {}, samples: {} };
    const trendNote = prev
      ? ` Trend vs **${relativeAge(prev.ts)}**: ▲/▼ = win-rate move (pp), 🆕 = new to the board.`
      : '';

    const title = '🟢 Turbo Meta — Best Heroes by Position';
    const description =
      `Live from **STRATZ** · **${windowLabel}** · ${rankScope}. Ordered by **⌊conf⌋** — the Wilson 95% ` +
      `lower-bound win rate — so a thin sample cannot spike the list. Each line shows that, then raw WR, ` +
      `then games.${trendNote}`;
    const embed = new EmbedBuilder()
      .setColor('#16a34a')
      .setTitle(title)
      .setDescription(description)
      .setTimestamp();

    const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
    const filtered = opts.patch || opts.brackets.length > 0;
    for (let pos = 1; pos <= 5; pos++) {
      const rows = byPosition[pos] ?? [];
      const { ranked, gate } = rankPosition(rows, filtered ? FILTERED_GAMES_FLOOR : MIN_GAMES_FLOOR);
      if (ranked.length === 0) {
        fields.push({ name: POSITION_LABELS[pos], value: '_not enough data_', inline: false });
        continue;
      }
      const topHeroes = ranked.slice(0, TOP_N);
      const prevPos = prev?.byPosition?.[pos];
      const prevSamples = prev?.samples?.[pos];
      curSnap.byPosition[pos] = {};
      curSnap.samples![pos] = {};
      for (const h of topHeroes) {
        curSnap.byPosition[pos][h.heroId] = h.winRate;
        curSnap.samples![pos][h.heroId] = h.matchCount;
      }

      const rankedPos = rankedBaseline.byPosition?.[pos];
      const lines = topHeroes.map((h, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `\`${i + 1}.\``;
        const name = nameMap.get(h.heroId) ?? `Hero ${h.heroId}`;
        const base = rankedPos?.[h.heroId];
        const dWR = base ? h.winRate - base.winRate : null;
        const spec = dWR != null && base && dWR >= specialistThreshold(h.winRate, h.matchCount, base.winRate, base.matchCount)
          ? ` 🔥+${(dWR * 100).toFixed(1)}`
          : '';
        const marker = trendMarker(prevPos, prevSamples, h.heroId, h.winRate, h.matchCount);
        // Wilson is what the list is *ordered* by, so it has to be visible. Showing raw WR alone
        // made a better-evidenced hero appear to sort below a flashier one with a thinner sample
        // (54.8% on 375k games correctly outranking 54.9% on 76k), which reads as a sorting bug.
        return `${medal} **${name}** — ${(h.wilson * 100).toFixed(1)}% ⌊conf⌋ · ${(h.winRate * 100).toFixed(1)}% raw · ${fmtGames(h.matchCount)} games${spec}${marker}`;
      });
      fields.push({
        name: `${POSITION_LABELS[pos]}  _(min ${fmtGames(gate)} games)_`,
        value: lines.join('\n'),
        inline: false,
      });
    }

    // Advance the trend baseline only every ~12h, so within-day calls compare against a
    // meaningfully older snapshot instead of the last few minutes.
    if (!prev || Date.now() - prev.ts >= META_SNAPSHOT_REFRESH_MS) {
      history[histKey] = curSnap;
      saveMetaHistory(history);
    }

    const bracketNote = opts.brackets.length
      ? `Filtered to **${opts.rankLabel}**. `
      : 'Win rate is pooled across **all** skill brackets, so this is "what wins in Turbo overall," not skill-controlled. ';
    const windowNote = opts.patch
      ? `**${windowLabel}** — a wider current-patch sample (Turbo patches run for months, so 30 days = the live patch).`
      : 'Rolling 7-day window — tracks the current patch automatically. Add `patch` for a wider 30-day sample.';
    const specialistNote = hasRankedBaseline
      ? `\n🔥+x = **turbo specialist**: wins x pp more in Turbo than in same-role Ranked (vs ranked all-pick, same window${opts.brackets.length ? '/rank' : ''}) — turbo-favoured, not just universally strong.`
      : '';
    fields.push({
      name: 'Method & caveats',
      value:
        bracketNote +
        'Ranking uses the Wilson 95% lower bound, not raw WR, with a per-role sample gate. ' +
        windowNote +
        specialistNote +
        '\nFlags: `+turbometa [patch] [rank]` — e.g. `+turbometa immortal`, `+turbometa patch divine+`.',
      inline: false,
    });

    embed.addFields(safeFields(fields, title.length + description.length));
    await loading.edit({ content: null, embeds: [embed] });
  } catch (error) {
    logger.error('Error in turbometa command:', error);
    await loading.edit('An error occurred while building the Turbo meta. Please try again later.').catch(() => {});
  }
}
