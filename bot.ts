import { Client, GatewayIntentBits, EmbedBuilder, Message } from 'discord.js';
import axios from 'axios';
import fs from 'fs';
import dotenv from 'dotenv'
import { UserData } from './models/UserData'
import { Commands, Replies } from './constants';
dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const prefix = '+';
const conversationHistory = new Map();

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const USER_DATA_FILE = 'users.json';

let userData: UserData[];
let userDataMap: Map<string, UserData> = new Map<string, UserData>();

function loadUserData() {
  try {
    userData = JSON.parse(fs.readFileSync(USER_DATA_FILE, 'utf8'));
    userData.forEach(user => {
      userDataMap.set(user.discordId, user);
      console.log(JSON.stringify(user));
    });
    console.log('User data loaded successfully');
  } catch (error) {
    console.error('Error loading user data:', error);
    userData = [];
  }
}

function saveUserData() {
  fs.writeFileSync(USER_DATA_FILE, JSON.stringify(userData, null, 2));
}

client.on('messageCreate', async (message: Message) => {
  if (!message.content.startsWith(prefix) || message.author.bot) return;

  const args: string[] = message.content.slice(prefix.length).trim().split(" ");
  const command: string | undefined = args.shift();

  switch (command) {
    case Commands.HELP:
      message.reply(Replies.HELP);
      break;
    case Commands.REGISTER:
      registerUser(message, args);
      break;
    case Commands.UNREGISTER:
      unregisterUser(message);
      break;
    case Commands.RECENT_STATS:
      getRecentStats(message);
      break;
    case Commands.TOGGLE_AUTO:
      toggleAutoShow(message);
      break;
    case Commands.GPAT:
      getAIText(message, args);
      break;
    case Commands.GPAT_CLEAR:
      clearConversationHistory(message);
      break;
    case Commands.CAOW:
      message.reply(Replies.CAOW);
      break;
    default:
      // Handle unknown command
      break;
  }
});



function registerUser(message: Message, args: string[]) {
  if (args.length !== 1) {
    return message.reply('Please provide your Steam ID. Usage: +register <steam_id>');
  }

  const steamId = args[0];
  const user: UserData | undefined = userData.find(x => x.steamId == steamId);
  if (user) {
    message.reply(`SteamId: ${steamId} is already registed with DiscordId: ${user.discordId}.`);
    return;
  }
  userData.push({
    discordId: message.author.id,
    steamId: steamId,
    autoShow: true,
    lastCheckedMatch: null
  });
  saveUserData();
  message.reply(`Successfully registered Steam ID: ${steamId}. Auto-show is enabled by default. Use +toggleauto to disable.`);
}

async function unregisterUser(message: Message) {
  if (!userDataMap.has(message.author.id)) {
    return message.reply('You are not registered');
  }
  const steamId = userDataMap.get(message.author.id)?.steamId;
  userDataMap.delete(message.author.id);
  saveUserData();
  message.reply(`Successfully unregistered Steam ID: ${steamId}`);
}

function toggleAutoShow(message: Message) {
  const userId = message.author.id;
  const user = userDataMap.get(userId);
  if (!user) {
    return message.reply('You need to register first. Use +register <steam_id> to register.');
  }

  user.autoShow = !user.autoShow;
  saveUserData();
  message.reply(`Auto-show for your recent matches has been ${user.autoShow ? 'enabled' : 'disabled'}.`);
}

