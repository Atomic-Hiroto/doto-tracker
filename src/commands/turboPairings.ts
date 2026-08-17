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

function evidence(pairing: { liveGames?: number; historicalGames?: number; verifiedPartyGames?: number }) {
  const parts: string[] = [];
  if (pairing.liveGames) parts.push(`${pairing.liveGames} tracked`);
  if (pairing.historicalGames) parts.push(`${pairing.historicalGames} history`);
  if (pairing.verifiedPartyGames) parts.push(`${pairing.verifiedPartyGames} verified-party`);
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
    const scope = parseScope(args);
    const window = parseWindow(args);
    const pairings = turboStatsService.getPairingLeaderboard(10, 20, scope, window.sinceTimestamp);
    if (pairings.length === 0) {
      const hint = scope === 'history'
        ? ' Ask the bot owner to run `+turbobackfill` first.'
        : scope === 'tracked'
          ? ' The tracked ledger starts with the new system; use `+turbopairs` while new live matches accumulate.'
          : '';
      return message.reply(`No turbo duo has 20+ ${scope} games together in the ${window.label} yet.${hint}`);
    }

    const embed = new EmbedBuilder()
      .setColor('#ff6b6b')
      .setTitle('🤝 Best Turbo Duos')
      .setDescription(`Top same-team pairings by Bayesian projected win rate · **${window.label}** · scope: **${scope}** · min 20 games`)
      .setFooter({ text: 'Projected WR uses a neutral 10–10 prior; same-team is treated as likely party.' })
      .setTimestamp();

    let text = '';
    for (let i = 0; i < pairings.length; i++) {
      const pairing = pairings[i];
      try {
        const [user1, user2] = await Promise.all([
          message.client.users.fetch(pairing.player1),
          message.client.users.fetch(pairing.player2)
        ]);
        const games = pairing.wins + pairing.losses;
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        text += `${medal} **${user1.username}** + **${user2.username}**\n`;
        text += `Projected WR: **${pairing.rating.toFixed(1)}%** · observed ${(pairing.wins / games * 100).toFixed(1)}% (${pairing.wins}–${pairing.losses})\n`;
        text += `Evidence: ${evidenceStrength(games)} · ${games} games${evidence(pairing)}\n\n`;
      } catch (error) {
        logger.warn(`Could not fetch users for pairing ${pairing.player1} + ${pairing.player2}:`, error);
      }
    }
    if (!text) return message.reply('Could not display pairing leaderboard due to user fetch errors.');
    embed.addFields({ name: 'Best Duos', value: text.slice(0, 1024) });
    return message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in turbo pairings command:', error);
    return message.reply('An error occurred while fetching the turbo pairings leaderboard. Please try again later.');
  }
}

export async function myTurboPairings(message: Message, turboStatsService: TurboStatsService, args: string[] = []) {
  try {
    const target = message.mentions.users.first() ?? message.author;
    const scope = parseScope(args);
    const window = parseWindow(args);
    const pairings = turboStatsService.getPairingsForPlayer(target.id, scope, window.sinceTimestamp)
      .filter(pair => pair.wins + pair.losses >= 5)
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 10);
    if (!pairings.length) {
      const hint = scope === 'history'
        ? ' Ask the bot owner to run `+turbobackfill` first.'
        : scope === 'tracked'
          ? ' The tracked ledger starts with the new system; use `+turbopairs` while new live matches accumulate.'
          : '';
      return message.reply(`No duo has 5+ ${scope} games with **${target.username}** in the ${window.label} yet.${hint}`);
    }

    const embed = new EmbedBuilder()
      .setColor('#4ecdc4')
      .setTitle(`🤝 Turbo Duos — ${target.username}`)
      .setDescription(`Best same-team partnerships by Bayesian projected win rate · **${window.label}** · scope: **${scope}** · min 5 games`)
      .setFooter({ text: 'Projected WR uses a neutral 10–10 prior; same-team is treated as likely party.' })
      .setTimestamp();
    let text = '';
    for (let i = 0; i < pairings.length; i++) {
      const pairing = pairings[i];
      try {
        const partnerId = pairing.player1 === target.id ? pairing.player2 : pairing.player1;
        const partner = await message.client.users.fetch(partnerId);
        const games = pairing.wins + pairing.losses;
        text += `${i + 1}. **${partner.username}** — **${pairing.rating.toFixed(1)}% projected**\n`;
        text += `Observed ${(pairing.wins / games * 100).toFixed(1)}% (${pairing.wins}–${pairing.losses}) · ${evidenceStrength(games)} evidence${evidence(pairing)}\n\n`;
      } catch (error) {
        logger.warn('Could not fetch turbo duo partner:', error);
      }
    }
    if (!text) return message.reply('Could not display pairing stats due to user fetch errors.');
    embed.addFields({ name: 'Partners', value: text.slice(0, 1024) });
    return message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in personal turbo pairings command:', error);
    return message.reply('An error occurred while fetching turbo pairing stats. Please try again later.');
  }
}
