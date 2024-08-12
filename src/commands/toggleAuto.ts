import { Message } from 'discord.js';
import { Replies } from '../constants';
import { UserDataService } from '../services/userDataService';

export async function toggleAuto(message: Message, userDataService: UserDataService) {
  const user = userDataService.getUserByDiscordId(message.author.id);
  if (!user) {
    return message.reply(Replies.NEED_REGISTRATION);
  }

  user.autoShow = !user.autoShow;
  userDataService.updateUser(user);
  message.reply(Replies.AUTO_SHOW_TOGGLED(user.autoShow));
}