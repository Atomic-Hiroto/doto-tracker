import { Message, EmbedBuilder } from 'discord.js';
import { UserDataService } from '../services/userDataService';
import { Replies } from '../constants';
import { achievementService, ACHIEVEMENTS, RARITY_META, rarityOf, Rarity } from '../services/achievementService';
import { logger } from '../services/loggerService';
import { parseArgs } from '../utils/argParser';

function fitField(lines: string[], emptyText: string): string {
    if (lines.length === 0) return emptyText;

    const maxLen = 1000;
    const selected: string[] = [];
    let used = 0;
    for (let i = 0; i < lines.length; i++) {
        const nextLen = lines[i].length + (selected.length > 0 ? 1 : 0);
        if (used + nextLen > maxLen) {
            selected.push(`…and ${lines.length - i} more.`);
            break;
        }
        selected.push(lines[i]);
        used += nextLen;
    }
    return selected.join('\n');
}

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

        const byRarityDesc = (aId: string, bId: string) => RARITY_META[rarityOf(bId)].order - RARITY_META[rarityOf(aId)].order;

        // Unlocked achievements (rarest first)
        const unlockedLines = unlocked.length > 0
            ? fitField(
                [...unlocked]
                    .sort((a, b) => byRarityDesc(a.def.id, b.def.id))
                    .map(({ def }) => `${RARITY_META[rarityOf(def.id)].emoji} ${def.emoji} **${def.name}** — *${def.description}*`),
                '_No achievements yet — go play some games!_')
            : '_No achievements yet — go play some games!_';

        // Locked achievements (show easiest/most-common first as the next targets)
        const locked = ACHIEVEMENTS.filter(a => !unlockedIds.has(a.id));
        const lockedLines = locked.length > 0
            ? fitField(
                [...locked]
                    .sort((a, b) => byRarityDesc(b.id, a.id))
                    .map(a => `🔒 ${RARITY_META[rarityOf(a.id)].emoji} ~~${a.name}~~ — *${a.description}*`),
                '🎊 All achievements unlocked! You are GOATED!')
            : '🎊 All achievements unlocked! You are GOATED!';

        const completionBar = (() => {
            const filled = Math.round((count / total) * 10);
            return '🟦'.repeat(filled) + '⬜'.repeat(10 - filled) + ` ${count}/${total}`;
        })();

        // Rarity haul: unlocked / total per tier, rarest first, skipping empties.
        const rarityHaul = (() => {
            const order: Rarity[] = ['arcana', 'immortal', 'legendary', 'mythical', 'rare', 'uncommon', 'common'];
            return order
                .map(r => {
                    const got = unlocked.filter(u => rarityOf(u.def.id) === r).length;
                    const tot = ACHIEVEMENTS.filter(a => rarityOf(a.id) === r).length;
                    return got > 0 ? `${RARITY_META[r].emoji} ${got}/${tot}` : null;
                })
                .filter(Boolean)
                .join('  ') || '—';
        })();

        const embed = new EmbedBuilder()
            .setColor(count === total ? '#fbbf24' : '#6366f1')
            .setTitle(`🏆 Achievement Trophy Case — ${targetUser.username}`)
            .setDescription(`**Progress:** ${completionBar}\n**Rarity haul:** ${rarityHaul}`)
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
