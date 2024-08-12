import { Message } from 'discord.js';
import { ProcessConstants, Commands } from '../constants';
import { UserDataService } from './userDataService';
import * as commandHandlers from '../commands';

export async function handleMessage(message: Message, userDataService: UserDataService) {
  if (!message.content.startsWith(ProcessConstants.PREFIX) || message.author.bot) return;

  const args: string[] = message.content.slice(ProcessConstants.PREFIX.length).trim().split(ProcessConstants.SPACE);
  const command: string | undefined = args.shift()?.toLowerCase();

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
    default:
      await message.reply('Unknown command. Use +help to see available commands.');
      break;
  }
}