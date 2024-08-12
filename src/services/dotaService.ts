import { Client, TextBasedChannel, EmbedBuilder } from 'discord.js';
import axios from 'axios';
import { Match } from '../models/Match';
import { UserDataService } from './userDataService';
import { formatDuration } from '../utils/formatters';
import { APIConstants, ChannelConstants, ProcessConstants } from '../constants';

export async function checkNewMatches(client: Client, userDataService: UserDataService) {
  const guild = client.guilds.cache.first();
  if (!guild) {
    console.error('Bot is not in any guild');
    return;
  }

  const channel = guild.channels.cache.find(ch => ch.name === ChannelConstants.DOTO_TRACKER_CHANNEL);
  if (!channel || !channel.isTextBased()) {
    console.error('Could not find a suitable text-based channel to post updates');
    return;
  }

  const recentMatches = new Map<number, Array<{ discordId: string; steamId: string; match: any }>>();

  for (const user of userDataService.getAllUsers()) {
    if (!user.autoShow) continue; // Skip users who have disabled auto-show

    try {
      const response = await axios.get(APIConstants.RECENT_MATCHES(user.steamId));
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
      console.error(`Error fetching recent matches for user ${user.discordId}:`, error);
    }
  }

  for (const [matchId, players] of recentMatches) {
    if (players.length > 1) {
      await displayCombinedScoreboard(matchId, players, channel);
    } else {
      await displayMatchStats(players[0].discordId, players[0].match, channel);
    }
  }

  // Check again after 20 minutes
  setTimeout(() => checkNewMatches(client, userDataService), ProcessConstants.CHECK_INTERVAL);
}

export async function getRecentStats(discordId: string, steamId: string, channel: TextBasedChannel): Promise<void> {
  try {
    const response = await axios.get<Array<any>>(APIConstants.RECENT_MATCHES(steamId));
    const recentMatch = response.data[0];

    if (recentMatch) {
      await displayMatchStats(discordId, recentMatch, channel);
    } else {
      await channel.send("No recent matches found for the user.");
    }
  } catch (error) {
    console.error(`Error fetching recent match for user ${discordId}:`, error);
    await channel.send("An error occurred while fetching the recent match. Please try again later.");
  }
}

async function getHeroName(heroId: number) {
  try {
    const response = await axios.get<Array<{ id: number, localized_name: string }>>(APIConstants.HEROES_API);
    const hero = response.data.find((h: { id: number }) => h.id === heroId);
    return hero ? hero.localized_name : 'Unknown Hero';
  } catch (error) {
    console.error('Error fetching hero data:', error);
    return 'Unknown Hero';
  }
}

async function getItemName(itemId: number) {
  try {
    const response = await axios.get<Record<string, { id: number, dname: string }>>(APIConstants.ITEMS_API);
    const item = Object.values(response.data).find(i => i.id === itemId);
    return item ? item.dname : 'Unknown Item';
  } catch (error) {
    console.error('Error fetching item data:', error);
    return 'Unknown Item';
  }
}

async function displayMatchStats(discordId: string, match: Match, channel: TextBasedChannel) {
  try {
    const user = await channel.client.users.fetch(discordId);
    const heroName = await getHeroName(match.hero_id);

    // Fetch detailed match data
    const detailedMatch = await axios.get(APIConstants.MATCH_DETAILS(match.match_id));
    const playerData = detailedMatch.data.players.find((p: { hero_id: number; player_slot: number }) => p.hero_id === match.hero_id);
    const isRadiant = playerData.player_slot < 128;
    const didWin = (isRadiant && detailedMatch.data.radiant_win) || (!isRadiant && !detailedMatch.data.radiant_win);

    // Fetch item names
    const itemSlots = ['item_0', 'item_1', 'item_2', 'item_3', 'item_4', 'item_5'];
    const itemNames = await Promise.all(itemSlots.map(slot => getItemName(playerData[slot])));

    const embed = new EmbedBuilder()
      .setColor(didWin ? '#66bb6a' : '#ef5350')
      .setTitle(`Recent Match for ${user.username}`)
      .setDescription(`**${didWin ? 'Victory' : 'Defeat'}** as **${heroName}**`)
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

    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error('Error sending match stats:', error);
    channel.send('An error occurred while fetching the detailed match stats. Please try again later.');
  }
}

async function displayCombinedScoreboard(matchId: number, players: Array<{ steamId: string }>, channel: TextBasedChannel) {
  try {
    const response = await axios.get<Match>(APIConstants.MATCH_DETAILS(matchId));
    const match = response.data;

    const radiantPlayers = match.players.filter(p => p.isRadiant);
    const direPlayers = match.players.filter(p => !p.isRadiant);

    const formatPlayer = async (player: Match['players'][number]) => {
      const isRegisteredUser = players.some(p => p.steamId === (player.account_id ? player.account_id.toString() : null));
      const heroName = await getHeroName(player.hero_id);
      const playerName = isRegisteredUser ? `**${player.personaname || 'Unknown'}**` : (player.personaname || 'Unknown');
      return `${playerName} (${heroName}): ${player.kills}/${player.deaths}/${player.assists} | LH: ${player.last_hits} | GPM: ${player.gold_per_min} | XPM: ${player.xp_per_min}`;
    };

    const radiantScoreboard = await Promise.all(radiantPlayers.map(formatPlayer));
    const direScoreboard = await Promise.all(direPlayers.map(formatPlayer));

    const radiantKills = radiantPlayers.reduce((sum, player) => sum + (player.kills || 0), 0);
    const direKills = direPlayers.reduce((sum, player) => sum + (player.kills || 0), 0);

    const embed = new EmbedBuilder()
      .setColor(match.radiant_win ? '#66bb6a' : '#ef5350')
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

    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error('Error displaying combined scoreboard:', error);
    await channel.send('An error occurred while fetching the combined scoreboard. Please try again later.');
  }
}