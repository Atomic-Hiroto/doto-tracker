import { Message, EmbedBuilder } from 'discord.js';
import { UserDataService } from '../services/userDataService';
import { Replies } from '../constants';
import { logger } from '../services/loggerService';
import { opendotaClient } from '../services/apiClient';
import { dotaDataService } from '../services/dotaDataService';
import { parseArgs } from '../utils/argParser';
import { safeTyping } from '../utils/channelHelpers';

const MASTERY_LEVELS = ['⬜ Novice', '🟩 Apprentice', '🟦 Adept', '🟪 Expert', '🟧 Master'];

function getMasteryLevel(games: number, winRate: number): number {
    if (games < 5) return 0;
    if (games < 15) return 1;
    if (games < 30) return 2;
    if (games < 50 || winRate < 0.5) return 3;
    return 4;
}

export async function heroes(message: Message, args: string[], userDataService: UserDataService) {
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
        safeTyping(message.channel);

        const response = await opendotaClient.get<any[]>(`/players/${user.steamId}/heroes?&significant=0`);
        const heroStats = response.data
            .filter((h: any) => h.games >= 5)
            .sort((a: any, b: any) => b.games - a.games)
            .slice(0, 15);

        if (!heroStats || heroStats.length === 0) {
            return message.reply(`No hero data found for **${targetUser.username}** (need at least 5 games on a hero).`);
        }

        const heroLines = await Promise.all(
            heroStats.map(async (hero: any) => {
                const heroName = await dotaDataService.getHeroName(hero.hero_id);
                const winRate = hero.games > 0 ? hero.win / hero.games : 0;
                const level = getMasteryLevel(hero.games, winRate);
                const winRatePct = (winRate * 100).toFixed(1);
                const kda = ((hero.kills + hero.assists) / (hero.deaths || 1)).toFixed(2);
                return `${MASTERY_LEVELS[level]} **${heroName}** — ${hero.games}G | ${winRatePct}% WR | ${kda} KDA`;
            })
        );

        const masteryBreakdown = MASTERY_LEVELS.map((label, i) => {
            const count = heroStats.filter((h: any) => {
                const wr = h.games > 0 ? h.win / h.games : 0;
                return getMasteryLevel(h.games, wr) === i;
            }).length;
            return count > 0 ? `${label}: ${count}` : null;
        }).filter(Boolean).join(' | ');

        const embed = new EmbedBuilder()
            .setColor('#6366f1')
            .setTitle(`🦸 Hero Mastery — ${targetUser.username}`)
            .setDescription(`**Top 15 heroes** (5+ games)\n${masteryBreakdown}`)
            .setThumbnail(targetUser.displayAvatarURL())
            .addFields({ name: 'Hero Stats', value: heroLines.join('\n'), inline: false })
            .setFooter({ text: 'Mastery: ⬜ <5 🟩 5+ 🟦 15+ 🟪 30+ 🟧 50+games+55%WR' })
            .setURL(`https://www.opendota.com/players/${user.steamId}/heroes`)
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    } catch (error) {
        logger.error('Error in heroes command:', error);
        await message.reply('An error occurred while fetching hero stats. Please try again later.');
    }
}
