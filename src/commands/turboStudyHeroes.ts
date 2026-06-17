import { AttachmentBuilder, EmbedBuilder, Message } from 'discord.js';
import { opendotaClient } from '../services/apiClient';
import { dotaDataService } from '../services/dotaDataService';
import { renderTurboHeroBalanceScatter, HeroBalancePoint } from '../services/chartService';
import { logger } from '../services/loggerService';

// +turbostudyheros — the analytical sibling of +turbostudy, but for the META rather than
// for players. It asks: how differently does a hero perform in Turbo vs Ranked, and is
// Turbo measurably *more imbalanced* (more polarised win rates, more concentrated picks)?
//
// Source: OpenDota /heroStats (one keyless call) gives, per hero:
//   turbo_picks / turbo_wins                → the Turbo series
//   <bracket>_pick / <bracket>_win (1..8)   → ranked matchmaking by medal
// We sum the medal brackets for an overall "Ranked" baseline, or restrict to one medal
// when the caller passes e.g. `immortal` (addresses the rank-wise comparison ask).

// OpenDota medal brackets: 1 Herald … 8 Immortal.
const MEDAL_BRACKETS: Record<string, number> = {
  herald: 1, guardian: 2, crusader: 3, archon: 4,
  legend: 5, ancient: 6, divine: 7, immortal: 8,
};
const MEDAL_ALIASES: Record<string, string> = {
  imm: 'immortal', div: 'divine', anc: 'ancient', leg: 'legend',
  arc: 'archon', cru: 'crusader', guard: 'guardian', her: 'herald',
};

// A hero needs a real sample in BOTH modes to be compared. Turbo has far fewer games
// than ranked overall, so this gate is deliberately low — it only drops disabled or
// brand-new heroes, not anything with a meaningful win rate.
const MIN_PICKS = 400;

interface HeroRow {
  id: number;
  name: string;
  turboPicks: number;
  turboWR: number;
  rankedPicks: number;
  rankedWR: number;
  turboShare: number;   // fraction of all turbo picks
  rankedShare: number;  // fraction of all ranked picks
  dWR: number;          // turboWR - rankedWR (positive = turbo-favoured)
  dShare: number;       // turboShare - rankedShare
}

function pearson(pts: Array<{ x: number; y: number }>): number | null {
  if (pts.length < 3) return null;
  const xm = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const ym = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  let cov = 0, xv = 0, yv = 0;
  for (const p of pts) { const dx = p.x - xm, dy = p.y - ym; cov += dx * dy; xv += dx * dx; yv += dy * dy; }
  const denom = Math.sqrt(xv * yv);
  return denom === 0 ? null : cov / denom;
}

/** Population standard deviation of a value list. */
function stdev(vals: number[]): number {
  if (vals.length === 0) return 0;
  const m = vals.reduce((s, v) => s + v, 0) / vals.length;
  return Math.sqrt(vals.reduce((s, v) => s + (v - m) * (v - m), 0) / vals.length);
}

/** Gini coefficient of a distribution (0 = everyone picked equally, 1 = one hero hogs all picks). */
function gini(vals: number[]): number {
  if (vals.length === 0) return 0;
  const sorted = [...vals].sort((a, b) => a - b);
  const n = sorted.length;
  const total = sorted.reduce((s, v) => s + v, 0);
  if (total === 0) return 0;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i + 1) * sorted[i];
  return (2 * cum) / (n * total) - (n + 1) / n;
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}
function fmtSignedPct(v: number): string {
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
}

function toCsv(rows: HeroRow[]): Buffer {
  const header = ['hero', 'turboPicks', 'turboWR', 'rankedPicks', 'rankedWR', 'dWR', 'turboPickShare', 'rankedPickShare', 'dPickShare'];
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = rows
    .sort((a, b) => b.dWR - a.dWR)
    .map((r) => [
      r.name, r.turboPicks, (r.turboWR * 100).toFixed(2), r.rankedPicks, (r.rankedWR * 100).toFixed(2),
      (r.dWR * 100).toFixed(2), (r.turboShare * 100).toFixed(3), (r.rankedShare * 100).toFixed(3), (r.dShare * 100).toFixed(3),
    ].map(esc).join(','));
  return Buffer.from([header.join(','), ...lines].join('\n'), 'utf8');
}

