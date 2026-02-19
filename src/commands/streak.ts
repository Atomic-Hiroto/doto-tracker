import { Message, EmbedBuilder } from 'discord.js';
import { UserDataService } from '../services/userDataService';
import { streakService } from '../services/streakService';
import { Replies } from '../constants';
import { logger } from '../services/loggerService';

export async function streak(message: Message, args: string[], userDataService: UserDataService) {
    let discordId = message.author.id;
    let targetUser = message.author;

    if (args.length > 0 && message.mentions.users.size > 0) {
        discordId = message.mentions.users.first()!.id;
        targetUser = message.mentions.users.first()!;
    }

    const user = userDataService.getUserByDiscordId(discordId);
    if (!user) {
        return message.reply(Replies.NEED_REGISTRATION);
    }

    try {
        const info = streakService.getStreakInfo(discordId);

        if (!info) {
            return message.reply(`**${targetUser.username}** has no streak data yet. Keep playing and we'll track it! 🎮`);
        }

        const currentType = info.current > 0 ? 'win' : info.current < 0 ? 'loss' : 'none';
        const currentCount = Math.abs(info.current);

        let streakDisplay: string;
        if (currentType === 'win') {
            streakDisplay = `🔥 **${currentCount} Win Streak** — they're HOT right now!`;
        } else if (currentType === 'loss') {
            streakDisplay = `💀 **${currentCount} Loss Streak** — it happens to the best of us...`;
        } else {
            streakDisplay = '〰️ No active streak — just played a neutral game';
        }

        const embed = new EmbedBuilder()
            .setColor(currentType === 'win' ? '#ff6600' : currentType === 'loss' ? '#ef5350' : '#808080')
            .setTitle(`🎯 Streak Stats — ${targetUser.username}`)
            .setThumbnail(targetUser.displayAvatarURL())
            .addFields(
                { name: '⚡ Current Streak', value: streakDisplay, inline: false },
                { name: '🏆 Longest Win Streak', value: info.longestWin > 0 ? `${info.longestWin} wins in a row` : 'None yet', inline: true },
                { name: '💀 Longest Loss Streak', value: info.longestLoss > 0 ? `${info.longestLoss} losses in a row` : 'None yet', inline: true },
            )
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    } catch (error) {
        logger.error('Error in streak command:', error);
        await message.reply('An error occurred while fetching streak data. Please try again later.');
    }
}
