import axios from 'axios';
import { Message, TextChannel } from 'discord.js';
import { AIConstants, ProcessConstants } from '../constants';
import { formatDuration } from '../utils/formatters';
import { logger } from './loggerService';
import { ChannelDataService } from './channelDataService';
import { safeTyping } from '../utils/channelHelpers';

const conversationHistory = new Map<string, any[]>();
const channelDataService = new ChannelDataService();

export { channelDataService };

// Resolve user mentions (<@123456>) to readable usernames
async function resolveMentions(message: Message, content: string): Promise<string> {
  let resolvedContent = content;

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

async function getReplyContext(message: Message): Promise<string | null> {
  if (!message.reference?.messageId) return null;

  try {
    const contextAroundQuote = await fetchContextAroundMessage(message, message.reference.messageId);

    if (contextAroundQuote) {
      return `[Context around the message being replied to]\n${contextAroundQuote}\n[End context]`;
    }

    const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
    const resolvedContent = await resolveMentions(message, repliedMessage.content);
    return `[Replying to ${repliedMessage.author.username}: "${resolvedContent}"]`;
  } catch (error) {
    logger.debug('Could not fetch replied message');
    return null;
  }
}

async function fetchChannelContext(message: Message): Promise<string> {
  try {
    const channel = message.channel;
    if (!channel.isTextBased()) return '';

    const messages = await channel.messages.fetch({
      limit: AIConstants.CHANNEL_CONTEXT_MESSAGES,
      before: message.id
    });

    const sortedMessages = [...messages.values()].reverse();

    const formattedMessages = await Promise.all(
      sortedMessages
        .filter(msg => !msg.author.bot)
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

async function fetchContextAroundMessage(message: Message, targetMessageId: string): Promise<string> {
  try {
    const channel = message.channel;
    if (!channel.isTextBased()) return '';

    const targetMessage = await channel.messages.fetch(targetMessageId);

    const messagesBefore = await channel.messages.fetch({
      limit: AIConstants.CONTEXT_AROUND_QUOTE,
      before: targetMessageId
    });

    const messagesAfter = await channel.messages.fetch({
      limit: AIConstants.CONTEXT_AROUND_QUOTE,
      after: targetMessageId
    });

    const allMessages = [
      ...messagesBefore.values(),
      targetMessage,
      ...messagesAfter.values()
    ].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const formattedMessages = await Promise.all(
      allMessages
        .filter(msg => !msg.author.bot)
        .map(async msg => {
          const resolvedContent = await resolveMentions(message, msg.content);
          const isQuoted = msg.id === targetMessageId;
          if (isQuoted) {
            return `>> QUOTED: ${msg.author.username}: ${resolvedContent} <<`;
          }
          return `${msg.author.username}: ${resolvedContent}`;
        })
    );

    return formattedMessages.join('\n');
  } catch (error) {
    logger.error('Error fetching context around message:', error);
    return '';
  }
}

async function buildSmartContext(message: Message): Promise<{ context: string; type: 'reply' | 'recent' } | null> {
  const isReply = !!message.reference?.messageId;

  if (isReply && message.reference?.messageId) {
    const context = await fetchContextAroundMessage(message, message.reference.messageId);
    if (context) {
      return {
        context: `[Context around quoted message]\n${context}\n[End context]`,
        type: 'reply'
      };
    }
  }

  const context = await fetchChannelContext(message);
  if (context) {
    return {
      context: `[Recent channel messages]\n${context}\n[End context]`,
      type: 'recent'
    };
  }

  return null;
}

// Shared helper to call OpenRouter API
async function callOpenRouterAPI(systemPrompt: string, messages: any[]): Promise<string | null> {
  const response = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: AIConstants.AI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages,
      ],
      ...AIConstants.AI_PARAMS
    },
    {
      headers: {
        "Authorization": `Bearer ${ProcessConstants.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/Atomic-Hiroto/doto-tracker",
        "X-Title": "Doto Tracker"
      }
    }
  );

  if (!response.data?.choices?.[0]?.message) return null;

  const message_response = response.data.choices[0].message;
  const messageContent = message_response.content;

  if (message_response.reasoning) {
    logger.debug('AI reasoning tokens used (hidden from user)');
  }

  if (Array.isArray(messageContent)) {
    const thinkingBlocks = messageContent.filter((block: any) => block.type === 'thinking');
    if (thinkingBlocks.length > 0) {
      logger.debug(`AI thinking blocks: ${thinkingBlocks.length} (hidden from user)`);
    }
    const textBlocks = messageContent.filter((block: any) => block.type === 'text');
    return textBlocks.map((block: any) => block.text).join('').trimStart();
  }

  return (messageContent || '').trimStart();
}

export async function getAIText(message: Message, args: string[], triggeredByMention: boolean = false) {
  if (args.length === 0 && triggeredByMention) {
    return message.reply('yo~ you pinged me but said nothing... what do u want baka 💢');
  }

  if (args.length === 0) {
    return message.reply('Please provide a prompt. Usage: +gpat <your prompt here>');
  }

  let prompt = args.join(' ');
  prompt = await resolveMentions(message, prompt);

  const replyContext = await getReplyContext(message);
  if (replyContext) {
    prompt = `${replyContext}\n\n${prompt}`;
  }

  safeTyping(message.channel);

  const isSharedContext = channelDataService.isSharedContext(message.channel.id);
  const contextKey = isSharedContext ? message.channel.id : message.author.id;

  if (!conversationHistory.has(contextKey)) {
    conversationHistory.set(contextKey, []);
  }

  const userHistory = conversationHistory.get(contextKey)!;

  let smartContextPrefix = '';
  const hasReplyContext = !!message.reference?.messageId;

  if (isSharedContext && !hasReplyContext) {
    const smartContext = await buildSmartContext(message);
    if (smartContext) {
      smartContextPrefix = `${smartContext.context}\n\n`;
      logger.debug(`Using ${smartContext.type} context for shared mode`);
    }
  }

  // Collect image attachments
  const imageUrls: string[] = [];
  const validExtensions = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

  message.attachments.forEach(attachment => {
    const ext = attachment.name?.split('.').pop()?.toLowerCase();
    if (ext && validExtensions.includes(ext)) {
      imageUrls.push(attachment.url);
    }
  });

  if (message.reference?.messageId) {
    try {
      const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
      repliedMessage.attachments.forEach(attachment => {
        const ext = attachment.name?.split('.').pop()?.toLowerCase();
        if (ext && validExtensions.includes(ext)) {
          imageUrls.push(attachment.url);
        }
      });
    } catch (e) {
      logger.debug("Failed to fetch attachments from replied message");
    }
  }

  const userPromptText = smartContextPrefix
    ? `${smartContextPrefix}${message.author.username}: ${prompt}`
    : `${message.author.username}: ${prompt}`;

  let finalUserContent: any = userPromptText;

  if (imageUrls.length > 0) {
    finalUserContent = [
      { type: "text", text: userPromptText },
      ...imageUrls.map(url => ({
        type: "image_url",
        image_url: { url }
      }))
    ];
  }

  userHistory.push({ role: "user", content: finalUserContent });

  try {
    logger.debug(`Sending AI request for user ${message.author.username} (${isSharedContext ? 'shared' : 'individual'} context)`);

    const apiMessages = [
      ...userHistory,
      { role: "assistant", content: AIConstants.AI_PREFILL }
    ];

    const aiResponse = await callOpenRouterAPI(AIConstants.SYSTEM_PROMPT, apiMessages);

    if (!aiResponse) {
      logger.error('Unexpected API response structure from OpenRouter');
      return message.reply('Received an unexpected response from the AI service. Please try again later.');
    }

    logger.debug(`AI response length: ${aiResponse.length} chars`);
    userHistory.push({ role: "assistant", content: aiResponse });

    if (userHistory.length > AIConstants.MAX_CONVERSATION_HISTORY) {
      userHistory.splice(1, 2);
    }

    const chunks = aiResponse.match(new RegExp(`(.|[\r\n]){1,${AIConstants.MAX_MESSAGE_LENGTH}}`, 'g'));

    if (chunks) {
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } else if (aiResponse) {
      await message.reply(aiResponse);
    }
  } catch (error) {
    logger.error('Error getting AI text:', error);
    if (axios.isAxiosError(error) && error.response) {
      logger.error('API response:', error.response.data);
      message.reply(`An error occurred while getting the AI-generated text. Status: ${error.response.status}. Please try again later.`);
    } else if (axios.isAxiosError(error) && error.request) {
      logger.error('No response received from AI service');
      message.reply('No response received from the AI service. Please check your internet connection and try again.');
    } else {
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

  safeTyping(message.channel);

  try {
    const aiResponse = await callOpenRouterAPI(AIConstants.AI_STORY_SYSTEM_MESSAGE, [
      { role: "user", content: prompt }
    ]);

    if (!aiResponse) {
      logger.error('Unexpected API response structure for match story');
      return message.reply('Received an unexpected response from the AI service. Please try again later.');
    }

    const chunks = aiResponse.match(new RegExp(`(.|[\r\n]){1,${AIConstants.MAX_MESSAGE_LENGTH}}`, 'g'));

    if (chunks) {
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } else {
      await message.reply(aiResponse);
    }
  } catch (error) {
    logger.error('Error getting AI story:', error);
    message.reply('An error occurred while generating the match story. Please try again later.');
  }
}