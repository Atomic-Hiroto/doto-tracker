import { Message } from 'discord.js';
import { getMatchStory } from '../services/aiService';
import { getDetailedMatchData } from '../services/dotaService';

export async function story(message: Message, args: string[]) {
  if (args.length !== 1) {
    return message.reply('Please provide a match ID. Usage: +story <match_id>');
  }

  const matchId = parseInt(args[0], 10);
  if (isNaN(matchId)) {
    return message.reply('Invalid match ID. Please provide a valid number.');
  }

  try {
    const matchData = await getDetailedMatchData(matchId);
    if (!matchData) {
      return message.reply('Unable to fetch match data. The match might not be parsed yet.');
    }

    await getMatchStory(message, matchData);
  } catch (error) {
    console.error('Error generating match story:', error);
    message.reply('An error occurred while generating the match story. Please try again later.');
  }
}