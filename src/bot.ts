import { Client } from 'discord.js';
import { UserDataService } from './services/userDataService';
import { handleMessage } from './services/discordService';
import { checkNewMatches } from './services/dotaService';
import { ProcessConstants } from './constants';

export function initializeBot(client: Client) {
  const userDataService = new UserDataService();

  client.once('ready', () => {
    console.log(`Logged in as ${client.user!.tag}!`);
    setTimeout(() => checkNewMatches(client, userDataService), ProcessConstants.CHECK_INTERVAL);
  });

  client.on('messageCreate', async (message) => {
    await handleMessage(message, userDataService);
  });

  return client;
}