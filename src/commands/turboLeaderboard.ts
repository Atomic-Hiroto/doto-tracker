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
    // Honor an @mention so `+turbostats @user` shows that user, not the caller.
    const target = message.mentions.users.first() || message.author;
    const isSelf = target.id === message.author.id;
    const playerStats = turboStatsService.getPlayerStats(target.id);

    if (!playerStats) {
      return message.reply(
        isSelf
          ? "You haven't played any tracked turbo games yet! Play some turbo matches to see your stats."
          : `**${target.username}** has no tracked turbo games yet.`
      );
    }

    const totalGames = playerStats.wins + playerStats.losses;
    const winRate = (playerStats.wins / totalGames) * 100;

    // Break the rating down into its two parts so it's transparent that the
    // score = confidence-weighted win% + a flat volume bonus (0.1/game).
    const confidence = Math.min(totalGames / 20, 1);
    const skillPart = winRate * confidence;
    const volumePart = totalGames * 0.1;
    const confLabel = totalGames >= 20
      ? '✅ Established (20+ games)'
      : `⏳ Provisional — win% damped to ${Math.round(confidence * 100)}% until 20 games`;

    // Leaderboard rank among all tracked players with 3+ games.
    const ranked = turboStatsService.getAllStats().playerStats
      .filter((p) => p.wins + p.losses >= 3)
      .sort((a, b) => b.rating - a.rating);
    const rankIndex = ranked.findIndex((p) => p.discordId === target.id);
    const rankText = rankIndex >= 0 ? `#${rankIndex + 1} of ${ranked.length}` : 'Unranked (need 3+ games)';

    const wrColor = winRate >= 55 ? '#10b981' : winRate >= 48 ? '#00bfff' : '#ef4444';
    const form = winRate >= 55 ? '🔥 crushing it' : winRate >= 50 ? '🙂 above water' : winRate >= 45 ? '😬 grinding it out' : '💀 rough patch';

    const embed = new EmbedBuilder()
      .setColor(wrColor as `#${string}`)
      .setTitle(`⚡ Turbo Stats — ${target.username}`)
      .setThumbnail(target.displayAvatarURL())
      .setDescription(`🏅 **Rating ${playerStats.rating}**  •  🏆 ${rankText}  •  ${form}`)
      .addFields(
        { name: 'Record', value: `**${playerStats.wins}**W / **${playerStats.losses}**L`, inline: true },
        { name: 'Win Rate', value: `${winRate.toFixed(1)}%`, inline: true },
        { name: 'Games', value: totalGames.toString(), inline: true },
        {
          name: '🧮 Rating Breakdown',
          value: `Skill (win% × confidence): **${skillPart.toFixed(1)}**\nVolume bonus (${totalGames} × 0.1): **+${volumePart.toFixed(1)}**\n➡️ Total: **${playerStats.rating}**`,
          inline: false,
        },
        { name: 'Confidence', value: confLabel, inline: false },
      )
      .setFooter({ text: `Tracked turbo games only • last updated ${new Date(playerStats.lastUpdated).toLocaleDateString()}` })
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in turbo stats command:', error);
    await message.reply('An error occurred while fetching your turbo stats. Please try again later.');
  }
}