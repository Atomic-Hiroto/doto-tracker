import { TextBasedChannel } from 'discord.js';

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
 * Safely sends a message on a channel if it supports .send()
 */
export async function safeSend(channel: TextBasedChannel, content: Parameters<any>[0]): Promise<void> {
    if ('send' in channel && typeof (channel as any).send === 'function') {
        await (channel as any).send(content);
    }
}
