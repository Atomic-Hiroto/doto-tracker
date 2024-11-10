import { Message } from 'discord.js';
import { Replies } from '../constants';
import { UserDataService } from '../services/userDataService';
import { isValidDiscordId, isValidSteamId } from '../utils/validators';
import { logger } from '../services/loggerService';

export async function register(message: Message, args: string[], userDataService: UserDataService) {
  if (args.length < 1) {
    return message.reply(Replies.PROVIDE_STEAM_ID);
  }

  const steamId = args[0];
  const discordId = args.length > 1 ? (extractUserId(args[1]) ? extractUserId(args[1]) : args[1]) : message.author.id;
  logger.debug(discordId);

  if (!isValidSteamId(steamId)) {
    return message.reply('Invalid Steam ID. Please provide a valid 32-bit Steam ID.');
  }

  if (!isValidDiscordId(discordId)) {
    return message.reply('Invalid discord ID. Please provide a valid discord ID.')
  }

  const existingUser = userDataService.getUserBySteamId(steamId);
  if (existingUser) {
    return message.reply(Replies.ALREADY_REGISTERED(steamId, existingUser.discordId));
  }

  userDataService.addUser({
    discordId: discordId,
    steamId: steamId,
    autoShow: true,
    lastCheckedMatch: null
  });

  message.reply(Replies.REGISTER_SUCCESS(steamId));
}

function extractUserId(mention: string): string {
  const match = mention.match(/\d+/);
  return match?.[0] ?? '';
}