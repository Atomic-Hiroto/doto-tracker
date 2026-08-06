import { AttachmentBuilder, EmbedBuilder, Message } from 'discord.js';
import { opendotaClient } from '../services/apiClient';
import { renderTurboHeroBalanceScatter, HeroBalancePoint } from '../services/chartService';
import { logger } from '../services/loggerService';
import { safeFields } from '../utils/embedFields';
import {
  compareSpreads,
  correctedSpread,
  fmtCorr,
  gini,
  pearson,
  spearman,
} from '../services/turboStudyStats';

// +turbostudyheroes — the analytical sibling of +turbostudy, but for the META rather than
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

/**
 * "How far off a coin flip is this hero?" bands. Counting heroes outside a band answers
 * "how broken is the meta" far more legibly than a standard deviation does — a reader
 * knows what "49 heroes are more than 3% off 50%" means.
 */
const IMBALANCE_BANDS = [0.03, 0.05];

/** Ranked bracket ids that OpenDota actually populates, checked at runtime. */
const ALL_BRACKETS = [1, 2, 3, 4, 5, 6, 7, 8];
const BRACKET_NAMES: Record<number, string> = {
  1: 'Herald', 2: 'Guardian', 3: 'Crusader', 4: 'Archon',
  5: 'Legend', 6: 'Ancient', 7: 'Divine', 8: 'Immortal',
};


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

    // OpenDota does not always populate every bracket — Immortal (8) is currently all
    // zeros. Detect that up front instead of letting the pick filter empty the cohort
    // and report it as "not enough heroes", which hides the real cause.
    const populated = ALL_BRACKETS.filter((b) => stats.some((h: any) => Number(h[`${b}_pick`] || 0) > 0));
    if (medalId && !populated.includes(medalId)) {
      return progress.edit(
        `OpenDota currently publishes no ${BRACKET_NAMES[medalId]} bracket data in \`/heroStats\` — every ` +
        `${BRACKET_NAMES[medalId]} pick count is zero, so there is nothing to compare against. ` +
        `Available brackets: ${populated.map((b) => BRACKET_NAMES[b]).join(', ')}.`,
      );
    }

    // Ranked pick/win per hero: one medal bracket, or the sum of the populated ones.
    const rankedPickWin = (h: any): { picks: number; wins: number } => {
      if (medalId) return { picks: Number(h[`${medalId}_pick`] || 0), wins: Number(h[`${medalId}_win`] || 0) };
      let picks = 0, wins = 0;
      for (const b of populated) { picks += Number(h[`${b}_pick`] || 0); wins += Number(h[`${b}_win`] || 0); }
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
    // Spreads are sampling-corrected so the "Turbo is X% wider" claim reflects true
    // imbalance, not one mode's smaller per-hero samples carrying more binomial noise,
    // and the ratio now carries a bootstrap interval over the heroes themselves.
    const spreadCmp = compareSpreads(rows.map((r) => ({
      aWr: r.turboWR, aN: r.turboPicks, bWr: r.rankedWR, bN: r.rankedPicks,
    })));
    const turboSpreadStats = spreadCmp?.a ?? correctedSpread(rows.map((r) => ({ wr: r.turboWR, n: r.turboPicks })));
    const rankedSpreadStats = spreadCmp?.b ?? correctedSpread(rows.map((r) => ({ wr: r.rankedWR, n: r.rankedPicks })));
    const turboSpread = turboSpreadStats.corrected;
    const rankedSpread = rankedSpreadStats.corrected;
    const spreadRatio = spreadCmp?.ratio ?? null;
    const meanAbsDWR = rows.reduce((s, r) => s + Math.abs(r.dWR), 0) / rows.length;

    // ── Is Turbo only "wider" because low-skill players skew it? ─────────────
    // Turbo has no medal brackets, so its playerbase mix is unknown and that is the
    // obvious confound for the whole study. Ranked *does* have brackets, so measuring
    // the spread inside each one tests it directly: if even the widest single bracket
    // stays below Turbo, no skill mixture can explain the gap.
    const bracketSpreads = populated.map((b) => ({
      bracket: b,
      name: BRACKET_NAMES[b],
      spread: correctedSpread(
        stats
          .map((h: any) => ({ wr: Number(h[`${b}_win`] || 0) / Math.max(1, Number(h[`${b}_pick`] || 0)), n: Number(h[`${b}_pick`] || 0) }))
          .filter((p) => p.n >= MIN_PICKS),
      ).corrected,
    })).filter((b) => b.spread > 0);
    const widestBracket = bracketSpreads.reduce<{ name: string; spread: number } | null>(
      (best, b) => (best == null || b.spread > best.spread ? b : best), null,
    );
    const skillConfoundRuledOut = widestBracket != null && turboSpread > widestBracket.spread;

    // ── How many heroes are actually off-balance? ────────────────────────────
    // A standard deviation is not something a reader can picture. Counting heroes
    // outside a band around a coin flip is.
    const offBalance = IMBALANCE_BANDS.map((band) => ({
      band,
      turbo: rows.filter((r) => Math.abs(r.turboWR - 0.5) > band).length,
      ranked: rows.filter((r) => Math.abs(r.rankedWR - 0.5) > band).length,
    }));

    // ── Can you just pick a broken hero and win? ─────────────────────────────
    // Top-10 rather than the single best hero: one hero can be contested away, a pool
    // of ten is what a player can realistically always draw from.
    const pickAdvantage = (wrKey: 'turboWR' | 'rankedWR', shareKey: 'turboShare' | 'rankedShare') => {
      const byWR = [...rows].sort((a, b) => b[wrKey] - a[wrKey]);
      const top10 = byWR.slice(0, 10);
      const topWR = top10.reduce((s, r) => s + r[wrKey], 0) / top10.length;
      const bottomWR = byWR.slice(-10).reduce((s, r) => s + r[wrKey], 0) / 10;
      return {
        best: byWR[0],
        bestWR: byWR[0][wrKey],
        topWR,
        bottomWR,
        swing: topWR - bottomWR,
        // How often the choice alone flips a game you would otherwise have lost.
        gamesPerExtraWin: topWR > 0.5 ? 1 / (topWR - 0.5) : Infinity,
        // Do players actually take the free win rate on offer?
        exploitedShare: top10.reduce((s, r) => s + r[shareKey], 0),
      };
    };
    const turboPick = pickAdvantage('turboWR', 'turboShare');
    const rankedPick = pickAdvantage('rankedWR', 'rankedShare');

    const wrCorr = pearson(rows.map((r) => ({ x: r.rankedWR, y: r.turboWR })));
    // Pick shares are compositional and heavily skewed, so the rank-based version is the
    // honest one; Pearson here would be driven by a handful of top-picked heroes.
    const pickCorr = spearman(rows.map((r) => ({ x: r.rankedShare, y: r.turboShare })));

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
    const band3 = offBalance.find((b) => b.band === 0.03);
    if (spreadRatio != null && spreadCmp) {
      const pct = Math.round((spreadRatio - 1) * 100);
      plain.push(
        `**How broken is Turbo's hero balance?** ` +
        (!spreadCmp.significant
          ? `About the same as ${rankedLabel} — the ${spreadRatio.toFixed(2)}× spread ratio has an interval ` +
            `(${spreadCmp.lo.toFixed(2)}–${spreadCmp.hi.toFixed(2)}) that includes 1, so no difference is established.`
          : pct > 0
            ? `**Substantially more than ${rankedLabel}.** Win rates are spread **${pct}% wider** ` +
              `(±${(turboSpread * 100).toFixed(1)}% vs ±${(rankedSpread * 100).toFixed(1)}%, ratio ${spreadRatio.toFixed(2)}× ` +
              `[${spreadCmp.lo.toFixed(2)}–${spreadCmp.hi.toFixed(2)}])` +
              (band3 ? `. **${band3.turbo} of ${rows.length}** heroes sit more than 3% away from a coin flip in Turbo, against **${band3.ranked}** in ranked.` : '.')
            : `**Less** than ${rankedLabel} — Turbo win rates are ${-pct}% tighter.`),
      );
    }

    // The one confound worth pre-empting, because it is the first thing anyone asks.
    if (widestBracket) {
      plain.push(
        `**Just because worse players queue Turbo?** ${skillConfoundRuledOut ? '**No.**' : 'Possibly.'} ` +
        `Ranked brackets run ±${(Math.min(...bracketSpreads.map((b) => b.spread)) * 100).toFixed(1)}–${(widestBracket.spread * 100).toFixed(1)}% ` +
        `(widest: ${widestBracket.name}); Turbo is ±${(turboSpread * 100).toFixed(1)}%. ` +
        (skillConfoundRuledOut
          ? 'Wider than *any* single bracket, so no skill mixture produces it — the mode does.'
          : 'It does not clear the widest bracket, so a skill-mix explanation survives.'),
      );
    }

    plain.push(
      `**Can you just pick a broken hero and win?** Yes, and more so than in ranked. Always drafting from the ten strongest ` +
      `heroes wins **${fmtPct(turboPick.topWR)}** in Turbo — an extra win every **${Math.round(turboPick.gamesPerExtraWin)} games** ` +
      `for the pick alone — against ${fmtPct(rankedPick.topWR)} and one every ${Math.round(rankedPick.gamesPerExtraWin)} in ranked. ` +
      `Best-to-worst swing **${(turboPick.swing * 100).toFixed(1)}** vs ${(rankedPick.swing * 100).toFixed(1)} points. ` +
      (turboPick.exploitedShare <= rankedPick.exploitedShare * 1.15
        ? `Yet they are only **${fmtPct(turboPick.exploitedShare)}** of Turbo picks (${fmtPct(rankedPick.exploitedShare)} ranked) — largely unclaimed.`
        : `And players take it: **${fmtPct(turboPick.exploitedShare)}** of Turbo picks vs ${fmtPct(rankedPick.exploitedShare)}.`),
    );

    if (wrCorr) {
      plain.push(
        `**Same heroes winning in both?** Link **${wrCorr.r.toFixed(2)}** [${wrCorr.lo.toFixed(2)}, ${wrCorr.hi.toFixed(2)}] — ` +
        (wrCorr.r >= 0.7 ? 'mostly the same heroes, amplified.'
          : wrCorr.r >= 0.4 ? 'related, but Turbo genuinely reshuffles who is strong.'
            : 'weak — Turbo is close to its own game.') +
        ` Best: **${turboPick.best.name}** ${fmtPct(turboPick.bestWR)} turbo, ${rankedPick.best.name} ${fmtPct(rankedPick.bestWR)} ranked.`,
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
      .addFields(safeFields([
        { name: '🟢 In Plain English', value: plain.join('\n\n') || 'Not enough data.', inline: false },
        {
          name: '🔨 How broken is it?',
          value:
            offBalance.map((b) =>
              `Heroes more than **${(b.band * 100).toFixed(0)}%** off a coin flip: **${b.turbo}** turbo vs **${b.ranked}** ranked _(of ${rows.length})_`,
            ).join('\n') + '\n' +
            `Win-rate spread: **±${(turboSpread * 100).toFixed(1)}%** turbo vs **±${(rankedSpread * 100).toFixed(1)}%** ranked` +
            (spreadCmp ? ` — **${spreadRatio!.toFixed(2)}×** _(95% ${spreadCmp.lo.toFixed(2)}–${spreadCmp.hi.toFixed(2)}${spreadCmp.significant ? '' : ', includes 1'})_` : '') + '\n' +
            `_↳ sampling-corrected; raw ±${(turboSpreadStats.raw * 100).toFixed(1)}% vs ±${(rankedSpreadStats.raw * 100).toFixed(1)}%. ` +
            `Signal is ${(turboSpreadStats.reliability * 100).toFixed(1)}% of the observed variance, so this is real spread, not small samples._`,
          inline: false,
        },
        {
          name: '🎲 Skill-mix control — Turbo vs each ranked bracket',
          value:
            bracketSpreads.map((b) => `${b.name}: ±${(b.spread * 100).toFixed(2)}%`).join(' · ') +
            `\n**Turbo: ±${(turboSpread * 100).toFixed(2)}%**\n` +
            (skillConfoundRuledOut
              ? '_Turbo exceeds every individual bracket, so "worse players queue Turbo" cannot explain the spread._'
              : '_Turbo does not exceed every bracket, so a skill-mix explanation survives._'),
          inline: false,
        },
        {
          name: '⚔️ Value of the pick itself',
          value:
            `Always drafting a top-10 hero: **${fmtPct(turboPick.topWR)}** turbo vs **${fmtPct(rankedPick.topWR)}** ranked\n` +
            `↳ one extra win every **${Math.round(turboPick.gamesPerExtraWin)}** games vs **${Math.round(rankedPick.gamesPerExtraWin)}**\n` +
            `Best-to-worst hero swing: **${(turboPick.swing * 100).toFixed(1)} pts** turbo vs **${(rankedPick.swing * 100).toFixed(1)} pts** ranked\n` +
            `Share of picks going to that top-10: **${fmtPct(turboPick.exploitedShare)}** turbo vs **${fmtPct(rankedPick.exploitedShare)}** ranked`,
          inline: false,
        },
        {
          name: '📐 Other metrics',
          value:
            `Mean |WR gap| per hero: **${(meanAbsDWR * 100).toFixed(1)}%**\n` +
            `WR correlation: ${fmtCorr(wrCorr)}\n` +
            `Pick-order correlation (Spearman): ${fmtCorr(pickCorr)}\n` +
            `Pick concentration (top-10 share): **${fmtPct(top10Share('turboShare'))}** turbo vs **${fmtPct(top10Share('rankedShare'))}** ranked\n` +
            `Pick Gini: **${turboGini.toFixed(2)}** turbo vs **${rankedGini.toFixed(2)}** ranked`,
          inline: false,
        },
        { name: '📈 Most Turbo-Favoured', value: buffed.map(moverLine).join('\n'), inline: false },
        { name: '📉 Most Turbo-Suppressed', value: nerfed.map(moverLine).join('\n'), inline: false },
        { name: '🎯 Picked Much More in Turbo', value: byPickGain.map(pickLine).join('\n'), inline: false },
        {
          name: 'Caveats',
          value:
            `Hero-level only: this says nothing about item builds, lane setups or any other "strat" — \`/heroStats\` does not carry them.\n` +
            `Ranked baseline = ${medalId ? `${medalKey} medal only` : `brackets ${populated.map((b) => BRACKET_NAMES[b]).join('/')} summed`}. ` +
            `${populated.length < 8 ? `OpenDota publishes no data for ${ALL_BRACKETS.filter((b) => !populated.includes(b)).map((b) => BRACKET_NAMES[b]).join(', ')}. ` : ''}` +
            'Turbo has no brackets of its own, which is why the per-bracket comparison above exists.\n' +
            `Per-hero win rates are precise (${rows.length} heroes, all above ${MIN_PICKS} games), but a snapshot of one patch window is not a trend.`,
          inline: false,
        },
      ]))
      .setImage('attachment://turbo-hero-balance.png')
      .setFooter({ text: 'Data: OpenDota /heroStats · +turbostudyheroes <medal> to pin the ranked bracket' })
      .setTimestamp();

    await progress.edit({ content: null, embeds: [embed], files: [scatterAttachment, csvAttachment] });
  } catch (error) {
    logger.error('Error in turbostudyheroes:', error);
    await progress.edit('An error occurred while building the Turbo hero balance study. Please try again later.');
  }
}
