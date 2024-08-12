import { Message } from 'discord.js';
import { Replies } from '../constants';

export async function caow(message: Message) {
  await message.reply(Replies.CAOW);
}