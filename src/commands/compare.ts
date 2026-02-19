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
    return tier === 8 ? '⭐ Immortal' : `${tiers[tier] || 'Unranked'} ${stars}`;
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

        const [p1Profile, p1WL, p1Heroes, p2Profile, p2WL, p2Heroes] = await Promise.all([
            opendotaClient.get<any>(`/players/${user1Data.steamId}`),
            opendotaClient.get<any>(`/players/${user1Data.steamId}/wl`),
            opendotaClient.get<any[]>(`/players/${user1Data.steamId}/heroes`),
            opendotaClient.get<any>(`/players/${user2Data.steamId}`),
            opendotaClient.get<any>(`/players/${user2Data.steamId}/wl`),
            opendotaClient.get<any[]>(`/players/${user2Data.steamId}/heroes`),
        ]);

        const p1 = {
            name: p1Profile.data?.profile?.personaname || user1Discord.username,
            rank: getRankName(p1Profile.data?.rank_tier),
            wr: p1WL.data.win + p1WL.data.lose > 0
                ? p1WL.data.win / (p1WL.data.win + p1WL.data.lose)
                : 0,
            totalGames: p1WL.data.win + p1WL.data.lose,
            wins: p1WL.data.win,
            turbo: turboStatsService.getPlayerStats(user1Discord.id),
            heroes: p1Heroes.data.filter((h: any) => h.games >= 5).sort((a: any, b: any) => b.games - a.games).slice(0, 5),
        };

        const p2 = {
            name: p2Profile.data?.profile?.personaname || user2Discord.username,
            rank: getRankName(p2Profile.data?.rank_tier),
            wr: p2WL.data.win + p2WL.data.lose > 0
                ? p2WL.data.win / (p2WL.data.win + p2WL.data.lose)
                : 0,
            totalGames: p2WL.data.win + p2WL.data.lose,
            wins: p2WL.data.win,
            turbo: turboStatsService.getPlayerStats(user2Discord.id),
            heroes: p2Heroes.data.filter((h: any) => h.games >= 5).sort((a: any, b: any) => b.games - a.games).slice(0, 5),
        };

        // Determine who wins each category
        const win = (a: number, b: number, higherIsBetter = true) => {
            if (a === b) return '🟡';
            return ((a > b) === higherIsBetter) ? '✅' : '❌';
        };

        const p1Turbo = p1.turbo?.rating ?? 0;
        const p2Turbo = p2.turbo?.rating ?? 0;

        // Find shared heroes
        const p1HeroIds = new Set(p1.heroes.map((h: any) => h.hero_id));
        const sharedHeroIds = p2.heroes.filter((h: any) => p1HeroIds.has(h.hero_id)).map((h: any) => h.hero_id);
        const sharedHeroNames = await Promise.all(sharedHeroIds.slice(0, 3).map((id: number) => dotaDataService.getHeroName(id)));

        // Best heroes per player
        const p1BestHeroNames = await Promise.all(p1.heroes.slice(0, 3).map((h: any) => dotaDataService.getHeroName(h.hero_id)));
        const p2BestHeroNames = await Promise.all(p2.heroes.slice(0, 3).map((h: any) => dotaDataService.getHeroName(h.hero_id)));

        const p1Wins = [
            win(p1.wr, p2.wr) === '✅',
            win(p1.totalGames, p2.totalGames) === '✅',
            win(p1Turbo, p2Turbo) === '✅',
        ].filter(Boolean).length;

        const embed = new EmbedBuilder()
            .setColor('#6366f1')
            .setTitle(`⚔️ Player Comparison`)
            .setDescription(`**${p1.name}** vs **${p2.name}**\n_Who's the real carry?_ 🧠`)
            .addFields(
                {
                    name: `👤 ${p1.name}`,
                    value: [
                        `📊 **${(p1.wr * 100).toFixed(1)}%** WR (${p1.totalGames} games) ${win(p1.wr, p2.wr)}`,
                        `⭐ ${p1.rank}`,
                        `⚡ Turbo Rating: **${p1Turbo}** ${win(p1Turbo, p2Turbo)}`,
                        `🦸 Top heroes: ${p1BestHeroNames.join(', ')}`,
                    ].join('\n'),
                    inline: true,
                },
                {
                    name: `👤 ${p2.name}`,
                    value: [
                        `📊 **${(p2.wr * 100).toFixed(1)}%** WR (${p2.totalGames} games) ${win(p2.wr, p1.wr)}`,
                        `⭐ ${p2.rank}`,
                        `⚡ Turbo Rating: **${p2Turbo}** ${win(p2Turbo, p1Turbo)}`,
                        `🦸 Top heroes: ${p2BestHeroNames.join(', ')}`,
                    ].join('\n'),
                    inline: true,
                },
                {
                    name: '🤝 Shared Heroes',
                    value: sharedHeroNames.length > 0 ? sharedHeroNames.join(', ') : 'None in common',
                    inline: false,
                },
                {
                    name: '🏆 Verdict',
                    value: p1Wins > 1
                        ? `**${p1.name}** edges it out in ${p1Wins}/3 categories!`
                        : p1Wins < 1
                            ? `**${p2.name}** edges it out in ${3 - p1Wins}/3 categories!`
                            : `It\'s a close match — both players are very even! 🤝`,
                    inline: false,
                }
            )
            .setFooter({ text: 'Categories: Win Rate | Turbo Rating | Games Played' })
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    } catch (error) {
        logger.error('Error in compare command:', error);
        await message.reply('An error occurred while comparing players. Please try again later.');
    }
}
