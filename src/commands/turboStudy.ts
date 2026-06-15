import { AttachmentBuilder, EmbedBuilder, Message } from 'discord.js';
import { turboRankService, rankTierToMMR, rankTierToMedal } from '../services/turboRankService';
import { TurboRankEstimate } from '../models/TurboRank';
import { TurboStatsService } from '../services/turboStatsService';
import { UserDataService } from '../services/userDataService';
import { opendotaClient } from '../services/apiClient';
import { renderTurboStudyScatter } from '../services/chartService';
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

function daysSince(ms: number): number {
  return Math.floor((Date.now() - ms) / 86400000);
}

async function fetchVisibleRankMMR(steamId: string): Promise<{ rankTier: number; mmr: number } | null> {
  try {
    const response = await opendotaClient.get<{ rank_tier?: number }>(`/players/${steamId}`);
    const rankTier = response.data?.rank_tier;
    const mmr = rankTier ? rankTierToMMR(rankTier) : null;
    return rankTier && mmr != null ? { rankTier, mmr } : null;
  } catch (error) {
    logger.warn(`Turbo study profile fetch failed for ${steamId}:`, error);
    return null;
  }
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

      const visible = await fetchVisibleRankMMR(entry.steamId);
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

    const chart = renderTurboStudyScatter(
      rows.map((r) => ({
        label: r.name,
        x: r.visibleMMR,
        y: r.estimate.estimatedMMR,
        confidence: r.estimate.confidence,
        partyFallback: r.estimate.partyFallback,
        stale: daysSince(r.estimate.lastUpdated) > 30,
      })),
      {
        title: 'Hidden Turbo Rank vs Visible Ranked Medal',
        xLabel: 'Visible ranked medal estimate',
        yLabel: 'Hidden Turbo estimate',
      },
    );
    const chartAttachment = new AttachmentBuilder(chart, { name: 'turbo-study.png' });
    const csvAttachment = new AttachmentBuilder(toCsv(candidates), { name: 'turbo-study.csv' });

    const embed = new EmbedBuilder()
      .setColor('#7c3aed')
      .setTitle('📊 Turbo Study')
      .setDescription('Correlation and health report for hidden Turbo rank estimates. CSV export attached for deeper review.')
      .addFields(
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
        { name: 'Estimator Health', value: healthLines.join('\n'), inline: false },
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

    await progress.edit({ content: null, embeds: [embed], files: [chartAttachment, csvAttachment] });
  } catch (error) {
    logger.error('Error in turbo study command:', error);
    await message.reply('An error occurred while building the Turbo study. Please try again later.');
  }
}
