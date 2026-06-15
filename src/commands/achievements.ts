import { Message, EmbedBuilder } from 'discord.js';
import { UserDataService } from '../services/userDataService';
import { Replies } from '../constants';
import { achievementService, ACHIEVEMENTS } from '../services/achievementService';
import { logger } from '../services/loggerService';
import { parseArgs } from '../utils/argParser';

export async function achievements(message: Message, args: string[], userDataService: UserDataService) {
    const parsed = parseArgs(args, message);

    let discordId = message.author.id;
    let targetUser = message.author;
    if (parsed.mentions.length > 0) {
        discordId = parsed.mentions[0];
        targetUser = message.mentions.users.first()!;
    }

    const user = userDataService.getUserByDiscordId(discordId);
    if (!user) return message.reply(Replies.notRegistered(message.author.id, discordId, targetUser.username));

    try {
        const unlocked = achievementService.getUnlockedAchievements(discordId);
        const unlockedIds = new Set(unlocked.map(u => u.def.id));
        const total = ACHIEVEMENTS.length;
        const count = unlocked.length;

        // Unlocked achievements
        const unlockedLines = unlocked.length > 0
            ? unlocked.map(({ def }) => `${def.emoji} **${def.name}** — *${def.description}*`).join('\n')
            : '_No achievements yet — go play some games!_';

        // Locked achievements (show as a teaser)
        const locked = ACHIEVEMENTS.filter(a => !unlockedIds.has(a.id));
        const lockedLines = locked.length > 0
            ? locked.map(a => `🔒 ~~${a.name}~~ — *${a.description}*`).join('\n')
            : '🎊 All achievements unlocked! You are GOATED!';

        const completionBar = (() => {
            const filled = Math.round((count / total) * 10);
            return '🟦'.repeat(filled) + '⬜'.repeat(10 - filled) + ` ${count}/${total}`;
        })();

        const embed = new EmbedBuilder()
            .setColor(count === total ? '#fbbf24' : '#6366f1')
            .setTitle(`🏆 Achievement Trophy Case — ${targetUser.username}`)
            .setDescription(`**Progress:** ${completionBar}`)
            .setThumbnail(targetUser.displayAvatarURL())
            .addFields(
                { name: `✅ Unlocked (${count})`, value: unlockedLines, inline: false },
                { name: `🔒 Locked (${locked.length})`, value: lockedLines, inline: false },
            )
            .setFooter({ text: 'Achievements are tracked from bot-detected matches' })
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    } catch (error) {
        logger.error('Error in achievements command:', error);
        await message.reply('An error occurred fetching achievements. Please try again.');
    }
}
