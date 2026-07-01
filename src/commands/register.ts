import { Message, PermissionFlagsBits, User } from 'discord.js';
import { ProcessConstants, Replies } from '../constants';
import { UserDataService } from '../services/userDataService';
import { normalizeSteamId } from '../utils/validators';

function isMentionToken(arg: string): boolean {
  return /^<@!?\d+>$/.test(arg);
}

function canRegisterOtherUser(message: Message): boolean {
  if (message.author.id === ProcessConstants.BOT_OWNER_ID) return true;
  const permissions = (message as any).memberPermissions ?? (message.member as any)?.permissions;
  if (typeof permissions?.has === 'function') {
    return permissions.has(PermissionFlagsBits.ManageGuild);
  }
  try {
    return (BigInt(permissions ?? 0) & PermissionFlagsBits.ManageGuild) === PermissionFlagsBits.ManageGuild;
  } catch {
    return false;
  }
}

export async function register(message: Message, args: string[], userDataService: UserDataService) {
  const mentionedUser = message.mentions.users.first();
  const targetUser: User = mentionedUser ?? message.author;
  const steamArgs = mentionedUser ? args.filter(arg => !isMentionToken(arg)) : args;
  const registeringOtherUser = targetUser.id !== message.author.id;

  if (steamArgs.length !== 1) {
    return message.reply(Replies.PROVIDE_STEAM_ID);
  }

  if (registeringOtherUser && !canRegisterOtherUser(message)) {
    return message.reply('Only the bot owner or server managers can register another Discord user. They can still run `+register <steam_id>` themselves.');
  }

  if (targetUser.bot) {
    return message.reply('I will not register a bot account to a Steam ID.');
  }

  const steamId = normalizeSteamId(steamArgs[0]);

  if (!steamId) {
    return message.reply(
      "I couldn't read that Steam ID. You can give me any of these:\n"
      + '• your **Friend ID / 32-bit ID** (e.g. `428786815`)\n'
      + '• your **SteamID64** (e.g. `76561198389052543`)\n'
      + '• your **profile URL** (`steamcommunity.com/profiles/...`) or a **Dotabuff/OpenDota** link\n\n'
      + "If you only have a vanity URL (`steamcommunity.com/id/yourname`), open your **OpenDota** or **Dotabuff** page and copy the number from the URL — I can't resolve vanity names.",
    );
  }

  const existingDiscordUser = userDataService.getUserByDiscordId(targetUser.id);
  if (existingDiscordUser) {
    const who = registeringOtherUser ? `**${targetUser.username}** is` : 'You are';
    return message.reply(`${who} already registered with Steam ID ${existingDiscordUser.steamId}. Use \`+unregister\` first if you want to switch accounts.`);
  }

  const existingUser = userDataService.getUserBySteamId(steamId);
  if (existingUser) {
    return message.reply(Replies.ALREADY_REGISTERED(steamId, existingUser.discordId));
  }

  userDataService.addUser({
    discordId: targetUser.id,
    steamId: steamId,
    autoShow: true,
    lastCheckedMatch: null
  });

  message.reply(registeringOtherUser
    ? Replies.REGISTER_SUCCESS_FOR(targetUser.id, steamId)
    : Replies.REGISTER_SUCCESS(steamId));
}
