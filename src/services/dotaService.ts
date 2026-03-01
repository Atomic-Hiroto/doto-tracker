import { Client, TextBasedChannel, EmbedBuilder } from 'discord.js';
import { Match } from '../models/Match';
import { UserDataService } from './userDataService';
import { TurboStatsService } from './turboStatsService';
import { formatDuration } from '../utils/formatters';
import { APIConstants, ChannelConstants, ProcessConstants } from '../constants';
import { logger } from './loggerService';
import { opendotaClient } from './apiClient';
import { dotaDataService } from './dotaDataService';
import { safeSend } from '../utils/channelHelpers';

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

  const recentMatches = new Map<number, Array<{ discordId: string; steamId: string; match: any }>>();

  for (const user of userDataService.getAllUsers()) {
    if (!user.autoShow) continue;

    try {
      const response = await opendotaClient.get<Array<any>>(`/players/${user.steamId}/recentMatches`);
      const recentMatch = response.data[0];
      if (!user.lastCheckedMatch || user.lastCheckedMatch !== recentMatch.match_id) {
        user.lastCheckedMatch = recentMatch.match_id;
        userDataService.updateUser(user);

        if (!recentMatches.has(recentMatch.match_id)) {
          recentMatches.set(recentMatch.match_id, []);
        }
        recentMatches.get(recentMatch.match_id)!.push({ discordId: user.discordId, steamId: user.steamId, match: recentMatch });
      }
    } catch (error) {
      logger.error(`Error fetching recent matches for user ${user.discordId}:`, error);
    }
  }

  for (const [matchId, players] of recentMatches) {
    const isParsed = await isMatchParsed(matchId);
    if (!isParsed) {
      await requestMatchParse(matchId);
      await channel.send(`A parse request has been sent for match ${matchId}. More detailed stats will be available soon.`);
    }

    if (turboStatsService) {
      try {
        const matchDetails = await opendotaClient.get(`/matches/${matchId}`);
        const registeredPlayers = players.map(p => ({ discordId: p.discordId, steamId: p.steamId }));
        turboStatsService.processTurboMatch(matchDetails.data, registeredPlayers);
      } catch (error) {
        logger.error(`Error processing turbo stats for match ${matchId}:`, error);
      }
    }

    if (players.length > 1) {
      await displayCombinedScoreboard(matchId, players, channel);
    } else {
      await displayMatchStats(players[0].discordId, players[0].match, channel);
    }
  }

  setTimeout(() => checkNewMatches(client, userDataService, turboStatsService), ProcessConstants.CHECK_INTERVAL);
}

export async function getRecentStats(discordId: string, steamId: string, channel: TextBasedChannel): Promise<void> {
  try {
    const response = await opendotaClient.get<Array<any>>(`/players/${steamId}/recentMatches`);
    const recentMatch = response.data[0];

    if (recentMatch) {
      await displayMatchStats(discordId, recentMatch, channel);
    } else {
      await safeSend(channel, 'No recent matches found for the user.');
    }
  } catch (error) {
    logger.error(`Error fetching recent match for user ${discordId}:`, error);
    await safeSend(channel, 'An error occurred while fetching the recent match. Please try again later.');
  }
}