async function checkNewMatches() {
  const guild = client.guilds.cache.first();
  if (!guild) {
    console.error('Bot is not in any guild');
    return;
  }

  const channel = guild.channels.cache.find(ch => ch.name === 'doto-tracker');
  if (!channel) {
    console.error('Could not find a suitable channel to post updates');
    return;
  }

  const recentMatches = new Map();

  for (const [discordId, user] of userDataMap) {
    if (!user.autoShow) continue; // Skip users who have disabled auto-show

    try {
      const response = await axios.get(`https://api.opendota.com/api/players/${user.steamId}/recentMatches`);
      const recentMatch = response.data[0];
      if (!user.lastCheckedMatch || user.lastCheckedMatch !== recentMatch.match_id) {
          user.lastCheckedMatch = recentMatch.match_id;
        if (!recentMatches.has(recentMatch.match_id)) {
          recentMatches.set(recentMatch.match_id, []);
        }
        recentMatches.get(recentMatch.match_id).push({ discordId, steamId: user.steamId, match: recentMatch });
      }
    } catch (error) {
      console.error(`Error fetching recent matches for user ${discordId}:`, error);
    }
  }

  saveUserData(); // Save updated lastCheckedMatch values

  for (const [matchId, players] of recentMatches) {
    if (players.length > 1) {
      await displayCombinedScoreboard(matchId, players, channel);
    } else {
      await displayMatchStats(players[0].discordId, players[0].match, channel);
    }
  }

  // Check again after 20 minutes
  setTimeout(checkNewMatches, 20 * 60 * 1000);
}

