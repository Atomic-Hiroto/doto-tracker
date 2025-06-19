import { Message } from 'discord.js';
import { channelDataService } from '../services/aiService';

export async function toggleSharedContext(message: Message, args: string[]) {
  if (!message.member?.permissions.has('MANAGE_CHANNELS')) {
    return message.reply('You need the "Manage Channels" permission to toggle shared context.');
  }

  const channelId = message.channel.id;
  const currentSetting = channelDataService.isSharedContext(channelId);
  
  if (args.length === 0) {
    const status = currentSetting ? 'enabled' : 'disabled';
    return message.reply(`Shared AI context is currently **${status}** in this channel.\nUse \`+toggleSharedContext on\` or \`+toggleSharedContext off\` to change it.`);
  }

  const action = args[0].toLowerCase();
  
  if (action === 'on' || action === 'enable' || action === 'true') {
    channelDataService.setSharedContext(channelId, true);
    message.reply('✅ Shared AI context **enabled** for this channel. All users will now share the same conversation context.');
  } else if (action === 'off' || action === 'disable' || action === 'false') {
    channelDataService.setSharedContext(channelId, false);
    message.reply('✅ Shared AI context **disabled** for this channel. Users will now have individual conversation contexts.');
  } else {
    message.reply('Invalid option. Use `on` or `off` to toggle shared context.');
  }
}