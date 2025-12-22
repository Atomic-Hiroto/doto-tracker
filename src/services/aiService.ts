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

// Get the content of a replied/quoted message WITH surrounding context
async function getReplyContext(message: Message): Promise<string | null> {
  if (!message.reference?.messageId) return null;

  try {
    // Fetch context around the quoted message (not just the single message)
    const contextAroundQuote = await fetchContextAroundMessage(message, message.reference.messageId);

    if (contextAroundQuote) {
      return `[Context around the message being replied to]\n${contextAroundQuote}\n[End context]`;
    }

    // Fallback: just get the single message if context fetch fails
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

// Fetch context around a specific quoted message (for replies to older messages)
async function fetchContextAroundMessage(message: Message, targetMessageId: string): Promise<string> {
  try {
    const channel = message.channel;
    if (!channel.isTextBased()) return '';

    // Fetch the target message first
    const targetMessage = await channel.messages.fetch(targetMessageId);

    // Fetch messages BEFORE the target
    const messagesBefore = await channel.messages.fetch({
      limit: AIConstants.CONTEXT_AROUND_QUOTE,
      before: targetMessageId
    });

    // Fetch messages AFTER the target
    const messagesAfter = await channel.messages.fetch({
      limit: AIConstants.CONTEXT_AROUND_QUOTE,
      after: targetMessageId
    });

    // Combine and sort chronologically
    const allMessages = [
      ...messagesBefore.values(),
      targetMessage,
      ...messagesAfter.values()
    ].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    // Format messages, marking the quoted one
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

// Smart context builder - decides which context strategy to use
async function buildSmartContext(message: Message): Promise<{ context: string; type: 'reply' | 'recent' } | null> {
  const isReply = !!message.reference?.messageId;

  if (isReply && message.reference?.messageId) {
    // User is replying to a specific message - get context around that message
    const context = await fetchContextAroundMessage(message, message.reference.messageId);
    if (context) {
      return {
        context: `[Context around quoted message]\n${context}\n[End context]`,
        type: 'reply'
      };
    }
  }

  // Default: fetch recent channel messages
  const context = await fetchChannelContext(message);
  if (context) {
    return {
      context: `[Recent channel messages]\n${context}\n[End context]`,
      type: 'recent'
    };
  }

  return null;
}

export async function getAIText(message: Message, args: string[], triggeredByMention: boolean = false) {
  // If triggered by mention with no args, just say hi
  if (args.length === 0 && triggeredByMention) {
    return message.reply('yo~ you pinged me but said nothing... what do u want baka 💢');
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

  if (!conversationHistory.has(contextKey)) {
    conversationHistory.set(contextKey, []);
  }

  const userHistory = conversationHistory.get(contextKey)!;

  // For shared context: Fetch smart context ONLY if not already replying
  // (Reply context already includes surrounding messages)
  let smartContextPrefix = '';
  const hasReplyContext = !!message.reference?.messageId;

  if (isSharedContext && !hasReplyContext) {
    // Only fetch recent messages if NOT replying (reply already has context)
    const smartContext = await buildSmartContext(message);
    if (smartContext) {
      smartContextPrefix = `${smartContext.context}\n\n`;
      logger.debug(`Using ${smartContext.type} context for shared mode`);
    }
  }
  // CHECK FOR IMAGES (Current message + Replied message)
  const imageUrls: string[] = [];
  const validExtensions = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

  // 1. Current message attachments
  message.attachments.forEach(attachment => {
    const ext = attachment.name?.split('.').pop()?.toLowerCase();
    if (ext && validExtensions.includes(ext)) {
      imageUrls.push(attachment.url);
    }
  });

  // 2. Replied message attachments
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

  // Build the user prompt with smart context prefix (if applicable)
  const userPromptText = smartContextPrefix
    ? `${smartContextPrefix}${message.author.username}: ${prompt}`
    : `${message.author.username}: ${prompt}`;
  let finalUserContent: any = userPromptText;

  if (imageUrls.length > 0) {
    // Multimodal payload structure
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

    // Construct the payload entirely first to log it
    const apiPayload = {
      model: AIConstants.AI_MODEL,
      messages: [
        // 1. System Prompt (combined instructions)
        { role: "system", content: AIConstants.SYSTEM_PROMPT },

        // 2. Chat History (includes context + user message)
        ...userHistory,

        // 3. Assistant Prefill (guides response style)
        { role: "assistant", content: AIConstants.AI_PREFILL }
      ],
      ...AIConstants.AI_PARAMS
    };

    // LOG THE FULL PAYLOAD for inspection
    console.log("--------------- AI REQUEST PAYLOAD ---------------");
    console.dir(apiPayload, { depth: null, colors: true });
    console.log("--------------------------------------------------");

    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      apiPayload,
      {
        headers: {
          "Authorization": `Bearer ${ProcessConstants.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/Atomic-Hiroto/doto-tracker", // Required by OpenRouter for rankings
          "X-Title": "Doto Tracker" // Required by OpenRouter for rankings
        }
      }
    );

    if (response.data && response.data.choices && response.data.choices[0] && response.data.choices[0].message) {
      const message_response = response.data.choices[0].message;
      const messageContent = message_response.content;

      // Handle OpenRouter reasoning response format
      // OpenRouter returns reasoning in a separate 'reasoning' field
      let aiResponse: string;

      // Check for OpenRouter reasoning field
      if (message_response.reasoning) {
        console.log('--- AI REASONING (not shown to user) ---');
        console.log(message_response.reasoning);
        console.log('--- END REASONING ---');
      }



      // Handle content (could be string or array for multimodal responses)
      if (Array.isArray(messageContent)) {
        // Extract only text blocks, ignore thinking blocks (fallback for direct Claude)
        const textBlocks = messageContent.filter((block: any) => block.type === 'text');
        aiResponse = textBlocks.map((block: any) => block.text).join('').trimStart();

        // Also check for thinking blocks (direct Claude API format)
        const thinkingBlocks = messageContent.filter((block: any) => block.type === 'thinking');
        if (thinkingBlocks.length > 0) {
          console.log('--- AI THINKING (not shown to user) ---');
          thinkingBlocks.forEach((block: any) => console.log(block.thinking));
          console.log('--- END THINKING ---');
        }
      } else {
        // Standard string response
        aiResponse = (messageContent || '').trimStart();
      }

      console.log('AI Response:', aiResponse);
      userHistory.push({ role: "assistant", content: aiResponse });

      // Trim history if it gets too long
      if (userHistory.length > AIConstants.MAX_CONVERSATION_HISTORY) {
        userHistory.splice(1, 2); // Remove oldest user-assistant pair
      }

      // Split the response into chunks of 2000 characters or less
      const chunks = aiResponse.match(new RegExp(`(.|[\r\n]){1,${AIConstants.MAX_MESSAGE_LENGTH}}`, 'g'));

      if (chunks) {
        for (const chunk of chunks) {
          await message.reply(chunk);
        }
      } else if (aiResponse) {
        await message.reply(aiResponse);
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