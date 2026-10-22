import { EmbedBuilder, Message } from 'discord.js';
import { TurboStatsScope } from '../models/TurboStats';
import { logger } from '../services/loggerService';
import { TurboStatsService } from '../services/turboStatsService';
import { turboRankService, mmrToMedal, mmrToEmoji } from '../services/turboRankService';

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
  const words = args.map(arg => arg.toLowerCase());
  const adjusted = words.some(word => ['hard', 'adjusted', 'difficulty'].includes(word));
  // `games` (also `+turbosquad`) orders by games together instead of win rate: who you actually play with.
  const byGames = words.some(word => ['games', 'matches', 'played', 'most', 'squad'].includes(word));
  return { scope: parseScope(args), window: parseWindow(args), minGames: 30, adjusted, byGames };
}

type Window = { sinceTimestamp?: number; label: string };

// From the 2026-10-17 forward test: duo win rates spread no wider than luck, and the five best duos
// of the older half of the ledger went from 66% to 48% in the newer half.
const LUCK_NOTE = '🍀 **Mostly luck.** ± is how far a lucky or unlucky run alone could push it, and the top 5 duos '
  + 'we checked earlier dropped to ~48% afterwards. A partner changes how tough your enemies are, not your odds: see `+turbopull`.';

/** "61.2% ±12" win rate, where ± is the 95% range binomial luck allows at that many games. */
export function winRateText(wins: number, games: number) {
  const rate = wins / games;
  return `**${(rate * 100).toFixed(1)}%** ±${Math.round(196 * Math.sqrt(rate * (1 - rate) / games))}`;
}

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
  const difficulty = turboRankService.getEnemyStrengthByMatch({ registeredOnly: true, minVisibleEnemies: 2 });
  const rows = turboStatsService.getDuoDifficultyProfiles(
    difficulty, 10, minGames, minScored, scope, window.sinceTimestamp, targetId
  );

  const target = targetId ? await message.client.users.fetch(targetId).catch(() => null) : null;
  if (!rows.length) {
    const who = target ? ` with **${target.username}**` : '';
    return message.reply(
      `No pair of teammates${who} has ${minGames}+ games together with at least ${minScored} of them rank-scored in the ${window.label} yet. `
      + 'Enemy ranks come from the medals visible in each game, so older games without them are skipped.'
    );
  }

  const embed = new EmbedBuilder()
    .setColor('#f59e0b')
    .setTitle(target ? `🤝 Turbo Teammates vs Rank — ${target.username}` : '🤝 Turbo Teammates vs Rank')
    .setDescription(`**Ranked by win rate**, highest first · ${window.label} · min ${minGames} games together\n${LUCK_NOTE}`)
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
        value: `${winRateText(row.wins, row.wins + row.losses)} win rate · ${row.wins}W–${row.losses}L in ${row.games} games\n`
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
    const { scope, window, minGames, adjusted, byGames } = parseOptions(args);

    if (adjusted) return rankAdjustedBoard(message, turboStatsService, scope, window);

    const pairings = byGames
      ? turboStatsService.getPairingLeaderboard(Infinity, minGames, scope, window.sinceTimestamp)
        .sort((a, b) => (b.wins + b.losses) - (a.wins + a.losses))
        .slice(0, 10)
      : turboStatsService.getPairingLeaderboard(10, minGames, scope, window.sinceTimestamp);
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
      .setTitle(byGames ? '🎮 Most-Played Turbo Duos' : '🍀 Luckiest Turbo Duos')
      .setDescription(
        `${byGames ? 'Games on the same team' : 'Win rate when you\'re on the same team'} · **${window.label}** · min ${minGames} games\n${LUCK_NOTE}`
      )
      .setFooter({ text: 'Any game on the same team counts, solo queue or full stack · +turbopairs hard adds enemy ranks · +turbopairs games sorts by games together' })
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
          value: `${winRateText(pairing.wins, games)} win rate · ${pairing.wins}W–${pairing.losses}L in ${games} games`
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
    const { scope, window, adjusted, byGames } = parseOptions(args);

    if (adjusted) return rankAdjustedBoard(message, turboStatsService, scope, window, target.id);
    const games = (pair: { wins: number; losses: number }) => pair.wins + pair.losses;
    const pairings = turboStatsService.getPairingsForPlayer(target.id, scope, window.sinceTimestamp)
      .filter(pair => games(pair) >= 5)
      .sort((a, b) => byGames
        ? games(b) - games(a)
        : (b.wins / games(b)) - (a.wins / games(a)) || games(b) - games(a))
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
      .setTitle(byGames ? `🎮 Most-Played Teammates — ${target.username}` : `🍀 Luckiest Teammates — ${target.username}`)
      .setDescription(
        `${byGames ? 'Games on the same team' : 'Win rate when you\'re on the same team'} · **${window.label}** · min 5 games\n${LUCK_NOTE}`
      )
      .setFooter({ text: `Any game on the same team counts, solo queue or full stack · ${byGames ? '+turbopairs me sorts by win rate' : '+turbopairs me games sorts by games together'}` })
      .setTimestamp();
    const entries: Array<{ name: string; value: string }> = [];
    for (let i = 0; i < pairings.length; i++) {
      const pairing = pairings[i];
      try {
        const partnerId = pairing.player1 === target.id ? pairing.player2 : pairing.player1;
        const partner = await message.client.users.fetch(partnerId);
        const played = games(pairing);
        const hidden = turboRankService.getEstimate(partnerId);
        entries.push({
          name: `${i + 1}. ${partner.username}${hidden ? ` · ${mmrToEmoji(hidden.estimatedMMR)} ${hidden.medal}` : ''}`,
          value: `${winRateText(pairing.wins, played)} win rate · ${pairing.wins}W–${pairing.losses}L in ${played} games`
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
