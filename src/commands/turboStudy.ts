import fs from 'fs';
import { AttachmentBuilder, EmbedBuilder, Message } from 'discord.js';
import { turboRankService, rankTierToMMR, rankTierToMedal } from '../services/turboRankService';
import { TurboRankEstimate } from '../models/TurboRank';
import { TurboStatsService } from '../services/turboStatsService';
import { UserDataService } from '../services/userDataService';
import { opendotaClient } from '../services/apiClient';
import { renderTurboStudyScatter, renderTurboStudyResidual } from '../services/chartService';
import { logger } from '../services/loggerService';

interface StudyCandidate {
  discordId: string;
  steamId: string;
  name: string;
  estimate: TurboRankEstimate;
  turboScore?: number;
  turboGames?: number;
  turboWinRate?: number;
  visibleRankTier?: number;
  visibleMMR?: number;
}

interface StudyRow extends StudyCandidate {
  visibleRankTier: number;
  visibleMMR: number;
}

function asRows(candidates: StudyCandidate[]): StudyRow[] {
  return candidates.filter((c): c is StudyRow => c.visibleRankTier != null && c.visibleMMR != null);
}

function pearsonPairs(points: Array<{ x: number; y: number }>): number | null {
  if (points.length < 3) return null;

  const xMean = points.reduce((s, p) => s + p.x, 0) / points.length;
  const yMean = points.reduce((s, p) => s + p.y, 0) / points.length;
  let numerator = 0;
  let xVar = 0;
  let yVar = 0;

  for (const p of points) {
    const dx = p.x - xMean;
    const dy = p.y - yMean;
    numerator += dx * dy;
    xVar += dx * dx;
    yVar += dy * dy;
  }

  const denom = Math.sqrt(xVar * yVar);
  return denom === 0 ? null : numerator / denom;
}

function pearson(rows: StudyRow[], x: (r: StudyRow) => number | undefined, y: (r: StudyRow) => number | undefined): number | null {
  const points = rows
    .map((r) => ({ x: x(r), y: y(r) }))
    .filter((p): p is { x: number; y: number } => Number.isFinite(p.x) && Number.isFinite(p.y));
  return pearsonPairs(points);
}

function weightedPearson(rows: StudyRow[]): number | null {
  const points = rows.map((r) => ({
    x: r.visibleMMR,
    y: r.estimate.estimatedMMR,
    w: Math.max(0.1, r.estimate.effectiveSample) * Math.max(0.2, r.estimate.confidence / 100),
  }));
  if (points.length < 3) return null;

  const wSum = points.reduce((s, p) => s + p.w, 0);
  if (wSum === 0) return null;

  const xMean = points.reduce((s, p) => s + p.x * p.w, 0) / wSum;
  const yMean = points.reduce((s, p) => s + p.y * p.w, 0) / wSum;
  let cov = 0;
  let xVar = 0;
  let yVar = 0;
  for (const p of points) {
    const dx = p.x - xMean;
    const dy = p.y - yMean;
    cov += p.w * dx * dy;
    xVar += p.w * dx * dx;
    yVar += p.w * dy * dy;
  }

  const denom = Math.sqrt(xVar * yVar);
  return denom === 0 ? null : cov / denom;
}

function ranks(values: number[]): number[] {
  const sorted = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);
  const result = new Array(values.length);

  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].value === sorted[i].value) j++;
    const rank = (i + j + 1) / 2;
    for (let k = i; k < j; k++) result[sorted[k].index] = rank;
    i = j;
  }

  return result;
}

