import { Message, EmbedBuilder } from 'discord.js';
import { TurboStatsService } from '../services/turboStatsService';
import { turboRankService, TurboRankService } from '../services/turboRankService';
import { logger } from '../services/loggerService';

export async function turboLeaderboard(message: Message, turboStatsService: TurboStatsService) {
  try {
    const MIN_GAMES = 10;
    const players = turboStatsService.getAllStats().playerStats.filter(p => p.wins + p.losses >= MIN_GAMES);
    if (players.length === 0) {
      return message.reply('No players have 10+ tracked turbo games yet. Play more turbo matches to unlock the leaderboard.');
    }

    // Rank by the opponent-AWARE hidden-MMR estimate (read from lobby opponent medals) —
    // turbo win rates all cluster near 50% (matchmaking), so they barely separate anyone.
    // Win rate is just the tiebreaker. Players without a usable estimate are listed apart.
    const entries = players.map(p => ({ p, est: turboRankService.getEstimate(p.discordId) }));
    const skill = entries
      .filter(e => e.est && e.est.confidence >= 25)
      .sort((a, b) => (b.est!.estimatedMMR - a.est!.estimatedMMR)
        || ((b.p.wins / (b.p.wins + b.p.losses)) - (a.p.wins / (a.p.wins + a.p.losses))));
    const uncalibrated = entries.filter(e => !(e.est && e.est.confidence >= 25));

    const embed = new EmbedBuilder()
      .setColor('#ffd700')
      .setTitle('🏆 Turbo Leaderboard — the Crew')
      .setDescription('Registered players ranked by **estimated hidden Turbo MMR** (from lobby opponent medals — opponent-aware, not just win rate). Min 10 games. _For the full estimator dataset incl. discovered peers, use `+turborank all`._')
      .setTimestamp();

    if (skill.length > 0) {
      let text = '';
      for (let i = 0; i < skill.length; i++) {
        const { p, est } = skill[i];
        const user = await message.client.users.fetch(p.discordId).catch(() => null);
        const name = user?.username ?? `Player ${p.discordId}`;
        const total = p.wins + p.losses;
        const wr = ((p.wins / total) * 100).toFixed(0);
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        const flags = est!.partyFallback ? ' ⚠ party-based' : est!.confidence < 50 ? ' ⏳ low conf' : '';
        text += `${medal} **${name}** — ${est!.medal} (~${est!.estimatedMMR})${flags}\n`;
        text += `   ${p.wins}W/${p.losses}L (${wr}%) · est. confidence ${est!.confidence}%\n\n`;
      }
      embed.addFields({ name: 'Rankings — by hidden Turbo MMR', value: text.slice(0, 1024), inline: false });
    }

    if (uncalibrated.length > 0) {
      const names = (await Promise.all(uncalibrated.slice(0, 12).map(async e => {
        const u = await message.client.users.fetch(e.p.discordId).catch(() => null);
        return u?.username ?? `Player ${e.p.discordId}`;
      }))).join(', ');
      embed.addFields({
        name: `🔧 Uncalibrated (${uncalibrated.length})`,
        value: `${names}\nRun \`+turborank calibrate\` (with Expose Public Match Data on) to join the skill ranking.`.slice(0, 1024),
        inline: false,
      });
    }

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

    // Mirror the service's Wilson-based score so the breakdown is transparent:
    // score = conservative (lower-bound) win-rate estimate + a small activity bump.
    const z = 1.96;
    const p = playerStats.wins / totalGames;
    const denom = 1 + (z * z) / totalGames;
    const centre = p + (z * z) / (2 * totalGames);
    const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * totalGames)) / totalGames);
    const wilson = ((centre - margin) / denom) * 100;
    const activityBonus = Math.min(totalGames, 100) * 0.02;
    const confLabel = totalGames >= 20
      ? '✅ Established (20+ games)'
      : '⏳ Provisional — small sample, score stays conservative until ~20 games';

    // Leaderboard rank among all tracked players with 10+ games.
    const ranked = turboStatsService.getAllStats().playerStats
      .filter((p) => p.wins + p.losses >= 10)
      .sort((a, b) => b.rating - a.rating);
    const rankIndex = ranked.findIndex((p) => p.discordId === target.id);
    const rankText = rankIndex >= 0 ? `#${rankIndex + 1} of ${ranked.length}` : 'Unranked (need 10+ games)';

    const wrColor = winRate >= 55 ? '#10b981' : winRate >= 48 ? '#00bfff' : '#ef4444';
    const form = winRate >= 55 ? '🔥 crushing it' : winRate >= 50 ? '🙂 above water' : winRate >= 45 ? '😬 grinding it out' : '💀 rough patch';

    const embed = new EmbedBuilder()
      .setColor(wrColor as `#${string}`)
      .setTitle(`⚡ Turbo Stats — ${target.username}`)
      .setThumbnail(target.displayAvatarURL())
      .setDescription(`🏅 **Score ${playerStats.rating}**  •  🏆 ${rankText}  •  ${form}`)
      .addFields(
        { name: 'Record', value: `**${playerStats.wins}**W / **${playerStats.losses}**L`, inline: true },
        { name: 'Win Rate', value: `${winRate.toFixed(1)}%`, inline: true },
        { name: 'Games', value: totalGames.toString(), inline: true },
      );

    // Add hidden turbo rank if calibrated
    const rankEstimate = turboRankService.getEstimate(target.id);
    if (rankEstimate) {
      embed.addFields({
        name: '🔮 Hidden Turbo Rank',
        value: `**${rankEstimate.medal}** (~${rankEstimate.estimatedMMR} MMR, ${rankEstimate.confidence}% confidence)`,
        inline: false,
      });
    }

    embed.addFields(
        {
          name: '🧮 Score Breakdown',
          value: `Raw win rate: **${winRate.toFixed(1)}%**\nConservative estimate (Wilson 95%): **${wilson.toFixed(1)}**\nActivity bonus (${totalGames} games): **+${activityBonus.toFixed(2)}**\n➡️ Score: **${playerStats.rating}**`,
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