import { Message, EmbedBuilder } from 'discord.js';
import axios from 'axios';
import { Replies, APIConstants } from '../constants';
import { UserDataService } from '../services/userDataService';
import { logger } from '../services/loggerService';

interface HeroStats {
    hero_id: number;
    games: number;
    win: number;
    with_games?: number;
    with_win?: number;
    against_games?: number;
    against_win?: number;
}

// Get hero name from hero ID
async function getHeroName(heroId: number): Promise<string> {
    try {
        const response = await axios.get<Array<{ id: number; localized_name: string }>>(APIConstants.HEROES_API);
        const hero = response.data.find(h => h.id === heroId);
        return hero ? hero.localized_name : 'Unknown Hero';
    } catch (error) {
        logger.error('Error fetching hero data:', error);
        return 'Unknown Hero';
    }
}

export async function tophero(
    message: Message,
    args: string[],
    userDataService: UserDataService
) {
    let discordId = message.author.id;
    let targetUser = message.author;

    // Check if user mentioned someone
    if (args.length > 0 && message.mentions.users.size > 0) {
        discordId = message.mentions.users.first()!.id;
        targetUser = message.mentions.users.first()!;
    }

    const user = userDataService.getUserByDiscordId(discordId);
    if (!user) {
        return message.reply(Replies.NEED_REGISTRATION);
    }

    try {
        message.channel.sendTyping();

        // Fetch turbo heroes from past 28 days (4 weeks)
        const daysAgo = 28;
        const response = await axios.get<HeroStats[]>(APIConstants.PLAYER_TURBO_HEROES(user.steamId, daysAgo));
        const heroes = response.data;

        // Calculate hero rating: winrate * confidence factor + games bonus
        // Confidence factor scales from 0 to 1 based on games (full confidence at 10+ games)
        const calculateHeroRating = (hero: HeroStats): number => {
            if (hero.games === 0) return 0;
            const winRate = hero.win / hero.games;
            const confidenceFactor = Math.min(hero.games / 10, 1);
            return (winRate * 100 * confidenceFactor) + (hero.games * 0.5);
        };

        // Filter heroes with at least 2 games and sort by rating (best heroes, not most played)
        const topHeroes = heroes
            .filter(h => h.games >= 2)
            .map(h => ({ ...h, rating: calculateHeroRating(h) }))
            .sort((a, b) => b.rating - a.rating)
            .slice(0, 5);

        if (topHeroes.length === 0) {
            return message.reply(`No turbo games found for ${targetUser.username} in the past 4 weeks (min 2 games per hero). Play some turbo! ⚡`);
        }

        // Build hero lines
        const heroLines = await Promise.all(
            topHeroes.map(async (hero, index) => {
                const heroName = await getHeroName(hero.hero_id);
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

        // Build embed
        const embed = new EmbedBuilder()
            .setColor('#f59e0b')
            .setTitle(`⚡ Best Turbo Heroes: ${targetUser.username}`)
            .setDescription(`📅 **Past 4 Weeks** • Ranked by rating (winrate + games)`)
            .setThumbnail(targetUser.displayAvatarURL())
            .addFields(heroLines)
            .setFooter({ text: `Steam ID: ${user.steamId} • Data from OpenDota` })
            .setURL(`https://www.opendota.com/players/${user.steamId}/heroes?game_mode=23`)
            .setTimestamp();

        // Calculate total turbo stats for the period
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
        if (axios.isAxiosError(error) && error.response?.status === 404) {
            return message.reply('Player not found. Make sure the Steam ID is correct and the profile is public.');
        }
        return message.reply('An error occurred while fetching turbo heroes. Please try again later.');
    }
}