function spearman(rows: StudyRow[], x: (r: StudyRow) => number, y: (r: StudyRow) => number): number | null {
  if (rows.length < 3) return null;
  const xRanks = ranks(rows.map(x));
  const yRanks = ranks(rows.map(y));
  return pearsonPairs(xRanks.map((rank, i) => ({ x: rank, y: yRanks[i] })));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function linearFit(rows: StudyRow[]): { slope: number; intercept: number; r2: number } | null {
  if (rows.length < 3) return null;
  const corr = pearson(rows, (r) => r.visibleMMR, (r) => r.estimate.estimatedMMR);
  const xMean = rows.reduce((s, r) => s + r.visibleMMR, 0) / rows.length;
  const yMean = rows.reduce((s, r) => s + r.estimate.estimatedMMR, 0) / rows.length;
  let numerator = 0;
  let denominator = 0;
  for (const r of rows) {
    numerator += (r.visibleMMR - xMean) * (r.estimate.estimatedMMR - yMean);
    denominator += Math.pow(r.visibleMMR - xMean, 2);
  }
  if (denominator === 0 || corr == null) return null;
  const slope = numerator / denominator;
  return { slope, intercept: yMean - slope * xMean, r2: corr * corr };
}

function fmtCorr(value: number | null): string {
  if (value == null) return 'n/a';
  const strength = Math.abs(value) >= 0.8 ? 'strong'
    : Math.abs(value) >= 0.5 ? 'moderate'
      : Math.abs(value) >= 0.25 ? 'weak'
        : 'very weak';
  return `${value.toFixed(2)} (${strength})`;
}

function fmtMmr(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${Math.round(value)} MMR`;
}

/**
 * Plain-language version of the headline stats, so readers who don't know what
 * "correlation" or "R²" mean still get the takeaway. Reflects the live numbers.
 */
function plainEnglish(rankCorr: number | null, fit: { slope: number; r2: number } | null): string {
  const lines: string[] = [];
  if (rankCorr != null) {
    const c = Math.abs(rankCorr);
    const strength = c >= 0.8 ? 'strong' : c >= 0.6 ? 'solid' : c >= 0.4 ? 'modest' : 'weak';
    const verdict = c >= 0.6 ? 'Yes' : c >= 0.4 ? 'Somewhat' : 'Not really';
    lines.push(
      `**Does ranked skill carry into Turbo?** ${verdict} — the link is **${rankCorr.toFixed(2)} out of 1.00** (${strength}). ` +
      `If we know your ranked medal we can predict your Turbo level fairly well, and vice-versa. Good ranked players are good in Turbo; weak ones are weak.`,
    );
  }
  if (fit) {
    const pct = Math.round(fit.r2 * 100);
    lines.push(
      `**How much of your Turbo skill is just your ranked medal?** About **${pct}%** of it. ` +
      `The other ${100 - pct}% is Turbo's own chaos plus how much you actually play it.`,
    );
    if (fit.slope < 0.9) {
      lines.push(
        `**Why are the dots flatter than the diagonal?** Turbo *squashes* the skill gap (slope ${fit.slope.toFixed(2)} below 1): ` +
        `weaker players look a bit better than their medal, and the very best flatten out at the top — Turbo can't tell an Ancient from an Immortal.`,
      );
    }
  }
  if (lines.length === 0) return 'Not enough data yet for a plain-language read.';
  return lines.join('\n\n');
}

function fitLines(lines: string[], emptyText: string, limit = 1000): string {
  if (lines.length === 0) return emptyText;
  const selected: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const nextLen = lines[i].length + (selected.length > 0 ? 1 : 0);
    if (used + nextLen > limit) {
      selected.push(`...and ${lines.length - i} more.`);
      break;
    }
    selected.push(lines[i]);
    used += nextLen;
  }
  return selected.join('\n');
}

function isHighQuality(row: StudyRow): boolean {
  return !row.estimate.partyFallback && row.estimate.confidence >= 70 && row.estimate.soloSampleSize >= 15;
}

/**
 * Immortal-ranked players sit above the turbo estimator's resolution ceiling
 * (turbo lobby averages top out ~4–4.5k), so their gaps are structural, not
 * estimator error. Splitting them out keeps the headline error honest.
 */
function isCeiling(row: StudyRow): boolean {
  return Math.floor(row.visibleRankTier / 10) === 8;
}

/** MAE / RMSE / median gap for a subset of rows (null if empty). */
function errorStats(rows: StudyRow[]): { n: number; mae: number; rmse: number; medianGap: number | null } | null {
  if (rows.length === 0) return null;
  const gaps = rows.map((r) => r.estimate.estimatedMMR - r.visibleMMR);
  const mae = gaps.reduce((s, g) => s + Math.abs(g), 0) / gaps.length;
  const rmse = Math.sqrt(gaps.reduce((s, g) => s + g * g, 0) / gaps.length);
  return { n: rows.length, mae, rmse, medianGap: median(gaps) };
}

