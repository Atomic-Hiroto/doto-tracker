import { Message, EmbedBuilder } from 'discord.js';
import { Replies } from '../constants';
import { UserDataService } from '../services/userDataService';
import { TurboStatsService } from '../services/turboStatsService';
import { logger } from '../services/loggerService';
import { opendotaClient } from '../services/apiClient';
import { dotaDataService } from '../services/dotaDataService';
import { streakService } from '../services/streakService';
import { rankTierToMedal, tierToEmoji } from '../services/turboRankService';
import { safeTyping } from '../utils/channelHelpers';
import { pullRatingsById, turboSummary } from './turboSummary';

interface PlayerProfile {
    profile?: {
        personaname?: string;
        avatarfull?: string;
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
}

const PODIUM = ['🥇', '🥈', '🥉'];

function streakText(discordId: string): string | null {
    const info = streakService.getStreakInfo(discordId);
    if (!info || !info.current) return null;
    const count = Math.abs(info.current);
    return info.current > 0 ? `🔥 ${count}-win streak` : `💀 ${count}-loss streak`;
}

/**
 * `+profile [@user]` (also `+turbostats`) — one card for a player: their visible ranked medal and
 * all-mode record from OpenDota, then the Turbo block shared with `+compare` (hidden rank, pull,
 * tracked record). The old Turbo "score" was a win-rate formula and is no longer shown: Turbo
 * matchmaking holds everyone near 50%, so it ranked players by luck.
 */
export async function profile(
    message: Message,
    args: string[],
    userDataService: UserDataService,
    turboStatsService: TurboStatsService
) {
    const targetUser = message.mentions.users.first() ?? message.author;
    const discordId = targetUser.id;

    const user = userDataService.getUserByDiscordId(discordId);
    if (!user) {
        return message.reply(Replies.notRegistered(message.author.id, discordId, targetUser.username));
    }

    try {
        safeTyping(message.channel);

        // significant=0 includes turbo/unranked so the "All modes" labels below are accurate;
        // the default would silently return ranked-standard games only.
        const [profileRes, wlRes, totalsRes, heroesRes] = await Promise.all([
            opendotaClient.get<PlayerProfile>(`/players/${user.steamId}`),
            opendotaClient.get<WinLoss>(`/players/${user.steamId}/wl?significant=0`),
            opendotaClient.get<TotalField[]>(`/players/${user.steamId}/totals?significant=0`),
            opendotaClient.get<HeroStats[]>(`/players/${user.steamId}/heroes?significant=0`)
        ]);

        const playerProfile = profileRes.data;
        const wl = wlRes.data;
        const totals = totalsRes.data;
        const totalGames = wl.win + wl.lose;
        const winRate = totalGames > 0 ? ((wl.win / totalGames) * 100).toFixed(1) : '0';

        const avg = (field: string) => {
            const stat = totals.find(t => t.field === field);
            return stat && stat.n ? stat.sum / stat.n : 0;
        };

        const topHeroes = heroesRes.data
            .filter(h => h.games >= 1)
            .sort((a, b) => b.games - a.games)
            .slice(0, 3);
        const heroLines = await Promise.all(topHeroes.map(async (hero, index) => {
            const heroWinRate = ((hero.win / hero.games) * 100).toFixed(0);
            return `${PODIUM[index]} **${await dotaDataService.getHeroName(hero.hero_id)}** · ${hero.games.toLocaleString()} games · ${heroWinRate}%`;
        }));

        const turbo = turboSummary(turboStatsService, discordId, user.steamId, pullRatingsById(turboStatsService));
        const streak = streakText(discordId);

        const rankTier = playerProfile.rank_tier;
        const rankedText = rankTier
            ? `${tierToEmoji(Math.floor(rankTier / 10))} **${rankTierToMedal(rankTier)}**${playerProfile.leaderboard_rank ? ` · #${playerProfile.leaderboard_rank}` : ''}`
            : '⚪ **Unranked**';
        const name = playerProfile.profile?.personaname || targetUser.username;

        const embed = new EmbedBuilder()
            .setColor('#7c3aed')
            .setAuthor({ name: targetUser.username, iconURL: targetUser.displayAvatarURL() })
            .setTitle(`📊 ${name}`)
            .setURL(`https://www.opendota.com/players/${user.steamId}`)
            .setThumbnail(playerProfile.profile?.avatarfull || targetUser.displayAvatarURL())
            .setDescription(`Ranked ${rankedText}${streak ? `\n${streak}` : ''}`)
            .addFields(
                {
                    name: '📈 All modes',
                    value: `**${wl.win.toLocaleString()}W – ${wl.lose.toLocaleString()}L**\n${winRate}% · ${totalGames.toLocaleString()} games`,
                    inline: true,
                },
                {
                    name: '⚔️ Averages',
                    value: `KDA **${avg('kills').toFixed(1)} / ${avg('deaths').toFixed(1)} / ${avg('assists').toFixed(1)}**\n`
                        + `GPM **${Math.round(avg('gold_per_min'))}** · XPM **${Math.round(avg('xp_per_min'))}**`,
                    inline: true,
                },
                { name: '🦸 Most played', value: heroLines.length ? heroLines.join('\n') : 'No hero data yet', inline: false },
                { name: '⚡ Turbo', value: turbo.lines.join('\n'), inline: false },
            )
            .setFooter({ text: 'All-mode stats from OpenDota · +turborank for the full rank card · +turbopull for party effects' })
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    } catch (error) {
        logger.error(`Error in profile command for user ${discordId}:`, error);
        if (error instanceof Error && (error as any).response?.status === 404) {
            return message.reply('Player profile not found. Make sure the Steam ID is correct and the profile is public.');
        }
        return message.reply('An error occurred while fetching the profile. Please try again later.');
    }
}
