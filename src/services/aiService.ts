import axios from 'axios';
import { Message } from 'discord.js';
import { AIConstants, ProcessConstants } from '../constants';
import { formatDuration } from '../utils/formatters';

const conversationHistory = new Map<string, any[]>();

export async function getAIText(message: Message, args: string[]) {
  if (args.length === 0) {
    return message.reply('Please provide a prompt. Usage: +gpat <your prompt here>');
  }

  const prompt = args.join(' ');
  message.channel.sendTyping();

  const userId = message.author.id;
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }

  const userHistory = conversationHistory.get(userId)!;
  userHistory.push({ role: "user", content: prompt });

  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: AIConstants.AI_MODEL,
        messages: [
          { role: "system", content: AIConstants.AI_SYSTEM_MESSAGE },
          ...userHistory
        ],
      },
      {
        headers: {
          "Authorization": `Bearer ${ProcessConstants.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    if (response.data && response.data.choices && response.data.choices[0] && response.data.choices[0].message) {
      const aiResponse = response.data.choices[0].message.content;
      userHistory.push({ role: "assistant", content: aiResponse });

      // Trim history if it gets too long
      if (userHistory.length > AIConstants.MAX_CONVERSATION_HISTORY) {
        userHistory.splice(1, 2); // Remove oldest user-assistant pair
      }

      // Split the response into chunks of 2000 characters or less
      const chunks = aiResponse.match(new RegExp(`(.|[\r\n]){1,${AIConstants.MAX_MESSAGE_LENGTH}}`, 'g'));

      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } else {
      console.error('Unexpected API response structure:', response.data);
      message.reply('Received an unexpected response from the AI service. Please try again later.');
    }
  } catch (error) {
    console.error('Error getting AI text:', error);
    if (axios.isAxiosError(error) && error.response) {
      console.error('API response:', error.response.data);
      message.reply(`An error occurred while getting the AI-generated text. Status: ${error.response.status}. Please try again later.`);
    } else if (axios.isAxiosError(error) && error.request) {
      console.error('No response received:', error.request);
      message.reply('No response received from the AI service. Please check your internet connection and try again.');
    } else {
      console.error('Error details:', error);
      message.reply('An unexpected error occurred. Please try again later.');
    }
  }
}

export function clearConversationHistory(message: Message) {
  const userId = message.author.id;
  conversationHistory.delete(userId);
  message.reply('Your AI conversation history has been cleared.');
}

export async function getMatchStory(message: Message, matchData: any) {
  const prompt = `Generate a short, engaging story about this Dota 2 match:
Match ID: ${matchData.matchId}
Duration: ${formatDuration(matchData.duration)}
Winner: ${matchData.radiantWin ? 'Radiant' : 'Dire'}

Players:
${matchData.players.map((p: any) => `${p.name} as ${p.heroName} (${p.team}): ${p.kills}/${p.deaths}/${p.assists}`).join('\n')}

Key events:
${matchData.objectives.map((obj: any) => `${formatDuration(obj.time)} - ${obj.type} (${obj.team})`).join('\n')}

Chat highlights:
${matchData.chatLog.slice(0, 5).map((msg: any) => `${formatDuration(msg.time)} - ${msg.player}: ${msg.message}`).join('\n')}

Please create a narrative that captures the excitement and key moments of the match, incorporating player actions, objectives, and any interesting chat messages. Keep the story concise but entertaining. Use player names and hero names when describing actions.`;

  message.channel.sendTyping();

  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: AIConstants.AI_MODEL,
        messages: [
          { role: "system", content: AIConstants.AI_STORY_SYSTEM_MESSAGE },
          { role: "user", content: prompt }
        ],
      },
      {
        headers: {
          "Authorization": `Bearer ${ProcessConstants.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    if (response.data && response.data.choices && response.data.choices[0] && response.data.choices[0].message) {
      const aiResponse = response.data.choices[0].message.content;
      const chunks = aiResponse.match(new RegExp(`(.|[\r\n]){1,${AIConstants.MAX_MESSAGE_LENGTH}}`, 'g'));

      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } else {
      console.error('Unexpected API response structure:', response.data);
      message.reply('Received an unexpected response from the AI service. Please try again later.');
    }
  } catch (error) {
    console.error('Error getting AI story:', error);
    message.reply('An error occurred while generating the match story. Please try again later.');
  }
}