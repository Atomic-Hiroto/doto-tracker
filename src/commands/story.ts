import { Message } from 'discord.js';
import { analyze } from './aiCommands';

// +story is deprecated in favour of the fact-grounded +analyze. It is kept as a
// thin alias so existing usage and muscle memory keep working: it forwards to a
// whole-match analysis (which, unlike the old story flow, handles unparsed data).
export async function story(message: Message, args: string[]) {
  return analyze(message, args);
}
