import { Message, EmbedBuilder } from 'discord.js';
import { Replies, APIConstants } from '../constants';
import { UserDataService } from '../services/userDataService';
import { TurboStatsService } from '../services/turboStatsService';
import { logger } from '../services/loggerService';
import { opendotaClient } from '../services/apiClient';
import { dotaDataService } from '../services/dotaDataService';
import { safeTyping } from '../utils/channelHelpers';

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

function getRankName(rankTier: number | undefined): string {
    if (!rankTier) return 'Unranked';
    const tier = Math.floor(rankTier / 10);
    const stars = rankTier % 10;
    const tiers: Record<number, string> = {
        1: 'Herald', 2: 'Guardian', 3: 'Crusader',
        4: 'Archon', 5: 'Legend', 6: 'Ancient', 7: 'Divine', 8: 'Immortal'
    };
    const tierName = tiers[tier] || 'Unknown';
    if (tier === 8) return '⭐ Immortal';
    return `${tierName} ${stars}`;
}

export async function profile(
    message: Message,
    args: string[],
    userDataService: UserDataService,
    turboStatsService: TurboStatsService
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

        const [profileRes, wlRes, totalsRes, heroesRes] = await Promise.all([
            opendotaClient.get<PlayerProfile>(`/players/${user.steamId}`),
            opendotaClient.get<WinLoss>(`/players/${user.steamId}/wl`),
            opendotaClient.get<TotalField[]>(`/players/${user.steamId}/totals`),
            opendotaClient.get<HeroStats[]>(`/players/${user.steamId}/heroes`)
        ]);

        const playerProfile = profileRes.data;
        const wl = wlRes.data;
        const totals = totalsRes.data;
        const heroes = heroesRes.data;

        const totalGames = wl.win + wl.lose;
        const winRate = totalGames > 0 ? ((wl.win / totalGames) * 100).toFixed(1) : '0';

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

        const topHeroes = heroes
            .filter(h => h.games >= 1)
            .sort((a, b) => b.games - a.games)
            .slice(0, 3);

        const heroLines = await Promise.all(
            topHeroes.map(async (hero, index) => {
                const heroName = await dotaDataService.getHeroName(hero.hero_id);
                const heroWinRate = hero.games > 0 ? ((hero.win / hero.games) * 100).toFixed(1) : '0';
                const medals = ['🥇', '🥈', '🥉'];
                return `${medals[index]} **${heroName}** • ${hero.games} games • ${heroWinRate}% WR`;
            })
        );

        const turboStats = turboStatsService.getPlayerStats(discordId);

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
        if (error instanceof Error && (error as any).response?.status === 404) {
            return message.reply('Player profile not found. Make sure the Steam ID is correct and the profile is public.');
        }
        return message.reply('An error occurred while fetching the profile. Please try again later.');
    }
}
