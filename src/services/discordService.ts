import { Message } from 'discord.js';
import { ProcessConstants, Commands } from '../constants';
import { UserDataService } from './userDataService';
import { TurboStatsService } from './turboStatsService';
import * as commandHandlers from '../commands';
import { logger } from './loggerService';
import { getAIText, channelDataService } from './aiService';

export async function handleMessage(message: Message, userDataService: UserDataService, turboStatsService: TurboStatsService) {
  // Ignore bot messages
  if (message.author.bot) return;

  // Allow setchannel/unsetchannel to work in any channel so the owner can manage the allowlist
  const rawCmd = message.content.startsWith(ProcessConstants.PREFIX)
    ? message.content.slice(ProcessConstants.PREFIX.length).trim().split(/\s+/)[0]?.toLowerCase()
    : null;
  const isChannelAdmin = rawCmd === Commands.SET_CHANNEL || rawCmd === Commands.UNSET_CHANNEL;

  // Block all activity in non-allowed channels (except channel admin commands)
  if (!isChannelAdmin && !channelDataService.isAllowed(message.channel.id)) return;

  // Check if the bot was mentioned
  const botMentioned = message.mentions.has(message.client.user!);

  if (botMentioned) {
    const mentionRegex = new RegExp(`<@!?${message.client.user!.id}>`, 'g');
    const prompt = message.content.replace(mentionRegex, '').trim();
    const args = prompt ? prompt.split(/\s+/) : [];

    logger.debug(`Bot mentioned by ${message.author.username} with args: ${args}`);
    await getAIText(message, args, true);
    return;
  }

  if (!message.content.startsWith(ProcessConstants.PREFIX)) return;

  const args: string[] = message.content.slice(ProcessConstants.PREFIX.length).trim().split(ProcessConstants.SPACE);
  const command: string | undefined = args.shift()?.toLowerCase();

  logger.debug(`Command ${command} called with args ${args} by author ${message.author}`);

  switch (command) {
    // --- Existing commands ---
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
    case Commands.PROFILE:
      await commandHandlers.profile(message, args, userDataService, turboStatsService);
      break;
    case Commands.TOP_HEROES:
      await commandHandlers.tophero(message, args, userDataService);
      break;

    // --- Phase 2 ---
    case Commands.STREAK:
      await commandHandlers.streak(message, args, userDataService);
      break;

    // --- Phase 3 ---
    case Commands.TREND:
      await commandHandlers.trend(message, args, userDataService);
      break;
    case Commands.HEROES:
      await commandHandlers.heroes(message, args, userDataService);
      break;
    case Commands.COMPARE:
      await commandHandlers.compare(message, args, userDataService, turboStatsService);
      break;

    // --- Phase 4 ---
    case Commands.ANALYZE:
      await commandHandlers.analyze(message, args);
      break;
    case Commands.SUGGEST:
      await commandHandlers.suggest(message, args, userDataService);
      break;
    case Commands.DRAFT:
      await commandHandlers.draft(message, args);
      break;
    case Commands.META:
      await commandHandlers.meta(message);
      break;
    case Commands.ACHIEVEMENTS:
      await commandHandlers.achievements(message, args, userDataService);
      break;

    // --- Admin ---
    case Commands.SET_CHANNEL:
      await commandHandlers.setChannel(message, channelDataService);
      break;
    case Commands.UNSET_CHANNEL:
      await commandHandlers.unsetChannel(message, channelDataService);
      break;

    default:
      await message.reply('Unknown command. Use +help to see available commands.');
      break;
  }
}