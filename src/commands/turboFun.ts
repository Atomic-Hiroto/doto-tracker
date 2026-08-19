import { EmbedBuilder, Message } from 'discord.js';
import { turboRankService, rankTierToMedal } from '../services/turboRankService';
import { TurboRankEstimate, TurboRankPlayerData } from '../models/TurboRank';
import { TurboStatsService } from '../services/turboStatsService';
import { UserDataService } from '../services/userDataService';
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

function fmtPct(wins: number, total: number): string {
  return total > 0 ? `${Math.round((wins / total) * 100)}%` : 'n/a';
}

function archetype(e: TurboRankEstimate): string {
  if (e.partyFallback || e.confidence < 30 || e.soloSampleSize < 5) return 'Unproven';
  if ((e.rankedTier ?? 0) >= 80 || e.lean == null) return 'Verified Calibre';
  if (e.lean >= 800 && e.soloSampleSize < 20) return 'Smurf Suspect';
  if (e.lean >= 600) return 'Turbo God';
  if (e.lean >= 250) return 'Overperformer';
  if (e.lean <= -600) return 'Turbo Feeder';
  if (e.lean <= -250) return 'Underperformer';
  return 'Ranked Andy';
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

async function resolvePlayer(message: Message, query: string, userDataService: UserDataService): Promise<TurboRankPlayerData | null> {
  const mention = query.match(/^<@!?(\d+)>$/);
  if (mention) {
    const user = userDataService.getUserByDiscordId(mention[1]);
    return user ? turboRankService.getPlayerBySteamId(user.steamId) ?? null : null;
  }
  if (/^\d{4,}$/.test(query)) return turboRankService.getPlayerBySteamId(query) ?? null;

  const registered = userDataService.getAllUsers().find(u => u.discordId === query);
  if (registered) return turboRankService.getPlayerBySteamId(registered.steamId) ?? null;
  return turboRankService.getPlayerByName(query) ?? null;
}

function splitVsArgs(args: string[]): [string, string] | null {
  const raw = args.join(' ').trim();
  const vs = raw.match(/^(.+?)\s+(?:vs|v|versus)\s+(.+)$/i);
  if (vs) return [vs[1].trim(), vs[2].trim()];
  if (args.length >= 2) return [args[0], args.slice(1).join(' ')];
  return null;
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

export async function turboVs(message: Message, args: string[], userDataService: UserDataService, turboStatsService: TurboStatsService) {
  try {
    const mentions = [...message.mentions.users.values()];
    const pair: [string, string] | null = mentions.length >= 2
      ? [`<@${mentions[0].id}>`, `<@${mentions[1].id}>`]
      : splitVsArgs(args);
    if (!pair) return message.reply('Usage: `+turbovs @player1 @player2` or `+turbovs name1 vs name2`');

    const a = await resolvePlayer(message, pair[0], userDataService);
    const b = await resolvePlayer(message, pair[1], userDataService);
    if (!a?.estimate || !b?.estimate) return message.reply('Could not find calibrated Turbo estimates for both players.');

    const an = a.steamName ?? pair[0];
    const bn = b.steamName ?? pair[1];
    const aStats = a.discordId ? turboStatsService.getPlayerStats(a.discordId) : undefined;
    const bStats = b.discordId ? turboStatsService.getPlayerStats(b.discordId) : undefined;
    const aGames = aStats ? aStats.wins + aStats.losses : 0;
    const bGames = bStats ? bStats.wins + bStats.losses : 0;
    const mmrGap = a.estimate.estimatedMMR - b.estimate.estimatedMMR;
    const rankedGap = (a.estimate.rankedMMR ?? 0) && (b.estimate.rankedMMR ?? 0)
      ? (a.estimate.rankedMMR! - b.estimate.rankedMMR!)
      : null;

    const winner = Math.abs(mmrGap) < 100 ? 'Too close to call' : mmrGap > 0 ? an : bn;
    const embed = new EmbedBuilder()
      .setColor('#06b6d4')
      .setTitle(`⚔️ Turbo VS — ${an} vs ${bn}`)
      .setDescription(`Verdict: **${winner}**${winner === 'Too close to call' ? '' : ' has the stronger hidden Turbo estimate.'}`)
      .addFields(
        {
          name: an,
          value:
            `Turbo: **${a.estimate.medal}** (~${a.estimate.estimatedMMR})\n` +
            `Ranked: **${a.estimate.rankedTier ? rankTierToMedal(a.estimate.rankedTier) : 'unknown'}**\n` +
            `Lean: **${fmtLean(a.estimate.lean)}** | ${archetype(a.estimate)}\n` +
            `Tracked WR: **${aStats ? fmtPct(aStats.wins, aGames) : 'n/a'}** (${aGames} games)`,
          inline: true,
        },
        {
          name: bn,
          value:
            `Turbo: **${b.estimate.medal}** (~${b.estimate.estimatedMMR})\n` +
            `Ranked: **${b.estimate.rankedTier ? rankTierToMedal(b.estimate.rankedTier) : 'unknown'}**\n` +
            `Lean: **${fmtLean(b.estimate.lean)}** | ${archetype(b.estimate)}\n` +
            `Tracked WR: **${bStats ? fmtPct(bStats.wins, bGames) : 'n/a'}** (${bGames} games)`,
          inline: true,
        },
        {
          name: 'Gap',
          value:
            `Turbo gap: **${fmtLean(mmrGap)}** ${mmrGap >= 0 ? an : bn}\n` +
            `Ranked gap: **${rankedGap == null ? 'n/a' : fmtLean(rankedGap)}**\n` +
            'Win rate is local tracked Turbo only; rank estimate is lobby-calibration based.',
          inline: false,
        },
      )
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in turbovs:', error);
    await message.reply('Failed to build Turbo VS report.');
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

    if (rows.length === 0) return message.reply('Not enough calibration history yet. Run bulk recalibration over time, then `+turboclimb` will show movement.');

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
      .setDescription('Movement across saved calibration snapshots. This gets better every time `+turborank calibrateall` is run on different days.')
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

export async function turboSquad(message: Message, args: string[], userDataService: UserDataService, turboStatsService: TurboStatsService) {
  try {
    const targetQuery = message.mentions.users.first()
      ? `<@${message.mentions.users.first()!.id}>`
      : args.join(' ').trim();
    if (!targetQuery) return message.reply('Usage: `+turbosquad @player`');

    const player = await resolvePlayer(message, targetQuery, userDataService);
    if (!player?.discordId) return message.reply('Squad graph needs a registered/tracked Discord player.');

    const pairs = turboStatsService.getAllStats().pairings
      .filter(p => p.player1 === player.discordId || p.player2 === player.discordId)
      .map(p => ({ pair: p, otherId: p.player1 === player.discordId ? p.player2 : p.player1, games: p.wins + p.losses }))
      .sort((a, b) => b.games - a.games)
      .slice(0, 10);

    if (pairs.length === 0) return message.reply('No tracked same-team Turbo pairings found for that player yet.');

    const lines = await Promise.all(pairs.map(async ({ pair, otherId, games }) => {
      const user = await message.client.users.fetch(otherId).catch(() => null);
      const reg = userDataService.getUserByDiscordId(otherId);
      const estimate = reg ? turboRankService.getEstimateBySteamId(reg.steamId) : null;
      return `**${user?.username ?? otherId}** — ${games} games, ${fmtPct(pair.wins, games)} WR, ${turboStatsService.pairSortKey(pair).toFixed(1)}% floor` +
        (estimate ? `, ${estimate.medal}` : '');
    }));

    const name = player.steamName ?? targetQuery;
    const embed = new EmbedBuilder()
      .setColor('#14b8a6')
      .setTitle(`🕸️ Turbo Squad — ${name}`)
      .setDescription('Most-played tracked same-team partners from bot-observed Turbo matches.')
      .addFields({ name: 'Frequent Teammates', value: fitLines(lines, 'None'), inline: false })
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in turbosquad:', error);
    await message.reply('Failed to build Turbo squad report.');
  }
}
