import { Message } from 'discord.js';
import { ProcessConstants, Commands } from '../constants';
import { UserDataService } from './userDataService';
import { TurboStatsService } from './turboStatsService';
import * as commandHandlers from '../commands';
import { logger } from './loggerService';

export async function handleMessage(message: Message, userDataService: UserDataService, turboStatsService: TurboStatsService) {
  if (!message.content.startsWith(ProcessConstants.PREFIX) || message.author.bot) return;

  const args: string[] = message.content.slice(ProcessConstants.PREFIX.length).trim().split(ProcessConstants.SPACE);
  const command: string | undefined = args.shift()?.toLowerCase();

  logger.debug(`Command ${command} called with args ${args} by author ${message.author}`);

  switch (command) {
    case Commands.HELP:
      await commandHandlers.help(message);
      break;
    case Commands.REGISTER:
      await commandHandlers.register(message, args, userDataService);
      break;
    case Commands.UNREGISTER:
      await commandHandlers.unregister(message, userDataService);
      break;
    case Commands.RECENT_STATS:
      await commandHandlers.recentStats(message, args, userDataService);
      break;
    case Commands.TOGGLE_AUTO:
      await commandHandlers.toggleAuto(message, userDataService);
      break;
    case Commands.GPAT:
      await commandHandlers.gpat(message, args);
      break;
    case Commands.GPAT_CLEAR:
      await commandHandlers.gpatClear(message);
      break;
    case Commands.CAOW:
      await commandHandlers.caow(message);
      break;
    case Commands.STORY:
      await commandHandlers.story(message, args);
      break;
    case Commands.TURBO_LEADERBOARD:
      await commandHandlers.turboLeaderboard(message, turboStatsService);
      break;
    case Commands.TURBO_STATS:
      await commandHandlers.turboStats(message, turboStatsService);
      break;
    case Commands.TURBO_PAIRINGS:
      await commandHandlers.turboPairings(message, turboStatsService);
      break;
    case Commands.MY_TURBO_PAIRINGS:
      await commandHandlers.myTurboPairings(message, turboStatsService);
      break;
    case Commands.TOGGLE_SHARED_CONTEXT:
      await commandHandlers.toggleSharedContext(message, args);
      break;
    default:
      await message.reply('Unknown command. Use +help to see available commands.');
      break;
  }
}