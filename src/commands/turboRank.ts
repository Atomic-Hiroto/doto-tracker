import { Message, EmbedBuilder } from 'discord.js';
import {
  turboRankService,
  tierToEmoji,
  mmrToEmoji,
  mmrToMedal,
} from '../services/turboRankService';
import { fetchStratzPlayerProfile } from '../services/stratzClient';
import { TurboRankObservation } from '../models/TurboRank';
import { UserDataService } from '../services/userDataService';
import { logger } from '../services/loggerService';

/**
 * +turborank [@user | steamId]   — view hidden turbo rank estimate
 * +turborank calibrate [@user | steamId] — retroactive calibration from match history
 * +turborank all                 — leaderboard of all calculated players
 */
export async function turboRank(
  message: Message,
  args: string[],
  userDataService: UserDataService,
) {
  const subcommand = args[0]?.toLowerCase();

  if (subcommand === 'all' || subcommand === 'leaderboard' || subcommand === 'lb') {
    return turboRankAll(message);
  }
  if (subcommand === 'calibrate' || subcommand === 'recalc') {
    return turboRankCalibrate(message, args.slice(1), userDataService);
  }
  return turboRankView(message, args, userDataService);
}

// ── Target resolution (registered @user, or raw steamId for unregistered) ─────

interface RankTarget {
  steamId: string;
  name: string;
  discordId: string; // '' if unregistered
  avatarURL?: string;
}

function looksLikeSteamId(s?: string): boolean {
  return !!s && /^\d{4,}$/.test(s);
}

async function resolveTarget(
  message: Message,
  args: string[],
  userDataService: UserDataService,
): Promise<RankTarget | { error: string }> {
  // 1) @mention → registered user
  const mentioned = message.mentions.users.first();
  if (mentioned) {
    const user = userDataService.getUserByDiscordId(mentioned.id);
    if (!user) return { error: `**${mentioned.username}** is not registered.` };
    return {
      steamId: user.steamId,
      name: mentioned.username,
      discordId: mentioned.id,
      avatarURL: mentioned.displayAvatarURL(),
    };
  }

  // 2) raw steamId argument → unregistered player
  const idArg = args.find(a => looksLikeSteamId(a));
  if (idArg) {
    const registered = userDataService.getUserBySteamId(idArg);
    const cachedName = turboRankService.getSteamName(idArg);
    let name = cachedName;
    if (!name) {
      const profile = await fetchStratzPlayerProfile(parseInt(idArg, 10));
      name = profile.name ?? `Steam ${idArg}`;
    }
    return { steamId: idArg, name: name!, discordId: registered?.discordId ?? '' };
  }

  // 3) self
  const self = userDataService.getUserByDiscordId(message.author.id);
  if (!self) {
    return { error: "You're not registered. Use `+register <steamId>` first, or pass a steamId: `+turborank <steamId>`." };
  }
  return {
    steamId: self.steamId,
    name: message.author.username,
    discordId: message.author.id,
    avatarURL: message.author.displayAvatarURL(),
  };
}

// ── Shared rendering helpers ─────────────────────────────────────────────────

