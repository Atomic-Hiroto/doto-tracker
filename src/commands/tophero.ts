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

interface HeroImpactStats {
    games: number;
    avgKda: string;
    avgGpm: number;
    avgXpm: number;
    parsedSample: number;
    avgHeroDamage?: number;
    avgStuns?: number;
}

function formatCompact(value: number): string {
    if (!Number.isFinite(value)) return '0';
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
    return Math.round(value).toString();
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
        const recentRows = await opendotaClient.get<any[]>(
            `/players/${user.steamId}/matches?game_mode=23&significant=0&date=${daysAgo}&limit=200`
        ).then((res) => res.data || []).catch(() => []);

        const calculateHeroScore = (hero: HeroStats): number => {
            const n = hero.games;
            if (n === 0) return 0;
            const z = 1.96;
            const p = hero.win / n;
            const denom = 1 + (z * z) / n;
            const centre = p + (z * z) / (2 * n);
            const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
            const wilson = (centre - margin) / denom;
            const activityBonus = Math.min(n, 100) * 0.02;
            return Math.round((wilson * 100 + activityBonus) * 100) / 100;
        };

        const topHeroes = heroes
            .filter(h => h.games >= 2)
            .map(h => ({ ...h, score: calculateHeroScore(h) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 5);

        if (topHeroes.length === 0) {
            return message.reply(`No turbo games found for ${targetUser.username} in the past 4 weeks (min 2 games per hero). Play some turbo! ⚡`);
        }

        const rowsByHero = new Map<number, any[]>();
        for (const row of recentRows) {
            const heroRows = rowsByHero.get(Number(row.hero_id)) || [];
            heroRows.push(row);
            rowsByHero.set(Number(row.hero_id), heroRows);
        }

        const impactByHero = new Map<number, HeroImpactStats>();
        await Promise.all(topHeroes.map(async (hero) => {
            const rows = rowsByHero.get(hero.hero_id) || [];
            if (rows.length === 0) return;

            const avg = (field: string) => rows.reduce((sum, row) => sum + Number(row[field] || 0), 0) / rows.length;
            const avgKdaValue = rows.reduce((sum, row) => sum + ((Number(row.kills || 0) + Number(row.assists || 0)) / Math.max(1, Number(row.deaths || 0))), 0) / rows.length;

            const detailed = await Promise.all(rows.slice(0, 3).map((row) =>
                opendotaClient.get<any>(`/matches/${row.match_id}`).then((res) => {
                    const match = res.data;
                    const player = (match.players || []).find((p: any) => String(p.account_id || '') === String(user.steamId));
                    if (!player) return null;
                    return {
                        heroDamage: Number(player.hero_damage || 0),
                        stuns: Number(player.stuns || 0),
                    };
                }).catch(() => null)
            ));
            const parsed = detailed.filter((entry): entry is { heroDamage: number; stuns: number } => !!entry);

            impactByHero.set(hero.hero_id, {
                games: rows.length,
                avgKda: avgKdaValue.toFixed(2),
                avgGpm: Math.round(avg('gold_per_min')),
                avgXpm: Math.round(avg('xp_per_min')),
                parsedSample: parsed.length,
                avgHeroDamage: parsed.length ? Math.round(parsed.reduce((sum, row) => sum + row.heroDamage, 0) / parsed.length) : undefined,
                avgStuns: parsed.length ? Math.round((parsed.reduce((sum, row) => sum + row.stuns, 0) / parsed.length) * 10) / 10 : undefined,
            });
        }));

        const heroLines = await Promise.all(
            topHeroes.map(async (hero, index) => {
                const heroName = await dotaDataService.getHeroName(hero.hero_id);
                const losses = hero.games - hero.win;
                const winRate = hero.games > 0 ? ((hero.win / hero.games) * 100).toFixed(1) : '0';
                const impact = impactByHero.get(hero.hero_id);
                const impactLine = impact
                    ? `Impact avg: **${impact.avgKda} KDA** | **${impact.avgGpm} GPM** | **${impact.avgXpm} XPM**${impact.parsedSample ? `\nParsed sample (${impact.parsedSample}): **${formatCompact(impact.avgHeroDamage || 0)} dmg** | **${impact.avgStuns?.toFixed(1) ?? '0.0'}s stuns**` : ''}`
                    : 'Impact avg unavailable from recent match rows.';
                const medals = ['🥇', '🥈', '🥉', '4.', '5.'];
                return {
                    name: `${medals[index]} ${heroName} (${hero.score.toFixed(1)} score)`,
                    value: `**${hero.games}** games | **${hero.win}**W/**${losses}**L (${winRate}% WR)\n${impactLine}`,
                    inline: false
                };
            })
        );

        const embed = new EmbedBuilder()
            .setColor('#f59e0b')
            .setTitle(`⚡ Best Turbo Heroes: ${targetUser.username}`)
            .setDescription(`📅 **Past 4 Weeks** • Ranked by conservative win-rate score\nImpact stats are context, not the ranking formula.`)
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
