import { Client } from 'discord.js';
import { UserDataService } from './services/userDataService';
import { TurboStatsService } from './services/turboStatsService';
import { handleMessage } from './services/discordService';
import { checkNewMatches } from './services/dotaService';
import { ProcessConstants } from './constants';
import { logger } from './services/loggerService';

export function initializeBot(client: Client) {
  const userDataService = new UserDataService();
  const turboStatsService = new TurboStatsService();

  client.once('ready', () => {
    logger.info(`Logged in as ${client.user!.tag}!`);
    setTimeout(() => checkNewMatches(client, userDataService, turboStatsService), ProcessConstants.CHECK_INTERVAL);
  });

  client.on('messageCreate', async (message) => {
    await handleMessage(message, userDataService, turboStatsService);
  });

  return client;
}