/** "2 Immortal · 1 Divine · 4 unranked" composition from an observation's tiers. */
function lobbyComposition(obs: TurboRankObservation): string {
  const tiers = obs.tiers ?? []; // older persisted observations may lack tiers
  const visible = obs.visibleRanks ?? tiers.length;
  if (tiers.length === 0) {
    // Fall back to the lobby-average medal if per-player tiers weren't stored.
    return `avg ${mmrToEmoji(obs.lobbyMMR)} ${mmrToMedal(obs.lobbyMMR).medal}`;
  }
  const counts = new Map<number, number>(); // tier int → count
  for (const t of tiers) {
    const tier = Math.floor(t / 10);
    counts.set(tier, (counts.get(tier) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const tier of [8, 7, 6, 5, 4, 3, 2, 1]) {
    const c = counts.get(tier);
    if (c) parts.push(`${c}× ${tierToEmoji(tier)}`);
  }
  const unranked = 9 - visible;
  if (unranked > 0) parts.push(`${unranked}× ⚫`);
  return parts.join(' ');
}

function confidenceBar(confidence: number): string {
  const filled = Math.round(confidence / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function recentProofMatches(observations: TurboRankObservation[], partyFallback: boolean): string {
  const targets = partyFallback ? observations : observations.filter(o => o.partySize === 1);
  const recent = targets.sort((a, b) => b.timestamp - a.timestamp).slice(0, 5);
  if (recent.length === 0) return '_No games on record_';
  return recent
    .map(o => {
      const date = new Date(o.timestamp * 1000).toLocaleDateString();
      const type = o.partySize === 1 ? 'Solo' : `${o.partySize}-stack`;
      const outcome = o.won === true ? '🟩 W' : o.won === false ? '🟥 L' : '';
      return `${mmrToEmoji(o.lobbyMMR)} **${lobbyComposition(o)}**\n   └ ${type}${outcome ? ` · ${outcome}` : ''} · ${date}`;
    })
    .join('\n');
}

const HOW_TEXT =
  'Estimated from the **actual ranked medals of the other players** in your lobbies.\n' +
  '• **Solo only:** only your solo-queue games count — party games distort it, so they\'re ignored unless you *never* solo.\n' +
  '• **Recency (60-day half-life):** recent games prove current skill and weigh the most.\n' +
  '• **Lobby completeness:** lobbies where more players are ranked count more than thin, mostly-unranked ones.';

function buildRankEmbed(target: RankTarget, estimate: NonNullable<ReturnType<typeof turboRankService.getEstimateBySteamId>>, observations: TurboRankObservation[]): EmbedBuilder {
  const confEmoji = estimate.confidence >= 80 ? '🟢' : estimate.confidence >= 50 ? '🟡' : '🔴';
  const confLabel = estimate.confidence >= 80 ? 'High confidence'
    : estimate.confidence >= 50 ? 'Moderate confidence'
    : 'Low confidence — needs more solo games';

  const embed = new EmbedBuilder()
    .setColor(estimate.confidence >= 50 ? '#8b5cf6' : '#6b7280')
    .setTitle(`${tierToEmoji(estimate.medalTier)} Hidden Turbo Rank — ${target.name}`)
    .setDescription(
      `# ${estimate.medal}\n` +
      `est. **~${estimate.estimatedMMR} MMR**` +
      (estimate.rangeLow && estimate.rangeHigh ? `  ·  range **${estimate.rangeLow} – ${estimate.rangeHigh}**` : '') +
      (estimate.partyFallback ? '\n⚠️ _Party-based estimate — this player never solo-queues, so it may be skewed by stackmates._' : ''),
    )
    .addFields(
      {
        name: `${confEmoji} Confidence`,
        value: `\`${confidenceBar(estimate.confidence)}\` ${estimate.confidence}%\n${confLabel}`,
        inline: false,
      },
      {
        name: '📊 Sample',
        value: estimate.partyFallback
          ? `**${estimate.sampleSize}** party matches (no solo games found)`
          : `**${estimate.soloSampleSize}** solo matches used`,
        inline: true,
      },
      {
        name: '⚖️ Effective weight',
        value: `${estimate.effectiveSample.toFixed(1)}`,
        inline: true,
      },
      {
        name: estimate.partyFallback ? '🎯 Recent lobbies' : '🎯 Recent solo lobbies (proof)',
        value: recentProofMatches(observations, estimate.partyFallback),
        inline: false,
      },
      { name: '🧠 How is this calculated?', value: HOW_TEXT, inline: false },
    )
    .setFooter({ text: `updated ${new Date(estimate.lastUpdated).toLocaleDateString()} • medals: ⚫ unranked` })
    .setTimestamp();

  if (target.avatarURL) embed.setThumbnail(target.avatarURL);
  return embed;
}

// ── View ──────────────────────────────────────────────────────────────────────

async function turboRankView(message: Message, args: string[], userDataService: UserDataService) {
  try {
    const target = await resolveTarget(message, args, userDataService);
    if ('error' in target) return message.reply(target.error);

    const estimate = turboRankService.getEstimateBySteamId(target.steamId);
    if (!estimate) {
      return message.reply(
        `No turbo rank estimate for **${target.name}** yet. ` +
        `Run \`+turborank calibrate${args.find(looksLikeSteamId) ? ' ' + target.steamId : ''}\` to analyze their match history.`,
      );
    }

    const observations = turboRankService.getObservationsBySteamId(target.steamId);
    await message.reply({ embeds: [buildRankEmbed(target, estimate, observations)] });
  } catch (error) {
    logger.error('Error in turborank view:', error);
    await message.reply('An error occurred. Please try again later.');
  }
}

// ── Calibrate ─────────────────────────────────────────────────────────────────

async function turboRankCalibrate(message: Message, args: string[], userDataService: UserDataService) {
  try {
    const target = await resolveTarget(message, args, userDataService);
    if ('error' in target) return message.reply(target.error);

    const progressMsg = await message.reply(
      `🔮 Calibrating hidden Turbo rank for **${target.name}**…\nAnalyzing match history, this may take a minute.`,
    );

    const estimate = await turboRankService.calibratePlayer(
      target.discordId,
      target.steamId,
      100,
      (fetched, total, phase) => {
        if (fetched === 0 || fetched % 10 === 0 || fetched === total) {
          let text = `🔮 Calibrating **${target.name}**… ${phase ?? ''}`;
          if (total > 0) text += ` (${fetched}/${total})`;
          progressMsg.edit(text).catch(() => {});
        }
      },
    );

    if (!estimate) {
      return progressMsg.edit(
        `❌ Calibration failed for **${target.name}** — not enough turbo matches with visible rank data.`,
      );
    }

    // Refresh the name in case calibration resolved it.
    target.name = turboRankService.getSteamName(target.steamId) ?? target.name;
    const observations = turboRankService.getObservationsBySteamId(target.steamId);
    const embed = buildRankEmbed(target, estimate, observations)
      .setTitle(`✅ Calibration Complete — ${target.name}`);

    await progressMsg.edit({ content: null, embeds: [embed] });
  } catch (error) {
    logger.error('Error in turborank calibrate:', error);
    await message.reply('An error occurred during calibration. Please try again later.');
  }
}

// ── Leaderboard ─────────────────────────────────────────────────────────────

async function turboRankAll(message: Message) {
  try {
    const ranked = turboRankService.getAllEstimates();
    if (ranked.length === 0) {
      return message.reply('No players have turbo rank estimates yet. Run `+turborank calibrate` to get started.');
    }

    const lines: string[] = [];
    for (let i = 0; i < ranked.length; i++) {
      const { discordId, steamName, estimate } = ranked[i];
      let name = steamName;
      if (!name && discordId) {
        const user = await message.client.users.fetch(discordId).catch(() => null);
        name = user?.username ?? undefined;
      }
      name = name ?? `Player ${i + 1}`;

      const place = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
      const conf = estimate.confidence >= 70 ? '✅' : estimate.confidence >= 40 ? '⚠️' : '❓';
      const fallback = estimate.partyFallback ? ' · _party-est_' : '';

      lines.push(
        `${place} ${tierToEmoji(estimate.medalTier)} **${name}** — ${estimate.medal}\n` +
        ` ~${estimate.estimatedMMR} MMR · \`${confidenceBar(estimate.confidence)}\` ${estimate.confidence}% ${conf} · ${estimate.soloSampleSize} solo${fallback}`,
      );
    }

    const top = ranked[0];
    const embed = new EmbedBuilder()
      .setColor('#ffd700')
      .setTitle('🔮 Hidden Turbo Rank Leaderboard')
      .setDescription(
        `Estimated hidden Turbo MMR from solo-lobby rank analysis.\n` +
        `👑 Top: **${top.steamName ?? 'Player'}** at **${top.estimate.medal}**\n\n` +
        lines.join('\n'),
      )
      .setFooter({ text: 'medals: ⭐ Immortal 🔴 Divine 🟠 Ancient 🟡 Legend 🟣 Archon 🔵 Crusader 🟢 Guardian 🟤 Herald' })
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in turborank all:', error);
    await message.reply('An error occurred. Please try again later.');
  }
}
