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
const users = new Map();
const lastCheckedMatch = new Map();
const conversationHistory = new Map();

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

client.on('messageCreate', async (message) => {
  if (!message.content.startsWith(prefix) || message.author.bot) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'help') {
    message.reply('Available commands:\n+register <steam_id> - Register your Steam ID\n+rs [@user] - Show your or mentioned user\'s most recent match stats\n+help - Show this help message');
  } else if (command === 'register') {
    registerUser(message, args);
  } else if (command === 'unregister') {
    await unregisterUser(message, args);
  } else if (command === 'rs') {
    await getRecentStats(message, args);
  } else if (command === 'gpat') {
    await getAIText(message, args);
  } else if (command === 'gpatclear') {
    clearConversationHistory(message);
  } else if (command === 'caow') {
    message.reply('Thrower hai');
  }
});

function loadUsers() {
  try {
    const data = fs.readFileSync('users.json', 'utf8');
    const loadedUsers = JSON.parse(data);
    for (const [discordId, steamId] of Object.entries(loadedUsers)) {
      users.set(discordId, steamId);
    }
    console.log('Users loaded successfully');
  } catch (error) {
    console.error('Error loading users:', error);
  }
}

function saveUsers() {
  const usersObject = Object.fromEntries(users);
  fs.writeFileSync('users.json', JSON.stringify(usersObject, null, 2));
}

async function registerUser(message, args) {
  if (args.length !== 1) {
    return message.reply('Please provide your Steam ID. Usage: +register <steam_id>');
  }

  const steamId = args[0];
  users.set(message.author.id, steamId);
  saveUsers();
  message.reply(`Successfully registered Steam ID: ${steamId}`);
}

async function unregisterUser(message) {
  const steamId = users.get(message.author.id);
  if (!users.has(message.author.id)) {
    return message.reply('You are not registered');
  }
  users.delete(message.author.id);
  saveUsers();
  message.reply(`Successfully unregistered Steam ID: ${steamId}`);
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

  for (const [discordId, steamId] of users) {
    try {
      const response = await axios.get(`https://api.opendota.com/api/players/${steamId}/recentMatches`);
      const recentMatch = response.data[0];

      if (!lastCheckedMatch.has(discordId) || lastCheckedMatch.get(discordId) !== recentMatch.match_id) {
        lastCheckedMatch.set(discordId, recentMatch.match_id);
        
        if (!recentMatches.has(recentMatch.match_id)) {
          recentMatches.set(recentMatch.match_id, []);
        }
        recentMatches.get(recentMatch.match_id).push({ discordId, steamId, match: recentMatch });
      }
    } catch (error) {
      console.error(`Error fetching recent matches for user ${discordId}:`, error);
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
  setTimeout(checkNewMatches, 20 * 60 * 1000);
}

async function getRecentStats(message, args) {
  let discordId;
  let steamId;

  if (message.mentions.users.size > 0) {
    // If a user is mentioned, get their Discord ID
    discordId = message.mentions.users.first().id;
    steamId = users.get(discordId);
  } else {
    // If no user is mentioned, use the message author's ID
    discordId = message.author.id;
    steamId = users.get(discordId);
  }

  if (!steamId) {
    return message.reply(discordId === message.author.id 
      ? "You haven't registered your Steam ID yet. Use +register <steam_id> to register."
      : "The mentioned user hasn't registered their Steam ID yet.");
  }

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

async function displayMatchStats(discordId, match, channel) {
  if (!channel) {
    console.error('No channel provided to displayMatchStats');
    return;
  }

  const user = await client.users.fetch(discordId);
  const heroName = await getHeroName(match.hero_id);

  const embed = new EmbedBuilder()
    .setColor('#0099ff')
    .setTitle(`Recent Match for ${user.username}`)
    .addFields(
      { name: 'Hero', value: heroName, inline: true },
      { name: 'K/D/A', value: `${match.kills}/${match.deaths}/${match.assists}`, inline: true },
      { name: 'GPM/XPM', value: `${match.gold_per_min}/${match.xp_per_min}`, inline: true },
      { name: 'Last Hits', value: match.last_hits.toString(), inline: true },
      { name: 'Result', value: match.player_slot <= 127 ? (match.radiant_win ? 'Win' : 'Loss') : (match.radiant_win ? 'Loss' : 'Win'), inline: true },
      { name: 'Duration', value: `${Math.floor(match.duration / 60)}:${(match.duration % 60).toString().padStart(2, '0')}`, inline: true }
    )
    .setTimestamp()
    .setFooter({ text: `Match ID: ${match.match_id}` })
    .setURL(`https://www.opendota.com/matches/${match.match_id}`);

  try {
    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error('Error sending match stats:', error);
  }
}

async function displayCombinedScoreboard(matchId, players, channel) {
  try {
    const response = await axios.get(`https://api.opendota.com/api/matches/${matchId}`);
    const match = response.data;

    const radiantPlayers = match.players.filter(p => p.isRadiant);
    const direPlayers = match.players.filter(p => !p.isRadiant);

    const formatPlayer = (player) => {
      const isRegisteredUser = players.some(p => p.steamId === player.account_id.toString());
      const heroName = getHeroName(player.hero_id);
      const playerName = isRegisteredUser ? `**${player.personaname || 'Unknown'}**` : (player.personaname || 'Unknown');
      return `${playerName} (${heroName}): ${player.kills}/${player.deaths}/${player.assists}`;
    };

    const radiantScoreboard = radiantPlayers.map(formatPlayer).join('\n');
    const direScoreboard = direPlayers.map(formatPlayer).join('\n');

    const embed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle(`Combined Match Scoreboard`)
      .addFields(
        { name: 'Radiant', value: radiantScoreboard, inline: false },
        { name: 'Dire', value: direScoreboard, inline: false },
        { name: 'Result', value: match.radiant_win ? 'Radiant Victory' : 'Dire Victory', inline: true },
        { name: 'Duration', value: `${Math.floor(match.duration / 60)}:${(match.duration % 60).toString().padStart(2, '0')}`, inline: true }
      )
      .setTimestamp()
      .setFooter({ text: `Match ID: ${matchId}` })
      .setURL(`https://www.opendota.com/matches/${matchId}`);

    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error('Error displaying combined scoreboard:', error);
    channel.send('An error occurred while fetching the combined scoreboard. Please try again later.');
  }
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
  loadUsers();
  setTimeout(checkNewMatches, 20 * 60 * 1000);
});