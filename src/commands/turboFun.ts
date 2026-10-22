import { EmbedBuilder, Message } from 'discord.js';
import { turboRankService, rankTierToMedal } from '../services/turboRankService';
import { TurboRankEstimate } from '../models/TurboRank';
import { loadCalibrationHistory, detectRankChanges, summarizeValidation } from '../services/turboCalibrationLog';
import { logger } from '../services/loggerService';

type RankedEntry = {
  discordId: string;
  steamId: string;
  steamName?: string;
  discovered?: boolean;
  estimate: TurboRankEstimate;
};

function fitLines(lines: string[], emptyText: string, limit = 1000): string {
  if (lines.length === 0) return emptyText;
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const extra = lines[i].length + (out.length ? 1 : 0);
    if (used + extra > limit) {
      out.push(`...and ${lines.length - i} more.`);
      break;
    }
    out.push(lines[i]);
    used += extra;
  }
  return out.join('\n');
}

function fmtLean(v?: number | null): string {
  if (v == null) return 'n/a';
  return `${v >= 0 ? '+' : ''}${Math.round(v)} MMR`;
}

async function nameFor(message: Message, entry: RankedEntry): Promise<string> {
  if (entry.steamName) return entry.steamName;
  if (entry.discordId) {
    const user = await message.client.users.fetch(entry.discordId).catch(() => null);
    if (user) return user.username;
  }
  return `Steam ${entry.steamId}`;
}

function crewEntries(includeDiscovered = false): RankedEntry[] {
  return turboRankService.getAllEstimates().filter(e => includeDiscovered || !e.discovered);
}

export async function turboLean(message: Message, args: string[]) {
  try {
    const includeDiscovered = ['all', 'everyone', 'full'].includes(args[0]?.toLowerCase() ?? '');
    const rows = crewEntries(includeDiscovered).filter(e => e.estimate.lean != null && e.estimate.rankedTier);
    if (rows.length === 0) return message.reply('No players have both hidden Turbo estimates and visible ranked medals yet.');

    const named = await Promise.all(rows.map(async e => ({ ...e, name: await nameFor(message, e) })));
    const over = [...named].sort((a, b) => (b.estimate.lean ?? 0) - (a.estimate.lean ?? 0)).slice(0, 8);
    const under = [...named].sort((a, b) => (a.estimate.lean ?? 0) - (b.estimate.lean ?? 0)).slice(0, 8);
    const suspect = named
      .filter(e => (e.estimate.lean ?? 0) >= 700 && e.estimate.soloSampleSize < 25)
      .sort((a, b) => (b.estimate.lean ?? 0) - (a.estimate.lean ?? 0))
      .slice(0, 6);

    const line = (e: typeof named[number]) =>
      `**${e.name}** — ${fmtLean(e.estimate.lean)} (${e.estimate.medal} turbo vs ${rankTierToMedal(e.estimate.rankedTier)} ranked)`;

    const embed = new EmbedBuilder()
      .setColor('#22c55e')
      .setTitle('📈 Turbo Lean')
      .setDescription('Who plays above or below their visible ranked medal in Turbo. Positive means Turbo estimate is higher than ranked medal.')
      .addFields(
        { name: 'Overperformers', value: fitLines(over.map(line), 'None'), inline: false },
        { name: 'Underperformers', value: fitLines(under.map(line), 'None'), inline: false },
        { name: 'Smurf-Suspect Watch', value: fitLines(suspect.map(line), 'None'), inline: false },
      )
      .setFooter({ text: includeDiscovered ? 'Full dataset' : 'Crew/default dataset; use +turbolean all for discovered players too' })
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in turbolean:', error);
    await message.reply('Failed to build Turbo lean report.');
  }
}

export async function turboClimb(message: Message) {
  try {
    const history = loadCalibrationHistory();
    const byPlayer = new Map<string, typeof history>();
    for (const s of history) {
      if (!byPlayer.has(s.steamId)) byPlayer.set(s.steamId, []);
      byPlayer.get(s.steamId)!.push(s);
    }

    const rows = [...byPlayer.values()]
      .map(snaps => snaps.sort((a, b) => a.ts - b.ts))
      .filter(snaps => snaps.length >= 2)
      .map(snaps => {
        const first = snaps[0];
        const last = snaps[snaps.length - 1];
        return { name: last.steamName ?? first.steamName ?? last.steamId, first, last, delta: last.estimatedMMR - first.estimatedMMR };
      })
      .filter(r => Math.abs(r.delta) >= 25);

    if (rows.length === 0) return message.reply('Not enough calibration history yet. The nightly refresh adds a snapshot for everyone who played, so check back in a few days.');

    const climbers = rows
      .filter(r => r.delta > 0)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 8);
    const fallers = rows
      .filter(r => r.delta < 0)
      .sort((a, b) => a.delta - b.delta)
      .slice(0, 8);
    const line = (r: typeof rows[number]) => `**${r.name}** — ${fmtLean(r.delta)} (${r.first.medal} → ${r.last.medal})`;

    const embed = new EmbedBuilder()
      .setColor('#a855f7')
      .setTitle('⛰️ Turbo Climb')
      .setDescription('How each hidden Turbo rank has moved across saved calibrations. Everyone who played gets re-calibrated nightly, so this fills in on its own.')
      .addFields(
        { name: 'Biggest Climbers', value: fitLines(climbers.map(line), 'No positive movement yet.'), inline: false },
        { name: 'Biggest Drops', value: fitLines(fallers.map(line), 'No negative movement yet.'), inline: false },
      )
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in turboclimb:', error);
    await message.reply('Failed to build Turbo climb report.');
  }
}

export async function turboScorecard(message: Message) {
  try {
    const summary = summarizeValidation();
    const events = detectRankChanges()
      .sort((a, b) => Math.abs(a.errorMMR) - Math.abs(b.errorMMR))
      .slice(0, 8);

    if (!summary) {
      return message.reply('No ranked-medal movement has been observed in calibration history yet. This scorecard will populate after players rank up/down between recalibrations.');
    }

    const embed = new EmbedBuilder()
      .setColor('#0ea5e9')
      .setTitle('🔬 Turbo Estimator Scorecard')
      .setDescription('Checks whether older Turbo estimates predicted later visible ranked-medal movement.')
      .addFields(
        {
          name: 'Validation Summary',
          value:
            `Rank changes tracked: **${summary.events}** across **${summary.players}** players\n` +
            `Mean absolute error: **${summary.meanAbsError} MMR**\n` +
            `Mean signed error: **${fmtLean(summary.meanSignedError)}**`,
          inline: false,
        },
        {
          name: 'Closest Predictions',
          value: fitLines(events.map(e =>
            `**${e.steamName ?? e.steamId}** — predicted ~${e.predictedMMR}, moved to ${rankTierToMedal(e.toTier)} (${fmtLean(e.errorMMR)} error)`,
          ), 'None'),
          inline: false,
        },
      )
      .setTimestamp();
    await message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in turboscorecard:', error);
    await message.reply('Failed to build Turbo estimator scorecard.');
  }
}
