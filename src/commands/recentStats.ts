import { Message } from 'discord.js';
import { Replies } from '../constants';
import { UserDataService } from '../services/userDataService';
import { getRecentStats } from '../services/dotaService';
import { logger } from '../services/loggerService';

export async function recentStats(message: Message, args: string[], userDataService: UserDataService) {
  let discordId = message.author.id;

  if (args.length > 0 && message.mentions.users.size > 0) {
    discordId = message.mentions.users.first()!.id;
  }

  const user = userDataService.getUserByDiscordId(discordId);
  if (!user) {
    return message.reply(Replies.NEED_REGISTRATION);
  }

  try {
    await getRecentStats(discordId, user.steamId, message.channel);
  } catch (error) {
    logger.error(`Error in recentStats command for user ${discordId}:`, error);
    message.reply('An error occurred while fetching the recent match stats. Please try again later.');
  }
}