function daysSince(ms: number): number {
  return Math.floor((Date.now() - ms) / 86400000);
}

/**
 * Immortal (tier 80) has no medal stars, so rankTierToMMR pins every Immortal —
 * a top-1000 ladder player and a just-qualified one — to the same floor (~5420),
 * which badly understates the strong ones and flattens the whole high end of the
 * study. Spread them out using the OpenDota leaderboard rank instead.
 *
 * Curve fit to known anchors (leaderboard rank → MMR): #4903≈7.0k, #3205≈7.2k,
 * #959≈8.0k → `mmr ≈ 12200 − 613·ln(rank)`. Off-leaderboard Immortals (no rank
 * returned — usually just-qualified) sit at the Immortal entry floor.
 */
const IMMORTAL_FLOOR_MMR = 5620;
function immortalMMRFromLeaderboard(leaderboardRank: number | null | undefined): number {
  if (!leaderboardRank || leaderboardRank <= 0) return IMMORTAL_FLOOR_MMR;
  const est = 12200 - 613 * Math.log(leaderboardRank);
  return Math.max(IMMORTAL_FLOOR_MMR, Math.round(est));
}

/**
 * Resolve a player's visible *ranked* MMR for the study's x-axis.
 *
 * Prefers the Stratz `seasonRank` captured at calibration time (`estimate.rankedTier`):
 * it's the same source the turbo estimate used, it's generally fresher than OpenDota's
 * `rank_tier` (which only updates on a profile re-parse), and it needs no extra call.
 * OpenDota is hit only when we need a leaderboard rank to de-compress an Immortal, or
 * as a fallback when Stratz never captured a medal.
 */
async function fetchVisibleRankMMR(
  steamId: string,
  stratzTier: number | null | undefined,
): Promise<{ rankTier: number; mmr: number } | null> {
  let rankTier = stratzTier && stratzTier > 0 ? stratzTier : null;
  let leaderboardRank: number | null = null;

  const needsOpenDota = rankTier == null || Math.floor(rankTier / 10) === 8;
  if (needsOpenDota) {
    try {
      const response = await opendotaClient.get<{ rank_tier?: number; leaderboard_rank?: number }>(`/players/${steamId}`);
      if (rankTier == null && response.data?.rank_tier) rankTier = response.data.rank_tier;
      leaderboardRank = response.data?.leaderboard_rank ?? null;
    } catch (error) {
      logger.warn(`Turbo study profile fetch failed for ${steamId}:`, error);
    }
  }

  if (!rankTier) return null;
  const mmr = Math.floor(rankTier / 10) === 8
    ? immortalMMRFromLeaderboard(leaderboardRank)
    : rankTierToMMR(rankTier);
  return mmr != null ? { rankTier, mmr } : null;
}

function toCsv(candidates: StudyCandidate[]): Buffer {
  const header = [
    'name', 'discordId', 'steamId', 'rankedMedal', 'rankedApproxMMR',
    'turboMedal', 'turboMMR', 'gapMMR', 'confidence', 'sampleSize',
    'soloSampleSize', 'effectiveSample', 'partyFallback', 'lastUpdated',
    'turboScore', 'turboGames', 'turboWinRate',
  ];
  const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = candidates.map((r) => {
    const gap = r.visibleMMR == null ? '' : r.estimate.estimatedMMR - r.visibleMMR;
    return [
      r.name,
      r.discordId,
      r.steamId,
      r.visibleRankTier ? rankTierToMedal(r.visibleRankTier) : '',
      r.visibleMMR ?? '',
      r.estimate.medal,
      r.estimate.estimatedMMR,
      gap,
      r.estimate.confidence,
      r.estimate.sampleSize,
      r.estimate.soloSampleSize,
      r.estimate.effectiveSample,
      r.estimate.partyFallback,
      new Date(r.estimate.lastUpdated).toISOString(),
      r.turboScore ?? '',
      r.turboGames ?? '',
      r.turboWinRate == null ? '' : r.turboWinRate.toFixed(1),
    ].map(escape).join(',');
  });

  return Buffer.from([header.join(','), ...rows].join('\n'), 'utf8');
}