async function displayMatchStats(discordId: string, match: Match, channel: TextBasedChannel) {
  try {
    const user = await channel.client.users.fetch(discordId);
    const heroName = await dotaDataService.getHeroName(match.hero_id);

    const detailedMatch = await opendotaClient.get(`/matches/${match.match_id}`);
    const playerData = detailedMatch.data.players.find((p: { hero_id: number; player_slot: number }) => p.hero_id === match.hero_id);
    const isRadiant = playerData.player_slot < 128;
    const didWin = (isRadiant && detailedMatch.data.radiant_win) || (!isRadiant && !detailedMatch.data.radiant_win);

    const itemSlots = ['item_0', 'item_1', 'item_2', 'item_3', 'item_4', 'item_5'];
    const itemNames = await Promise.all(itemSlots.map(slot => dotaDataService.getItemName(playerData[slot])));

    const embed = new EmbedBuilder()
      .setColor(didWin ? '#66bb6a' : '#ef5350')
      .setTitle(`Recent Match for ${user.username}`)
      .setDescription(`**${didWin ? 'Victory' : 'Defeat'}** as **${heroName}**`)
      .setThumbnail(APIConstants.IMAGE_URL(heroName))
      .addFields(
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
        { name: 'Game Mode', value: (detailedMatch.data.game_mode || 'Unknown').toString(), inline: true },
        { name: 'Region', value: (detailedMatch.data.region || 'Unknown').toString(), inline: true }
      )
      .setTimestamp(new Date(detailedMatch.data.start_time * 1000))
      .setFooter({ text: `Match played on ${new Date(detailedMatch.data.start_time * 1000).toLocaleString()}` })
      .setURL(`https://www.opendota.com/matches/${match.match_id}`);

    await safeSend(channel, { embeds: [embed] });
  } catch (error) {
    logger.error('Error sending match stats:', error);
    safeSend(channel, 'An error occurred while fetching the detailed match stats. Please try again later.');
  }
}

async function displayCombinedScoreboard(matchId: number, players: Array<{ steamId: string }>, channel: TextBasedChannel) {
  try {
    const response = await opendotaClient.get<Match>(`/matches/${matchId}`);
    const match = response.data;

    const radiantPlayers = match.players.filter(p => p.isRadiant);
    const direPlayers = match.players.filter(p => !p.isRadiant);

    const formatPlayer = async (player: Match['players'][number]) => {
      const isRegisteredUser = players.some(p => p.steamId === (player.account_id ? player.account_id.toString() : null));
      const heroName = await dotaDataService.getHeroName(player.hero_id);
      const playerName = isRegisteredUser ? `**${player.personaname || 'Unknown'}**` : (player.personaname || 'Unknown');
      return `${playerName} (${heroName}): ${player.kills}/${player.deaths}/${player.assists} | LH: ${player.last_hits} | GPM: ${player.gold_per_min} | XPM: ${player.xp_per_min}`;
    };

    const radiantScoreboard = await Promise.all(radiantPlayers.map(formatPlayer));
    const direScoreboard = await Promise.all(direPlayers.map(formatPlayer));

    const radiantKills = radiantPlayers.reduce((sum, player) => sum + (player.kills || 0), 0);
    const direKills = direPlayers.reduce((sum, player) => sum + (player.kills || 0), 0);

    const registeredPlayerWon = match.players.some(player =>
      players.some(p => p.steamId === (player.account_id ? player.account_id.toString() : null)) &&
      ((player.isRadiant && match.radiant_win) || (!player.isRadiant && !match.radiant_win))
    );

    const embed = new EmbedBuilder()
      .setColor(registeredPlayerWon ? '#66bb6a' : '#ef5350')
      .setTitle(`Match ${matchId} Summary`)
      .setDescription(`**${match.radiant_win ? 'Radiant' : 'Dire'} Victory**`)
      .addFields(
        { name: 'Radiant', value: radiantScoreboard.join('\n'), inline: false },
        { name: 'Dire', value: direScoreboard.join('\n'), inline: false },
        { name: 'Score', value: `Radiant ${radiantKills} - ${direKills} Dire`, inline: true },
        { name: 'Duration', value: formatDuration(match.duration), inline: true },
        { name: 'Game Mode', value: match.game_mode?.toString() || 'Unknown', inline: true }
      )
      .setTimestamp(new Date(match.start_time * 1000))
      .setFooter({ text: `Match ID: ${matchId}` })
      .setURL(`https://www.opendota.com/matches/${matchId}`);

    await safeSend(channel, { embeds: [embed] });
  } catch (error) {
    logger.error('Error displaying combined scoreboard:', error);
    await safeSend(channel, 'An error occurred while fetching the combined scoreboard. Please try again later.');
  }
}

