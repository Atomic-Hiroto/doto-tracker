import { Message, EmbedBuilder } from 'discord.js';
import {
  turboRankService,
  rankTierToMedal,
  mmrToMedal,
} from '../services/turboRankService';
import { fetchStratzPlayerProfile } from '../services/stratzClient';
import { TurboRankObservation } from '../models/TurboRank';
import { UserDataService } from '../services/userDataService';
import { logger } from '../services/loggerService';
import { ProcessConstants } from '../constants';

const BULK_CALIBRATE_SUBCOMMANDS = new Set([
  'calibrateall',
  'calibrate-all',
  'calibrate_all',
  'recalibrateall',
  'recalibrate-all',
  'recalibrate_all',
  'recalc-all',
  'recalc_all',
  'caliball',
]);
const BULK_PLAYER_TIMEOUT_MS = 120_000;

/**
 * +turborank [@user | steamId]   — view hidden turbo rank estimate
 * +turborank calibrate [@user | steamId] — retroactive calibration from match history
 * +turborank calibrateall        — owner-only recalibration for registered + manual estimates
 * +turborank audit [@user | steamId] — show exact matches used by the estimate
 * +turborank all                 — leaderboard of all calculated players
 */
export async function turboRank(
  message: Message,
  args: string[],
  userDataService: UserDataService,
) {
  const subcommand = args[0]?.toLowerCase();

  if (subcommand === 'all' || subcommand === 'leaderboard' || subcommand === 'lb') {
    const showEveryone = ['everyone', 'full', 'all'].includes(args[1]?.toLowerCase() ?? '');
    return turboRankAll(message, showEveryone);
  }
  if (subcommand === 'trim' || subcommand === 'prune') {
    return turboRankTrim(message, args.slice(1), userDataService);
  }
  if (subcommand === 'hide' || subcommand === 'show' || subcommand === 'unhide') {
    return turboRankShowHide(message, subcommand === 'hide', args.slice(1), userDataService);
  }
  if (
    (subcommand && BULK_CALIBRATE_SUBCOMMANDS.has(subcommand))
    || ((subcommand === 'calibrate' || subcommand === 'recalc' || subcommand === 'recalibrate') && args[1]?.toLowerCase() === 'all')
  ) {
    return turboRankCalibrateAll(message, userDataService);
  }
  if (subcommand === 'discover' || subcommand === 'peers' || subcommand === 'expand') {
    return turboRankDiscover(message, args.slice(1), userDataService);
  }
  if (subcommand === 'calibrate' || subcommand === 'recalc') {
    return turboRankCalibrate(message, args.slice(1), userDataService);
  }
  if (subcommand === 'audit' || subcommand === 'debug') {
    return turboRankAudit(message, args.slice(1), userDataService);
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

interface BulkRankTarget {
  steamId: string;
  discordId: string;
  name: string;
  source: 'registered' | 'manual';
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

/** "2 Immortal, 1 Divine, 6 unranked" — readable lobby make-up. Null if tiers weren't stored. */
function lobbyComposition(obs: TurboRankObservation): string | null {
  const tiers = obs.tiers ?? []; // older persisted observations may lack tiers
  if (tiers.length === 0) return null;
  const counts = new Map<number, number>(); // tier int → count
  for (const t of tiers) {
    const tier = Math.floor(t / 10);
    counts.set(tier, (counts.get(tier) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const tier of [8, 7, 6, 5, 4, 3, 2, 1]) {
    const c = counts.get(tier);
    if (c) parts.push(`${c} ${rankTierToMedal(tier * 10)}`);
  }
  const unranked = 9 - (obs.visibleRanks ?? tiers.length);
  if (unranked > 0) parts.push(`${unranked} unranked`);
  return parts.join(', ');
}

function confidenceBar(confidence: number): string {
  const filled = Math.round(confidence / 10);
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

function matchLink(matchId: number): string {
  return `[#${matchId}](https://stratz.com/matches/${matchId})`;
}

function formatMatchDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const iso = date.toISOString().slice(0, 10);
  const ageDays = Math.max(0, Math.floor((Date.now() / 1000 - timestamp) / 86400));
  const age = ageDays === 0 ? 'today'
    : ageDays === 1 ? '1d ago'
      : ageDays < 30 ? `${ageDays}d ago`
        : ageDays < 365 ? `${Math.round(ageDays / 30)}mo ago`
          : `${Math.round(ageDays / 365)}y ago`;
  return `${iso} (${age})`;
}

function usedObservations(observations: TurboRankObservation[], partyFallback: boolean): TurboRankObservation[] {
  return partyFallback ? observations : observations.filter(o => o.partySize === 1);
}

function fitLines(lines: string[], emptyText: string, limit = 1000): string {
  if (lines.length === 0) return emptyText;
  const selected: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const nextLen = lines[i].length + (selected.length > 0 ? 1 : 0);
    if (used + nextLen > limit) {
      selected.push(`...and ${lines.length - i} more.`);
      break;
    }
    selected.push(lines[i]);
    used += nextLen;
  }
  return selected.join('\n');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function recentLobbies(observations: TurboRankObservation[], partyFallback: boolean): string {
  const recent = [...usedObservations(observations, partyFallback)].sort((a, b) => b.timestamp - a.timestamp).slice(0, 5);
  if (recent.length === 0) return '_No games on record_';
  return recent
    .map(o => {
      const date = formatMatchDate(o.timestamp);
      const type = o.partySize === 1 ? 'Solo' : `${o.partySize}-stack`;
      const outcome = o.won === true ? 'W' : o.won === false ? 'L' : '—';
      const head = `${matchLink(o.matchId)} · **${mmrToMedal(o.lobbyMMR).medal}** lobby · ${type} · ${outcome} · ${date}`;
      const comp = lobbyComposition(o);
      return comp ? `${head}\n${comp}` : head;
    })
    .join('\n\n');
}

const HOW_TEXT =
  'Dota balances every lobby around your hidden MMR, so the average rank of the other 9 players is a read on your own level. To keep that read accurate, each game is weighted by how trustworthy it is:\n' +
  '• **Solo only** — party games match you to your *stack\'s* average, not yours, so they\'re excluded entirely (used only if you never solo-queue).\n' +
  '• **Recency** — a 60-day half-life means recent games dominate, so the estimate tracks your *current* form rather than old skill.\n' +
  '• **Lobby completeness** — a lobby where 8 players are ranked is far more reliable than one with 3, so thin, mostly-unranked lobbies are down-weighted instead of trusted blindly.\n' +
  '• **Honest uncertainty** — the confidence % and likely range scale with how much solid data backs the estimate, so a 3-game read shows low confidence and a wider range rather than false precision.';

/**
 * Turbo-lean line: how far above/below their visible ranked medal the player
 * actually plays in turbo. The headline finding of the whole estimator.
 */
function formatLean(estimate: { lean?: number | null; rankedTier?: number | null }): string | null {
  if (estimate.lean == null || !estimate.rankedTier) return null;
  const rankedMedal = rankTierToMedal(estimate.rankedTier);
  const lean = estimate.lean;
  if (lean >= 150) {
    return `📈 Plays **+${lean}** MMR above their **${rankedMedal}** ranked medal in turbo.`;
  }
  if (lean <= -150) {
    return `📉 Plays **${lean}** MMR below their **${rankedMedal}** ranked medal in turbo.`;
  }
  return `Plays right around their **${rankedMedal}** ranked medal in turbo.`;
}

/** Dota rank medal icon (medal tier only — the star count is shown in the text). */
function medalIconUrl(tier: number): string {
  const t = Math.min(8, Math.max(1, tier));
  return `https://www.opendota.com/assets/images/dota2/rank_icons/rank_icon_${t}.png`;
}

function buildRankEmbed(target: RankTarget, estimate: NonNullable<ReturnType<typeof turboRankService.getEstimateBySteamId>>, observations: TurboRankObservation[]): EmbedBuilder {
  const confLabel = estimate.confidence >= 80 ? 'High confidence'
    : estimate.confidence >= 50 ? 'Moderate confidence'
    : 'Low confidence — needs more solo games';

  const desc: string[] = [`**${estimate.medal}**  ·  est. ~${estimate.estimatedMMR} MMR`];
  if (estimate.rangeLow && estimate.rangeHigh && estimate.rangeLow !== estimate.rangeHigh) {
    desc.push(`Likely range: ${estimate.rangeLow} – ${estimate.rangeHigh}`);
  }
  const leanLine = formatLean(estimate);
  if (leanLine) desc.push(leanLine);
  if (estimate.partyFallback) {
    desc.push('_Party-based estimate — this player never solo-queues, so it may be skewed by stackmates._');
  }

  const now = Date.now() / 1000;
  const usedObs = usedObservations(observations, estimate.partyFallback);
  const newestTs = usedObs.reduce((m, o) => Math.max(m, o.timestamp), 0);
  const ageDays = newestTs ? Math.floor((now - newestTs) / 86400) : 0;
  const months = Math.max(1, Math.round(ageDays / 30));
  const stale = !estimate.partyFallback && ageDays > 100;
  if (estimate.oldGamesFallback) {
    desc.push(`📜 **No solo games in the last year — this reaches back to their last active turbo stretch (newest ~${months} month${months > 1 ? 's' : ''} ago).** Treat as historical skill, not current form.`);
  } else if (stale) {
    desc.push(`⚠️ **Based on old games — newest is ~${months} month${months > 1 ? 's' : ''} ago.** May be out of date; play recent solo turbo to refresh.`);
  }

  const embed = new EmbedBuilder()
    .setColor(estimate.partyFallback || estimate.confidence < 40 || stale ? '#9ca3af' : estimate.confidence < 60 ? '#eab308' : '#8b5cf6')
    .setTitle(`🔮 Hidden Turbo Rank — ${target.name}`)
    .setDescription(
      (estimate.partyFallback
        ? "⚠️ **Rough, party-based estimate — don't trust this as a real rank.**\n\n"
        : estimate.confidence < 40
          ? '⚠️ **Low-confidence estimate — treat as a rough guess, not a verified rank.**\n\n'
          : '') + desc.join('\n'),
    )
    .addFields(
      {
        name: 'Confidence',
        value: `${confidenceBar(estimate.confidence)}  ${estimate.confidence}% · ${confLabel}`,
        inline: false,
      },
      {
        name: 'Based on',
        value: estimate.partyFallback
          ? `${estimate.sampleSize} party matches (no solo games found)\nEffective sample: **${estimate.effectiveSample}** visible-rank-weighted lobbies`
          : `${estimate.soloSampleSize} solo matches\nEffective sample: **${estimate.effectiveSample}** visible-rank-weighted lobbies`,
        inline: false,
      },
      {
        name: estimate.partyFallback ? 'Recent Lobbies' : 'Recent Solo Lobbies',
        value: recentLobbies(observations, estimate.partyFallback),
        inline: false,
      },
      { name: 'How this is calculated', value: HOW_TEXT, inline: false },
    )
    .setFooter({ text: `updated ${new Date(estimate.lastUpdated).toLocaleDateString()}` })
    .setTimestamp();

  embed.setThumbnail(medalIconUrl(estimate.medalTier));
  return embed;
}

function buildAuditEmbed(target: RankTarget, estimate: NonNullable<ReturnType<typeof turboRankService.getEstimateBySteamId>>, observations: TurboRankObservation[]): EmbedBuilder {
  const used = [...usedObservations(observations, estimate.partyFallback)].sort((a, b) => b.timestamp - a.timestamp);
  const visibleAvg = used.length
    ? used.reduce((sum, obs) => sum + obs.visibleRanks, 0) / used.length
    : 0;
  const newest = used[0]?.timestamp;
  const oldest = used[used.length - 1]?.timestamp;
  const ageText = newest
    ? `${Math.floor((Date.now() / 1000 - newest) / 86400)}d since newest`
    : 'no usable observations';
  const qualityFlags: string[] = [];
  if (estimate.partyFallback) qualityFlags.push('party fallback');
  if (estimate.confidence < 50) qualityFlags.push('low confidence');
  if (estimate.soloSampleSize < 15 && !estimate.partyFallback) qualityFlags.push('thin solo sample');
  if (estimate.effectiveSample < 8) qualityFlags.push('low effective sample');

  const lines = used.slice(0, 12).map((obs) => {
    const type = obs.partySize === 1 ? 'solo' : `${obs.partySize}-stack`;
    const outcome = obs.won === true ? 'W' : obs.won === false ? 'L' : '-';
    const date = formatMatchDate(obs.timestamp);
    return `${matchLink(obs.matchId)} · **${mmrToMedal(obs.lobbyMMR).medal}** · ${type} · ${outcome} · ${obs.visibleRanks}/9 ranks · ${date}`;
  });

  return new EmbedBuilder()
    .setColor(estimate.partyFallback || estimate.confidence < 50 ? '#9ca3af' : '#8b5cf6')
    .setTitle(`🔎 Turbo Rank Audit — ${target.name}`)
    .setDescription(`Estimate: **${estimate.medal}** (~${estimate.estimatedMMR} MMR), confidence **${estimate.confidence}%**`)
    .addFields(
      {
        name: 'Sample Health',
        value:
          `Used observations: **${used.length}** / stored **${observations.length}**\n` +
          `Solo observations: **${estimate.soloSampleSize}** | effective sample: **${estimate.effectiveSample}**\n` +
          `Average visible ranks: **${visibleAvg.toFixed(1)}/9** | ${ageText}\n` +
          `Window: ${oldest ? formatMatchDate(oldest) : 'n/a'} – ${newest ? formatMatchDate(newest) : 'n/a'}`,
        inline: false,
      },
      {
        name: 'Quality Flags',
        value: qualityFlags.length ? qualityFlags.join(', ') : 'No major flags.',
        inline: false,
      },
      {
        name: 'Recent Used Matches',
        value: fitLines(lines, '_No usable observations_'),
        inline: false,
      },
      {
        name: 'What To Check',
        value: 'Open the linked matches and verify the player actually solo-queued. If party games appear here as solo, recalibration is contaminated and the estimator should not be trusted for that player.',
        inline: false,
      },
    )
    .setTimestamp();
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

    // A manual calibrate is an explicit "I vouch for this player" — promote them
    // onto the leaderboard even if they were originally peer-discovered.
    turboRankService.setDiscovered(target.steamId, false);

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

function getBulkCalibrationTargets(userDataService: UserDataService): BulkRankTarget[] {
  const bySteamId = new Map<string, BulkRankTarget>();

  for (const user of userDataService.getAllUsers()) {
    bySteamId.set(user.steamId, {
      steamId: user.steamId,
      discordId: user.discordId,
      name: turboRankService.getSteamName(user.steamId) ?? `Steam ${user.steamId}`,
      source: 'registered',
    });
  }

  for (const entry of turboRankService.getAllEstimates()) {
    if (bySteamId.has(entry.steamId)) continue;
    bySteamId.set(entry.steamId, {
      steamId: entry.steamId,
      discordId: entry.discordId,
      name: entry.steamName ?? `Steam ${entry.steamId}`,
      source: 'manual',
    });
  }

  return [...bySteamId.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'registered' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ── Bulk Calibrate ───────────────────────────────────────────────────────────

async function turboRankCalibrateAll(message: Message, userDataService: UserDataService) {
  if (message.author.id !== ProcessConstants.BOT_OWNER_ID) {
    return message.reply('❌ Only the bot owner can bulk recalibrate Turbo ranks.');
  }

  let progressMsg: Message | null = null;

  try {
    const targets = getBulkCalibrationTargets(userDataService);
    if (targets.length === 0) {
      return message.reply('No registered or manually calibrated players found to recalibrate.');
    }

    logger.info(`Bulk Turbo rank recalibration requested by ${message.author.tag} (${message.author.id}) for ${targets.length} players`);

    progressMsg = await message.reply(
      `🔮 Bulk recalibrating Turbo ranks for **${targets.length}** players...\n` +
      `Includes registered users and Steam-ID-only manual calibrations. This can take several minutes.`,
    );

    const successes: Array<{ target: BulkRankTarget; medal: string; confidence: number }> = [];
    const failures: BulkRankTarget[] = [];

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      let lastProgressEdit = 0;
      await progressMsg.edit(
        `🔮 Bulk recalibrating Turbo ranks... **${i + 1}/${targets.length}**\n` +
        `Now: **${target.name}** (${target.steamId}, ${target.source})\n` +
        `Done: ${successes.length} ok, ${failures.length} failed`,
      ).catch(() => {});

      try {
        logger.info(`Bulk Turbo rank recalibrating ${target.name} (${target.steamId}, ${target.source})`);
        const estimate = await withTimeout(
          turboRankService.calibratePlayer(
            target.discordId,
            target.steamId,
            100,
            (fetched, total, phase) => {
              const now = Date.now();
              if (now - lastProgressEdit < 5000 && fetched !== total) return;
              lastProgressEdit = now;
              let text =
                `🔮 Bulk recalibrating Turbo ranks... **${i + 1}/${targets.length}**\n` +
                `Now: **${target.name}** (${target.steamId}, ${target.source})\n` +
                `Status: ${phase ?? 'fetching match history'}`;
              if (total > 0) text += ` (${fetched}/${total})`;
              text += `\nDone: ${successes.length} ok, ${failures.length} failed`;
              progressMsg?.edit(text).catch(() => {});
            },
          ),
          BULK_PLAYER_TIMEOUT_MS,
          `Timed out after ${Math.round(BULK_PLAYER_TIMEOUT_MS / 1000)}s`,
        );

        const refreshedName = turboRankService.getSteamName(target.steamId);
        if (refreshedName) target.name = refreshedName;

        if (estimate) {
          successes.push({ target, medal: estimate.medal, confidence: estimate.confidence });
        } else {
          failures.push(target);
        }
      } catch (error) {
        logger.error(`Bulk Turbo rank calibration failed for ${target.name} (${target.steamId})`, error);
        failures.push(target);
      }

      if (i < targets.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }

    const topLines = successes
      .slice()
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 10)
      .map((entry) => `**${entry.target.name}** — ${entry.medal}, ${entry.confidence}% conf`);
    const failureLines = failures.map((target) => `**${target.name}** (${target.steamId})`);

    const embed = new EmbedBuilder()
      .setColor(failures.length ? '#eab308' : '#10b981')
      .setTitle('✅ Bulk Turbo Rank Recalibration Complete')
      .setDescription(`Processed **${targets.length}** players: **${successes.length}** updated, **${failures.length}** failed.`)
      .addFields(
        {
          name: 'Updated',
          value: fitLines(topLines, '_No successful calibrations_'),
          inline: false,
        },
        {
          name: 'Failed / No Usable Rank Data',
          value: fitLines(failureLines, '_None_'),
          inline: false,
        },
        {
          name: 'Next',
          value: 'Run `+turbostudy` to compare the refreshed estimates, or `+turborank audit <steamId>` for suspicious outliers.',
          inline: false,
        },
      )
      .setTimestamp();

    await progressMsg.edit({ content: null, embeds: [embed] });
  } catch (error) {
    logger.error('Error in turborank calibrateall:', error);
    const text = '❌ Bulk recalibration failed before it could finish. Check the bot logs, then try again.';
    if (progressMsg) {
      await progressMsg.edit(text).catch(() => message.reply(text).catch(() => {}));
    } else {
      await message.reply(text).catch(() => {});
    }
  }
}

// ── Discover Peers ───────────────────────────────────────────────────────────

/**
 * +turborank discover <@user | steamId> [minLobbies]
 * Owner-only. Harvests a seed player's recurring same-team turbo peers (default
 * 3+ shared lobbies, visible ranked medal, not already tracked) and calibrates
 * each into the dataset. Grows the turbo-study sample from one anchor player.
 */
async function turboRankDiscover(message: Message, args: string[], userDataService: UserDataService) {
  if (message.author.id !== ProcessConstants.BOT_OWNER_ID) {
    return message.reply('❌ Only the bot owner can run peer discovery (it spawns many calibrations).');
  }

  const minLobbies = looksLikeSteamId(args[1]) ? undefined : parseInt(args[1] ?? '', 10);
  const minCoOccurrence = Number.isFinite(minLobbies) && (minLobbies as number) > 0 ? (minLobbies as number) : 3;

  let progressMsg: Message | null = null;

  try {
    const target = await resolveTarget(message, args, userDataService);
    if ('error' in target) return message.reply(target.error);

    progressMsg = await message.reply(
      `🕸️ Discovering **${target.name}**'s turbo peers (same team, **${minCoOccurrence}+** shared lobbies, visible medal)…`,
    );

    const { candidates, matchesScanned, seedName } = await withTimeout(
      turboRankService.discoverPeerCandidates(target.steamId, minCoOccurrence),
      BULK_PLAYER_TIMEOUT_MS,
      `Timed out scanning ${target.name}'s match history`,
    );

    if (candidates.length === 0) {
      return progressMsg.edit(
        `🕸️ Scanned **${matchesScanned}** of ${seedName ?? target.name}'s turbo matches — ` +
        `found no new peers with **${minCoOccurrence}+** shared lobbies and a visible ranked medal. ` +
        `(Already-tracked players are skipped.)`,
      );
    }

    logger.info(
      `Peer discovery by ${message.author.tag}: ${candidates.length} new candidates from ${seedName ?? target.steamId} ` +
      `(${matchesScanned} matches, min ${minCoOccurrence})`,
    );

    const successes: Array<{ steamId: string; name: string; medal: string; confidence: number }> = [];
    const failures: Array<{ steamId: string; coOccurrences: number }> = [];

    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      let lastProgressEdit = 0;
      await progressMsg.edit(
        `🕸️ Found **${candidates.length}** new peers of ${seedName ?? target.name}. Calibrating **${i + 1}/${candidates.length}**…\n` +
        `Now: \`${cand.steamId}\` (${cand.coOccurrences} shared lobbies)\n` +
        `Done: ${successes.length} ok, ${failures.length} failed`,
      ).catch(() => {});

      try {
        const estimate = await withTimeout(
          turboRankService.calibratePlayer(
            '',
            cand.steamId,
            100,
            (fetched, total, phase) => {
              const now = Date.now();
              if (now - lastProgressEdit < 5000 && fetched !== total) return;
              lastProgressEdit = now;
              let text =
                `🕸️ Calibrating new peers **${i + 1}/${candidates.length}**\n` +
                `Now: \`${cand.steamId}\` (${cand.coOccurrences} shared lobbies)\n` +
                `Status: ${phase ?? 'fetching match history'}`;
              if (total > 0) text += ` (${fetched}/${total})`;
              text += `\nDone: ${successes.length} ok, ${failures.length} failed`;
              progressMsg?.edit(text).catch(() => {});
            },
          ),
          BULK_PLAYER_TIMEOUT_MS,
          `Timed out after ${Math.round(BULK_PLAYER_TIMEOUT_MS / 1000)}s`,
        );

        if (estimate) {
          turboRankService.setDiscovered(cand.steamId, true); // hide from default leaderboard
          const name = turboRankService.getSteamName(cand.steamId) ?? `Steam ${cand.steamId}`;
          successes.push({ steamId: cand.steamId, name, medal: estimate.medal, confidence: estimate.confidence });
        } else {
          failures.push({ steamId: cand.steamId, coOccurrences: cand.coOccurrences });
        }
      } catch (error) {
        logger.error(`Peer discovery calibration failed for ${cand.steamId}`, error);
        failures.push({ steamId: cand.steamId, coOccurrences: cand.coOccurrences });
      }

      if (i < candidates.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }

    const okLines = successes
      .slice()
      .sort((a, b) => b.confidence - a.confidence)
      .map(s => `**${s.name}** — ${s.medal}, ${s.confidence}% conf`);
    const failLines = failures.map(f => `\`${f.steamId}\` (${f.coOccurrences} lobbies)`);

    const embed = new EmbedBuilder()
      .setColor(failures.length ? '#eab308' : '#10b981')
      .setTitle('🕸️ Peer Discovery Complete')
      .setDescription(
        `Scanned **${matchesScanned}** of ${seedName ?? target.name}'s turbo matches. ` +
        `Added **${successes.length}** new player(s) to the dataset` +
        (failures.length ? `, **${failures.length}** had no usable rank data.` : '.'),
      )
      .addFields(
        { name: 'Added', value: fitLines(okLines, '_None_'), inline: false },
        { name: 'Skipped / No Usable Data', value: fitLines(failLines, '_None_'), inline: false },
        { name: 'Next', value: 'Run `+turbostudy` to see how the bigger sample moves the fit, MAE and bracket bias.', inline: false },
      )
      .setTimestamp();

    await progressMsg.edit({ content: null, embeds: [embed] });
  } catch (error) {
    logger.error('Error in turborank discover:', error);
    const text = '❌ Peer discovery failed before it could finish. Check the bot logs, then try again.';
    if (progressMsg) {
      await progressMsg.edit(text).catch(() => message.reply(text).catch(() => {}));
    } else {
      await message.reply(text).catch(() => {});
    }
  }
}

// ── Trim (backfill discovered flag) ──────────────────────────────────────────

/**
 * +turborank trim <@user | steamId>
 * Owner-only. Re-harvests a seed's recurring peers and flags the ones already in
 * the dataset as `discovered`, so they drop off the default leaderboard. This
 * back-fills players that peer-discovery added before the flag existed. Registered
 * users are never touched, and a later manual `+turborank calibrate` re-promotes
 * anyone you want back on the board.
 */
async function turboRankTrim(message: Message, args: string[], userDataService: UserDataService) {
  if (message.author.id !== ProcessConstants.BOT_OWNER_ID) {
    return message.reply('❌ Only the bot owner can trim the leaderboard.');
  }

  const minLobbies = looksLikeSteamId(args[1]) ? undefined : parseInt(args[1] ?? '', 10);
  const minCoOccurrence = Number.isFinite(minLobbies) && (minLobbies as number) > 0 ? (minLobbies as number) : 3;

  try {
    const target = await resolveTarget(message, args, userDataService);
    if ('error' in target) return message.reply(target.error);

    const progressMsg = await message.reply(
      `✂️ Re-scanning **${target.name}**'s peers to flag discovered players (${minCoOccurrence}+ shared lobbies)…`,
    );

    const { candidates, matchesScanned, seedName } = await withTimeout(
      turboRankService.discoverPeerCandidates(target.steamId, minCoOccurrence, 200, true),
      BULK_PLAYER_TIMEOUT_MS,
      `Timed out scanning ${target.name}'s match history`,
    );

    const flagged: string[] = [];
    for (const cand of candidates) {
      const player = turboRankService.getPlayerBySteamId(cand.steamId);
      // Only flag players that exist, aren't registered, and aren't already flagged.
      if (player && !player.discordId && !player.discovered) {
        turboRankService.setDiscovered(cand.steamId, true);
        flagged.push(turboRankService.getSteamName(cand.steamId) ?? cand.steamId);
      }
    }

    logger.info(`Trim by ${message.author.tag}: flagged ${flagged.length} discovered from ${seedName ?? target.steamId}`);

    const embed = new EmbedBuilder()
      .setColor('#10b981')
      .setTitle('✂️ Leaderboard Trimmed')
      .setDescription(
        `Re-scanned **${matchesScanned}** of ${seedName ?? target.name}'s matches. ` +
        `Flagged **${flagged.length}** peer-discovered player(s) as hidden.\n` +
        'They stay in the dataset (and `+turbostudy`) but leave the default `+turborank all`.',
      )
      .addFields(
        { name: 'Now hidden', value: fitLines(flagged.map(n => `**${n}**`), '_None — nothing to trim_'), inline: false },
        { name: 'Note', value: 'Registered users were left alone. To put someone back, run `+turborank calibrate <id>`.', inline: false },
      )
      .setTimestamp();

    await progressMsg.edit({ content: null, embeds: [embed] });
  } catch (error) {
    logger.error('Error in turborank trim:', error);
    await message.reply('❌ Trim failed. Check the bot logs and try again.');
  }
}

// ── Show / Hide (manual leaderboard control) ─────────────────────────────────

/**
 * +turborank hide <@user | steamId | name>  — drop someone from the default board
 * +turborank show <@user | steamId | name>  — put them back on it
 * Owner-only. The reliable, explicit override when discovery/heuristics get it wrong.
 */
async function turboRankShowHide(message: Message, hide: boolean, args: string[], userDataService: UserDataService) {
  if (message.author.id !== ProcessConstants.BOT_OWNER_ID) {
    return message.reply('❌ Only the bot owner can manage the leaderboard.');
  }
  if (args.length === 0) {
    return message.reply(`Usage: \`+turborank ${hide ? 'hide' : 'show'} <@user | steamId | name>\``);
  }

  // Resolve by @user/steamId first; otherwise treat the rest of the args as a name.
  let player = undefined as ReturnType<typeof turboRankService.getPlayerBySteamId>;
  const mentioned = message.mentions.users.first();
  const idArg = args.find(looksLikeSteamId);
  if (mentioned) {
    const u = userDataService.getUserByDiscordId(mentioned.id);
    if (u) player = turboRankService.getPlayerBySteamId(u.steamId);
  } else if (idArg) {
    player = turboRankService.getPlayerBySteamId(idArg);
  } else {
    player = turboRankService.getPlayerByName(args.join(' '));
  }

  if (!player) {
    return message.reply(`No tracked player matched **${args.join(' ')}**. Try a steamId or exact name.`);
  }

  turboRankService.setDiscovered(player.steamId, hide);
  const who = player.steamName ?? player.steamId;
  return message.reply(
    hide
      ? `🙈 **${who}** hidden from the default \`+turborank all\`. (Still in the dataset & \`+turbostudy\`.)`
      : `👀 **${who}** is back on the default \`+turborank all\`.`,
  );
}

// ── Audit ────────────────────────────────────────────────────────────────────

async function turboRankAudit(message: Message, args: string[], userDataService: UserDataService) {
  try {
    const target = await resolveTarget(message, args, userDataService);
    if ('error' in target) return message.reply(target.error);

    const estimate = turboRankService.getEstimateBySteamId(target.steamId);
    if (!estimate) {
      return message.reply(`No turbo rank estimate for **${target.name}** yet. Run \`+turborank calibrate ${target.steamId}\` first.`);
    }

    const observations = turboRankService.getObservationsBySteamId(target.steamId);
    await message.reply({ embeds: [buildAuditEmbed(target, estimate, observations)] });
  } catch (error) {
    logger.error('Error in turborank audit:', error);
    await message.reply('An error occurred while building the audit. Please try again later.');
  }
}

// ── Leaderboard ─────────────────────────────────────────────────────────────

/** Quality bar for the default board — keeps out tiny-sample / low-conf / party guesses. */
const LB_MIN_SOLO = 10;
const LB_MIN_CONF = 40;
function isLeaderboardQuality(estimate: { confidence: number; soloSampleSize: number; partyFallback: boolean }): boolean {
  return !estimate.partyFallback && estimate.confidence >= LB_MIN_CONF && estimate.soloSampleSize >= LB_MIN_SOLO;
}

async function turboRankAll(message: Message, showEveryone = false) {
  try {
    const all = turboRankService.getAllEstimates();
    if (all.length === 0) {
      return message.reply('No players have turbo rank estimates yet. Run `+turborank calibrate` to get started.');
    }

    // Default board: your crew only (registered + manually calibrated), and only
    // solid estimates. `everyone` shows the full dataset, discovered + provisional.
    const hiddenDiscovered = showEveryone ? 0 : all.filter(r => r.discovered).length;
    const shown = showEveryone ? all : all.filter(r => !r.discovered);
    const provisional = shown.filter(r => !isLeaderboardQuality(r.estimate));
    const ranked = showEveryone ? shown : shown.filter(r => isLeaderboardQuality(r.estimate));

    if (ranked.length === 0) {
      return message.reply(
        'No players meet the leaderboard quality bar yet (need >=10 solo games and >=40% confidence). ' +
        'Try `+turborank all everyone` to see every estimate.',
      );
    }

    const lines: string[] = [];
    for (let i = 0; i < ranked.length; i++) {
      const { discordId, steamName, discovered, estimate } = ranked[i];
      let name = steamName;
      if (!name && discordId) {
        const user = await message.client.users.fetch(discordId).catch(() => null);
        name = user?.username ?? undefined;
      }
      name = name ?? `Player ${i + 1}`;

      const place = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
      const conf = estimate.confidence >= 70 ? '✅' : estimate.confidence >= 40 ? '⚠️' : '❓';
      const fallback = estimate.partyFallback ? ' · _party-est_' : '';
      const tag = showEveryone && discovered ? ' · _discovered_' : '';

      lines.push(
        `${place}  **${name}** — ${estimate.medal} ${conf}\n` +
        ` ~${estimate.estimatedMMR} MMR · ${estimate.confidence}% conf · ${estimate.soloSampleSize} solo${fallback}${tag}`,
      );
    }

    const footerBits: string[] = [];
    if (!showEveryone && hiddenDiscovered > 0) footerBits.push(`${hiddenDiscovered} discovered hidden`);
    if (!showEveryone && provisional.length > 0) footerBits.push(`${provisional.length} provisional (need more games)`);
    const footerNote = footerBits.length ? `\n\n_See \`+turborank all everyone\` for ${footerBits.join(' and ')}._` : '';

    const top = ranked[0];
    const embed = new EmbedBuilder()
      .setColor('#ffd700')
      .setTitle(showEveryone ? '🔮 Hidden Turbo Rank — Everyone' : '🔮 Hidden Turbo Rank Leaderboard')
      .setDescription(
        `Estimated hidden Turbo MMR from solo-lobby rank analysis.\n` +
        `👑 Top: **${top.steamName ?? 'Player'}** at **${top.estimate.medal}**\n\n` +
        lines.join('\n') +
        footerNote,
      )
      .setFooter({ text: 'medals: ⭐ Immortal 🔴 Divine 🟠 Ancient 🟡 Legend 🟣 Archon 🔵 Crusader 🟢 Guardian 🟤 Herald' })
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  } catch (error) {
    logger.error('Error in turborank all:', error);
    await message.reply('An error occurred. Please try again later.');
  }
}
