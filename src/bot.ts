import { Client } from 'discord.js';
import { UserDataService } from './services/userDataService';
import { TurboStatsService } from './services/turboStatsService';
import { handleMessage } from './services/discordService';
import { checkNewMatches } from './services/dotaService';
import { ProcessConstants } from './constants';
import { logger } from './services/loggerService';
import { dotaDataService } from './services/dotaDataService';
import { registerInteractionHandler, registerSlashCommands } from './services/interactionService';
import { closeDotabuffBrowser } from './services/dotabuffScraper';
import { startTiPoller, stopTiPoller } from './services/tiService';

export async function initializeBot(client: Client) {
  const userDataService = new UserDataService();
  const turboStatsService = new TurboStatsService();

  // Pre-cache hero and item data before starting
  await dotaDataService.initialize();

  client.once('ready', () => {
    logger.info(`Logged in as ${client.user!.tag}!`);
    registerSlashCommands(client).catch((error) => logger.warn('Failed to register slash commands:', error));
    setTimeout(() => checkNewMatches(client, userDataService, turboStatsService), ProcessConstants.CHECK_INTERVAL);
    startTiPoller(client);
  });

  client.on('messageCreate', async (message) => {
    await handleMessage(message, userDataService, turboStatsService);
  });

  // Register button/component interaction handler
  registerInteractionHandler(client, userDataService, turboStatsService);

  // Graceful shutdown
  async function shutdown(signal: string) {
    logger.info(`Received ${signal} — shutting down gracefully...`);
    userDataService.saveUserData();
    stopTiPoller();
    await closeDotabuffBrowser().catch(() => null);
    client.destroy();
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A rejected promise anywhere — a Discord send that lost its target message, a
  // provider timing out inside a fire-and-forget task — used to exit the process
  // and take every other user's command down with it. Log it and stay up; the
  // command that caused it has already failed on its own terms.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection (bot staying up):', reason);
  });
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception (bot staying up):', error);
  });


  return client;
}
