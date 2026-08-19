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
 * `+turbopairs hard` — the duo board annotated with the strength of the opposition, plus the
 * evidence for why nothing is adjusted. The point is that the reader can check the reasoning
 * rather than trust a single opaque number.
 */
async function rankAdjustedBoard(
  message: Message,
  turboStatsService: TurboStatsService,
  scope: TurboStatsScope,
  window: Window,
  minGames: number
) {
  const difficulty = turboRankService.getEnemyStrengthByMatch();
  const { profiles, quintiles, scoredGames } = turboStatsService.getDuoDifficultyProfiles(
    difficulty, 10, minGames, 20, scope, window.sinceTimestamp
  );
  if (!profiles.length) {
    return message.reply(
      `No turbo duo has ${minGames}+ games together with at least 20 of them rank-scored in the ${window.label} yet. `
      + 'Enemy ranks come from `+turborank calibrate`, so more calibrated players means more coverage.'
    );
  }

  const embed = new EmbedBuilder()
    .setColor('#f59e0b')
    .setTitle('🤝 Turbo Duos — who you actually beat')
    .setDescription(`Ranked by win rate · **${window.label}** · min ${minGames} games, 20+ with known enemy ranks`)
    .setTimestamp();

  if (quintiles.length === 5) {
    const labels = ['Weakest  ', '         ', '  Middle ', '         ', 'Strongest'];
    const table = quintiles
      .map((q, i) => `${labels[i]}  ${Math.round(q.meanEnemyMMR).toString().padStart(4)} MMR  →  ${q.winRate.toFixed(1)}% won`)
      .join('\n');
    const spread = Math.max(...quintiles.map(q => q.winRate)) - Math.min(...quintiles.map(q => q.winRate));
    embed.addFields({
      name: '❓ Do stronger enemies actually cost you games?',
      value: '```\n' + table + '\n```'
        + `Across **${scoredGames}** scored games there is no pattern — the best and worst quintiles differ by `
        + `${spread.toFixed(1)}pp with no trend, because matchmaking puts you against your own level. `
        + 'So nothing here is weighted or adjusted: the order below is plain win rate, and enemy strength is context.',
      inline: false
    });
  }

  for (let i = 0; i < profiles.length; i++) {
    const row = profiles[i];
    try {
      const [user1, user2] = await Promise.all([
        message.client.users.fetch(row.player1),
        message.client.users.fetch(row.player2)
      ]);
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      const harder = row.harderHalfWinRate === null ? 'n/a' : `${row.harderHalfWinRate.toFixed(0)}% (${row.harderHalfGames}g)`;
      const easier = row.easierHalfWinRate === null ? 'n/a' : `${row.easierHalfWinRate.toFixed(0)}% (${row.easierHalfGames}g)`;
      embed.addFields({
        name: `${medal} ${user1.username} + ${user2.username}`,
        value: `**${row.winRate.toFixed(1)}%** · ${row.wins}W–${row.losses}L in ${row.games} games\n`
          + `Median enemy **${Math.round(row.medianEnemyMMR)} MMR** (${mmrToMedal(Math.round(row.medianEnemyMMR)).medal}) · `
          + `vs their stronger half ${harder} · vs their weaker half ${easier}\n`
          + `*enemy ranks known for ${row.scoredGames} of ${row.games} games*`,
        inline: false
      });
    } catch (error) {
      logger.warn(`Could not fetch users for pairing ${row.player1} + ${row.player2}:`, error);
    }
  }
  if (embed.data.fields && embed.data.fields.length <= 1) {
    return message.reply('Could not display pairing leaderboard due to user fetch errors.');
  }
  embed.setFooter({ text: 'Stronger/weaker halves are split at each duo\'s own median enemy MMR, so they are self-relative.' });
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
