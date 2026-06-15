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

    const isSoloOnly = estimate.soloSampleSize >= 5;
    const observations = turboRankService.getObservations(target.id);
    const targets = isSoloOnly
      ? observations.filter(o => o.partySize === 1)
      : observations;

    const recentMatches = targets
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 5);

    const matchBreakdown = recentMatches.length > 0
      ? recentMatches
          .map(o => {
            const { medal } = mmrToMedal(o.lobbyMMR);
            const date = new Date(o.timestamp * 1000).toLocaleDateString();
            const partyType = o.partySize === 1 ? 'Solo' : `${o.partySize}-stack`;
            const outcome = o.won === true ? 'W' : o.won === false ? 'L' : '';
            const outcomeStr = outcome ? ` | **${outcome}**` : '';
            return `• **${medal}** lobby (${partyType}${outcomeStr}) — ${date}`;
          })
          .join('\n')
      : '_No games on record_';

    const sampleValue = isSoloOnly
      ? `**${estimate.soloSampleSize}** solo matches used\n*(ignored ${estimate.sampleSize - estimate.soloSampleSize} party)*`
      : `**${estimate.sampleSize}** matches\n*(${estimate.soloSampleSize} solo, ${estimate.sampleSize - estimate.soloSampleSize} party)*`;

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
          name: '📊 Matches Used',
          value: sampleValue,
          inline: true,
        },
        {
          name: '⚖️ Effective Weight',
          value: `${estimate.effectiveSample.toFixed(1)}`,
          inline: true,
        },
        {
          name: isSoloOnly ? '🎯 Recent Solo Lobbies' : '🎯 Recent Calibration Lobbies',
          value: matchBreakdown,
          inline: false,
        },
        {
          name: '🧠 How is this calculated?',
          value: 'Your hidden rank is estimated by analyzing the **actual ranked medals of other players** (enemies and teammates) in your matches.\n' +
                 '• **Solo Priority:** Solo matches are the purest signal. If you have **≥ 5** solo games, party matches are **completely ignored** so your friends\' ranks do not distort your calibration.\n' +
                 '• **Recency Decay:** Newer matches carry higher weight (60-day half-life) to reflect your current skill level.\n' +
                 '• **Win/Loss Adjustment:** Winning in a lobby shifts the estimated matchmaking level up by +100 MMR; losing shifts it down by -100 MMR.',
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
    const target = message.mentions.users.first() || message.author;
    const user = userDataService.getUserByDiscordId(target.id);
    if (!user) {
      return message.reply(
        target.id === message.author.id
          ? "You're not registered. Use `+register <steamId>` first."
          : `**${target.username}** is not registered.`,
      );
    }

    const progressMsg = await message.reply(
      `🔮 Calibrating hidden Turbo rank for **${target.username}**…\n` +
      'Analyzing match history, this may take a minute.',
    );

    const estimate = await turboRankService.calibratePlayer(
      target.id,
      user.steamId,
      100, // Fetch up to 100 matches overall if we fall back
      (fetched, total, phase) => {
        // Update progress dynamically
        if (fetched === 0 || fetched % 10 === 0 || fetched === total) {
          let text = `🔮 Calibrating **${target.username}**… **${phase}**`;
          if (total > 0) {
            text += ` (${fetched}/${total})`;
          }
          progressMsg.edit(text).catch(() => {});
        }
      },
    );

    if (!estimate) {
      return progressMsg.edit(
        `❌ Calibration failed for **${target.username}** — not enough matches with visible rank data. ` +
        'Play more Turbo matches (especially solo queue) and try again.',
      );
    }

    const confEmoji =
      estimate.confidence >= 80 ? '🟢' : estimate.confidence >= 50 ? '🟡' : '🔴';

    const isSoloOnly = estimate.soloSampleSize >= 5;
    const observations = turboRankService.getObservations(target.id);
    const targets = isSoloOnly
      ? observations.filter(o => o.partySize === 1)
      : observations;

    const recentMatches = targets
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 5);

    const matchBreakdown = recentMatches.length > 0
      ? recentMatches
          .map(o => {
            const { medal } = mmrToMedal(o.lobbyMMR);
            const date = new Date(o.timestamp * 1000).toLocaleDateString();
            const partyType = o.partySize === 1 ? 'Solo' : `${o.partySize}-stack`;
            const outcome = o.won === true ? 'W' : o.won === false ? 'L' : '';
            const outcomeStr = outcome ? ` | **${outcome}**` : '';
            return `• **${medal}** lobby (${partyType}${outcomeStr}) — ${date}`;
          })
          .join('\n')
      : '_No games on record_';

    const matchesUsedDesc = isSoloOnly
      ? `Based on **${estimate.soloSampleSize}** solo matches *(ignored ${estimate.sampleSize - estimate.soloSampleSize} party matches to prevent stack distortion)*`
      : `Based on **${estimate.sampleSize}** matches *(${estimate.soloSampleSize} solo, ${estimate.sampleSize - estimate.soloSampleSize} party)*`;

    const embed = new EmbedBuilder()
      .setColor('#8b5cf6')
      .setTitle(`🔮 Calibration Complete — ${target.username}`)
      .setDescription(
        `**Hidden Turbo Rank: ${estimate.medal}**\n` +
        `Estimated MMR: **~${estimate.estimatedMMR}**\n\n` +
        `${confEmoji} **${estimate.confidence}% confidence**\n` +
        `${matchesUsedDesc}`,
      )
      .setThumbnail(target.displayAvatarURL())
      .addFields(
        {
          name: isSoloOnly ? '🎯 Recent Solo Lobbies' : '🎯 Recent Calibration Lobbies',
          value: matchBreakdown,
          inline: false,
        },
        {
          name: '🧠 How is this calculated?',
          value: 'Your hidden rank is estimated by analyzing the **actual ranked medals of other players** (enemies and teammates) in your matches.\n' +
                 '• **Solo Priority:** Solo matches are the purest signal. If you have **≥ 5** solo games, party matches are **completely ignored** so your friends\' ranks do not distort your calibration.\n' +
                 '• **Recency Decay:** Newer matches carry higher weight (60-day half-life) to reflect your current skill level.\n' +
                 '• **Win/Loss Adjustment:** Winning in a lobby shifts the estimated matchmaking level up by +100 MMR; losing shifts it down by -100 MMR.',
          inline: false,
        },
      )
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
