import { Message, EmbedBuilder } from 'discord.js';
import { UserDataService } from '../services/userDataService';
import { Replies } from '../constants';
import { achievementService, ACHIEVEMENTS, RARITY_META, rarityOf, Rarity } from '../services/achievementService';
import { logger } from '../services/loggerService';
import { parseArgs } from '../utils/argParser';

const RARITY_ORDER: Rarity[] = ['arcana', 'immortal', 'legendary', 'mythical', 'rare', 'uncommon', 'common'];

function buildCatalogEmbeds(unlockedIds: Set<string>, username: string): EmbedBuilder[] {
    const maxDescriptionLength = 2300;
    const pages: string[][] = [];
    let page: string[] = [];
    let pageLength = 0;

    for (const rarity of RARITY_ORDER) {
        const achievements = ACHIEVEMENTS.filter(a => rarityOf(a.id) === rarity);
        let needsHeading = true;

        for (const achievement of achievements) {
            const status = unlockedIds.has(achievement.id) ? '✅' : '🔒';
            const line = `${status} ${achievement.emoji} **${achievement.name}** — ${achievement.description}`;
            const heading = `${RARITY_META[rarity].emoji} **${RARITY_META[rarity].label} (${achievements.length})**`;
            const additions = needsHeading ? [page.length > 0 ? '' : null, heading, line].filter((x): x is string => x !== null) : [line];
            const addedLength = additions.reduce((sum, part) => sum + part.length + 1, 0);

            if (page.length > 0 && pageLength + addedLength > maxDescriptionLength) {
                pages.push(page);
                page = [`${heading} _(continued)_`, line];
                pageLength = page.reduce((sum, part) => sum + part.length + 1, 0);
            } else {
                page.push(...additions);
                pageLength += addedLength;
            }
            needsHeading = false;
        }
    }

    if (page.length > 0) pages.push(page);

    return pages.map((lines, index) => new EmbedBuilder()
        .setColor('#6366f1')
        .setTitle(`🏆 All Achievements — ${username} (${index + 1}/${pages.length})`)
        .setDescription(lines.join('\n'))
        .setFooter({ text: '✅ Earned · 🔒 Locked · tracked from bot-detected matches' }));
}

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

        const showAll = parsed.positional.some(arg => arg.toLowerCase() === 'all');
        if (showAll) {
            const embeds = buildCatalogEmbeds(unlockedIds, targetUser.username);
            await message.reply({ embeds });
            return;
        }

        const locked = ACHIEVEMENTS.filter(a => !unlockedIds.has(a.id));

        const completionBar = (() => {
            const filled = Math.round((count / total) * 10);
            return '🟦'.repeat(filled) + '⬜'.repeat(10 - filled) + ` ${count}/${total}`;
        })();

        // Legend so the colours mean something (rarest -> commonest).
        const legend = RARITY_ORDER.map(r => `${RARITY_META[r].emoji} ${RARITY_META[r].label}`).join(' › ');

        // Unlocked, grouped under named rarity headers (only tiers you've earned in).
        const unlockedSection = RARITY_ORDER
            .map(r => {
                const got = unlocked.filter(u => rarityOf(u.def.id) === r);
                if (got.length === 0) return null;
                const tot = ACHIEVEMENTS.filter(a => rarityOf(a.id) === r).length;
                const names = got.map(u => `${u.def.emoji} ${u.def.name}`).join(' · ');
                return `${RARITY_META[r].emoji} **${RARITY_META[r].label}** — ${got.length}/${tot}\n${names}`;
            })
            .filter(Boolean)
            .join('\n\n');
        const unlockedValue = (unlockedSection || '_No achievements yet — go play some games!_').slice(0, 1020);

        // Locked: how many remain per tier + a few easy next targets, instead of a wall.
        const remainByTier = RARITY_ORDER
            .map(r => {
                const n = locked.filter(a => rarityOf(a.id) === r).length;
                return n > 0 ? `${RARITY_META[r].emoji} ${n}` : null;
            })
            .filter(Boolean)
            .join(' · ');
        const nextTargets = locked
            .filter(a => rarityOf(a.id) === 'common' || rarityOf(a.id) === 'uncommon')
            .slice(0, 6)
            .map(a => `${a.emoji} **${a.name}** — *${a.description}*`)
            .join('\n');
        const lockedValue = locked.length === 0
            ? '🎊 All achievements unlocked! You are GOATED!'
            : `**Remaining:** ${remainByTier}\n\n**Easy next targets:**\n${nextTargets || '_Only the hard ones left — respect._'}`;

        const embed = new EmbedBuilder()
            .setColor(count === total ? '#fbbf24' : '#6366f1')
            .setTitle(`🏆 Achievement Trophy Case — ${targetUser.username}`)
            .setDescription(`**Progress:** ${completionBar}\n**Rarity:** ${legend}`)
            .setThumbnail(targetUser.displayAvatarURL())
            .addFields(
                { name: `✅ Unlocked (${count}/${total})`, value: unlockedValue, inline: false },
                { name: `🔒 Still to earn (${locked.length})`, value: lockedValue, inline: false },
            )
            .setFooter({ text: 'Rarest → Common · achievements tracked from bot-detected matches' })
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    } catch (error) {
        logger.error('Error in achievements command:', error);
        await message.reply('An error occurred fetching achievements. Please try again.');
    }
}
