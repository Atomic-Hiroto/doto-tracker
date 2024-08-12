import { Client, GatewayIntentBits } from 'discord.js';
import { ProcessConstants } from './constants';
import { initializeBot } from './bot';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

initializeBot(client);

client.login(ProcessConstants.BOT_TOKEN);