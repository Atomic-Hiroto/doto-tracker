import fs from 'fs';
import { EmbedBuilder, Message } from 'discord.js';
import { dotaDataService } from '../services/dotaDataService';
import { logger } from '../services/loggerService';
import { fetchStratzTurboMetaByPosition, fetchStratzRankedBaselineByPosition, TURBO_META_BRACKETS, TurboMetaPositionHero } from '../services/stratzClient';

// Pos 1..5 display labels.
const POSITION_LABELS: Record<number, string> = {
  1: '🛡️ Pos 1 — Safelane Carry',
  2: '⚔️ Pos 2 — Mid',
  3: '🪓 Pos 3 — Offlane',
  4: '🎯 Pos 4 — Soft Support',
  5: '💉 Pos 5 — Hard Support',
};

const TOP_N = 8;
// A hero in the top list that wins at least this much MORE in Turbo than in same-role Ranked is
// flagged a "turbo specialist" — genuinely turbo-favoured, not just strong everywhere.
const SPECIALIST_DELTA = 0.03;
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

type MetaSnapshot = { ts: number; byPosition: Record<number, Record<number, number>> };
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
/** Trend marker for a hero vs the previous snapshot: ` 🆕` new to board, ` ▲/▼x.x` WR move, '' stable. */
function trendMarker(prev: Record<number, number> | undefined, heroId: number, curWR: number): string {
  if (!prev) return '';
  const prevWR = prev[heroId];
  if (prevWR == null) return ' 🆕';
  const d = curWR - prevWR;
  if (Math.abs(d) < META_WR_DELTA_MIN) return '';
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
        .catch(() => ({ byPosition: {} as Record<number, Record<number, number>> })),
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
    const curSnap: MetaSnapshot = { ts: Date.now(), byPosition: {} };
    const trendNote = prev
      ? ` Trend vs **${relativeAge(prev.ts)}**: ▲/▼ = win-rate move (pp), 🆕 = new to the board.`
      : '';

    const embed = new EmbedBuilder()
      .setColor('#16a34a')
      .setTitle('🟢 Turbo Meta — Best Heroes by Position')
      .setDescription(
        `Live from **STRATZ** · **${windowLabel}** · ${rankScope}. Ranked by **Wilson 95% lower-bound win rate** so small samples can't spike the list. Each cell shows raw WR and game count.${trendNote}`,
      )
      .setTimestamp();

    const filtered = opts.patch || opts.brackets.length > 0;
    for (let pos = 1; pos <= 5; pos++) {
      const rows = byPosition[pos] ?? [];
      const { ranked, gate } = rankPosition(rows, filtered ? FILTERED_GAMES_FLOOR : MIN_GAMES_FLOOR);
      if (ranked.length === 0) {
        embed.addFields({ name: POSITION_LABELS[pos], value: '_not enough data_', inline: false });
        continue;
      }
      const topHeroes = ranked.slice(0, TOP_N);
      const prevPos = prev?.byPosition?.[pos];
      curSnap.byPosition[pos] = {};
      for (const h of topHeroes) curSnap.byPosition[pos][h.heroId] = h.winRate;

      const rankedPos = rankedBaseline.byPosition?.[pos];
      const lines = topHeroes.map((h, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `\`${i + 1}.\``;
        const name = nameMap.get(h.heroId) ?? `Hero ${h.heroId}`;
        const rankedWR = rankedPos?.[h.heroId];
        const dWR = rankedWR != null ? h.winRate - rankedWR : null;
        const spec = dWR != null && dWR >= SPECIALIST_DELTA ? ` 🔥+${(dWR * 100).toFixed(1)}` : '';
        const marker = trendMarker(prevPos, h.heroId, h.winRate);
        return `${medal} **${name}** — ${(h.winRate * 100).toFixed(1)}% WR · ${fmtGames(h.matchCount)} games${spec}${marker}`;
      });
      embed.addFields({
        name: `${POSITION_LABELS[pos]}  _(min ${fmtGames(gate)} games)_`,
        value: lines.join('\n').slice(0, 1024),
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
    embed.addFields({
      name: 'Method & caveats',
      value:
        bracketNote +
        'Ranking uses the Wilson 95% lower bound, not raw WR, with a per-role sample gate. ' +
        windowNote +
        specialistNote +
        '\nFlags: `+turbometa [patch] [rank]` — e.g. `+turbometa immortal`, `+turbometa patch divine+`.',
      inline: false,
    });

    await loading.edit({ content: null, embeds: [embed] });
  } catch (error) {
    logger.error('Error in turbometa command:', error);
    await loading.edit('An error occurred while building the Turbo meta. Please try again later.').catch(() => {});
  }
}
