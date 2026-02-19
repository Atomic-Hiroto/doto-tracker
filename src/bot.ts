import { Client } from 'discord.js';
import { UserDataService } from './services/userDataService';
import { TurboStatsService } from './services/turboStatsService';
import { handleMessage } from './services/discordService';
import { checkNewMatches } from './services/dotaService';
import { ProcessConstants } from './constants';
import { logger } from './services/loggerService';
import { dotaDataService } from './services/dotaDataService';
import { registerInteractionHandler } from './services/interactionService';
import { closeDotabuffBrowser } from './services/dotabuffScraper';

export async function initializeBot(client: Client) {
  const userDataService = new UserDataService();
  const turboStatsService = new TurboStatsService();

  // Pre-cache hero and item data before starting
  await dotaDataService.initialize();

  client.once('ready', () => {
    logger.info(`Logged in as ${client.user!.tag}!`);
    setTimeout(() => checkNewMatches(client, userDataService, turboStatsService), ProcessConstants.CHECK_INTERVAL);
  });

  client.on('messageCreate', async (message) => {
    await handleMessage(message, userDataService, turboStatsService);
  });

  // Register button/component interaction handler
  registerInteractionHandler(client);

  // Graceful shutdown
  async function shutdown(signal: string) {
    logger.info(`Received ${signal} — shutting down gracefully...`);
    userDataService.saveUserData();
    await closeDotabuffBrowser().catch(() => null);
    client.destroy();
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));


  return client;
}
