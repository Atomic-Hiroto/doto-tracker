import { Message, EmbedBuilder } from 'discord.js';
import axios from 'axios';
import { Replies, APIConstants } from '../constants';
import { UserDataService } from '../services/userDataService';
import { TurboStatsService } from '../services/turboStatsService';
import { logger } from '../services/loggerService';

interface PlayerProfile {
    profile?: {
        personaname?: string;
        avatarfull?: string;
        loccountrycode?: string;
    };
    rank_tier?: number;
    leaderboard_rank?: number;
}

interface WinLoss {
    win: number;
    lose: number;
}

interface TotalField {
    field: string;
    n: number;
    sum: number;
}

interface HeroStats {
    hero_id: number;
    games: number;
    win: number;
    last_played: number;
}

// Map rank tier to medal name
function getRankName(rankTier: number | undefined): string {
    if (!rankTier) return 'Unranked';

    const tier = Math.floor(rankTier / 10);
    const stars = rankTier % 10;

    const tiers: Record<number, string> = {
        1: 'Herald',
        2: 'Guardian',
        3: 'Crusader',
        4: 'Archon',
        5: 'Legend',
        6: 'Ancient',
        7: 'Divine',
        8: 'Immortal'
    };

    const tierName = tiers[tier] || 'Unknown';
    if (tier === 8) return '⭐ Immortal';
    return `${tierName} ${stars}`;
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

export async function profile(
    message: Message,
    args: string[],
    userDataService: UserDataService,
    turboStatsService: TurboStatsService
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

        // Fetch all data in parallel
        const [profileRes, wlRes, totalsRes, heroesRes] = await Promise.all([
            axios.get<PlayerProfile>(APIConstants.PLAYER_PROFILE(user.steamId)),
            axios.get<WinLoss>(APIConstants.PLAYER_WL(user.steamId)),
            axios.get<TotalField[]>(APIConstants.PLAYER_TOTALS(user.steamId)),
            axios.get<HeroStats[]>(APIConstants.PLAYER_HEROES(user.steamId))
        ]);

        const playerProfile = profileRes.data;
        const wl = wlRes.data;
        const totals = totalsRes.data;
        const heroes = heroesRes.data;

        // Calculate stats
        const totalGames = wl.win + wl.lose;
        const winRate = totalGames > 0 ? ((wl.win / totalGames) * 100).toFixed(1) : '0';

        // Get averages from totals
        const getAvg = (field: string): string => {
            const stat = totals.find(t => t.field === field);
            if (!stat || stat.n === 0) return '0';
            return (stat.sum / stat.n).toFixed(1);
        };

        const avgKills = getAvg('kills');
        const avgDeaths = getAvg('deaths');
        const avgAssists = getAvg('assists');
        const avgGpm = getAvg('gold_per_min');
        const avgXpm = getAvg('xp_per_min');

        // Get top 3 heroes
        const topHeroes = heroes
            .filter(h => h.games >= 1)
            .sort((a, b) => b.games - a.games)
            .slice(0, 3);

        const heroLines = await Promise.all(
            topHeroes.map(async (hero, index) => {
                const heroName = await getHeroName(hero.hero_id);
                const heroWinRate = hero.games > 0 ? ((hero.win / hero.games) * 100).toFixed(1) : '0';
                const medals = ['🥇', '🥈', '🥉'];
                return `${medals[index]} **${heroName}** • ${hero.games} games • ${heroWinRate}% WR`;
            })
        );

        // Get turbo stats
        const turboStats = turboStatsService.getPlayerStats(discordId);

        // Build embed
        const embed = new EmbedBuilder()
            .setColor('#7c3aed')
            .setTitle(`📊 Player Profile: ${playerProfile.profile?.personaname || targetUser.username}`)
            .setDescription(`⭐ **${getRankName(playerProfile.rank_tier)}**${playerProfile.leaderboard_rank ? ` • Rank #${playerProfile.leaderboard_rank}` : ''}`)
            .setThumbnail(playerProfile.profile?.avatarfull || targetUser.displayAvatarURL())
            .addFields(
                {
                    name: '📈 Overall Stats',
                    value: `**Wins:** ${wl.win.toLocaleString()} | **Losses:** ${wl.lose.toLocaleString()} | **WR:** ${winRate}%\n**Total Games:** ${totalGames.toLocaleString()}`,
                    inline: false
                },
                {
                    name: '⚔️ Avg Performance',
                    value: `**KDA:** ${avgKills}/${avgDeaths}/${avgAssists} | **GPM:** ${avgGpm} | **XPM:** ${avgXpm}`,
                    inline: false
                },
                {
                    name: '🦸 Top Heroes (All Modes)',
                    value: heroLines.length > 0 ? heroLines.join('\n') : 'No hero data available',
                    inline: false
                }
            );

        // Add turbo stats if available
        if (turboStats) {
            const turboTotal = turboStats.wins + turboStats.losses;
            const turboWr = turboTotal > 0 ? ((turboStats.wins / turboTotal) * 100).toFixed(1) : '0';
            embed.addFields({
                name: '⚡ Turbo Stats',
                value: `**Rating:** ${turboStats.rating} | **W/L:** ${turboStats.wins}/${turboStats.losses} (${turboWr}%)`,
                inline: false
            });
        }

        embed.setFooter({ text: `Steam ID: ${user.steamId}` });
        embed.setURL(`https://www.opendota.com/players/${user.steamId}`);
        embed.setTimestamp();

        await message.reply({ embeds: [embed] });
    } catch (error) {
        logger.error(`Error in profile command for user ${discordId}:`, error);
        if (axios.isAxiosError(error) && error.response?.status === 404) {
            return message.reply('Player profile not found. Make sure the Steam ID is correct and the profile is public.');
        }
        return message.reply('An error occurred while fetching the profile. Please try again later.');
    }
}
