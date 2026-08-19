import { EmbedBuilder, Message } from 'discord.js';
import { TurboStatsScope } from '../models/TurboStats';
import { logger } from '../services/loggerService';
import { TurboStatsService } from '../services/turboStatsService';
import { turboRankService, mmrToMedal } from '../services/turboRankService';

function parseScope(args: string[]): TurboStatsScope {
  const words = args.map(arg => arg.toLowerCase());
  if (words.some(word => word === 'tracked' || word === 'live')) return 'tracked';
  if (words.some(word => word === 'history' || word === 'historical' || word === 'past')) return 'history';
  return 'all';
}

function parseWindow(args: string[]) {
  const allTime = args.some(arg => ['alltime', 'all-time', 'forever'].includes(arg.toLowerCase()));
  if (allTime) return { days: null, sinceTimestamp: undefined, label: 'all imported history' };
  const requested = args.map(arg => Number.parseInt(arg, 10)).find(value => Number.isFinite(value));
  const days = Math.max(7, Math.min(1825, requested || 60));
  return {
    days,
    sinceTimestamp: Math.floor(Date.now() / 1000) - days * 86400,
    label: `last ${days} days`
  };
}

function parseOptions(args: string[]) {
  // `legacy` is the only way to reach the pre-backfill snapshot. It used to be the no-argument
  // default, which meant the headline duo board was the one dataset that cannot self-correct:
  // it counts no match ids, so its totals sit between 0.27x and 1.99x of the deduplicated ledger.
  const useLegacy = args.some(arg => arg.toLowerCase() === 'legacy');
  const adjusted = args.some(arg => ['hard', 'adjusted', 'difficulty'].includes(arg.toLowerCase()));
  const scope = useLegacy ? 'tracked' as TurboStatsScope : parseScope(args);
  const window = useLegacy
    ? { days: null, sinceTimestamp: undefined, label: 'legacy snapshot' }
    : parseWindow(args);
  return { scope, window, minGames: useLegacy ? 10 : 30, useLegacy, adjusted };
}

type Window = { sinceTimestamp?: number; label: string };

/**
 * `+turbopairs hard` — the same question, but a win against stronger enemies is worth more.
 * Difficulty comes from the rank service's per-match observations, which cover roughly 42% of
 * recent matches, so this board reports how much of each duo's record it could actually weigh.
 */
async function rankAdjustedBoard(
  message: Message,
  turboStatsService: TurboStatsService,
  scope: TurboStatsScope,
  window: Window,
  minGames: number
) {
  const difficulty = turboRankService.getEnemyStrengthByMatch();
  const rows = turboStatsService.getRankAdjustedPairings(difficulty, 10, minGames, 20, scope, window.sinceTimestamp);
  if (!rows.length) {
    return message.reply(
      `No turbo duo has ${minGames}+ games together with at least 20 of them rank-scored in the ${window.label} yet. `
      + 'Lobby strength comes from `+turborank calibrate`, so more calibrated players means more coverage.'
    );
  }

  const embed = new EmbedBuilder()
    .setColor('#f59e0b')
    .setTitle('🤝 Best Turbo Duos — difficulty adjusted')
    .setDescription(`Wins weighted by how strong the enemies were · **${window.label}** · min ${minGames} games`)
    .setFooter({ text: 'Matchmaking averages a party, so lobby strength varies far less for duos than for solo players — expect small shifts.' })
    .setTimestamp();

  const entries: Array<{ name: string; value: string }> = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const [user1, user2] = await Promise.all([
        message.client.users.fetch(row.player1),
        message.client.users.fetch(row.player2)
      ]);
      const delta = row.adjustedWinRate - row.rawWinRate;
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      entries.push({
        name: `${medal} ${user1.username} + ${user2.username}`,
        value: `**${row.adjustedWinRate.toFixed(1)}%** adjusted · ${row.rawWinRate.toFixed(1)}% unweighted (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp)\n`
          + `Typical enemies ${mmrToMedal(Math.round(row.meanEnemyMMR)).medal} · scored on ${row.rankedGames} of ${row.games} games (${row.overallWinRate.toFixed(1)}% overall)`
      });
    } catch (error) {
      logger.warn(`Could not fetch users for pairing ${row.player1} + ${row.player2}:`, error);
    }
  }
  if (!entries.length) return message.reply('Could not display pairing leaderboard due to user fetch errors.');
  embed.addFields(entries);
  return message.reply({ embeds: [embed] });
}

