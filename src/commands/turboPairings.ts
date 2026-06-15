import { Message, EmbedBuilder } from 'discord.js';
import { TurboStatsService } from '../services/turboStatsService';
import { logger } from '../services/loggerService';

export async function turboPairings(message: Message, turboStatsService: TurboStatsService) {
  try {
    const pairings = turboStatsService.getPairingLeaderboard(10);

    if (pairings.length === 0) {
      return message.reply('No turbo duo has 10+ tracked games together yet. Play more turbo matches together to unlock the duo leaderboard.');
    }

    const embed = new EmbedBuilder()
      .setColor('#ff6b6b')
      .setTitle('🤝 Best Turbo Duos')
      .setDescription('Top player pairings by turbo score (min 10 games together)')
      .setTimestamp();

    let pairingsText = '';
    for (let i = 0; i < pairings.length; i++) {
      const pairing = pairings[i];

      try {
        const user1 = await message.client.users.fetch(pairing.player1);
        const user2 = await message.client.users.fetch(pairing.player2);
        const totalGames = pairing.wins + pairing.losses;
        const winRate = ((pairing.wins / totalGames) * 100).toFixed(1);

        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;

        pairingsText += `${medal} **${user1.username}** + **${user2.username}**\n`;
        pairingsText += `   Score: ${pairing.rating} | W/L: ${pairing.wins}/${pairing.losses} (${winRate}%)\n\n`;
      } catch (userError) {
        logger.warn(`Could not fetch users for pairing ${pairing.player1} + ${pairing.player2}:`, userError);
        continue;
      }
    }

    if (pairingsText === '') {
      return message.reply('Could not display pairing leaderboard due to user fetch errors.');
    }

    embed.addFields({ name: 'Best Duos', value: pairingsText, inline: false });

    await message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in turbo pairings command:', error);
    await message.reply('An error occurred while fetching the turbo pairings leaderboard. Please try again later.');
  }
}

export async function myTurboPairings(message: Message, turboStatsService: TurboStatsService) {
  try {
    const allPairings = turboStatsService.getAllStats().pairings;
    const myPairings = allPairings
      .filter(p => p.player1 === message.author.id || p.player2 === message.author.id)
      .filter(p => p.wins + p.losses >= 2) // Show pairings with at least 2 games
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 10);

    if (myPairings.length === 0) {
      return message.reply('You haven\'t played enough turbo games with anyone yet! Play some turbo matches with friends to see your pairing stats.');
    }

    const embed = new EmbedBuilder()
      .setColor('#4ecdc4')
      .setTitle(`🤝 Your Turbo Duos - ${message.author.username}`)
      .setDescription('Your best turbo partnerships (min 2 games together)')
      .setTimestamp();

    let pairingsText = '';
    for (let i = 0; i < myPairings.length; i++) {
      const pairing = myPairings[i];

      try {
        const partnerId = pairing.player1 === message.author.id ? pairing.player2 : pairing.player1;
        const partner = await message.client.users.fetch(partnerId);
        const totalGames = pairing.wins + pairing.losses;
        const winRate = ((pairing.wins / totalGames) * 100).toFixed(1);

        pairingsText += `${i + 1}. **${partner.username}**\n`;
        pairingsText += `   Score: ${pairing.rating} | W/L: ${pairing.wins}/${pairing.losses} (${winRate}%)\n\n`;
      } catch (userError) {
        logger.warn(`Could not fetch partner for pairing:`, userError);
        continue;
      }
    }

    if (pairingsText === '') {
      return message.reply('Could not display your pairing stats due to user fetch errors.');
    }

    embed.addFields({ name: 'Your Partners', value: pairingsText, inline: false });

    await message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in my turbo pairings command:', error);
    await message.reply('An error occurred while fetching your turbo pairing stats. Please try again later.');
  }
}