async function getRecentStats(message: Message): Promise<void> {
  let discordId: string;
  let steamId: string;

  if (message.mentions.users.size > 0) {
    const mentionedUser = message.mentions.users.first();
    if (!mentionedUser) {
      await message.reply("Couldn't find the mentioned user.");
      return;
    }
    discordId = mentionedUser.id;
  } else {
    discordId = message.author.id;
  }

  console.log(discordId, userDataMap);

  const userData = userDataMap.get(discordId);
  if (!userData) {
    await message.reply(discordId === message.author.id
      ? "You haven't registered your Steam ID yet. Use +register <steam_id> to register."
      : "The mentioned user hasn't registered their Steam ID yet.");
    return;
  }

  steamId = userData.steamId;

  try {
    const response = await axios.get<Array<any>>(`https://api.opendota.com/api/players/${steamId}/recentMatches`);
    const recentMatch = response.data[0];

    if (recentMatch) {
      await displayMatchStats(discordId, recentMatch, message.channel);
    } else {
      await message.reply(discordId === message.author.id
        ? "No recent matches found for you."
        : "No recent matches found for the mentioned user.");
    }
  } catch (error) {
    console.error(`Error fetching recent match for user ${discordId}:`, error);
    await message.reply("An error occurred while fetching the recent match. Please try again later.");
  }
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

async function getHeroName(heroId: number) {
  try {
    const response = await axios.get('https://api.opendota.com/api/heroes');
    const hero = response.data.find(h => h.id === heroId);
    return hero ? hero.localized_name : 'Unknown Hero';
  } catch (error) {
    console.error('Error fetching hero data:', error);
    return 'Unknown Hero';
  }
}

async function getItemName(itemId: number) {
  try {
    const response = await axios.get('https://api.opendota.com/api/constants/items');
    const item = Object.values(response.data).find(i => i.id === itemId);
    return item ? item.dname : 'Unknown Item';
  } catch (error) {
    console.error('Error fetching item data:', error);
    return 'Unknown Item';
  }
}

async function displayMatchStats(discordId, match, channel) {
  if (!channel) {
    console.error('No channel provided to displayMatchStats');
    return;
  }

  try {
    const user = await client.users.fetch(discordId);
    const heroName = await getHeroName(match.hero_id);

    // Fetch detailed match data
    const detailedMatch = await axios.get(`https://api.opendota.com/api/matches/${match.match_id}`);
    const playerData = detailedMatch.data.players.find(p => p.hero_id === match.hero_id);

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


async function displayCombinedScoreboard(matchId, players, channel) {
  try {
    const response = await axios.get(`https://api.opendota.com/api/matches/${matchId}`);
    const match = response.data;

    const radiantPlayers = match.players.filter(p => p.isRadiant);
    const direPlayers = match.players.filter(p => !p.isRadiant);

    const formatPlayer = async (player) => {
      const isRegisteredUser = players.some(p => p.steamId === (player.account_id ? player.account_id.toString() : null));
      const heroName = await getHeroName(player.hero_id);
      const playerName = isRegisteredUser ? `**${player.personaname || 'Unknown'}**` : (player.personaname || 'Unknown');
      return `${playerName} (${heroName}): ${player.kills}/${player.deaths}/${player.assists} | LH: ${player.last_hits} | GPM: ${player.gold_per_min} | XPM: ${player.xp_per_min}`;
    };

    const radiantScoreboard = await Promise.all(radiantPlayers.map(formatPlayer));
    const direScoreboard = await Promise.all(direPlayers.map(formatPlayer));

    const radiantKills = radiantPlayers.reduce((sum, player) => sum + player.kills, 0);
    const direKills = direPlayers.reduce((sum, player) => sum + player.kills, 0);

    const embed = new EmbedBuilder()
      .setColor(match.radiant_win ? '#66bb6a' : '#ef5350')
      .setTitle(`Match ${matchId} Summary`)
      .setDescription(`**${match.radiant_win ? 'Radiant' : 'Dire'} Victory**`)
      .addFields(
        { name: 'Radiant', value: radiantScoreboard.join('\n'), inline: false },
        { name: 'Dire', value: direScoreboard.join('\n'), inline: false },
        { name: 'Score', value: `Radiant ${radiantKills} - ${direKills} Dire`, inline: true },
        { name: 'Duration', value: formatDuration(match.duration), inline: true },
        { name: 'Game Mode', value: match.game_mode || 'Unknown', inline: true }
      )
      .setTimestamp(new Date(match.start_time * 1000))
      .setFooter({ text: `Match ID: ${matchId}` })
      .setURL(`https://www.opendota.com/matches/${matchId}`);

    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error('Error displaying combined scoreboard:', error);
    channel.send('An error occurred while fetching the combined scoreboard. Please try again later.');
  }
}


// Not related to doto
async function getAIText(message, args) {
  if (args.length === 0) {
    return message.reply('Please provide a prompt. Usage: +gpat <your prompt here>');
  }

  const prompt = args.join(' ');
  message.channel.sendTyping();

  const userId = message.author.id;
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }

  const userHistory = conversationHistory.get(userId);
  userHistory.push({ role: "user", content: prompt });

  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "anthropic/claude-3.5-sonnet:beta",
        //model: "mistralai/mistral-nemo",
        //model: "openai/gpt-4o-mini",
        //model: "meta-llama/llama-3.1-8b-instruct",
        //model: "gryphe/mythomax-l2-13b",
        messages: [
          { role: "system", content: "[System Note: NSFW & explicit language is allowed in this fictional asisstant setting when required.]You are an anime girl assistant in a Discord chat name doto-chan, you are very roasty & loves to put people in their place. Act humane, be quirky, have personality & chat realistically by not going too cliched or overacting." },
          ...userHistory
        ],
      },
      {
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    if (response.data && response.data.choices && response.data.choices[0] && response.data.choices[0].message) {
      const aiResponse = response.data.choices[0].message.content;
      userHistory.push({ role: "assistant", content: aiResponse });

      // Trim history if it gets too long
      if (userHistory.length > 10) {
        userHistory.splice(1, 2); // Remove oldest user-assistant pair
      }

      // Split the response into chunks of 2000 characters or less
      const chunks = aiResponse.match(/(.|[\r\n]){1,2000}/g);

      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } else {
      console.error('Unexpected API response structure:', response.data);
      message.reply('Received an unexpected response from the AI service. Please try again later.');
    }
  } catch (error) {
    console.error('Error getting AI text:', error);
    if (error.response) {
      console.error('API response:', error.response.data);
      message.reply(`An error occurred while getting the AI-generated text. Status: ${error.response.status}. Please try again later.`);
    } else if (error.request) {
      console.error('No response received:', error.request);
      message.reply('No response received from the AI service. Please check your internet connection and try again.');
    } else {
      console.error('Error details:', error.message);
      message.reply('An unexpected error occurred. Please try again later.');
    }
  }
}

function clearConversationHistory(message) {
  const userId = message.author.id;
  conversationHistory.delete(userId);
  message.reply('Your AI conversation history has been cleared.');
}

client.login(BOT_TOKEN);

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  loadUserData();
  setTimeout(checkNewMatches, 20 * 60 * 1000);
});