export async function turboPairings(message: Message, turboStatsService: TurboStatsService, args: string[] = []) {
  try {
    const { scope, window, minGames, useLegacy, adjusted } = parseOptions(args);

    if (adjusted) return rankAdjustedBoard(message, turboStatsService, scope, window, minGames);

    const pairings = turboStatsService.getPairingLeaderboard(10, minGames, scope, window.sinceTimestamp, useLegacy);
    if (pairings.length === 0) {
      const hint = scope === 'history'
        ? ' Ask the bot owner to run `+turbobackfill` first.'
        : scope === 'tracked'
          ? ' The live ledger only holds matches polled since the new system went in — try `+turbopairs 60` for the full picture.'
          : '';
      return message.reply(`No turbo duo has ${minGames}+ ${scope} games together in the ${window.label} yet.${hint}`);
    }

    const embed = new EmbedBuilder()
      .setColor('#ff6b6b')
      .setTitle('🤝 Best Turbo Duos')
      .setDescription(
        `Best win rate together · **${window.label}** · min ${minGames} games`
        + (useLegacy ? '\n⚠️ Legacy snapshot: no match-id dedupe, so these counts are unreliable. Prefer `+turbopairs 60`.' : '')
      )
      .setFooter({ text: 'Straight win rate. `+turbopairs hard` weights wins by how strong the lobby was.' })
      .setTimestamp();

    const entries: Array<{ name: string; value: string }> = [];
    for (let i = 0; i < pairings.length; i++) {
      const pairing = pairings[i];
      try {
        const [user1, user2] = await Promise.all([
          message.client.users.fetch(pairing.player1),
          message.client.users.fetch(pairing.player2)
        ]);
        const games = pairing.wins + pairing.losses;
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        entries.push({
          name: `${medal} ${user1.username} + ${user2.username}`,
          value: `**${(pairing.wins / games * 100).toFixed(1)}%** win rate · ${pairing.wins}W–${pairing.losses}L in ${games} games`
        });
      } catch (error) {
        logger.warn(`Could not fetch users for pairing ${pairing.player1} + ${pairing.player2}:`, error);
      }
    }
    if (!entries.length) return message.reply('Could not display pairing leaderboard due to user fetch errors.');
    embed.addFields(entries);
    return message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in turbo pairings command:', error);
    return message.reply('An error occurred while fetching the turbo pairings leaderboard. Please try again later.');
  }
}

export async function myTurboPairings(message: Message, turboStatsService: TurboStatsService, args: string[] = []) {
  try {
    const target = message.mentions.users.first() ?? message.author;
    const { scope, window, useLegacy } = parseOptions(args);
    const pairings = turboStatsService.getPairingsForPlayer(target.id, scope, window.sinceTimestamp, useLegacy)
      .filter(pair => pair.wins + pair.losses >= 5)
      .sort((a, b) => (b.wins / (b.wins + b.losses)) - (a.wins / (a.wins + a.losses)) || (b.wins + b.losses) - (a.wins + a.losses))
      .slice(0, 10);
    if (!pairings.length) {
      const hint = scope === 'history'
        ? ' Ask the bot owner to run `+turbobackfill` first.'
        : scope === 'tracked'
          ? ' The live ledger only holds matches polled since the new system went in — try `+turbopairs 60` for the full picture.'
          : '';
      return message.reply(`No duo has 5+ ${scope} games with **${target.username}** in the ${window.label} yet.${hint}`);
    }

    const embed = new EmbedBuilder()
      .setColor('#4ecdc4')
      .setTitle(`🤝 Turbo Duos — ${target.username}`)
      .setDescription(
        `Best win rate alongside each partner · **${window.label}** · min 5 games`
        + (useLegacy ? '\n⚠️ Legacy snapshot: no match-id dedupe, so these counts are unreliable.' : '')
      )
      .setFooter({ text: 'Straight win rate, minimum 5 games together.' })
      .setTimestamp();
    const entries: Array<{ name: string; value: string }> = [];
    for (let i = 0; i < pairings.length; i++) {
      const pairing = pairings[i];
      try {
        const partnerId = pairing.player1 === target.id ? pairing.player2 : pairing.player1;
        const partner = await message.client.users.fetch(partnerId);
        const games = pairing.wins + pairing.losses;
        entries.push({
          name: `${i + 1}. ${partner.username}`,
          value: `**${(pairing.wins / games * 100).toFixed(1)}%** win rate · ${pairing.wins}W–${pairing.losses}L in ${games} games`
        });
      } catch (error) {
        logger.warn('Could not fetch turbo duo partner:', error);
      }
    }
    if (!entries.length) return message.reply('Could not display pairing stats due to user fetch errors.');
    embed.addFields(entries);
    return message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in personal turbo pairings command:', error);
    return message.reply('An error occurred while fetching turbo pairing stats. Please try again later.');
  }
}