async function isMatchParsed(matchId: number): Promise<boolean> {
  try {
    const response = await opendotaClient.get(`/matches/${matchId}`);
    return response.data.version !== null;
  } catch (error) {
    logger.error(`Error checking if match ${matchId} is parsed:`, error);
    return false;
  }
}

async function requestMatchParse(matchId: number): Promise<void> {
  try {
    await opendotaClient.post(`/request/${matchId}`);
    logger.info(`Requested parsing for match ${matchId}`);
  } catch (error) {
    logger.error(`Error requesting parse for match ${matchId}:`, error);
  }
}

export async function getDetailedMatchData(matchId: number) {
  try {
    const response = await opendotaClient.get(`/matches/${matchId}`);
    const match = response.data;

    if (!match.version) {
      logger.info(`Match ${matchId} is not parsed yet. Sending a parse request.`);
      requestMatchParse(matchId);
      return null;
    }

    const processedData = {
      matchId: match.match_id,
      duration: match.duration,
      radiantWin: match.radiant_win,
      gameMode: match.game_mode,
      patch: match.patch,

      // Gold/XP advantage snapshots (sampled every 3 min)
      goldAdvantage: (() => {
        const adv: number[] = match.radiant_gold_adv || [];
        const step = Math.max(1, Math.floor(adv.length / 6));
        return adv
          .filter((_: number, i: number) => i % step === 0)
          .map((g: number, i: number) => `${i * step}min: ${g > 0 ? '+' : ''}${g}`);
      })(),

      xpAdvantage: (() => {
        const adv: number[] = match.radiant_xp_adv || [];
        const step = Math.max(1, Math.floor(adv.length / 6));
        return adv
          .filter((_: number, i: number) => i % step === 0)
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
          name: p.personaname || 'Anonymous',
          team: p.player_slot < 128 ? 'Radiant' : 'Dire',
          kills: p.kills,
          deaths: p.deaths,
          assists: p.assists,
          kda: (((p.kills + p.assists) / Math.max(p.deaths, 1))).toFixed(2),
          netWorth: p.net_worth,
          gpm: p.gold_per_min,
          xpm: p.xp_per_min,
          lastHits: p.last_hits,
          heroDamage: p.hero_damage,
          towerDamage: p.tower_damage,
          heroHealing: p.hero_healing,
          lane: laneNames[p.lane_role] || 'Unknown',
          isRoaming: p.is_roaming || false,
          items,
          backpack,
          level: p.level ?? 0,
          buybacks: p.buyback_count ?? 0,
          obsPlaced: p.obs_placed ?? 0,
          senPlaced: p.sen_placed ?? 0,
          runePickups: p.rune_pickups ?? 0,
          benchmarks,
          permanentBuffs: (p.permanent_buffs || []).map((b: any) => b.name || `buff_${b.permanent_buff}`),

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
                'veil_of_discord', 'rod_of_atos',
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
          if (obj.team === 2) {
            team = 'Radiant';
          } else if (obj.team === 3) {
            team = 'Dire';
          } else if (obj.player_slot != null) {
            team = obj.player_slot < 128 ? 'Radiant' : 'Dire';
          } else if (obj.type === 'building_kill' && obj.key) {
            // goodguys building killed = Dire killed it; badguys building killed = Radiant killed it
            team = obj.key.includes('goodguys') ? 'Dire' : 'Radiant';
          }

          // Simplify building keys for readability
          let key = obj.key || '';
          if (obj.type === 'building_kill') {
            key = key.replace('npc_dota_', '').replace('badguys_', '').replace('goodguys_', '');
          }

          return { time: Math.max(0, obj.time), type: obj.type, team, key };
        }),

      // Teamfights — killed is an object {hero_key: count}, not a simple kills int
      teamfights: (match.teamfights || []).slice(0, 8).map((fight: any) => {
        const countKills = (p: any) =>
          Object.values(p?.killed || {}).reduce((s: number, v: any) => s + (typeof v === 'number' ? v : 0), 0);
        const players = fight.players || [];
        return {
          start: fight.start,
          end: fight.end,
          totalDeaths: fight.deaths,
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