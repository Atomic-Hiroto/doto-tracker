import axios from 'axios';
import { Message, TextChannel } from 'discord.js';
import { AIConstants, ProcessConstants } from '../constants';
import { formatDuration } from '../utils/formatters';
import { logger } from './loggerService';
import { ChannelDataService } from './channelDataService';

const conversationHistory = new Map<string, any[]>();
const channelDataService = new ChannelDataService();

export { channelDataService };

// Resolve user mentions (<@123456>) to readable usernames
async function resolveMentions(message: Message, content: string): Promise<string> {
  let resolvedContent = content;

  // Match user mentions like <@123456> or <@!123456>
  const mentionRegex = /<@!?(\d+)>/g;
  const matches = content.matchAll(mentionRegex);

  for (const match of matches) {
    const userId = match[1];
    try {
      const user = await message.client.users.fetch(userId);
      resolvedContent = resolvedContent.replace(match[0], `@${user.username}`);
    } catch (error) {
      logger.debug(`Could not resolve user ID ${userId}`);
    }
  }

  // Match channel mentions like <#123456>
  const channelRegex = /<#(\d+)>/g;
  const channelMatches = content.matchAll(channelRegex);

  for (const match of channelMatches) {
    const channelId = match[1];
    try {
      const channel = await message.client.channels.fetch(channelId);
      if (channel && 'name' in channel) {
        resolvedContent = resolvedContent.replace(match[0], `#${channel.name}`);
      }
    } catch (error) {
      logger.debug(`Could not resolve channel ID ${channelId}`);
    }
  }

  return resolvedContent;
}

// Get the content of a replied/quoted message
async function getReplyContext(message: Message): Promise<string | null> {
  if (!message.reference?.messageId) return null;

  try {
    const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
    const resolvedContent = await resolveMentions(message, repliedMessage.content);
    return `[Replying to ${repliedMessage.author.username}: "${resolvedContent}"]`;
  } catch (error) {
    logger.debug('Could not fetch replied message');
    return null;
  }
}

// Fetch recent channel messages to provide context for shared mode
async function fetchChannelContext(message: Message): Promise<string> {
  try {
    const channel = message.channel;
    if (!channel.isTextBased()) return '';

    const messages = await channel.messages.fetch({
      limit: AIConstants.CHANNEL_CONTEXT_MESSAGES,
      before: message.id
    });

    // Reverse to get chronological order (oldest first)
    const sortedMessages = [...messages.values()].reverse();

    // Format messages for context with resolved mentions
    const formattedMessages = await Promise.all(
      sortedMessages
        .filter(msg => !msg.author.bot) // Skip bot messages
        .map(async msg => {
          const resolvedContent = await resolveMentions(message, msg.content);
          return `${msg.author.username}: ${resolvedContent}`;
        })
    );

    return formattedMessages.join('\n');
  } catch (error) {
    logger.error('Error fetching channel context:', error);
    return '';
  }
}

export async function getAIText(message: Message, args: string[], triggeredByMention: boolean = false) {
  // If triggered by mention with no args, just say hi
  if (args.length === 0 && triggeredByMention) {
    return message.reply('Hey! What\'s up? You can ask me anything~');
  }

  if (args.length === 0) {
    return message.reply('Please provide a prompt. Usage: +gpat <your prompt here>');
  }

  let prompt = args.join(' ');

  // Resolve any mentions in the user's prompt
  prompt = await resolveMentions(message, prompt);

  // Check for replied/quoted message
  const replyContext = await getReplyContext(message);
  if (replyContext) {
    prompt = `${replyContext}\n\n${prompt}`;
  }

  message.channel.sendTyping();

  const isSharedContext = channelDataService.isSharedContext(message.channel.id);
  const contextKey = isSharedContext ? message.channel.id : message.author.id;

  // Check if this is a fresh conversation that needs channel context
  const needsChannelContext = isSharedContext && !conversationHistory.has(contextKey);

  if (!conversationHistory.has(contextKey)) {
    conversationHistory.set(contextKey, []);
  }

  const userHistory = conversationHistory.get(contextKey)!;

  // If shared context and fresh conversation, fetch recent channel messages
  if (needsChannelContext) {
    const channelContext = await fetchChannelContext(message);
    if (channelContext) {
      userHistory.push({
        role: "user",
        content: `[Context: Recent messages in this channel]\n${channelContext}\n\n[End of context - the above are messages from the channel for reference]`
      });
      userHistory.push({
        role: "assistant",
        content: "Got it! I've noted the recent channel conversation for context. How can I help?"
      });
    }
  }
  const userPrompt = isSharedContext ? `${message.author.username}: ${prompt}` : prompt;
  userHistory.push({ role: "user", content: userPrompt });

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
      console.log('AI Response:', aiResponse);
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
      logger.error('Unexpected API response structure:', response.data);
      message.reply('Received an unexpected response from the AI service. Please try again later.');
    }
  } catch (error) {
    logger.error('Error getting AI text:', error);
    if (axios.isAxiosError(error) && error.response) {
      logger.error('API response:', error.response.data);
      message.reply(`An error occurred while getting the AI-generated text. Status: ${error.response.status}. Please try again later.`);
    } else if (axios.isAxiosError(error) && error.request) {
      logger.error('No response received:', error.request);
      message.reply('No response received from the AI service. Please check your internet connection and try again.');
    } else {
      logger.error('Error details:', error);
      message.reply('An unexpected error occurred. Please try again later.');
    }
  }
}

export function clearConversationHistory(message: Message) {
  const isSharedContext = channelDataService.isSharedContext(message.channel.id);
  const contextKey = isSharedContext ? message.channel.id : message.author.id;

  conversationHistory.delete(contextKey);

  if (isSharedContext) {
    message.reply('Channel AI conversation history has been cleared.');
  } else {
    message.reply('Your AI conversation history has been cleared.');
  }
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
      logger.error('Unexpected API response structure:', response.data);
      message.reply('Received an unexpected response from the AI service. Please try again later.');
    }
  } catch (error) {
    logger.error('Error getting AI story:', error);
    message.reply('An error occurred while generating the match story. Please try again later.');
  }
}