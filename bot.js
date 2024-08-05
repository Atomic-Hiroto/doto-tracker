require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');

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

let userData = {};

function loadUserData() {
  try {
    const data = fs.readFileSync(USER_DATA_FILE, 'utf8');
    const loadedData = JSON.parse(data);
    
    // Check if the loaded data is in the old format
    if (typeof Object.values(loadedData)[0] === 'string') {
      // Convert old format to new format
      Object.keys(loadedData).forEach(discordId => {
        userData[discordId] = {
          steamId: loadedData[discordId],
          autoShow: true,
          lastCheckedMatch: null
        };
      });
      console.log('Converted user data from old format to new format');
      saveUserData(); // Save the converted data
    } else {
      userData = loadedData;
    }
    
    console.log('User data loaded successfully');
  } catch (error) {
    console.error('Error loading user data:', error);
    userData = {};
  }
}

function saveUserData() {
  fs.writeFileSync(USER_DATA_FILE, JSON.stringify(userData, null, 2));
}

client.on('messageCreate', async (message) => {
  if (!message.content.startsWith(prefix) || message.author.bot) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'help') {
    message.reply('Available commands:\n+register <steam_id> - Register your Steam ID\n+rs [@user] - Show your or mentioned user\'s most recent match stats\n+toggleauto - Toggle auto-showing of your recent matches\n+help - Show this help message');
  } else if (command === 'register') {
    registerUser(message, args);
  } else if (command === 'unregister') {
    await unregisterUser(message);
  } else if (command === 'rs') {
    await getRecentStats(message, args);
  } else if (command === 'toggleauto') {
    toggleAutoShow(message);
  } else if (command === 'gpat') {
    await getAIText(message, args);
  } else if (command === 'gpatclear') {
    clearConversationHistory(message);
  } else if (command === 'caow') {
    message.reply('Thrower hai');
  }
});

function registerUser(message, args) {
  if (args.length !== 1) {
    return message.reply('Please provide your Steam ID. Usage: +register <steam_id>');
  }

  const steamId = args[0];
  userData[message.author.id] = {
    steamId: steamId,
    autoShow: true,
    lastCheckedMatch: null
  };
  saveUserData();
  message.reply(`Successfully registered Steam ID: ${steamId}. Auto-show is enabled by default. Use +toggleauto to disable.`);
}

async function unregisterUser(message) {
  if (!userData[message.author.id]) {
    return message.reply('You are not registered');
  }
  const steamId = userData[message.author.id].steamId;
  delete userData[message.author.id];
  saveUserData();
  message.reply(`Successfully unregistered Steam ID: ${steamId}`);
}

function toggleAutoShow(message) {
  const userId = message.author.id;
  if (!userData[userId]) {
    return message.reply('You need to register first. Use +register <steam_id> to register.');
  }

  userData[userId].autoShow = !userData[userId].autoShow;
  saveUserData();
  message.reply(`Auto-show for your recent matches has been ${userData[userId].autoShow ? 'enabled' : 'disabled'}.`);
}

async function checkNewMatches() {
  const guild = client.guilds.cache.first();
  if (!guild) {
    console.error('Bot is not in any guild');
    return;
  }

  const channel = guild.channels.cache.find(ch => ch.name === 'match-updates' || ch.name === 'doto');
  if (!channel) {
    console.error('Could not find a suitable channel to post updates');
    return;
  }

  const recentMatches = new Map();

  for (const [discordId, user] of Object.entries(userData)) {
    if (!user.autoShow) continue; // Skip users who have disabled auto-show

    try {
      const response = await axios.get(`https://api.opendota.com/api/players/${user.steamId}/recentMatches`);
      const recentMatch = response.data[0];

      if (!user.lastCheckedMatch || user.lastCheckedMatch !== recentMatch.match_id) {
        userData[discordId].lastCheckedMatch = recentMatch.match_id;
        
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

async function getRecentStats(message, args) {
  let discordId;
  let steamId;

  if (message.mentions.users.size > 0) {
    discordId = message.mentions.users.first().id;
  } else {
    discordId = message.author.id;
  }

  if (!userData[discordId]) {
    return message.reply(discordId === message.author.id 
      ? "You haven't registered your Steam ID yet. Use +register <steam_id> to register."
      : "The mentioned user hasn't registered their Steam ID yet.");
  }

  steamId = userData[discordId].steamId;

  try {
    const response = await axios.get(`https://api.opendota.com/api/players/${steamId}/recentMatches`);
    const recentMatch = response.data[0];

    if (recentMatch) {
      await displayMatchStats(discordId, recentMatch, message.channel);
    } else {
      message.reply(discordId === message.author.id
        ? "No recent matches found for you."
        : "No recent matches found for the mentioned user.");
    }
  } catch (error) {
    console.error(`Error fetching recent match for user ${discordId}:`, error);
    message.reply("An error occurred while fetching the recent match. Please try again later.");
  }
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

async function getHeroName(heroId) {
  try {
    const response = await axios.get('https://api.opendota.com/api/heroes');
    const hero = response.data.find(h => h.id === heroId);
    return hero ? hero.localized_name : 'Unknown Hero';
  } catch (error) {
    console.error('Error fetching hero data:', error);
    return 'Unknown Hero';
  }
}

async function getItemName(itemId) {
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
        { name: 'Game Mode', value: match.game_mode_name || 'Unknown', inline: true }
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
        //model: "anthropic/claude-3.5-sonnet:beta",
        model: "mistralai/mistral-nemo",
        //model: "openai/gpt-4o-mini",
        //model: "meta-llama/llama-3.1-8b-instruct",
        //model: "gryphe/mythomax-l2-13b",
        messages: [
          { role: "system", content: "You are a human assistant in a Discord chat. Act humane, be quirky, have personality." },
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