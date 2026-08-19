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
  // default, which meant the headline teammate board was the one dataset that cannot self-correct:
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
 * `+turbopairs hard [@user]` — the teammate board with the opposition each pair faced. The order is
 * plain win rate: enemy strength was measured against 502 scored crew games and predicts
 * nothing, so weighting by it only ever produced orders that could not be explained.
 */
async function rankAdjustedBoard(
  message: Message,
  turboStatsService: TurboStatsService,
  scope: TurboStatsScope,
  window: Window,
  targetId?: string
) {
  // A single player's teammates are a much smaller pool, so the bar comes down with it.
  const minGames = targetId ? 10 : 30;
  const minScored = targetId ? 8 : 20;
  const difficulty = turboRankService.getEnemyStrengthByMatch();
  const rows = turboStatsService.getDuoDifficultyProfiles(
    difficulty, 10, minGames, minScored, scope, window.sinceTimestamp, targetId
  );

  const target = targetId ? await message.client.users.fetch(targetId).catch(() => null) : null;
  if (!rows.length) {
    const who = target ? ` with **${target.username}**` : '';
    return message.reply(
      `No pair of teammates${who} has ${minGames}+ games together with at least ${minScored} of them rank-scored in the ${window.label} yet. `
      + 'Enemy ranks come from `+turborank calibrate`, so more calibrated players means more coverage.'
    );
  }

  const embed = new EmbedBuilder()
    .setColor('#f59e0b')
    .setTitle(target ? `🤝 Turbo Teammates vs Rank — ${target.username}` : '🤝 Turbo Teammates vs Rank')
    .setDescription(`**Ranked by win rate**, highest first · ${window.label} · min ${minGames} games together`)
    .setFooter({ text: 'Enemy rank is shown for context, not used in the ranking — in this crew\'s games it does not affect who wins.' })
    .setTimestamp();

  const entries: Array<{ name: string; value: string }> = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const label = target
        ? (await message.client.users.fetch(row.player1 === targetId ? row.player2 : row.player1)).username
        : (await Promise.all([
            message.client.users.fetch(row.player1),
            message.client.users.fetch(row.player2)
          ])).map(user => user.username).join(' + ');
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      const mmr = Math.round(row.medianEnemyMMR);
      entries.push({
        name: `${medal} ${label}`,
        value: `**${row.winRate.toFixed(1)}%** win rate · ${row.wins}W–${row.losses}L in ${row.games} games\n`
          + `Usually up against **${mmrToMedal(mmr).medal}** (${mmr} MMR)`
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

    if (adjusted) return rankAdjustedBoard(message, turboStatsService, scope, window);

    const pairings = turboStatsService.getPairingLeaderboard(10, minGames, scope, window.sinceTimestamp, useLegacy);
    if (pairings.length === 0) {
      const hint = scope === 'history'
        ? ' Ask the bot owner to run `+turbobackfill` first.'
        : scope === 'tracked'
          ? ' The live ledger only holds matches polled since the new system went in — try `+turbopairs 60` for the full picture.'
          : '';
      return message.reply(`No pair of teammates has ${minGames}+ ${scope} games together in the ${window.label} yet.${hint}`);
    }

    const embed = new EmbedBuilder()
      .setColor('#ff6b6b')
      .setTitle('🤝 Best Turbo Teammates')
      .setDescription(
        `Win rate when you're on the same team · **${window.label}** · min ${minGames} games`
        + (useLegacy ? '\n⚠️ Legacy snapshot: no match-id dedupe, so these counts are unreliable. Prefer `+turbopairs 60`.' : '')
      )
      .setFooter({ text: 'Any game on the same team counts, solo queue or full stack. `+turbopairs hard` adds the ranks you played against.' })
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
    const { scope, window, useLegacy, adjusted } = parseOptions(args);

    if (adjusted) return rankAdjustedBoard(message, turboStatsService, scope, window, target.id);
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
      return message.reply(`Nobody has 5+ ${scope} games on the same team as **${target.username}** in the ${window.label} yet.${hint}`);
    }

    const embed = new EmbedBuilder()
      .setColor('#4ecdc4')
      .setTitle(`🤝 Turbo Teammates — ${target.username}`)
      .setDescription(
        `Win rate when you're on the same team · **${window.label}** · min 5 games`
        + (useLegacy ? '\n⚠️ Legacy snapshot: no match-id dedupe, so these counts are unreliable.' : '')
      )
      .setFooter({ text: 'Any game on the same team counts, solo queue or full stack.' })
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
        logger.warn('Could not fetch turbo teammate:', error);
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
