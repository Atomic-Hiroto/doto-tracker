import { Message, TextChannel } from 'discord.js';
import { ProcessConstants } from '../constants';
import { ChannelDataService } from '../services/channelDataService';
import { logger } from '../services/loggerService';

const BOT_OWNER_ID = ProcessConstants.BOT_OWNER_ID;

export async function setChannel(message: Message, channelDataService: ChannelDataService) {
    if (message.author.id !== BOT_OWNER_ID) {
        return message.reply('❌ Only the bot owner can use this command.');
    }

    const channelName = (message.channel as TextChannel).name ?? message.channel.id;
    channelDataService.setAllowed(message.channel.id, true);
    logger.info(`Channel allowed: #${channelName} (${message.channel.id}) by ${message.author.username}`);

    const allowedIds = channelDataService.getAllowedChannelIds();
    const allowedNames = allowedIds.map(id => `<#${id}>`).join(', ');

    await message.reply(`✅ Bot is now **active** in this channel.\n📋 Allowed channels: ${allowedNames}`);
}

export async function unsetChannel(message: Message, channelDataService: ChannelDataService) {
    if (message.author.id !== BOT_OWNER_ID) {
        return message.reply('❌ Only the bot owner can use this command.');
    }

    const channelName = (message.channel as TextChannel).name ?? message.channel.id;
    channelDataService.setAllowed(message.channel.id, false);
    logger.info(`Channel disallowed: #${channelName} (${message.channel.id}) by ${message.author.username}`);

    const allowedIds = channelDataService.getAllowedChannelIds();
    const allowedNames = allowedIds.length > 0 ? allowedIds.map(id => `<#${id}>`).join(', ') : '_none (bot will respond everywhere)_';

    await message.reply(`🚫 Bot is now **inactive** in this channel.\n📋 Allowed channels: ${allowedNames}`);
}
