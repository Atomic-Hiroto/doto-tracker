import { Message, TextBasedChannel } from 'discord.js';

/**
 * Safely calls sendTyping on a channel if the channel supports it.
 * (PartialGroupDMChannel does not have sendTyping)
 */
export function safeTyping(channel: TextBasedChannel) {
    if ('sendTyping' in channel && typeof (channel as any).sendTyping === 'function') {
        (channel as any).sendTyping();
    }
}

/**
 * Safely sends a message on a channel if it supports .send().
 * Returns the sent Message so callers can delete it later (e.g. loading indicators).
 */
export async function safeSend(
    channel: TextBasedChannel,
    content: Parameters<any>[0]
): Promise<Message | null> {
    if ('send' in channel && typeof (channel as any).send === 'function') {
        return (channel as any).send(content) as Promise<Message>;
    }
    return null;
}

/**
 * Replies without ever being able to take the process down.
 *
 * `message.reply` throws MESSAGE_REFERENCE_UNKNOWN_MESSAGE if the user deleted
 * the command before the answer was ready. Thrown from inside a catch block
 * that had no catch of its own, that became an unhandled rejection and killed
 * the bot — so the visible symptom of a slow API was the whole bot restarting.
 * Falls back to a plain channel send, then gives up quietly.
 */
export async function safeReply(
    message: Message,
    content: Parameters<any>[0]
): Promise<Message | null> {
    try {
        return await message.reply(content as any);
    } catch (replyError) {
        try {
            return await safeSend(message.channel, content);
        } catch {
            return null;
        }
    }
}
