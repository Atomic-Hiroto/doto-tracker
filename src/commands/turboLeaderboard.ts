import { Message, EmbedBuilder } from 'discord.js';
import { TurboStatsService } from '../services/turboStatsService';
import { logger } from '../services/loggerService';

export async function turboLeaderboard(message: Message, turboStatsService: TurboStatsService) {
  try {
    const leaderboard = turboStatsService.getPlayerLeaderboard(10);
    
    if (leaderboard.length === 0) {
      return message.reply('No turbo games recorded yet! Play some turbo matches to see the leaderboard.');
    }

    const embed = new EmbedBuilder()
      .setColor('#ffd700')
      .setTitle('🏆 Turbo Leaderboard')
      .setDescription('Top players by turbo rating (min 3 games)')
      .setTimestamp();

    let leaderboardText = '';
    for (let i = 0; i < leaderboard.length; i++) {
      const player = leaderboard[i];
      const user = await message.client.users.fetch(player.discordId);
      const totalGames = player.wins + player.losses;
      const winRate = ((player.wins / totalGames) * 100).toFixed(1);
      
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      
      leaderboardText += `${medal} **${user.username}**\n`;
      leaderboardText += `   Rating: ${player.rating} | W/L: ${player.wins}/${player.losses} (${winRate}%)\n\n`;
    }

    embed.addFields({ name: 'Rankings', value: leaderboardText, inline: false });
    
    await message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in turbo leaderboard command:', error);
    await message.reply('An error occurred while fetching the turbo leaderboard. Please try again later.');
  }
}

export async function turboStats(message: Message, turboStatsService: TurboStatsService) {
  try {
    const playerStats = turboStatsService.getPlayerStats(message.author.id);
    
    if (!playerStats) {
      return message.reply('You haven\'t played any turbo games yet! Play some turbo matches to see your stats.');
    }

    const totalGames = playerStats.wins + playerStats.losses;
    const winRate = ((playerStats.wins / totalGames) * 100).toFixed(1);
    
    const embed = new EmbedBuilder()
      .setColor('#00bfff')
      .setTitle(`⚡ Turbo Stats for ${message.author.username}`)
      .addFields(
        { name: 'Rating', value: playerStats.rating.toString(), inline: true },
        { name: 'Wins', value: playerStats.wins.toString(), inline: true },
        { name: 'Losses', value: playerStats.losses.toString(), inline: true },
        { name: 'Total Games', value: totalGames.toString(), inline: true },
        { name: 'Win Rate', value: `${winRate}%`, inline: true },
        { name: 'Last Updated', value: new Date(playerStats.lastUpdated).toLocaleDateString(), inline: true }
      )
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in turbo stats command:', error);
    await message.reply('An error occurred while fetching your turbo stats. Please try again later.');
  }
}