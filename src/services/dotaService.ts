import { Client, TextBasedChannel, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { Match } from '../models/Match';
import { UserDataService } from './userDataService';
import { TurboStatsService } from './turboStatsService';
import { formatDuration } from '../utils/formatters';
import { APIConstants, ChannelConstants, ProcessConstants } from '../constants';
import { logger } from './loggerService';
import { opendotaClient } from './apiClient';
import { dotaDataService } from './dotaDataService';
import { safeSend } from '../utils/channelHelpers';
import { gradeActivePlanForMatch } from './coachingPlanService';
import { renderScoreboardFromMatch } from './chartService';
import { achievementService, MatchContext } from './achievementService';
import { streakService } from './streakService';
import { turboRankService } from './turboRankService';

const GAME_MODE_NAMES: Record<number, string> = {
  0: 'Unknown', 1: 'All Pick', 2: 'Captains Mode', 3: 'Random Draft',
  4: 'Single Draft', 5: 'All Random', 8: 'Reverse Captains Mode',
  16: 'Captains Draft', 22: 'All Draft', 23: 'Turbo', 24: 'Mutation',
};

function highestRecordedKey(counts: Record<string, number> | undefined): number {
  return Math.max(0, ...Object.entries(counts || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([key]) => Number(key))
    .filter(Number.isFinite));
}

function comebackDeficit(match: any, isRadiant: boolean, won: boolean): number | undefined {
  if (!won || !Array.isArray(match?.radiant_gold_adv) || match.radiant_gold_adv.length === 0) return undefined;
  const advantages = match.radiant_gold_adv.map(Number).filter(Number.isFinite);
  if (advantages.length === 0) return undefined;
  return isRadiant ? Math.max(0, -Math.min(...advantages)) : Math.max(0, Math.max(...advantages));
}

function parsedAchievementContext(match: any, detailedPlayer: any, isRadiant: boolean, won: boolean): Partial<MatchContext> {
  if (!match || !detailedPlayer) return {};
  const itemIds = ['item_0', 'item_1', 'item_2', 'item_3', 'item_4', 'item_5', 'backpack_0', 'backpack_1', 'backpack_2']
    .map(slot => Number(detailedPlayer[slot] || 0));
  const boughtDivineRapier = (detailedPlayer.purchase_log || []).some((entry: any) => entry.key === 'rapier')
    || itemIds.some(itemId => dotaDataService.getItemInternalName(itemId) === 'rapier');

  return {
    firstBloodClaimed: Number(detailedPlayer.firstblood_claimed || 0) > 0,
    maxMultiKill: highestRecordedKey(detailedPlayer.multi_kills),
    maxKillStreak: highestRecordedKey(detailedPlayer.kill_streaks),
    denies: detailedPlayer.denies,
    towerDamage: detailedPlayer.tower_damage,
    towerKills: detailedPlayer.tower_kills,
    roshanKills: detailedPlayer.roshan_kills,
    wardsPlaced: Number(detailedPlayer.obs_placed || 0) + Number(detailedPlayer.sen_placed || 0),
    wardsDestroyed: Number(detailedPlayer.observer_kills || 0) + Number(detailedPlayer.sentry_kills || 0),
    campsStacked: detailedPlayer.camps_stacked,
    stunDuration: detailedPlayer.stuns,
    teamfightParticipation: detailedPlayer.teamfight_participation,
    comebackDeficit: comebackDeficit(match, isRadiant, won),
    runePickups: detailedPlayer.rune_pickups,
    actionsPerMinute: detailedPlayer.actions_per_min,
    buybacks: detailedPlayer.buyback_count,
    boughtDivineRapier,
    maxHeroHit: detailedPlayer.max_hero_hit?.value,
  };
}

// Cadence guard for the pending-parse recheck; see PARSED_RECHECK_INTERVAL.
let lastParsedRecheck = 0;

async function processPendingParsedAchievements(
  channel: TextBasedChannel,
  userDataService: UserDataService,
): Promise<void> {
  const matchRequests = new Map<number, Promise<any>>();
  for (const user of userDataService.getAllUsers()) {
    const pending = user.pendingParsedAchievements || [];
    if (pending.length === 0) continue;

    const remaining: number[] = [];
    for (const matchId of pending.slice(0, 5)) {
      try {
        if (!matchRequests.has(matchId)) {
          matchRequests.set(matchId, opendotaClient.get(`/matches/${matchId}`).then(response => response.data));
        }
        const match = await matchRequests.get(matchId)!;
        if (!match?.version) {
          // Some matches never get parsed. Drop those instead of re-fetching them
          // every cycle forever; keep the entry when start_time is unknown so a
          // bad response cannot evict a match that is still legitimately waiting.
          const startMs = Number(match?.start_time || 0) * 1000;
          const tooOld = startMs > 0 && Date.now() - startMs > ProcessConstants.PARSED_PENDING_MAX_AGE_MS;
          if (tooOld) logger.info(`Giving up on parse for match ${matchId} (unparsed after cutoff)`);
          else remaining.push(matchId);
          continue;
        }

        const detailedPlayer = match.players?.find((p: any) => String(p.account_id) === String(user.steamId));
        if (!detailedPlayer) continue;
        const isRadiant = detailedPlayer.player_slot < 128;
        const won = (isRadiant && match.radiant_win) || (!isRadiant && !match.radiant_win);
        const unlocked = achievementService.checkAchievements(user.discordId, {
          gameMode: Number(match.game_mode),
          matchId,
          won,
          isRadiant,
          kills: detailedPlayer.kills,
          deaths: detailedPlayer.deaths,
          assists: detailedPlayer.assists,
          gpm: detailedPlayer.gold_per_min,
          xpm: detailedPlayer.xp_per_min,
          heroDamage: detailedPlayer.hero_damage,
          heroHealing: detailedPlayer.hero_healing,
          lastHits: detailedPlayer.last_hits,
          durationMin: Number.isFinite(Number(match.duration)) ? Number(match.duration) / 60 : undefined,
          partySize: detailedPlayer.party_size,
          ...parsedAchievementContext(match, detailedPlayer, isRadiant, won),
        });
        if (user.autoShow && unlocked.length > 0) {
          const username = (await channel.client.users.fetch(user.discordId)).username;
          await safeSend(channel, achievementService.formatAnnouncement(unlocked, user.discordId, username));
        }
      } catch (error) {
        remaining.push(matchId);
        logger.error(`Error rechecking parsed achievements for match ${matchId}:`, error);
      }
    }

    user.pendingParsedAchievements = [...remaining, ...pending.slice(5)].slice(-20);
    userDataService.updateUser(user);
  }
}

// Records streak/achievement progress for one registered player on a newly
// detected match, and announces any milestones. Safe against double counting
// because the caller only enqueues a match once (via user.lastCheckedMatch).
async function trackMatchForPlayer(
  player: { discordId: string; steamId: string; match: any },
  channel: TextBasedChannel,
  userDataService: UserDataService,
  turboStatsService?: TurboStatsService,
  fullMatch?: any,
  shouldAnnounce = true,
) {
  try {
    const summary = player.match;
    const gameMode = Number(fullMatch?.game_mode ?? summary.game_mode);
    const isTurbo = gameMode === 23;
    const isRadiant = summary.player_slot < 128;
    const won = (isRadiant && summary.radiant_win) || (!isRadiant && !summary.radiant_win);
    const detailedPlayer = fullMatch?.players?.find((p: any) => String(p.account_id) === String(player.steamId))
      || fullMatch?.players?.find((p: any) => p.player_slot === summary.player_slot);

    // Turbo stats were already updated for this match before this call.
    const turbo = turboStatsService?.getPlayerStats(player.discordId);

    // Keep legacy all-mode counters for compatibility, but achievement progress
    // uses only the separate Turbo state below.
    let totalMatches: number | undefined;
    let heroPoolSize: number | undefined;
    let winStreak: number | undefined;
    let heroGames: number | undefined;
    const user = userDataService.getUserByDiscordId(player.discordId);
    if (user) {
      user.matchesTracked = (user.matchesTracked || 0) + 1;
      if (summary.hero_id) {
        user.heroesPlayed = user.heroesPlayed || [];
        if (!user.heroesPlayed.includes(summary.hero_id)) user.heroesPlayed.push(summary.hero_id);
      }

      if (isTurbo) {
        const turboGames = turbo ? turbo.wins + turbo.losses : undefined;
        user.turboMatchesTracked = turboGames !== undefined
          ? Math.max(user.turboMatchesTracked || 0, turboGames)
          : (user.turboMatchesTracked || 0) + 1;

        // Preserve existing hero-pool progress on first migration, then only add
        // heroes from Turbo matches going forward.
        user.turboHeroesPlayed = user.turboHeroesPlayed || [...(user.heroesPlayed || [])];
        if (summary.hero_id && !user.turboHeroesPlayed.includes(summary.hero_id)) {
          user.turboHeroesPlayed.push(summary.hero_id);
        }

        user.turboWinStreak = won ? (user.turboWinStreak || 0) + 1 : 0;
        user.turboHeroStats = user.turboHeroStats || {};
        if (summary.hero_id) {
          const heroKey = String(summary.hero_id);
          const heroStats = user.turboHeroStats[heroKey] || { games: 0, wins: 0 };
          heroStats.games += 1;
          if (won) heroStats.wins += 1;
          user.turboHeroStats[heroKey] = heroStats;
          heroGames = heroStats.games;
        }

        totalMatches = user.turboMatchesTracked;
        heroPoolSize = user.turboHeroesPlayed.length;
        winStreak = user.turboWinStreak;

        if (!fullMatch?.version) {
          user.pendingParsedAchievements = user.pendingParsedAchievements || [];
          if (!user.pendingParsedAchievements.includes(summary.match_id)) {
            user.pendingParsedAchievements.push(summary.match_id);
            user.pendingParsedAchievements = user.pendingParsedAchievements.slice(-20);
          }
        }
      }

      userDataService.updateUser(user);
    }

    const streakEvent = streakService.updateStreak(player.discordId, won);

    const username = (await channel.client.users.fetch(player.discordId)).username;
    const newAchievements = achievementService.checkAchievements(player.discordId, {
      kills: summary.kills,
      deaths: summary.deaths,
      assists: summary.assists,
      won,
      matchId: summary.match_id,
      isRadiant,
      gameMode,
      totalMatches,
      winStreak,
      turboRating: turbo?.rating,
      turboGames: totalMatches,
      gpm: detailedPlayer?.gold_per_min ?? summary.gold_per_min,
      xpm: detailedPlayer?.xp_per_min ?? summary.xp_per_min,
      heroDamage: detailedPlayer?.hero_damage ?? summary.hero_damage,
      heroHealing: detailedPlayer?.hero_healing ?? summary.hero_healing,
      lastHits: detailedPlayer?.last_hits ?? summary.last_hits,
      durationMin: (fullMatch?.duration ?? summary.duration) ? (fullMatch?.duration ?? summary.duration) / 60 : undefined,
      partySize: detailedPlayer?.party_size ?? summary.party_size,
      heroPoolSize,
      heroGames,
      ...parsedAchievementContext(fullMatch, detailedPlayer, isRadiant, won),
    });

    if (shouldAnnounce && streakEvent) {
      await safeSend(channel, streakService.getStreakAnnouncement(streakEvent, username));
    }
    if (shouldAnnounce && newAchievements.length > 0) {
      await safeSend(
        channel,
        achievementService.formatAnnouncement(newAchievements, player.discordId, username),
      );
    }
  } catch (error) {
    logger.error(`Error tracking match for ${player.discordId}:`, error);
  }
}

export async function checkNewMatches(client: Client, userDataService: UserDataService, turboStatsService?: TurboStatsService) {
  const guild = client.guilds.cache.first();
  if (!guild) {
    logger.error('Bot is not in any guild');
    return;
  }

  const channel = guild.channels.cache.find(ch => ch.name === ChannelConstants.DOTO_TRACKER_CHANNEL);
  if (!channel || !channel.isTextBased()) {
    logger.error('Could not find a suitable text-based channel to post updates');
    return;
  }

  if (Date.now() - lastParsedRecheck >= ProcessConstants.PARSED_RECHECK_INTERVAL) {
    lastParsedRecheck = Date.now();
    await processPendingParsedAchievements(channel, userDataService);
  }

  const recentMatches = new Map<number, Array<{ discordId: string; steamId: string; match: any; shouldPost: boolean }>>();

  for (const user of userDataService.getAllUsers()) {
    try {
      const response = await opendotaClient.get<Array<any>>(`/players/${user.steamId}/recentMatches?limit=20`);
      const matches = response.data || [];
      if (matches.length === 0) continue;

      const latestMatchId = matches[0]?.match_id;
      if (!latestMatchId) continue;

      const lastChecked = user.lastCheckedMatch;
      const lastCheckedIndex = lastChecked
        ? matches.findIndex((match) => match.match_id === lastChecked)
        : -1;
      const unseen = lastChecked
        ? (lastCheckedIndex >= 0 ? matches.slice(0, lastCheckedIndex) : matches)
        : matches.slice(0, 1);

      if (unseen.length > 0 || user.lastCheckedMatch !== latestMatchId) {
        user.lastCheckedMatch = latestMatchId;
        userDataService.updateUser(user);
      }

      // Process oldest first so streaks and counters remain chronological when
      // a player had multiple matches between polls.
      for (const recentMatch of unseen.reverse()) {
        const recoveredFromOldCursor = !!lastChecked && lastCheckedIndex === -1;
        if (!recentMatches.has(recentMatch.match_id)) {
          recentMatches.set(recentMatch.match_id, []);
        }
        recentMatches.get(recentMatch.match_id)!.push({
          discordId: user.discordId,
          steamId: user.steamId,
          match: recentMatch,
          shouldPost: user.autoShow && (!recoveredFromOldCursor || recentMatch.match_id === latestMatchId),
        });
      }
    } catch (error) {
      logger.error(`Error fetching recent matches for user ${user.discordId}:`, error);
    }
  }

  for (const [matchId, players] of recentMatches) {
    const postPlayers = players.filter((player) => player.shouldPost);
    const isParsed = await isMatchParsed(matchId);
    if (!isParsed) {
      await requestMatchParse(matchId);
      if (postPlayers.length > 0) {
        await channel.send(`A parse request has been sent for match ${matchId}. More detailed stats will be available soon.`);
      }
    }

    let matchDetailsData: any;
    try {
      const matchDetails = await opendotaClient.get(`/matches/${matchId}`);
      matchDetailsData = matchDetails.data;
      if (turboStatsService) {
        const registeredPlayers = players.map(p => ({ discordId: p.discordId, steamId: p.steamId }));
        turboStatsService.processTurboMatch(matchDetailsData, registeredPlayers);

        // Update hidden turbo rank estimates (piggybacks on the same match data)
        if (matchDetailsData.game_mode === 23) {
          for (const rp of registeredPlayers) {
            turboRankService.updateFromMatch(matchDetailsData, rp.discordId, rp.steamId);
          }
        }
      }
    } catch (error) {
      logger.error(`Error fetching match details for match ${matchId}:`, error);
    }

    // Streaks + achievements run after turbo stats so score-based achievements
    // see this match's updated turbo numbers.
    for (const player of players) {
      await trackMatchForPlayer(player, channel, userDataService, turboStatsService, matchDetailsData, player.shouldPost);
    }

    if (postPlayers.length > 1) {
      await displayCombinedScoreboard(matchId, postPlayers, channel);
    } else if (postPlayers.length === 1) {
      await displayMatchStats(postPlayers[0].discordId, postPlayers[0].steamId, postPlayers[0].match, channel);
    }
  }

  setTimeout(() => checkNewMatches(client, userDataService, turboStatsService), ProcessConstants.CHECK_INTERVAL);
}

export async function getRecentStats(discordId: string, steamId: string, channel: TextBasedChannel): Promise<void> {
  try {
    const response = await opendotaClient.get<Array<any>>(`/players/${steamId}/recentMatches`);
    const recentMatch = response.data[0];

    if (recentMatch) {
      await displayMatchStats(discordId, steamId, recentMatch, channel);
    } else {
      await safeSend(channel, 'No recent matches found for the user.');
    }
  } catch (error) {
    logger.error(`Error fetching recent match for user ${discordId}:`, error);
    await safeSend(channel, 'An error occurred while fetching the recent match. Please try again later.');
  }
}

async function displayMatchStats(discordId: string, steamId: string, match: Match, channel: TextBasedChannel) {
  try {
    const user = await channel.client.users.fetch(discordId);
    const heroName = await dotaDataService.getHeroName(match.hero_id);

    const detailedMatch = await opendotaClient.get(`/matches/${match.match_id}`);
    // Match by account_id first; hero_id alone is wrong when both teams ran the
    // same hero (mirror) — it could surface an enemy's stats as yours.
    const playerData = detailedMatch.data.players.find((p: any) => String(p.account_id) === String(steamId))
      || detailedMatch.data.players.find((p: { hero_id: number; player_slot: number }) => p.hero_id === match.hero_id);
    const isRadiant = playerData.player_slot < 128;
    const didWin = (isRadiant && detailedMatch.data.radiant_win) || (!isRadiant && !detailedMatch.data.radiant_win);

    const planGrade = await gradeActivePlanForMatch(String(playerData.account_id || ''), match.match_id, detailedMatch.data);

    // The visual scoreboard already carries every per-player stat (K/D/A, GPM,
    // net worth, last hits, items) for the focus row, so when it renders we keep
    // the embed minimal and only fall back to the text stat fields if it fails.
    const files: AttachmentBuilder[] = [];
    let hasBoard = false;
    try {
      const board = await renderScoreboardFromMatch(detailedMatch.data, [steamId]);
      files.push(new AttachmentBuilder(board, { name: 'scoreboard.png' }));
      hasBoard = true;
    } catch (boardError) {
      logger.error(`Failed to render scoreboard for match ${match.match_id}:`, boardError);
    }

    const embed = new EmbedBuilder()
      .setColor(didWin ? '#66bb6a' : '#ef5350')
      .setTitle(`Recent Match for ${user.username}`)
      .setDescription(`**${didWin ? 'Victory' : 'Defeat'}** as **${heroName}**`)
      .setThumbnail(APIConstants.IMAGE_URL(heroName))
      .setTimestamp(new Date(detailedMatch.data.start_time * 1000))
      .setFooter({ text: `Match played on ${new Date(detailedMatch.data.start_time * 1000).toLocaleString()}` })
      .setURL(`https://www.opendota.com/matches/${match.match_id}`);

    if (hasBoard) {
      embed.setImage('attachment://scoreboard.png');
    } else {
      // Text fallback: the image didn't render, so spell the stats out.
      const itemSlots = ['item_0', 'item_1', 'item_2', 'item_3', 'item_4', 'item_5'];
      const itemNames = await Promise.all(itemSlots.map(slot => dotaDataService.getItemName(playerData[slot])));
      embed.addFields(
        { name: 'K/D/A', value: `${playerData.kills}/${playerData.deaths}/${playerData.assists}`, inline: true },
        { name: 'KDA Ratio', value: ((playerData.kills + playerData.assists) / (playerData.deaths || 1)).toFixed(2), inline: true },
        { name: 'Level', value: playerData.level.toString(), inline: true },
        { name: 'Last Hits/Denies', value: `${playerData.last_hits}/${playerData.denies || 0}`, inline: true },
        { name: 'GPM/XPM', value: `${playerData.gold_per_min}/${playerData.xp_per_min}`, inline: true },
        { name: 'Hero Damage', value: playerData.hero_damage.toLocaleString(), inline: true },
        { name: 'Tower Damage', value: playerData.tower_damage.toLocaleString(), inline: true },
        { name: 'Hero Healing', value: playerData.hero_healing.toLocaleString(), inline: true },
        { name: 'Items', value: itemNames.map(name => name !== 'Unknown Item' ? name : 'Empty Slot').join(', '), inline: false },
        { name: 'Gold Spent', value: playerData.gold_spent.toLocaleString(), inline: true },
        { name: 'Team', value: isRadiant ? 'Radiant' : 'Dire', inline: true },
        { name: 'Match ID', value: `[${match.match_id}](https://www.opendota.com/matches/${match.match_id})`, inline: true },
        { name: 'Duration', value: formatDuration(detailedMatch.data.duration), inline: true },
        { name: 'Game Mode', value: GAME_MODE_NAMES[Number(detailedMatch.data.game_mode)] || `Mode ${detailedMatch.data.game_mode ?? '?'}`, inline: true }
      );
    }

    if (planGrade) {
      embed.addFields({ name: 'Coach Check-In', value: planGrade.slice(0, 1024), inline: false });
    }

    await safeSend(channel, { embeds: [embed], files });
  } catch (error) {
    logger.error('Error sending match stats:', error);
    safeSend(channel, 'An error occurred while fetching the detailed match stats. Please try again later.');
  }
}

async function displayCombinedScoreboard(matchId: number, players: Array<{ steamId: string }>, channel: TextBasedChannel) {
  try {
    const response = await opendotaClient.get<Match>(`/matches/${matchId}`);
    const match = response.data;

    const planGrades = (await Promise.all(players.map(async (tracked) => {
      const player = match.players.find(p => tracked.steamId === (p.account_id ? p.account_id.toString() : null));
      if (!player) return null;
      return gradeActivePlanForMatch(tracked.steamId, matchId, match);
    }))).filter((line): line is string => !!line);

    const registeredPlayerWon = match.players.some(player =>
      players.some(p => p.steamId === (player.account_id ? player.account_id.toString() : null)) &&
      ((player.isRadiant && match.radiant_win) || (!player.isRadiant && !match.radiant_win))
    );

    const embed = new EmbedBuilder()
      .setColor(registeredPlayerWon ? '#66bb6a' : '#ef5350')
      .setTitle(`Match ${matchId} Summary`)
      .setDescription(`**${match.radiant_win ? 'Radiant' : 'Dire'} Victory**`)
      .setTimestamp(new Date(match.start_time * 1000))
      .setFooter({ text: `Match ID: ${matchId}` })
      .setURL(`https://www.opendota.com/matches/${matchId}`);
    if (planGrades.length) {
      embed.addFields({ name: 'Coach Check-In', value: planGrades.join('\n').slice(0, 1024), inline: false });
    }

    // Visual scoreboard (header carries score/duration/mode); registered players highlighted.
    const files: AttachmentBuilder[] = [];
    try {
      const board = await renderScoreboardFromMatch(match, players.map(p => p.steamId));
      files.push(new AttachmentBuilder(board, { name: 'scoreboard.png' }));
      embed.setImage('attachment://scoreboard.png');
    } catch (boardError) {
      logger.error(`Failed to render combined scoreboard for match ${matchId}:`, boardError);
    }

    await safeSend(channel, { embeds: [embed], files });
  } catch (error) {
    logger.error('Error displaying combined scoreboard:', error);
    await safeSend(channel, 'An error occurred while fetching the combined scoreboard. Please try again later.');
  }
}

async function isMatchParsed(matchId: number): Promise<boolean> {
  try {
    // refresh: the parsed flag is exactly the thing that changes under us, and a
    // cached "not parsed yet" would make waitForMatchParse spin until it times out.
    const response = await opendotaClient.get(`/matches/${matchId}`, { refresh: true } as any);
    return !!response.data.version;
  } catch (error) {
    logger.error(`Error checking if match ${matchId} is parsed:`, error);
    return false;
  }
}

export async function requestMatchParse(matchId: number): Promise<boolean> {
  try {
    // Goes through opendotaClient so it draws from the shared rate-limit budget.
    // axiosRetry still skips it (non-idempotent POST), which is what we want.
    const response = await opendotaClient.post(`/request/${matchId}`, null, {
      timeout: 15000,
    });
    const job = response.data?.job;
    logger.info(`Parse request for match ${matchId}: job=${JSON.stringify(job)}`);
    return true;
  } catch (error: any) {
    const status = error?.response?.status;
    const body = error?.response?.data;
    logger.error(`Error requesting parse for match ${matchId} (HTTP ${status}):`, body || error.message);
    return false;
  }
}

/**
 * Poll OpenDota until a match is parsed (has replay data).
 * Sends a second parse request midway through as a nudge.
 * @returns true if parsed within the window, false if timed out
 */
export async function waitForMatchParse(
  matchId: number,
  opts?: { maxAttempts?: number; intervalMs?: number; onTick?: (attempt: number, max: number) => void },
): Promise<boolean> {
  const max = opts?.maxAttempts ?? 15;
  const interval = opts?.intervalMs ?? 20_000;
  const nudgeAt = Math.floor(max / 2); // re-request parse halfway through

  for (let i = 1; i <= max; i++) {
    await new Promise((r) => setTimeout(r, interval));
    opts?.onTick?.(i, max);

    // Nudge: re-request parse midway in case the first request was lost
    if (i === nudgeAt) {
      logger.info(`Nudge: re-requesting parse for match ${matchId} at attempt ${i}`);
      await requestMatchParse(matchId);
    }

    if (await isMatchParsed(matchId)) return true;
  }
  return false;
}

export async function getDetailedMatchData(matchId: number) {
  try {
    const response = await opendotaClient.get(`/matches/${matchId}`);
    const match = response.data;

    if (!match.version) {
      return null;
    }

    // ── Skill bracket mapping ────────────────────────────────────────────────
    const skillBrackets: Record<number, string> = { 1: 'Normal', 2: 'High', 3: 'Very High' };

    // ── Rank tier to medal name ──────────────────────────────────────────────
    const rankMedals: Record<number, string> = {
      1: 'Herald', 2: 'Guardian', 3: 'Crusader', 4: 'Archon',
      5: 'Legend', 6: 'Ancient', 7: 'Divine', 8: 'Immortal',
    };
    const rankTierToString = (tier: number | null | undefined): string | null => {
      if (tier == null || tier === 0) return null;
      const medal = rankMedals[Math.floor(tier / 10)];
      const stars = tier % 10;
      return medal ? `${medal}${stars > 0 ? ` ${stars}` : ''}` : null;
    };

    // ── Draft / picks-bans ───────────────────────────────────────────────────
    const draft = await Promise.all(
      (match.picks_bans || []).map(async (pb: any) => ({
        order: pb.order,
        isPick: pb.is_pick,
        team: pb.team === 0 || pb.team === 2 ? 'Radiant' : 'Dire',
        heroName: await dotaDataService.getHeroName(pb.hero_id),
      }))
    );

    // ── Sample array at ~8 points for concise curves ─────────────────────────
    const sampleCurve = (arr: number[] | undefined, points = 8): string[] => {
      if (!arr || arr.length === 0) return [];
      const step = Math.max(1, Math.floor(arr.length / points));
      return arr
        .filter((_: number, i: number) => i % step === 0 || i === arr.length - 1)
        .map((v: number, i: number) => `${i * step}min: ${v.toLocaleString()}`);
    };

    const processedData = {
      matchId: match.match_id,
      duration: match.duration,
      radiantWin: match.radiant_win,
      gameMode: (() => {
        const modes: Record<number, string> = {
          0: 'Unknown', 1: 'All Pick', 2: "Captain's Mode", 3: 'Random Draft',
          4: 'Single Draft', 5: 'All Random', 11: 'Mid Only', 12: 'Least Played',
          13: 'Limited Heroes', 14: 'Compendium', 15: 'Custom', 16: 'Captain\'s Draft',
          18: 'Ability Draft', 22: 'All Pick (Ranked)', 23: 'Turbo', 24: 'Mutation',
        };
        return modes[match.game_mode] || `Mode ${match.game_mode}`;
      })(),
      gameModeId: match.game_mode as number,
      patch: match.patch,
      firstBloodTime: match.first_blood_time ?? null,
      radiantScore: match.radiant_score ?? null,
      direScore: match.dire_score ?? null,
      skillBracket: skillBrackets[match.skill] || null,
      // Max gold advantage of the winning team / losing team (tells the game's drama)
      comeback: match.comeback ?? null,  // max gold disadvantage of winning team
      throw: match.throw ?? null,        // max gold advantage of losing team

      // Draft order
      draft,

      // Gold/XP advantage snapshots (sampled every ~5 min)
      goldAdvantage: (() => {
        const adv: number[] = match.radiant_gold_adv || [];
        const step = Math.max(1, Math.floor(adv.length / 8));
        return adv
          .filter((_: number, i: number) => i % step === 0 || i === adv.length - 1)
          .map((g: number, i: number) => `${i * step}min: ${g > 0 ? '+' : ''}${g}`);
      })(),

      xpAdvantage: (() => {
        const adv: number[] = match.radiant_xp_adv || [];
        const step = Math.max(1, Math.floor(adv.length / 8));
        return adv
          .filter((_: number, i: number) => i % step === 0 || i === adv.length - 1)
          .map((x: number, i: number) => `${i * step}min: ${x > 0 ? '+' : ''}${x}`);
      })(),

      players: await Promise.all(match.players.map(async (p: any) => {
        const itemSlots = ['item_0', 'item_1', 'item_2', 'item_3', 'item_4', 'item_5'];
        const items = (await Promise.all(
          itemSlots.map((slot) => dotaDataService.getItemName(p[slot]))
        )).filter((name) => name && name !== 'Unknown Item' && name !== 'Empty');

        const backpackSlots = ['backpack_0', 'backpack_1', 'backpack_2'];
        const backpack = (await Promise.all(
          backpackSlots.map((slot) => dotaDataService.getItemName(p[slot]))
        )).filter((name) => name && name !== 'Unknown Item' && name !== 'Empty');

        const laneNames: Record<number, string> = { 1: 'Safe', 2: 'Mid', 3: 'Off', 4: 'Jungle', 5: 'Unknown' };

        // Extract benchmark percentiles if available — humanize keys + correct ordinals
        const benchmarkLabels: Record<string, string> = {
          gold_per_min: 'GPM', xp_per_min: 'XPM', kills_per_min: 'Kills/min',
          last_hits_per_min: 'LH/min', hero_damage_per_min: 'Dmg/min',
          hero_healing_per_min: 'Heal/min', tower_damage: 'Tower Dmg',
        };
        const ordinal = (n: number) => {
          const s = ['th', 'st', 'nd', 'rd'];
          const v = n % 100;
          return n + (s[(v - 20) % 10] || s[v] || s[0]);
        };
        const benchmarks: Record<string, string> = {};
        if (p.benchmarks) {
          for (const [key, val] of Object.entries(p.benchmarks)) {
            const pct = (val as any)?.pct;
            if (pct != null) {
              const label = benchmarkLabels[key] || key;
              benchmarks[label] = ordinal(Math.round(pct * 100));
            }
          }
        }

        return {
          heroName: await dotaDataService.getHeroName(p.hero_id),
          heroVariant: p.hero_variant ?? null,  // 1-indexed facet selection
          name: p.personaname || 'Anonymous',
          team: p.player_slot < 128 ? 'Radiant' : 'Dire',
          rankTier: rankTierToString(p.rank_tier),
          partyId: p.party_id ?? null,
          kills: p.kills,
          deaths: p.deaths,
          assists: p.assists,
          kda: (((p.kills + p.assists) / Math.max(p.deaths, 1))).toFixed(2),
          netWorth: p.net_worth,
          gpm: p.gold_per_min,
          xpm: p.xp_per_min,
          lastHits: p.last_hits,
          denies: p.denies ?? 0,
          heroDamage: p.hero_damage,
          towerDamage: p.tower_damage,
          heroHealing: p.hero_healing,
          lane: laneNames[p.lane_role] || 'Unknown',
          isRoaming: p.is_roaming || false,
          items,
          backpack,
          level: p.level ?? 0,
          buybacks: p.buyback_count ?? 0,
          buybackLog: (p.buyback_log || []).map((bb: any) => ({ time: bb.time })),

          // Map Control
          obsPlaced: p.obs_placed ?? 0,
          senPlaced: p.sen_placed ?? 0,
          obsLog: (p.obs_log || []).map((l: any) => l.time),
          senLog: (p.sen_log || []).map((l: any) => l.time),
          obsKilled: p.observer_kills ?? 0,
          senKilled: p.sentry_kills ?? 0,

          runePickups: p.rune_pickups ?? 0,
          runesLog: (p.runes_log || []).map((r: any) => ({ time: r.time, key: r.key })),

          benchmarks,
          permanentBuffs: (p.permanent_buffs || []).map((b: any) => b.name || `buff_${b.permanent_buff}`),

          // ── New fields ──────────────────────────────────────────────────────
          // Multi-kills and killstreaks
          multiKills: (() => {
            const mk: Record<string, number> = p.multi_kills || {};
            const labels: Record<string, string> = { '2': 'Double', '3': 'Triple', '4': 'Ultra', '5': 'Rampage' };
            return Object.entries(mk)
              .filter(([, count]) => count > 0)
              .map(([size, count]) => `${labels[size] || `${size}x`} Kill x${count}`)
              .join(', ') || null;
          })(),

          killStreaks: (() => {
            const ks: Record<string, number> = p.kill_streaks || {};
            const maxStreak = Object.keys(ks).map(Number).filter(n => n > 0).sort((a, b) => b - a)[0];
            return maxStreak && maxStreak >= 3 ? maxStreak : null;
          })(),

          // Farming / economy
          campsStacked: p.camps_stacked ?? 0,
          neutralKills: p.neutral_kills ?? 0,
          laneKills: p.lane_kills ?? 0,
          towerKills: p.tower_kills ?? 0,
          roshanKills: p.roshan_kills ?? 0,
          aegisPickups: p.hero_kills ? (p.hero_kills['aegis'] ?? 0) : 0, // Using hero_kills mapped objects from opendota if possible though usually it is in objectives
          courierKills: p.courier_kills ?? 0,

          // Biggest single damage instance
          maxHeroHit: (() => {
            const mhh = p.max_hero_hit;
            if (!mhh || !mhh.value) return null;
            const rawInflictor = mhh.inflictor;
            return {
              value: mhh.value,
              inflictor: (!rawInflictor || rawInflictor === 'null') ? 'Right Click'
                : rawInflictor.replace(/^(npc_dota_hero_)?/, '').replace(/_/g, ' '),
              target: (mhh.key || '').replace('npc_dota_hero_', '').replace(/_/g, ' '),
            };
          })(),

          // Incoming damage breakdown — top 5 sources
          damageReceived: (() => {
            const recv: Record<string, number> = p.damage_inflictor_received || {};
            return Object.entries(recv)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 5)
              .map(([ability, dmg]) => ({
                ability: ability === 'null' ? 'Right Click'
                  : ability.replace(/^(npc_dota_hero_)?/, '').replace(/_/g, ' '),
                damage: dmg,
              }));
          })(),

          // Net worth curve (sampled)
          goldCurve: sampleCurve(p.gold_t),
          xpCurve: sampleCurve(p.xp_t),
          lhCurve: sampleCurve(p.lh_t),

          // Disconnect / leaver
          leaverStatus: p.leaver_status ?? 0,  // 0 = stayed, 1 = left safely, 2+ = abandoned

          // Skill build (ability upgrades as array of ability IDs)
          abilityBuild: p.ability_upgrades_arr || null,

          // Key item timings — major items only (completed items from purchase_log)
          keyItemTimings: (p.purchase_log || [])
            .filter((purchase: any) => {
              // Only include completed major items, not components
              const majorItems = [
                'bfury', 'desolator', 'black_king_bar', 'abyssal_blade', 'monkey_king_bar',
                'satanic', 'rapier', 'butterfly', 'daedalus', 'assault', 'heart', 'skadi',
                'manta', 'radiance', 'mjollnir', 'silver_edge', 'bloodthorn', 'nullifier',
                'hurricane_pike', 'refresher', 'aghanims_shard', 'ultimate_scepter',
                'ultimate_scepter_2', 'aeon_disk', 'lotus_orb', 'shivas_guard',
                'blink', 'power_treads', 'phase_boots', 'arcane_boots', 'travels',
                'orchid', 'gleipnir', 'aether_lens', 'octarine_core', 'pipe',
                'crimson_guard', 'halberd', 'basher', 'mask_of_madness', 'maelstrom',
                'kaya_and_sange', 'sange_and_yasha', 'yasha_and_kaya',
                'veil_of_discord', 'rod_of_atos', 'hand_of_midas', 'echo_sabre',
                'ethereal_blade', 'diffusal_blade', 'heavens_halberd', 'solar_crest',
              ];
              return majorItems.includes(purchase.key);
            })
            .map((purchase: any) => ({ item: purchase.key, time: purchase.time })),

          // Kill timeline — who this player killed and when
          killTimeline: (p.kills_log || []).map((k: any) => ({
            time: k.time,
            victim: (k.key || '').replace('npc_dota_hero_', ''),
          })),

          // Extra stats
          laneEfficiency: p.lane_efficiency_pct ?? null,
          timeSpentDead: p.life_state_dead ?? 0,
          apm: p.actions_per_min ?? 0,

          // Teamfight participation % and stun duration
          teamfightParticipation: p.teamfight_participation != null
            ? Math.round(p.teamfight_participation * 100)
            : null,
          stunDuration: p.stuns ? Math.round(p.stuns * 10) / 10 : 0,

          // Top damage abilities — sorted desc, top 5
          topDamageAbilities: (() => {
            const inflictor: Record<string, number> = p.damage_inflictor || {};
            return Object.entries(inflictor)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 5)
              .map(([ability, dmg]) => ({
                ability: ability === 'null' ? 'Right Click'
                  : ability.replace(/^(npc_dota_hero_)?/, '').replace(/_/g, ' '),
                damage: dmg,
              }));
          })(),

          // Damage dealt to each enemy hero
          damageToHeroes: (() => {
            const targets: Record<string, Record<string, number>> = p.damage_targets || {};
            const heroDmg: Record<string, number> = {};
            for (const abilityTargets of Object.values(targets)) {
              for (const [target, dmg] of Object.entries(abilityTargets)) {
                if (target.startsWith('npc_dota_hero_')) {
                  const heroName = target.replace('npc_dota_hero_', '').replace(/_/g, ' ');
                  heroDmg[heroName] = (heroDmg[heroName] || 0) + dmg;
                }
              }
            }
            return Object.entries(heroDmg)
              .sort(([, a], [, b]) => b - a)
              .map(([hero, dmg]) => ({ hero, damage: dmg }));
          })(),
        };
      })),

      chatLog: (match.chat || [])
        .filter((msg: any) => msg.type === 'chat')
        .slice(0, 20)
        .map((msg: any) => ({
          time: msg.time,
          player: match.players.find((p: any) => p.player_slot === msg.player_slot)?.personaname || 'Unknown',
          message: msg.key
        })),

      objectives: (match.objectives || [])
        .filter((obj: any) => obj.type !== 'CHAT_MESSAGE_FIRSTBLOOD')  // skip pre-game events
        .map((obj: any) => {
          // Determine which team performed this action
          let team = 'Unknown';
          let player = 'Unknown';
          if (obj.team === 2) {
            team = 'Radiant';
          } else if (obj.team === 3) {
            team = 'Dire';
          } else if (obj.player_slot != null) {
            team = obj.player_slot < 128 ? 'Radiant' : 'Dire';
            player = match.players.find((p: any) => p.player_slot === obj.player_slot)?.personaname || 'Unknown';
          } else if (obj.type === 'building_kill' && obj.key) {
            // goodguys building killed = Dire killed it; badguys building killed = Radiant killed it
            team = obj.key.includes('goodguys') ? 'Dire' : 'Radiant';
          }

          // Simplify building keys for readability
          let key = obj.key || '';
          if (obj.type === 'building_kill') {
            key = key.replace('npc_dota_', '').replace('badguys_', '').replace('goodguys_', '');
          }
          if (obj.type === 'CHAT_MESSAGE_ROSHAN_KILL') {
            key = 'Roshan';
          }
          if (obj.type === 'CHAT_MESSAGE_AEGIS') {
            key = 'Aegis';
          }

          return { time: Math.max(0, obj.time), type: obj.type, team, player, key };
        }),

      // Teamfights — determine exactly who died
      teamfights: (match.teamfights || []).slice(0, 10).map((fight: any) => {
        // Collect deaths by checking hero_id in players who died
        const radiantDeaths: string[] = [];
        const direDeaths: string[] = [];

        for (const p of (fight.players || [])) {
          if (p.deaths > 0) {
            const playerInfo = match.players.find((mp: any) => mp.player_slot === p.player_slot);
            if (playerInfo) {
               const name = playerInfo.hero_id
                 ? dotaDataService.getHeroById(playerInfo.hero_id)?.localized_name || `Hero ${playerInfo.hero_id}`
                 : `Slot ${p.player_slot}`;
               if (p.player_slot < 128) {
                 radiantDeaths.push(name);
               } else {
                 direDeaths.push(name);
               }
            }
          }
        }

        const countKills = (p: any) =>
          Object.values(p?.killed || {}).reduce((s: number, v: any) => s + (typeof v === 'number' ? v : 0), 0);
        const players = fight.players || [];

        return {
          start: fight.start,
          end: fight.end,
          totalDeaths: fight.deaths,
          radiantDeaths: radiantDeaths.length > 0 ? radiantDeaths.join(', ') : 'None',
          direDeaths: direDeaths.length > 0 ? direDeaths.join(', ') : 'None',
          radiantKills: players.slice(0, 5).reduce((s: number, p: any) => s + countKills(p), 0),
          direKills: players.slice(5).reduce((s: number, p: any) => s + countKills(p), 0),
        };
      }),
    };

    return processedData;
  } catch (error) {
    logger.error(`Error fetching detailed match data for match ${matchId}:`, error);
    return null;
  }
}