const STUDY_HISTORY_FILE = 'turboStudyHistory.json';
interface StudySnapshot { ts: number; n: number; mae: number; rmse: number; avgGap: number; slope: number | null; intercept: number | null; }
function loadStudyHistory(): StudySnapshot[] {
  try { return JSON.parse(fs.readFileSync(STUDY_HISTORY_FILE, 'utf8')); } catch { return []; }
}
function saveStudySnapshot(snap: StudySnapshot) {
  const hist = loadStudyHistory();
  hist.push(snap);
  try { fs.writeFileSync(STUDY_HISTORY_FILE, JSON.stringify(hist.slice(-50), null, 2)); } catch { /* ignore */ }
}
function trendArrow(curr: number, prev: number | undefined, lowerIsBetter = true): string {
  if (prev == null) return ' _(first run)_';
  const delta = curr - prev;
  if (Math.abs(delta) < 1) return ' (=)';
  const better = lowerIsBetter ? delta < 0 : delta > 0;
  return ` (${delta < 0 ? '▼' : '▲'}${Math.abs(Math.round(delta))} ${better ? '✅' : '⚠️'})`;
}
const STUDY_BRACKETS = [
  { name: 'Herald–Crusader (<2310)', lo: 0, hi: 2310 },
  { name: 'Archon–Legend (2310–3850)', lo: 2310, hi: 3850 },
  { name: 'Ancient+ (3850+)', lo: 3850, hi: Infinity },
];

