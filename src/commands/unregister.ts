import { Message } from 'discord.js';
import { Replies } from '../constants';
import { UserDataService } from '../services/userDataService';

export async function unregister(message: Message, userDataService: UserDataService) {
  const user = userDataService.getUserByDiscordId(message.author.id);
  if (!user) {
    return message.reply(Replies.NOT_REGISTERED);
  }

  userDataService.deleteUser(message.author.id);
  message.reply(Replies.UNREGISTER_SUCCESS(user.steamId));
}