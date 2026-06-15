import { Message, EmbedBuilder } from 'discord.js';
import { turboRankService, TurboRankService, mmrToMedal } from '../services/turboRankService';
import { UserDataService } from '../services/userDataService';
import { logger } from '../services/loggerService';

/**
 * +turborank [@user]          — view hidden turbo rank estimate
 * +turborank calibrate        — retroactive calibration from match history
 * +turborank all              — leaderboard of all tracked players' hidden ranks
 */
export async function turboRank(
  message: Message,
  args: string[],
  userDataService: UserDataService,
) {
  const subcommand = args[0]?.toLowerCase();

  if (subcommand === 'calibrate') {
    return turboRankCalibrate(message, userDataService);
  }
  if (subcommand === 'all') {
    return turboRankAll(message, userDataService);
  }

  // Default: show rank for mentioned user or self
  return turboRankView(message, userDataService);
}

// ── View ────────────────────────────────────────────────────────────────────

async function turboRankView(message: Message, userDataService: UserDataService) {
  try {
    const target = message.mentions.users.first() || message.author;
    const user = userDataService.getUserByDiscordId(target.id);

    if (!user) {
      return message.reply(
        target.id === message.author.id
          ? "You're not registered. Use `+register <steamId>` first."
          : `**${target.username}** is not registered.`,
      );
    }

    const estimate = turboRankService.getEstimate(target.id);

    if (!estimate) {
      return message.reply(
        `No turbo rank estimate for **${target.username}** yet. ` +
        `Run \`+turborank calibrate\` to analyze match history, or play some turbo matches.`,
      );
    }

    const confEmoji =
      estimate.confidence >= 80 ? '🟢' : estimate.confidence >= 50 ? '🟡' : '🔴';
    const confLabel =
      estimate.confidence >= 80
        ? 'High confidence'
        : estimate.confidence >= 50
          ? 'Moderate confidence'
          : 'Low confidence — need more games';

    const observations = turboRankService.getObservations(target.id);
    const recentSolo = observations
      .filter(o => o.partySize === 1)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 5);

    const soloBreakdown = recentSolo.length > 0
      ? recentSolo
          .map(o => {
            const { medal } = mmrToMedal(o.lobbyMMR);
            const date = new Date(o.timestamp * 1000).toLocaleDateString();
            return `• ${medal} lobby (${o.visibleRanks} visible ranks) — ${date}`;
          })
          .join('\n')
      : '_No solo games on record_';

    const embed = new EmbedBuilder()
      .setColor(estimate.confidence >= 50 ? '#8b5cf6' : '#6b7280')
      .setTitle(`🔮 Hidden Turbo Rank — ${target.username}`)
      .setThumbnail(target.displayAvatarURL())
      .setDescription(
        `**${estimate.medal}** (est. MMR ~${estimate.estimatedMMR})`,
      )
      .addFields(
        {
          name: `${confEmoji} Confidence`,
          value: `${estimate.confidence}% — ${confLabel}`,
          inline: true,
        },
        {
          name: '📊 Sample Size',
          value: `${estimate.sampleSize} matches (${estimate.soloSampleSize} solo)`,
          inline: true,
        },
        {
          name: '⚖️ Effective Weight',
          value: `${estimate.effectiveSample.toFixed(1)}`,
          inline: true,
        },
        {
          name: '🎯 Recent Solo Lobbies',
          value: soloBreakdown,
          inline: false,
        },
      )
      .setFooter({
        text:
          'Based on lobby ranks of enemies & teammates • solo games weighted highest • ' +
          `updated ${new Date(estimate.lastUpdated).toLocaleDateString()}`,
      })
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in turborank view:', error);
    await message.reply('An error occurred. Please try again later.');
  }
}

// ── Calibrate ───────────────────────────────────────────────────────────────

async function turboRankCalibrate(message: Message, userDataService: UserDataService) {
  try {
    const user = userDataService.getUserByDiscordId(message.author.id);
    if (!user) {
      return message.reply("You're not registered. Use `+register <steamId>` first.");
    }

    const progressMsg = await message.reply(
      '🔮 Calibrating your hidden Turbo rank… fetching up to 50 recent Turbo matches.\n' +
      'This may take a minute.',
    );

    const estimate = await turboRankService.calibratePlayer(
      message.author.id,
      user.steamId,
      50,
      (fetched, total) => {
        // Update progress every 10 matches
        if (fetched % 10 === 0 || fetched === total) {
          progressMsg.edit(
            `🔮 Calibrating… processed ${fetched}/${total} matches.`,
          ).catch(() => {});
        }
      },
    );

    if (!estimate) {
      return progressMsg.edit(
        '❌ Calibration failed — not enough matches with visible rank data. ' +
        'Play more Turbo matches (especially solo queue) and try again.',
      );
    }

    const confEmoji =
      estimate.confidence >= 80 ? '🟢' : estimate.confidence >= 50 ? '🟡' : '🔴';

    const embed = new EmbedBuilder()
      .setColor('#8b5cf6')
      .setTitle(`🔮 Calibration Complete — ${message.author.username}`)
      .setDescription(
        `**Hidden Turbo Rank: ${estimate.medal}**\n` +
        `Estimated MMR: **~${estimate.estimatedMMR}**\n\n` +
        `${confEmoji} ${estimate.confidence}% confidence\n` +
        `Based on ${estimate.sampleSize} matches (${estimate.soloSampleSize} solo)`,
      )
      .setThumbnail(message.author.displayAvatarURL())
      .setFooter({ text: 'Solo games carry the most weight • party games are discounted' })
      .setTimestamp();

    await progressMsg.edit({ content: null, embeds: [embed] });
  } catch (error) {
    logger.error('Error in turborank calibrate:', error);
    await message.reply('An error occurred during calibration. Please try again later.');
  }
}

// ── All (leaderboard) ───────────────────────────────────────────────────────

async function turboRankAll(message: Message, userDataService: UserDataService) {
  try {
    const ranked = turboRankService.getAllEstimates();

    if (ranked.length === 0) {
      return message.reply(
        'No players have turbo rank estimates yet. ' +
        'Run `+turborank calibrate` to get started.',
      );
    }

    let text = '';
    for (let i = 0; i < ranked.length; i++) {
      const { discordId, estimate } = ranked[i];
      const user = await message.client.users.fetch(discordId).catch(() => null);
      const name = user?.username ?? discordId;
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      const confEmoji =
        estimate.confidence >= 80 ? '🟢' : estimate.confidence >= 50 ? '🟡' : '🔴';

      text += `${medal} **${name}** — ${estimate.medal} (~${estimate.estimatedMMR} MMR) `;
      text += `${confEmoji} ${estimate.confidence}%\n`;
      text += `   ${estimate.sampleSize} games (${estimate.soloSampleSize} solo)\n\n`;
    }

    const embed = new EmbedBuilder()
      .setColor('#8b5cf6')
      .setTitle('🔮 Hidden Turbo Rank Leaderboard')
      .setDescription(
        'Estimated hidden Turbo MMR based on lobby rank observations.\n' +
        'Solo games carry the most weight.\n\n' + text,
      )
      .setFooter({ text: 'Run +turborank calibrate to update your estimate' })
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in turborank all:', error);
    await message.reply('An error occurred. Please try again later.');
  }
}