export async function turboStudy(message: Message, userDataService: UserDataService, turboStatsService: TurboStatsService) {
  try {
    const estimates = turboRankService.getAllEstimates();
    const registeredUsers = userDataService.getAllUsers();

    if (estimates.length < 3) {
      return message.reply('Need at least 3 players with calibrated `+turborank` estimates to run a study.');
    }

    const progress = await message.reply('📊 Building Turbo study... fetching visible ranked medals for calibrated players.');
    const candidates: StudyCandidate[] = [];

    for (let i = 0; i < estimates.length; i++) {
      const entry = estimates[i];
      if (i > 0 && i % 10 === 0) {
        progress.edit(`📊 Building Turbo study... checked ${i}/${estimates.length} calibrated players.`).catch(() => {});
      }

      const visible = await fetchVisibleRankMMR(entry.steamId, entry.estimate.rankedTier);
      const user = entry.discordId ? await message.client.users.fetch(entry.discordId).catch(() => null) : null;
      const stats = entry.discordId ? turboStatsService.getPlayerStats(entry.discordId) : undefined;
      const turboGames = stats ? stats.wins + stats.losses : undefined;
      candidates.push({
        discordId: entry.discordId,
        steamId: entry.steamId,
        name: user?.username ?? entry.steamName ?? entry.steamId,
        estimate: entry.estimate,
        turboScore: stats?.rating,
        turboGames,
        turboWinRate: stats && turboGames ? (stats.wins / turboGames) * 100 : undefined,
        visibleRankTier: visible?.rankTier,
        visibleMMR: visible?.mmr,
      });
    }

    const rows = asRows(candidates);
    if (rows.length < 3) {
      return progress.edit('Not enough calibrated players also have a visible ranked medal. Need at least 3 data points.');
    }

    const highQualityRows = rows.filter(isHighQuality);
    const gaps = rows.map((r) => r.estimate.estimatedMMR - r.visibleMMR);
    const absGaps = gaps.map(Math.abs);
    const avgGap = gaps.reduce((s, gap) => s + gap, 0) / gaps.length;
    const medianGap = median(gaps);
    const mae = absGaps.reduce((s, gap) => s + gap, 0) / absGaps.length;
    const rmse = Math.sqrt(gaps.reduce((s, gap) => s + gap * gap, 0) / gaps.length);
    const fit = linearFit(rows);

    // Segment the error: the measurable range (Herald–Divine) vs the ceiling
    // (Immortal), which the estimator structurally can't resolve. Without this
    // split the Immortal tail dominates MAE/slope and makes the estimator look
    // worse than it is for the players it actually handles.
    const measurableRows = rows.filter((r) => !isCeiling(r));
    const ceilingRows = rows.filter(isCeiling);
    const measurableStats = errorStats(measurableRows);
    const ceilingStats = errorStats(ceilingRows);
    const measurableFit = linearFit(measurableRows);

    const rankCorr = pearson(rows, (r) => r.visibleMMR, (r) => r.estimate.estimatedMMR);
    const highQualityCorr = pearson(highQualityRows, (r) => r.visibleMMR, (r) => r.estimate.estimatedMMR);
    const weightedCorr = weightedPearson(rows);
    const rankOrderCorr = spearman(rows, (r) => r.visibleMMR, (r) => r.estimate.estimatedMMR);
    const scoreCorr = pearson(rows, (r) => r.turboScore, (r) => r.estimate.estimatedMMR);

    const missingVisible = candidates.filter((r) => r.visibleMMR == null);
    const lowConfidence = rows.filter((r) => r.estimate.confidence < 50);
    const partyFallback = rows.filter((r) => r.estimate.partyFallback);
    const stale = rows.filter((r) => daysSince(r.estimate.lastUpdated) > 30);
    const outliers = [...rows].filter((r) => Math.abs(r.estimate.estimatedMMR - r.visibleMMR) >= 900);
    const calibratedSteamIds = new Set(candidates.map((r) => r.steamId));
    const uncalibratedRegistered = registeredUsers.filter((u) => !calibratedSteamIds.has(u.steamId));

    const largestGaps = [...rows]
      .sort((a, b) => Math.abs((b.estimate.estimatedMMR - b.visibleMMR)) - Math.abs((a.estimate.estimatedMMR - a.visibleMMR)))
      .slice(0, 6)
      .map((r) => {
        const gap = r.estimate.estimatedMMR - r.visibleMMR;
        const flags = [
          r.estimate.partyFallback ? 'party fallback' : null,
          r.estimate.confidence < 50 ? 'low conf' : null,
          daysSince(r.estimate.lastUpdated) > 30 ? 'stale' : null,
        ].filter(Boolean).join(', ');
        return `**${r.name}**: ${r.estimate.medal} turbo vs ${rankTierToMedal(r.visibleRankTier)} ranked (${fmtMmr(gap)})${flags ? ` - ${flags}` : ''}`;
      });

    const healthLines = [
      `High-quality solo estimates: **${highQualityRows.length}/${rows.length}**`,
      `Low confidence: **${lowConfidence.length}**`,
      `Party fallback: **${partyFallback.length}**`,
      `Stale >30d: **${stale.length}**`,
      `Large gaps >=900 MMR: **${outliers.length}**`,
    ];

    const actionLines = [
      uncalibratedRegistered.length > 0 ? `Run \`+turborank calibrate\` for ${uncalibratedRegistered.length} registered player(s) with no estimate.` : null,
      missingVisible.length > 0 ? `${missingVisible.length} calibrated player(s) have no visible ranked medal; they stay in the CSV but out of rank correlation.` : null,
      stale.length > 0 ? `Recalibrate stale estimate(s): ${stale.slice(0, 4).map((r) => r.name).join(', ')}.` : null,
      partyFallback.length > 0 ? `Audit party-fallback estimate(s): ${partyFallback.slice(0, 4).map((r) => r.name).join(', ')}.` : null,
      outliers.length > 0 ? `Manually inspect largest gap player(s): ${outliers.slice(0, 4).map((r) => r.name).join(', ')}.` : null,
      rows.length < 12 ? 'Collect more calibrated players before treating coefficients as stable.' : null,
      'Use the CSV attachment to track whether future formula changes reduce MAE/RMSE and outlier count.',
    ].filter((line): line is string => !!line);

    // Bias by ranked bracket (reveals the MMR-dependent gap).
    const bracketLines = STUDY_BRACKETS.map((b) => {
      const inB = rows.filter((r) => r.visibleMMR >= b.lo && r.visibleMMR < b.hi);
      if (inB.length === 0) return `${b.name}: _no players_`;
      const g = inB.reduce((s, r) => s + (r.estimate.estimatedMMR - r.visibleMMR), 0) / inB.length;
      return `${b.name}: **${fmtMmr(g)}** avg gap _(${inB.length})_`;
    });

    // Calibration extremes (closest / furthest from ranked).
    const byGap = [...rows].sort((a, z) => Math.abs(a.estimate.estimatedMMR - a.visibleMMR) - Math.abs(z.estimate.estimatedMMR - z.visibleMMR));
    const best = byGap[0];
    const worst = byGap[byGap.length - 1];
    const extremesLine =
      `Tightest: **${best.name}** (${fmtMmr(best.estimate.estimatedMMR - best.visibleMMR)})\n` +
      `Loosest: **${worst.name}** (${fmtMmr(worst.estimate.estimatedMMR - worst.visibleMMR)})`;

    // Fit interpretation.
    let fitNote = 'n/a';
    if (fit) {
      if (fit.slope < 0.9) fitNote = `Slope ${fit.slope.toFixed(2)} < 1 → low ranks over-estimated, high ranks compressed (classic unranked-drop bias).`;
      else if (fit.slope > 1.1) fitNote = `Slope ${fit.slope.toFixed(2)} > 1 → estimates fan out vs ranked.`;
      else fitNote = `Slope ${fit.slope.toFixed(2)} ≈ 1 → roughly uniform offset of ${fmtMmr(fit.intercept)}.`;
    }

    // Error split by what the estimator can actually measure.
    const rangeLines: string[] = [];
    if (measurableStats) {
      rangeLines.push(
        `✅ **Measurable (Herald–Divine, ${measurableStats.n}):** MAE **${Math.round(measurableStats.mae)} MMR**, ` +
        `median **${fmtMmr(measurableStats.medianGap)}**` +
        (measurableFit ? `, slope **${measurableFit.slope.toFixed(2)}** (R² ${measurableFit.r2.toFixed(2)})` : '') +
        ' — this is the estimator\'s real accuracy.',
      );
    }
    if (ceilingStats) {
      rangeLines.push(
        `🧢 **Ceiling (Immortal, ${ceilingStats.n}):** MAE **${Math.round(ceilingStats.mae)} MMR** — ` +
        'beyond turbo\'s resolution. Lobbies top out ~4–4.5k, so these can\'t be separated; treat as "elite, unmeasurable", not error.',
      );
    }
    const rangeNote = rangeLines.length ? rangeLines.join('\n') : 'Not enough data to segment by range.';

    // Trend vs the previous run (persisted), then record this run.
    const prevSnap = loadStudyHistory().slice(-1)[0];
    const trendLine =
      `MAE: **${Math.round(mae)}**${trendArrow(mae, prevSnap?.mae)}\n` +
      `RMSE: **${Math.round(rmse)}**${trendArrow(rmse, prevSnap?.rmse)}\n` +
      `|Avg gap|: **${Math.round(Math.abs(avgGap))}**${trendArrow(Math.abs(avgGap), prevSnap ? Math.abs(prevSnap.avgGap) : undefined)}`;
    saveStudySnapshot({ ts: Date.now(), n: rows.length, mae, rmse, avgGap, slope: fit?.slope ?? null, intercept: fit?.intercept ?? null });

    const scatter = renderTurboStudyScatter(
      rows.map((r) => ({
        label: r.name,
        x: r.visibleMMR,
        y: r.estimate.estimatedMMR,
        confidence: r.estimate.confidence,
        sampleSize: r.estimate.soloSampleSize,
        partyFallback: r.estimate.partyFallback,
        stale: daysSince(r.estimate.lastUpdated) > 30,
        outlier: Math.abs(r.estimate.estimatedMMR - r.visibleMMR) >= 900,
      })),
      {
        title: 'Hidden Turbo Rank vs Visible Ranked Medal',
        xLabel: 'Visible ranked medal estimate (MMR)',
        yLabel: 'Hidden Turbo estimate (MMR)',
        fit: fit ? { slope: fit.slope, intercept: fit.intercept } : undefined,
      },
    );
    const residual = renderTurboStudyResidual(
      rows.map((r) => ({
        label: r.name,
        rankedMMR: r.visibleMMR,
        gap: r.estimate.estimatedMMR - r.visibleMMR,
        confidence: r.estimate.confidence,
        partyFallback: r.estimate.partyFallback,
        stale: daysSince(r.estimate.lastUpdated) > 30,
      })),
      fit ? { slope: fit.slope, intercept: fit.intercept } : null,
    );
    const scatterAttachment = new AttachmentBuilder(scatter, { name: 'turbo-study.png' });
    const residualAttachment = new AttachmentBuilder(residual, { name: 'turbo-bias.png' });
    const csvAttachment = new AttachmentBuilder(toCsv(candidates), { name: 'turbo-study.csv' });

    const embed = new EmbedBuilder()
      .setColor('#2563eb')
      .setTitle('📊 Turbo Study')
      .setDescription('Diagnostic report for hidden Turbo rank estimates. Includes regression, residuals, estimator health, and CSV export.')
      .addFields(
        {
          name: '🟢 In Plain English',
          value: plainEnglish(rankCorr, fit),
          inline: false,
        },
        {
          name: 'Coverage',
          value:
            `Registered: **${registeredUsers.length}** | calibrated: **${candidates.length}** | analyzed: **${rows.length}**\n` +
            `Missing visible ranked medal: **${missingVisible.length}** | registered uncalibrated: **${uncalibratedRegistered.length}**`,
          inline: false,
        },
        {
          name: 'Correlations',
          value:
            `Turbo vs ranked: **${fmtCorr(rankCorr)}**\n` +
            `Confidence-weighted: **${fmtCorr(weightedCorr)}**\n` +
            `Rank-order/Spearman: **${fmtCorr(rankOrderCorr)}**\n` +
            `High-quality only (${highQualityRows.length}): **${fmtCorr(highQualityCorr)}**\n` +
            `Turbo score vs Turbo rank: **${fmtCorr(scoreCorr)}**`,
          inline: false,
        },
        {
          name: 'Gap / Error',
          value:
            `Average gap: **${fmtMmr(avgGap)}** | median: **${fmtMmr(medianGap)}**\n` +
            `MAE: **${Math.round(mae)} MMR** | RMSE: **${Math.round(rmse)} MMR**\n` +
            (fit ? `Fit: **Turbo ~= ${fit.slope.toFixed(2)} x Ranked ${fit.intercept >= 0 ? '+' : '-'} ${Math.abs(Math.round(fit.intercept))}** | R² **${fit.r2.toFixed(2)}**` : 'Fit: n/a'),
          inline: false,
        },
        { name: 'Error by Range', value: rangeNote, inline: false },
        { name: 'Estimator Health', value: healthLines.join('\n'), inline: false },
        { name: 'Bias by Ranked Bracket', value: bracketLines.join('\n'), inline: false },
        { name: 'Fit Interpretation', value: fitNote, inline: false },
        { name: 'Calibration Extremes', value: extremesLine, inline: true },
        { name: 'Trend vs Last Run', value: trendLine, inline: true },
        { name: 'Largest Gaps', value: fitLines(largestGaps, 'No large gaps found.'), inline: false },
        { name: 'Next Actions', value: fitLines(actionLines, 'No immediate study actions.'), inline: false },
        {
          name: 'Caveats',
          value: 'Visible medals can be stale/hidden, Immortal medals are compressed to one floor, ranked and Turbo measure different queues, and party contamination can still skew estimates.',
          inline: false,
        },
      )
      .setImage('attachment://turbo-study.png')
      .setTimestamp();

    await progress.edit({ content: null, embeds: [embed], files: [scatterAttachment, residualAttachment, csvAttachment] });
  } catch (error) {
    logger.error('Error in turbo study command:', error);
    await message.reply('An error occurred while building the Turbo study. Please try again later.');
  }
}