export async function turboStudyHeroes(message: Message, args: string[]) {
  // Optional medal restricts the *ranked* baseline (turbo has no brackets).
  const medalArg = (args.find((a) => {
    const k = a.toLowerCase();
    return MEDAL_BRACKETS[k] != null || MEDAL_ALIASES[k] != null;
  }) ?? '').toLowerCase();
  const medalKey = MEDAL_ALIASES[medalArg] ?? medalArg;
  const medalId = MEDAL_BRACKETS[medalKey] ?? null;
  const rankedLabel = medalId ? `${medalKey[0].toUpperCase()}${medalKey.slice(1)} ranked` : 'Ranked (all medals)';

  const progress = await message.reply(`📊 Building Turbo-vs-${rankedLabel} hero balance study…`);
  try {
    const stats = await opendotaClient.get<any[]>('/heroStats').then((r) => r.data || []);
    if (!stats.length) return progress.edit('OpenDota returned no hero stats. Try again later.');

    // Ranked pick/win per hero: one medal bracket, or the sum of all eight.
    const rankedPickWin = (h: any): { picks: number; wins: number } => {
      if (medalId) return { picks: Number(h[`${medalId}_pick`] || 0), wins: Number(h[`${medalId}_win`] || 0) };
      let picks = 0, wins = 0;
      for (let b = 1; b <= 8; b++) { picks += Number(h[`${b}_pick`] || 0); wins += Number(h[`${b}_win`] || 0); }
      return { picks, wins };
    };

    const raw = stats.map((h: any) => {
      const tp = Number(h.turbo_picks || 0), tw = Number(h.turbo_wins || 0);
      const { picks: rp, wins: rw } = rankedPickWin(h);
      return { id: Number(h.id), name: h.localized_name as string, tp, tw, rp, rw };
    }).filter((h) => h.tp >= MIN_PICKS && h.rp >= MIN_PICKS);

    if (raw.length < 5) {
      return progress.edit(`Not enough heroes clear the ${MIN_PICKS}-game gate in both modes${medalId ? ` at ${medalKey}` : ''}.`);
    }

    const turboTotal = raw.reduce((s, h) => s + h.tp, 0);
    const rankedTotal = raw.reduce((s, h) => s + h.rp, 0);

    const rows: HeroRow[] = raw.map((h) => {
      const turboWR = h.tw / h.tp, rankedWR = h.rw / h.rp;
      const turboShare = h.tp / turboTotal, rankedShare = h.rp / rankedTotal;
      return {
        id: h.id, name: h.name || `Hero ${h.id}`,
        turboPicks: h.tp, turboWR, rankedPicks: h.rp, rankedWR,
        turboShare, rankedShare, dWR: turboWR - rankedWR, dShare: turboShare - rankedShare,
      };
    });

    // ── Aggregate imbalance metrics ──────────────────────────────────────────
    const turboWRs = rows.map((r) => r.turboWR);
    const rankedWRs = rows.map((r) => r.rankedWR);
    const turboSpread = stdev(turboWRs);
    const rankedSpread = stdev(rankedWRs);
    const spreadRatio = rankedSpread > 0 ? turboSpread / rankedSpread : null;
    const meanAbsDWR = rows.reduce((s, r) => s + Math.abs(r.dWR), 0) / rows.length;

    const wrCorr = pearson(rows.map((r) => ({ x: r.rankedWR, y: r.turboWR })));
    const pickCorr = pearson(rows.map((r) => ({ x: r.rankedShare, y: r.turboShare })));

    const top10Share = (key: 'turboShare' | 'rankedShare') =>
      [...rows].sort((a, b) => b[key] - a[key]).slice(0, 10).reduce((s, r) => s + r[key], 0);
    const turboGini = gini(rows.map((r) => r.turboPicks));
    const rankedGini = gini(rows.map((r) => r.rankedPicks));

    // ── Movers ───────────────────────────────────────────────────────────────
    const byDWR = [...rows].sort((a, b) => b.dWR - a.dWR);
    const buffed = byDWR.slice(0, 8);
    const nerfed = byDWR.slice(-8).reverse();
    const byPickGain = [...rows].sort((a, b) => b.dShare - a.dShare).slice(0, 6);

    const moverLine = (r: HeroRow) =>
      `**${r.name}** — ${fmtPct(r.turboWR)} turbo vs ${fmtPct(r.rankedWR)} ranked (**${fmtSignedPct(r.dWR)}**)`;
    const pickLine = (r: HeroRow) =>
      `**${r.name}** — ${fmtPct(r.turboShare)} turbo vs ${fmtPct(r.rankedShare)} ranked (${fmtSignedPct(r.dShare)})`;

    // ── Plain-English read ─────────────────────────────────────────────────────
    const plain: string[] = [];
    if (spreadRatio != null) {
      const pct = Math.round((spreadRatio - 1) * 100);
      plain.push(
        `**Is Turbo more imbalanced than ${rankedLabel}?** ` +
        (Math.abs(pct) < 5
          ? `Not really — win rates are spread about the same (${(turboSpread * 100).toFixed(1)}% vs ${(rankedSpread * 100).toFixed(1)}%).`
          : pct > 0
            ? `**Yes.** Turbo win rates are spread **${pct}% wider** (±${(turboSpread * 100).toFixed(1)}% vs ±${(rankedSpread * 100).toFixed(1)}%) — more genuinely strong and genuinely weak heroes.`
            : `Actually **less** — Turbo win rates are **${-pct}% tighter** than ranked.`),
      );
    }
    if (wrCorr != null) {
      plain.push(
        `**Do the same heroes win in both?** The win-rate link is **${wrCorr.toFixed(2)}/1.00** — ` +
        (wrCorr >= 0.7 ? 'mostly the same heroes are good, just amplified.'
          : wrCorr >= 0.4 ? 'related, but Turbo clearly reshuffles who is strong.'
            : 'weak — Turbo is close to its own game balance-wise.'),
      );
    }
    if (buffed.length) {
      plain.push(
        `**Who does Turbo break?** ${buffed.slice(0, 3).map((r) => r.name).join(', ')} gain the most ` +
        '(fast gold + short games reward tanky/snowball/sustain heroes), while ' +
        `${nerfed.slice(0, 3).map((r) => r.name).join(', ')} fall off the hardest.`,
      );
    }

    // ── Scatter ────────────────────────────────────────────────────────────────
    const moverIds = new Set([...buffed.slice(0, 6), ...nerfed.slice(0, 6)].map((r) => r.id));
    const points: HeroBalancePoint[] = rows.map((r) => ({
      label: r.name,
      rankedWR: r.rankedWR,
      turboWR: r.turboWR,
      size: Math.sqrt(r.turboPicks / 1000),
      highlight: moverIds.has(r.id),
    }));
    const scatter = renderTurboHeroBalanceScatter(points, { title: `Hero Win Rate — Turbo vs ${rankedLabel}` });
    const scatterAttachment = new AttachmentBuilder(scatter, { name: 'turbo-hero-balance.png' });
    const csvAttachment = new AttachmentBuilder(toCsv(rows), { name: 'turbo-hero-balance.csv' });

    const embed = new EmbedBuilder()
      .setColor('#f59e0b')
      .setTitle(`⚡ Turbo Hero Balance Study — vs ${rankedLabel}`)
      .setDescription(`How Turbo's hero meta diverges from ${rankedLabel}, across ${rows.length} heroes (OpenDota, current patch window).`)
      .addFields(
        { name: '🟢 In Plain English', value: plain.join('\n\n') || 'Not enough data.', inline: false },
        {
          name: '📐 Imbalance Metrics',
          value:
            `Win-rate spread: **±${(turboSpread * 100).toFixed(1)}%** turbo vs **±${(rankedSpread * 100).toFixed(1)}%** ranked` +
            (spreadRatio != null ? ` (**${spreadRatio.toFixed(2)}×**)` : '') + '\n' +
            `Mean |WR gap| per hero: **${(meanAbsDWR * 100).toFixed(1)}%**\n` +
            `WR correlation: **${wrCorr?.toFixed(2) ?? 'n/a'}** · Pick correlation: **${pickCorr?.toFixed(2) ?? 'n/a'}**\n` +
            `Pick concentration (top-10 share): **${fmtPct(top10Share('turboShare'))}** turbo vs **${fmtPct(top10Share('rankedShare'))}** ranked\n` +
            `Pick Gini: **${turboGini.toFixed(2)}** turbo vs **${rankedGini.toFixed(2)}** ranked`,
          inline: false,
        },
        { name: '📈 Most Turbo-Favoured', value: buffed.map(moverLine).join('\n'), inline: false },
        { name: '📉 Most Turbo-Suppressed', value: nerfed.map(moverLine).join('\n'), inline: false },
        { name: '🎯 Picked Much More in Turbo', value: byPickGain.map(pickLine).join('\n'), inline: false },
        {
          name: 'Caveats',
          value: 'Whole-playerbase snapshot — Turbo has no skill brackets, so part of the gap is *who plays Turbo*, not pure balance. Ranked baseline = ' +
            (medalId ? `${medalKey} medal only.` : 'all medals summed.') + ' Use a medal arg (e.g. `+turbostudyheros immortal`) to control for skill.',
          inline: false,
        },
      )
      .setImage('attachment://turbo-hero-balance.png')
      .setFooter({ text: 'Data: OpenDota /heroStats · +turbostudyheros <medal> to pin the ranked bracket' })
      .setTimestamp();

    await progress.edit({ content: null, embeds: [embed], files: [scatterAttachment, csvAttachment] });
  } catch (error) {
    logger.error('Error in turbostudyheros:', error);
    await progress.edit('An error occurred while building the Turbo hero balance study. Please try again later.');
  }
}
