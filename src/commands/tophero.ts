import { Message, EmbedBuilder } from 'discord.js';
import { Replies } from '../constants';
import { UserDataService } from '../services/userDataService';
import { logger } from '../services/loggerService';
import { opendotaClient } from '../services/apiClient';
import { dotaDataService } from '../services/dotaDataService';
import { safeTyping } from '../utils/channelHelpers';

interface HeroStats {
    hero_id: number;
    games: number;
    win: number;
    with_games?: number;
    with_win?: number;
    against_games?: number;
    against_win?: number;
}

export async function tophero(
    message: Message,
    args: string[],
    userDataService: UserDataService
) {
    let discordId = message.author.id;
    let targetUser = message.author;

    if (args.length > 0 && message.mentions.users.size > 0) {
        discordId = message.mentions.users.first()!.id;
        targetUser = message.mentions.users.first()!;
    }

    const user = userDataService.getUserByDiscordId(discordId);
    if (!user) {
        return message.reply(Replies.notRegistered(message.author.id, discordId, targetUser.username));
    }

    try {
        safeTyping(message.channel);

        const daysAgo = 28;
        const response = await opendotaClient.get<HeroStats[]>(
            `/players/${user.steamId}/heroes?game_mode=23&significant=0&date=${daysAgo}`
        );
        const heroes = response.data;

        const calculateHeroRating = (hero: HeroStats): number => {
            if (hero.games === 0) return 0;
            const winRate = hero.win / hero.games;
            const confidenceFactor = Math.min(hero.games / 10, 1);
            return (winRate * 100 * confidenceFactor) + (hero.games * 0.5);
        };

        const topHeroes = heroes
            .filter(h => h.games >= 2)
            .map(h => ({ ...h, rating: calculateHeroRating(h) }))
            .sort((a, b) => b.rating - a.rating)
            .slice(0, 5);

        if (topHeroes.length === 0) {
            return message.reply(`No turbo games found for ${targetUser.username} in the past 4 weeks (min 2 games per hero). Play some turbo! ⚡`);
        }

        const heroLines = await Promise.all(
            topHeroes.map(async (hero, index) => {
                const heroName = await dotaDataService.getHeroName(hero.hero_id);
                const losses = hero.games - hero.win;
                const winRate = hero.games > 0 ? ((hero.win / hero.games) * 100).toFixed(1) : '0';
                const medals = ['🥇', '🥈', '🥉', '4.', '5.'];
                return {
                    name: `${medals[index]} ${heroName} (${hero.rating.toFixed(1)} pts)`,
                    value: `**${hero.games}** games | **${hero.win}**W/**${losses}**L (${winRate}% WR)`,
                    inline: false
                };
            })
        );

        const embed = new EmbedBuilder()
            .setColor('#f59e0b')
            .setTitle(`⚡ Best Turbo Heroes: ${targetUser.username}`)
            .setDescription(`📅 **Past 4 Weeks** • Ranked by rating (winrate + games)`)
            .setThumbnail(targetUser.displayAvatarURL())
            .addFields(heroLines)
            .setFooter({ text: `Steam ID: ${user.steamId} • Data from OpenDota` })
            .setURL(`https://www.opendota.com/players/${user.steamId}/heroes?game_mode=23`)
            .setTimestamp();

        const totalGames = topHeroes.reduce((sum, h) => sum + h.games, 0);
        const totalWins = topHeroes.reduce((sum, h) => sum + h.win, 0);
        const overallWr = totalGames > 0 ? ((totalWins / totalGames) * 100).toFixed(1) : '0';

        embed.addFields({
            name: '📊 Top 5 Summary',
            value: `**${totalGames}** games | **${totalWins}**W/**${totalGames - totalWins}**L (${overallWr}% WR)`,
            inline: false
        });

        await message.reply({ embeds: [embed] });
    } catch (error) {
        logger.error(`Error in tophero command for user ${discordId}:`, error);
        if (error instanceof Error && (error as any).response?.status === 404) {
            return message.reply('Player not found. Make sure the Steam ID is correct and the profile is public.');
        }
        return message.reply('An error occurred while fetching turbo heroes. Please try again later.');
    }
}
