import { Message } from 'discord.js';
import { Replies } from '../constants';
import { UserDataService } from '../services/userDataService';
import { isValidSteamId } from '../utils/validators';

export async function register(message: Message, args: string[], userDataService: UserDataService) {
  if (args.length !== 1) {
    return message.reply(Replies.PROVIDE_STEAM_ID);
  }

  const steamId = args[0];

  if (!isValidSteamId(steamId)) {
    return message.reply('Invalid Steam ID. Please provide a valid 32-bit Steam ID.');
  }

  const existingUser = userDataService.getUserBySteamId(steamId);
  if (existingUser) {
    return message.reply(Replies.ALREADY_REGISTERED(steamId, existingUser.discordId));
  }

  userDataService.addUser({
    discordId: message.author.id,
    steamId: steamId,
    autoShow: true,
    lastCheckedMatch: null
  });

  message.reply(Replies.REGISTER_SUCCESS(steamId));
}