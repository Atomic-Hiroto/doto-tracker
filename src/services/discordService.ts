import { Message } from 'discord.js';
import { ProcessConstants, Commands } from '../constants';
import { UserDataService } from './userDataService';
import { TurboStatsService } from './turboStatsService';
import * as commandHandlers from '../commands';
import { logger } from './loggerService';
import { getAIText, channelDataService, handleAnalysisFollowUp } from './aiService';

export async function handleMessage(message: Message, userDataService: UserDataService, turboStatsService: TurboStatsService) {
  // Ignore bot messages
  if (message.author.bot) return;

  const rawParts = message.content.startsWith(ProcessConstants.PREFIX)
    ? message.content.slice(ProcessConstants.PREFIX.length).trim().split(/\s+/).filter(Boolean)
    : [];
  const rawCmd = rawParts[0]?.toLowerCase() ?? null;
  const rawSubcommand = rawParts[1]?.toLowerCase();
  const isOwnerBulkTurboRank =
    message.author.id === ProcessConstants.BOT_OWNER_ID
    && rawCmd === Commands.TURBO_RANK
    && (
      ['calibrateall', 'calibrate-all', 'calibrate_all', 'recalibrateall', 'recalibrate-all', 'recalibrate_all', 'recalc-all', 'recalc_all', 'caliball'].includes(rawSubcommand ?? '')
      || ((rawSubcommand === 'calibrate' || rawSubcommand === 'recalc' || rawSubcommand === 'recalibrate') && rawParts[2]?.toLowerCase() === 'all')
    );

  // Allow help and channel admin commands in any channel so users don't get a silent no-op.
  const isChannelAdmin = rawCmd === Commands.HELP || rawCmd === Commands.SET_CHANNEL || rawCmd === Commands.UNSET_CHANNEL || isOwnerBulkTurboRank;

  // Block all activity in non-allowed channels (except channel admin commands)
  if (!isChannelAdmin && !channelDataService.isAllowed(message.channel.id)) return;

  if (!message.content.startsWith(ProcessConstants.PREFIX) && message.reference?.messageId) {
    if (await handleAnalysisFollowUp(message, userDataService)) return;
  }

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

  const args: string[] = rawParts;
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
    case Commands.RECENT_STATS_ALIAS:
      await commandHandlers.recentStats(message, args, userDataService);
      break;
    case Commands.MATCHES:
      await commandHandlers.matches(message, args, userDataService);
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
    case Commands.TURBO_STUDY:
      await commandHandlers.turboStudy(message, args, userDataService, turboStatsService);
      break;
    case Commands.TURBO_STUDY_HEROES:
    case Commands.TURBO_STUDY_HEROES_ALIAS:
      await commandHandlers.turboStudyHeroes(message, args);
      break;
    case Commands.TURBO_STUDY_PARTY:
      await commandHandlers.turboStudyParty(message, args, userDataService);
      break;
    case Commands.TURBO_STUDY_ITEMS:
      await commandHandlers.turboStudyItems(message, args, userDataService);
      break;
    case Commands.TURBO_STUDY_DEEP:
    case Commands.TURBO_STUDY_STRATZ:
      await commandHandlers.turboStudyDeep(message, args, userDataService);
      break;
    case Commands.TURBO_HERO_LB:
    case Commands.TURBO_STUDY_PLAYERS:
      await commandHandlers.turboHeroLeaderboard(message, args, userDataService);
      break;
    case Commands.TURBO_PAIRINGS:
      // +turbopairs = global board; +turbopairs @user / me = personal duos
      if (message.mentions.users.size > 0 || ['me', 'my', 'mine'].includes(rawSubcommand ?? '')) {
        await commandHandlers.myTurboPairings(message, turboStatsService);
      } else {
        await commandHandlers.turboPairings(message, turboStatsService);
      }
      break;
    case Commands.TURBO_RANK:
      await commandHandlers.turboRank(message, args, userDataService);
      break;
    case Commands.TURBO_LEAN:
      await commandHandlers.turboLean(message, args);
      break;
    case Commands.TURBO_VS:
      await commandHandlers.turboVs(message, args, userDataService, turboStatsService);
      break;
    case Commands.TURBO_CLIMB:
      await commandHandlers.turboClimb(message);
      break;
    case Commands.TURBO_SQUAD:
      await commandHandlers.turboSquad(message, args, userDataService, turboStatsService);
      break;
    case Commands.TURBO_WINRATE:
      await commandHandlers.turboWinRate(message, args, userDataService);
      break;
    case Commands.TURBO_ITEMS:
      await commandHandlers.turboItems(message, args, userDataService);
      break;
    case Commands.TOGGLE_SHARED_CONTEXT:
      await commandHandlers.toggleSharedContext(message, args);
      break;
    case Commands.PROFILE:
      await commandHandlers.profile(message, args, userDataService, turboStatsService);
      break;
    case Commands.TOP_HEROES:
    case Commands.TOP_HEROES_ALIAS:
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
      await commandHandlers.analyze(message, args, userDataService);
      break;
    case Commands.COACH:
      await commandHandlers.coach(message, args, userDataService);
      break;
    case Commands.SUGGEST:
      await commandHandlers.suggest(message, args, userDataService);
      break;
    case Commands.DRAFT:
      await commandHandlers.draft(message, args);
      break;
    case Commands.META:
    case Commands.TURBO_META:
      await commandHandlers.meta(message);
      break;
    case Commands.ACHIEVEMENTS:
      await commandHandlers.achievements(message, args, userDataService);
      break;

    // --- Reference (Dota knowledge base) ---
    case Commands.ITEM:
      await commandHandlers.item(message, args);
      break;
    case Commands.ABILITY:
      await commandHandlers.ability(message, args);
      break;
    case Commands.HERO:
      await commandHandlers.hero(message, args);
      break;
    case Commands.AGHS:
      await commandHandlers.aghs(message, args);
      break;
    case Commands.TALENTS:
      await commandHandlers.talents(message, args);
      break;

    // --- Match visuals ---
    case Commands.GRAPH:
      await commandHandlers.graph(message, args);
      break;
    case Commands.SKILLBUILD:
      await commandHandlers.skillbuild(message, args);
      break;
    case Commands.INVENTORY:
      await commandHandlers.matchInventory(message, args, userDataService);
      break;
    case Commands.PERCENT:
    case Commands.PERCENT_ALIAS:
      await commandHandlers.percent(message, args, userDataService);
      break;
    case Commands.ROLES:
      await commandHandlers.roles(message, args, userDataService);
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
