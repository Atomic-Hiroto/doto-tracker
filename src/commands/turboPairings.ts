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

function evidence(pairing: { liveGames?: number; historicalGames?: number; verifiedPartyGames?: number }) {
  const parts: string[] = [];
  if (pairing.liveGames) parts.push(`${pairing.liveGames} tracked`);
  if (pairing.historicalGames) parts.push(`${pairing.historicalGames} history`);
  if (pairing.verifiedPartyGames) parts.push(`${pairing.verifiedPartyGames} verified-party`);
  return parts.length ? ` · ${parts.join(', ')}` : '';
}

export async function turboPairings(message: Message, turboStatsService: TurboStatsService, args: string[] = []) {
  try {
    const scope = parseScope(args);
    const pairings = turboStatsService.getPairingLeaderboard(10, 10, scope);
    if (pairings.length === 0) {
      const hint = scope === 'history' ? ' Ask the bot owner to run `+turbobackfill` first.' : '';
      return message.reply(`No turbo duo has 10+ ${scope} games together yet.${hint}`);
    }

    const embed = new EmbedBuilder()
      .setColor('#ff6b6b')
      .setTitle('🤝 Best Turbo Duos')
      .setDescription(`Top same-team pairings by conservative score · scope: **${scope}** · min 10 games`)
      .setFooter({ text: 'Same team is treated as likely party; verified-party counts require a positive matching party ID.' })
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
        text += `Score: ${pairing.rating} · W/L ${pairing.wins}/${pairing.losses} (${(pairing.wins / games * 100).toFixed(1)}%)${evidence(pairing)}\n\n`;
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
    const pairings = turboStatsService.getPairingsForPlayer(target.id, scope)
      .filter(pair => pair.wins + pair.losses >= 2)
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 10);
    if (!pairings.length) {
      const hint = scope === 'history' ? ' Ask the bot owner to run `+turbobackfill` first.' : '';
      return message.reply(`No duo has 2+ ${scope} games with **${target.username}** yet.${hint}`);
    }

    const embed = new EmbedBuilder()
      .setColor('#4ecdc4')
      .setTitle(`🤝 Turbo Duos — ${target.username}`)
      .setDescription(`Best same-team partnerships · scope: **${scope}** · min 2 games`)
      .setFooter({ text: 'Same team is treated as likely party; verified-party counts require a positive matching party ID.' })
      .setTimestamp();
    let text = '';
    for (let i = 0; i < pairings.length; i++) {
      const pairing = pairings[i];
      try {
        const partnerId = pairing.player1 === target.id ? pairing.player2 : pairing.player1;
        const partner = await message.client.users.fetch(partnerId);
        const games = pairing.wins + pairing.losses;
        text += `${i + 1}. **${partner.username}** — ${pairing.rating}\n`;
        text += `W/L ${pairing.wins}/${pairing.losses} (${(pairing.wins / games * 100).toFixed(1)}%)${evidence(pairing)}\n\n`;
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
