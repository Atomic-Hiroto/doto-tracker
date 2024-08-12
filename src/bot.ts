import { Client } from 'discord.js';
import { UserDataService } from './services/userDataService';
import { handleMessage } from './services/discordService';
import { checkNewMatches } from './services/dotaService';

export function initializeBot(client: Client) {
  const userDataService = new UserDataService();

  client.once('ready', () => {
    console.log(`Logged in as ${client.user!.tag}!`);
    setTimeout(() => checkNewMatches(client, userDataService), 20 * 60 * 1000);
  });

  client.on('messageCreate', async (message) => {
    await handleMessage(message, userDataService);
  });

  return client;
}