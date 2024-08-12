import { Message } from 'discord.js';
import { getAIText, clearConversationHistory } from '../services/aiService';

export async function gpat(message: Message, args: string[]) {
  await getAIText(message, args);
}

export async function gpatClear(message: Message) {
  clearConversationHistory(message);
}