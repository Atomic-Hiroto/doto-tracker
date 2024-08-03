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

const BOT_TOKEN = process.env.BOT_TOKEN;

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  loadUsers();
  checkNewMatches();
});

client.on('messageCreate', async (message) => {
  if (!message.content.startsWith(prefix) || message.author.bot) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'help') {
    message.reply('Available commands:\n+register <steam_id> - Register your Steam ID\n+rs - Show your most recent match stats\n+help - Show this help message');
  } else if (command === 'register') {
    registerUser(message, args);
  } else if (command === 'unregister') {
    await unregisterUser(message, args);
  } else if (command === 'rs') {
    await getRecentStats(message);
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
  if(!users.has(message.author.id)){
    return message.reply('You are not registered');
  }
  users.delete(message.author.id);
  saveUsers();
  message.reply(`Successfully unregistered Steam ID: ${steamId}`);
}


async function checkNewMatches() {
  const guild = client.guilds.cache.first(); // Get the first guild the bot is in
  if (!guild) {
    console.error('Bot is not in any guild');
    return;
  }

  const channel = guild.channels.cache.find(ch => ch.name === 'match-updates' || ch.name === 'doto');
  if (!channel) {
    console.error('Could not find a suitable channel to post updates');
    return;
  }

  for (const [discordId, steamId] of users) {
    try {
      const response = await axios.get(`https://api.opendota.com/api/players/${steamId}/recentMatches`);
      const recentMatch = response.data[0];

      if (!lastCheckedMatch.has(discordId) || lastCheckedMatch.get(discordId) !== recentMatch.match_id) {
        lastCheckedMatch.set(discordId, recentMatch.match_id);
        await displayMatchStats(discordId, recentMatch, channel);
      }
    } catch (error) {
      console.error(`Error fetching recent matches for user ${discordId}:`, error);
    }
  }

  // Check again after 20 minutes
  setTimeout(checkNewMatches, 20 * 60 * 1000);
}
async function getRecentStats(message) {
  const discordId = message.author.id;
  const steamId = users.get(discordId);

  if (!steamId) {
    return message.reply("You haven't registered your Steam ID yet. Use +register <steam_id> to register.");
  }

  try {
    const response = await axios.get(`https://api.opendota.com/api/players/${steamId}/recentMatches`);
    const recentMatch = response.data[0];

    if (recentMatch) {
      await displayMatchStats(discordId, recentMatch, message.channel);
    } else {
      message.reply("No recent matches found.");
    }
  } catch (error) {
    console.error(`Error fetching recent match for user ${discordId}:`, error);
    message.reply("An error occurred while fetching your recent match. Please try again later.");
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
    .setFooter({ text: `Match ID: ${match.match_id}` });

  try {
    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error('Error sending match stats:', error);
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


client.login(BOT_TOKEN);

// Add this line to the end of the 'ready' event handler
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  loadUsers();
  checkNewMatches();
});