import { EmbedBuilder, Message } from 'discord.js';
import { TurboStatsScope } from '../models/TurboStats';
import { logger } from '../services/loggerService';
import { TurboStatsService } from '../services/turboStatsService';

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
  const scope = useLegacy ? 'tracked' as TurboStatsScope : parseScope(args);
  const window = useLegacy
    ? { days: null, sinceTimestamp: undefined, label: 'legacy snapshot' }
    : parseWindow(args);
  return { scope, window, minGames: useLegacy ? 10 : 20, useLegacy };
}

function evidence(pairing: { wins: number; losses: number; liveGames?: number; verifiedPartyGames?: number }) {
  const games = pairing.wins + pairing.losses;
  const parts: string[] = [];
  // liveGames and historicalGames both count a match seen by polling *and* by backfill, so they
  // overlap rather than partition. Report the overlap as what it is instead of adding up past
  // the number of games actually played.
  if (pairing.liveGames) parts.push(`${pairing.liveGames} seen live`);
  const unconfirmed = games - (pairing.verifiedPartyGames || 0);
  if (unconfirmed > 0) parts.push(`${unconfirmed} without a party id`);
  return parts.length ? ` · ${parts.join(', ')}` : '';
}

function evidenceStrength(games: number) {
  if (games >= 100) return 'strong';
  if (games >= 50) return 'solid';
  if (games >= 20) return 'developing';
  return 'provisional';
}

export async function turboPairings(message: Message, turboStatsService: TurboStatsService, args: string[] = []) {
  try {
    const { scope, window, minGames, useLegacy } = parseOptions(args);
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
        `Ranked by evidenced win rate · **${window.label}** · scope: **${scope}** · min ${minGames} games`
        + (useLegacy ? '\n⚠️ Legacy snapshot: no match-id dedupe, so these counts are unreliable. Prefer `+turbopairs 60`.' : '')
      )
      .setFooter({ text: 'Ranked by the low end of a Beta(10,10) estimate, so a thin hot streak cannot outrank a proven duo.' })
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
          value: `Evidenced floor **${turboStatsService.pairSortKey(pairing).toFixed(1)}%** · projected ${pairing.rating.toFixed(1)}% · observed ${(pairing.wins / games * 100).toFixed(1)}% (${pairing.wins}–${pairing.losses})\nEvidence: ${evidenceStrength(games)} · ${games} games${evidence(pairing)}`
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
      .sort((a, b) => turboStatsService.pairSortKey(b) - turboStatsService.pairSortKey(a))
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
        `Best same-team partnerships by evidenced win rate · **${window.label}** · scope: **${scope}** · min 5 games`
        + (useLegacy ? '\n⚠️ Legacy snapshot: no match-id dedupe, so these counts are unreliable.' : '')
      )
      .setFooter({ text: 'Ranked by the low end of a Beta(10,10) estimate, so a thin hot streak cannot outrank a proven duo.' })
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
          value: `**${turboStatsService.pairSortKey(pairing).toFixed(1)}% floor** · projected ${pairing.rating.toFixed(1)}% · observed ${(pairing.wins / games * 100).toFixed(1)}% (${pairing.wins}–${pairing.losses})\n${evidenceStrength(games)} evidence${evidence(pairing)}`
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
