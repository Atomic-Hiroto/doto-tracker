import { Message, EmbedBuilder } from 'discord.js';
import { UserDataService } from '../services/userDataService';
import { TurboStatsService } from '../services/turboStatsService';
import { Replies } from '../constants';
import { logger } from '../services/loggerService';
import { opendotaClient } from '../services/apiClient';
import { dotaDataService } from '../services/dotaDataService';
import { safeTyping } from '../utils/channelHelpers';

function getRankName(rankTier: number | undefined): string {
    if (!rankTier) return 'Unranked';
    const tier = Math.floor(rankTier / 10);
    const stars = rankTier % 10;
    const tiers: Record<number, string> = {
        1: 'Herald', 2: 'Guardian', 3: 'Crusader', 4: 'Archon',
        5: 'Legend', 6: 'Ancient', 7: 'Divine', 8: 'Immortal'
    };
    return tier === 8 ? 'Immortal' : `${tiers[tier] || 'Unranked'} ${stars}`;
}

interface SidePlayer {
    name: string;
    rankTier?: number;
    rank: string;
    wr: number;
    totalGames: number;
    turboRating?: number;
    heroes: any[];
}

export async function compare(
    message: Message,
    args: string[],
    userDataService: UserDataService,
    turboStatsService: TurboStatsService
) {
    const mentionedUsers = [...message.mentions.users.values()];

    if (mentionedUsers.length < 2) {
        return message.reply('Please mention two registered players to compare. Usage: `+compare @player1 @player2`');
    }

    const [user1Discord, user2Discord] = [mentionedUsers[0], mentionedUsers[1]];
    const user1Data = userDataService.getUserByDiscordId(user1Discord.id);
    const user2Data = userDataService.getUserByDiscordId(user2Discord.id);

    if (!user1Data) return message.reply(`${user1Discord.username} is not registered.`);
    if (!user2Data) return message.reply(`${user2Discord.username} is not registered.`);

    try {
        safeTyping(message.channel);

        // significant=0 keeps this turbo-inclusive, matching the rest of the bot.
        const [p1Profile, p1WL, p1Heroes, p2Profile, p2WL, p2Heroes] = await Promise.all([
            opendotaClient.get<any>(`/players/${user1Data.steamId}`),
            opendotaClient.get<any>(`/players/${user1Data.steamId}/wl?significant=0`),
            opendotaClient.get<any[]>(`/players/${user1Data.steamId}/heroes?significant=0`),
            opendotaClient.get<any>(`/players/${user2Data.steamId}`),
            opendotaClient.get<any>(`/players/${user2Data.steamId}/wl?significant=0`),
            opendotaClient.get<any[]>(`/players/${user2Data.steamId}/heroes?significant=0`),
        ]);

        const buildSide = (discord: typeof user1Discord, profile: any, wl: any, heroesRes: any): SidePlayer => {
            const total = (wl.data.win || 0) + (wl.data.lose || 0);
            return {
                name: profile.data?.profile?.personaname || discord.username,
                rankTier: profile.data?.rank_tier,
                rank: getRankName(profile.data?.rank_tier),
                wr: total > 0 ? wl.data.win / total : 0,
                totalGames: total,
                turboRating: turboStatsService.getPlayerStats(discord.id)?.rating,
                heroes: (heroesRes.data || []).filter((h: any) => h.games >= 3).sort((a: any, b: any) => b.games - a.games),
            };
        };

        const p1 = buildSide(user1Discord, p1Profile, p1WL, p1Heroes);
        const p2 = buildSide(user2Discord, p2Profile, p2WL, p2Heroes);

        const heroLine = async (h: any) => {
            const heroName = await dotaDataService.getHeroName(h.hero_id);
            const wr = h.games > 0 ? ((h.win / h.games) * 100).toFixed(0) : '0';
            return `**${heroName}** · ${h.games}G ${wr}%`;
        };
        const p1HeroLines = await Promise.all(p1.heroes.slice(0, 3).map(heroLine));
        const p2HeroLines = await Promise.all(p2.heroes.slice(0, 3).map(heroLine));

        // Shared heroes across each player's top pool (by games).
        const p1Ids = new Set(p1.heroes.slice(0, 10).map((h: any) => h.hero_id));
        const sharedIds = p2.heroes.slice(0, 10).filter((h: any) => p1Ids.has(h.hero_id)).map((h: any) => h.hero_id);
        const sharedNames = await Promise.all(sharedIds.slice(0, 4).map((id: number) => dotaDataService.getHeroName(id)));

        // Duo synergy — the ONE directly comparable, shared-context stat: how they
        // actually perform on the same team in turbo (tracked by the bot).
        const sortedIds = [user1Discord.id, user2Discord.id].sort();
        const pairing = turboStatsService.getAllStats().pairings.find(
            (p) => p.player1 === sortedIds[0] && p.player2 === sortedIds[1]
        );

        const fmtSide = (p: SidePlayer, heroLines: string[]) => [
            `📊 **${(p.wr * 100).toFixed(1)}%** WR · ${p.totalGames.toLocaleString()} games`,
            `⭐ ${p.rank}`,
            `⚡ Turbo: ${p.turboRating != null ? `**${p.turboRating}**` : '—'}`,
            heroLines.length ? `🦸 ${heroLines.join('\n     ')}` : '🦸 No hero data',
        ].join('\n');

        const embed = new EmbedBuilder()
            .setColor('#6366f1')
            .setTitle('⚔️ Scouting Report')
            .setDescription(`**${p1.name}** vs **${p2.name}**`)
            .addFields(
                { name: `👤 ${p1.name}`, value: fmtSide(p1, p1HeroLines), inline: true },
                { name: `👤 ${p2.name}`, value: fmtSide(p2, p2HeroLines), inline: true },
                { name: '🤝 Shared Heroes', value: sharedNames.length ? sharedNames.join(', ') : 'None in common', inline: false },
            );

        // Duo synergy field
        if (pairing && pairing.wins + pairing.losses > 0) {
            const games = pairing.wins + pairing.losses;
            const wr = ((pairing.wins / games) * 100).toFixed(1);
            embed.addFields({
                name: '🔗 As a Duo (turbo)',
                value: `**${games}** games together · **${wr}%** WR (${pairing.wins}W/${pairing.losses}L) · rating ${pairing.rating}`,
                inline: false,
            });
        } else {
            embed.addFields({ name: '🔗 As a Duo (turbo)', value: "Haven't played tracked turbo games together yet.", inline: false });
        }

        // Honest verdict: only the shared turbo ladder is directly comparable.
        // Raw WR sits in different rank brackets, so we never crown a winner on it.
        let verdict: string;
        if (p1.turboRating != null && p2.turboRating != null && p1.turboRating !== p2.turboRating) {
            const higher = p1.turboRating > p2.turboRating ? p1 : p2;
            verdict = `On the shared **turbo ladder**, **${higher.name}** rates higher (${p1.turboRating} vs ${p2.turboRating}). Win rates aren't directly comparable — they're relative to each player's own rank bracket.`;
        } else if (p1.turboRating != null && p2.turboRating != null) {
            verdict = `Dead even on the turbo ladder (${p1.turboRating} each). Win rates sit in different brackets, so they're not directly comparable.`;
        } else {
            verdict = 'Not enough shared turbo data to rank them fairly — win rates are relative to each player\'s own rank bracket, so they aren\'t directly comparable.';
        }
        embed.addFields({ name: '🧭 Read', value: verdict, inline: false });

        embed.setFooter({ text: 'Turbo rating is the only shared ladder • WR is bracket-relative' }).setTimestamp();

        await message.reply({ embeds: [embed] });
    } catch (error) {
        logger.error('Error in compare command:', error);
        await message.reply('An error occurred while comparing players. Please try again later.');
    }
}
