import { Message } from 'discord.js';
import { Replies } from '../constants';

export async function help(message: Message) {
  await message.reply(Replies.HELP);
}