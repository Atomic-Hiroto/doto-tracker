import { AttachmentBuilder, EmbedBuilder, Message } from 'discord.js';
import { turboRankService, rankTierToMMR, rankTierToMedal } from '../services/turboRankService';
import { TurboStatsService } from '../services/turboStatsService';
import { opendotaClient } from '../services/apiClient';
import { renderTurboStudyScatter } from '../services/chartService';
import { logger } from '../services/loggerService';

interface StudyRow {
  discordId: string;
  steamId: string;
  name: string;
  realRankTier: number;
  realMMR: number;
  turboMMR: number;
  turboMedal: string;
  turboConfidence: number;
  turboScore?: number;
}

function pearson(rows: StudyRow[], x: (r: StudyRow) => number | undefined, y: (r: StudyRow) => number | undefined): number | null {
  const points = rows
    .map((r) => ({ x: x(r), y: y(r) }))
    .filter((p): p is { x: number; y: number } => Number.isFinite(p.x) && Number.isFinite(p.y));
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

function fmtCorr(value: number | null): string {
  if (value == null) return 'n/a';
  const strength = Math.abs(value) >= 0.8 ? 'strong'
    : Math.abs(value) >= 0.5 ? 'moderate'
      : Math.abs(value) >= 0.25 ? 'weak'
        : 'very weak';
  return `${value.toFixed(2)} (${strength})`;
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

export async function turboStudy(message: Message, turboStatsService: TurboStatsService) {
  try {
    const estimates = turboRankService.getAllEstimates()
      .filter((entry) => entry.discordId && entry.estimate.confidence >= 30);

    if (estimates.length < 3) {
      return message.reply('Need at least 3 registered players with calibrated `+turborank` estimates to run a study.');
    }

    const progress = await message.reply('📊 Building Turbo study... fetching visible ranked medals for calibrated players.');
    const rows: StudyRow[] = [];

    for (const entry of estimates) {
      const visible = await fetchVisibleRankMMR(entry.steamId);
      if (!visible) continue;

      const user = await message.client.users.fetch(entry.discordId).catch(() => null);
      const stats = turboStatsService.getPlayerStats(entry.discordId);
      rows.push({
        discordId: entry.discordId,
        steamId: entry.steamId,
        name: user?.username ?? entry.steamName ?? entry.steamId,
        realRankTier: visible.rankTier,
        realMMR: visible.mmr,
        turboMMR: entry.estimate.estimatedMMR,
        turboMedal: entry.estimate.medal,
        turboConfidence: entry.estimate.confidence,
        turboScore: stats?.rating,
      });
    }

    if (rows.length < 3) {
      return progress.edit('Not enough calibrated players also have a visible ranked medal. Need at least 3 data points.');
    }

    const rankCorr = pearson(rows, (r) => r.realMMR, (r) => r.turboMMR);
    const scoreCorr = pearson(rows, (r) => r.turboScore, (r) => r.turboMMR);
    const avgGap = rows.reduce((s, r) => s + (r.turboMMR - r.realMMR), 0) / rows.length;
    const outliers = [...rows]
      .sort((a, b) => Math.abs(b.turboMMR - b.realMMR) - Math.abs(a.turboMMR - a.realMMR))
      .slice(0, 5)
      .map((r) => {
        const gap = r.turboMMR - r.realMMR;
        return `**${r.name}**: ${r.turboMedal} turbo vs ${rankTierToMedal(r.realRankTier)} ranked (${gap >= 0 ? '+' : ''}${Math.round(gap)} MMR)`;
      });

    const chart = renderTurboStudyScatter(
      rows.map((r) => ({ label: r.name, x: r.realMMR, y: r.turboMMR, confidence: r.turboConfidence })),
      {
        title: 'Hidden Turbo Rank vs Visible Ranked Medal',
        xLabel: 'Visible ranked medal estimate',
        yLabel: 'Hidden Turbo estimate',
      },
    );
    const attachment = new AttachmentBuilder(chart, { name: 'turbo-study.png' });

    const embed = new EmbedBuilder()
      .setColor('#7c3aed')
      .setTitle('📊 Turbo Study')
      .setDescription('Correlation study across calibrated players with visible ranked medals.')
      .addFields(
        { name: 'Sample', value: `${rows.length} players`, inline: true },
        { name: 'Turbo vs Ranked', value: fmtCorr(rankCorr), inline: true },
        { name: 'Turbo Score vs Turbo Rank', value: fmtCorr(scoreCorr), inline: true },
        { name: 'Average Gap', value: `${avgGap >= 0 ? '+' : ''}${Math.round(avgGap)} MMR (turbo estimate minus ranked medal estimate)`, inline: false },
        { name: 'Largest Gaps', value: outliers.join('\n'), inline: false },
        {
          name: 'Caveats',
          value: 'Small community sample, visible medals can be stale/hidden, Immortal medals are compressed, and party-heavy Turbo histories can skew estimates.',
          inline: false,
        },
      )
      .setImage('attachment://turbo-study.png')
      .setTimestamp();

    await progress.edit({ content: null, embeds: [embed], files: [attachment] });
  } catch (error) {
    logger.error('Error in turbo study command:', error);
    await message.reply('An error occurred while building the Turbo study. Please try again later.');
  }
}
