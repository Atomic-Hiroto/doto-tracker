import { Message } from 'discord.js';
import { Replies } from '../constants';
import { UserDataService } from '../services/userDataService';
import { normalizeSteamId } from '../utils/validators';

export async function register(message: Message, args: string[], userDataService: UserDataService) {
  if (args.length !== 1) {
    return message.reply(Replies.PROVIDE_STEAM_ID);
  }

  const steamId = normalizeSteamId(args[0]);

  if (!steamId) {
    return message.reply(
      "I couldn't read that Steam ID. You can give me any of these:\n"
      + '• your **Friend ID / 32-bit ID** (e.g. `428786815`)\n'
      + '• your **SteamID64** (e.g. `76561198389052543`)\n'
      + '• your **profile URL** (`steamcommunity.com/profiles/...`) or a **Dotabuff/OpenDota** link\n\n'
      + "If you only have a vanity URL (`steamcommunity.com/id/yourname`), open your **OpenDota** or **Dotabuff** page and copy the number from the URL — I can't resolve vanity names.",
    );
  }

  const existingDiscordUser = userDataService.getUserByDiscordId(message.author.id);
  if (existingDiscordUser) {
    return message.reply(`You are already registered with Steam ID ${existingDiscordUser.steamId}. Use \`+unregister\` first if you want to switch accounts.`);
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
