import axios from 'axios';
import { Message, TextChannel } from 'discord.js';
import { AIConstants, ProcessConstants } from '../constants';
import { formatDuration } from '../utils/formatters';
import { logger } from './loggerService';
import { ChannelDataService } from './channelDataService';
import { safeTyping } from '../utils/channelHelpers';
import { coachingDbService } from './coachingDbService';

const conversationHistory = new Map<string, any[]>();
const analysisConversationHistory = new Map<string, { expiresAt: number; messages: any[] }>();
const channelDataService = new ChannelDataService();
const BOT_OWNER_ID = '78168838910246912';

export { channelDataService };

function stripEvidenceMarkers(text: string): string {
  return text
    .replace(/\s*\[F\d+\]/g, '')
    .replace(/\s*\[C\d+\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function displayNameFor(message: Message): string {
  return message.member?.displayName ?? message.author.username;
}

async function replyInChunks(message: Message, text: string): Promise<Message[]> {
  const chunks = text.match(new RegExp(`(.|[\r\n]){1,${AIConstants.MAX_MESSAGE_LENGTH}}`, 'g'));
  if (!chunks?.length) return [];
  const sent: Message[] = [];
  for (const chunk of chunks) {
    sent.push(await message.reply(chunk));
  }
  return sent;
}

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
    return `[Replying to ${displayNameFor(repliedMessage)}: "${resolvedContent}"]`;
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
          return `${displayNameFor(msg)}: ${resolvedContent}`;
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
            return `>> QUOTED: ${displayNameFor(msg)}: ${resolvedContent} <<`;
          }
          return `${displayNameFor(msg)}: ${resolvedContent}`;
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
async function callOpenRouterAPI(systemPrompt: string, messages: any[], opts: { model?: string; params?: Record<string, any> } = {}): Promise<string | null> {
  const response = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: opts.model ?? AIConstants.AI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages,
      ],
      ...(opts.params ?? AIConstants.AI_PARAMS)
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

export function registerAnalysisConversation(messageId: string, context: string) {
  const now = Date.now();
  for (const [id, thread] of analysisConversationHistory.entries()) {
    if (thread.expiresAt <= now) analysisConversationHistory.delete(id);
  }
  analysisConversationHistory.set(messageId, {
    expiresAt: now + 30 * 60 * 1000,
    messages: [
      {
        role: 'user',
        content: `Seed this Dota 2 analysis follow-up conversation with the exact analysis context below. Use only this context for match-specific claims.\n\n${context}`,
      },
      {
        role: 'assistant',
        content: 'Understood. I will answer follow-up questions using only the seeded match facts and structured analysis.',
      },
    ],
  });
}

function normalizeAnalysisTitle(title: string): string {
  return title.replace(/\s+—\s+\d+\/\d+$/, '');
}

function matchIdFromAnalysisEmbedTitle(title?: string | null): number | null {
  const match = title?.match(/Match Analysis\s+—\s+#(\d+)/);
  if (!match) return null;
  const matchId = Number(match[1]);
  return Number.isFinite(matchId) ? matchId : null;
}

function buildStoredAnalysisContext(matchId: number): string | null {
  const stored = coachingDbService.getLatestAnalysisForMatch(matchId);
  if (!stored) return null;
  const structured = `STRUCTURED_ANALYSIS:\n${JSON.stringify(stored.structuredJson, null, 2)}`;
  return stored.factPrompt
    ? `MATCH_FACTS_PROMPT:\n${stored.factPrompt}\n\n${structured}`
    : structured;
}

async function buildAnalysisEmbedFallbackContext(message: Message, messageId: string): Promise<string | null> {
  try {
    const botId = message.client.user?.id;
    const cached = message.channel.messages.cache.get(messageId);
    if (cached && (!botId || cached.author.id !== botId)) return null;

    const referenced = cached ?? await message.channel.messages.fetch(messageId);
    if (!botId || referenced.author.id !== botId) return null;

    const referencedEmbed = referenced.embeds.find(embed => embed.title?.startsWith('🔍 Match Analysis'));
    if (!referencedEmbed?.title) return null;

    const matchId = matchIdFromAnalysisEmbedTitle(referencedEmbed.title);
    const storedContext = matchId == null ? null : buildStoredAnalysisContext(matchId);
    if (storedContext) return storedContext;

    const baseTitle = normalizeAnalysisTitle(referencedEmbed.title);
    const nearby = await Promise.allSettled([
      message.channel.messages.fetch({ limit: 4, before: referenced.id }),
      message.channel.messages.fetch({ limit: 4, after: referenced.id }),
    ]);

    const candidates = [referenced];
    for (const result of nearby) {
      if (result.status === 'fulfilled') {
        candidates.push(...result.value.values());
      }
    }

    const analysisPages = candidates
      .filter(candidate => candidate.author.id === botId)
      .flatMap(candidate => candidate.embeds.map(embed => ({ candidate, embed })))
      .filter(({ embed }) => embed.title?.startsWith('🔍 Match Analysis'))
      .filter(({ embed }) => normalizeAnalysisTitle(embed.title ?? '') === baseTitle)
      .sort((a, b) => a.candidate.createdTimestamp - b.candidate.createdTimestamp);

    if (!analysisPages.length) return null;

    const pageText = analysisPages.map(({ embed }) => {
      const fields = embed.fields
        .map(field => `${field.name}\n${field.value}`)
        .join('\n\n');
      return [
        `TITLE: ${embed.title}`,
        embed.description ? `BODY:\n${embed.description}` : '',
        fields ? `FIELDS:\n${fields}` : '',
        embed.footer?.text ? `FOOTER: ${embed.footer.text}` : '',
      ].filter(Boolean).join('\n\n');
    }).join('\n\n---\n\n');

    return `ANALYSIS_EMBED_CONTEXT_ONLY:
This context was reconstructed from the rendered Discord analysis embed because the full MATCH_FACTS thread was unavailable. Answer only from this embed text. If the user asks for details not visible here, say the analysis context does not contain enough data.

${pageText}`;
  } catch (error) {
    logger.debug('Could not reconstruct analysis follow-up context from referenced embed');
    return null;
  }
}

export async function handleAnalysisFollowUp(message: Message): Promise<boolean> {
  const messageId = message.reference?.messageId;
  if (!messageId) return false;
  let thread = analysisConversationHistory.get(messageId);
  if (!thread) {
    const fallbackContext = await buildAnalysisEmbedFallbackContext(message, messageId);
    if (!fallbackContext) return false;
    registerAnalysisConversation(messageId, fallbackContext);
    thread = analysisConversationHistory.get(messageId);
  }
  if (!thread) return false;
  if (Date.now() > thread.expiresAt) {
    analysisConversationHistory.delete(messageId);
    const fallbackContext = await buildAnalysisEmbedFallbackContext(message, messageId);
    if (!fallbackContext) {
      await message.reply('That analysis follow-up context expired. Re-run `+analyze` and reply to the fresh analysis embed.');
      return true;
    }
    registerAnalysisConversation(messageId, fallbackContext);
    thread = analysisConversationHistory.get(messageId);
  }
  if (!thread) return false;

  const prompt = await resolveMentions(message, message.content.trim());
  if (!prompt) return false;
  safeTyping(message.channel);
  thread.messages.push({ role: 'user', content: `${displayNameFor(message)}: ${prompt}` });

  const system = `You are doto-chan answering follow-up questions about one Dota 2 analysis.
Use only the seeded MATCH_FACTS and structured analysis for match-specific claims.
If the answer is not in the context, say the analysis data does not contain it.
You may use general Dota knowledge for item or strategy recommendations, but phrase those as recommendations, never as things that happened in this match.
Answer directly. Do not use openers like "Great question" or address the user by name unless needed for clarity.
Be concise, factual, and cite evidence ids when present.`;

  try {
    const response = await callOpenRouterAPI(system, thread.messages, {
      model: AIConstants.AI_ANALYZE_MODEL,
      params: { ...AIConstants.AI_ANALYZE_PARAMS, max_tokens: 1800 },
    });
    if (!response) {
      await message.reply('I could not produce a follow-up answer for that analysis.');
      return true;
    }
    const rendered = message.author.id === BOT_OWNER_ID ? response : stripEvidenceMarkers(response);
    thread.messages.push({ role: 'assistant', content: rendered });
    while (thread.messages.length > 14) {
      thread.messages.splice(2, 2);
    }
    thread.expiresAt = Date.now() + 30 * 60 * 1000;
    const sentMessages = await replyInChunks(message, rendered);
    // Chain the bot's own answers into the same thread so replying to them continues the conversation.
    for (const sent of sentMessages) {
      analysisConversationHistory.set(sent.id, thread);
    }
    return true;
  } catch (error) {
    logger.error('Error handling analysis follow-up:', error);
    await message.reply('Analysis follow-up failed. Try again later.');
    return true;
  }
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
    ? `${smartContextPrefix}${displayNameFor(message)}: ${prompt}`
    : `${displayNameFor(message)}: ${prompt}`;

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

    const aiResponse = await callOpenRouterAPI(AIConstants.SYSTEM_PROMPT, userHistory);

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
