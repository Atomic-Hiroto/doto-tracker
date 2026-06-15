import { Message, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { UserDataService } from '../services/userDataService';
import { Replies } from '../constants';
import { logger } from '../services/loggerService';
import { opendotaClient } from '../services/apiClient';
import { parseArgs } from '../utils/argParser';
import { renderKDATrend, renderGPMTrend, renderWinRateTrend } from '../services/chartService';
import { safeTyping } from '../utils/channelHelpers';

const CHART_TYPES = ['kda', 'gpm', 'wr'] as const;
type ChartType = typeof CHART_TYPES[number];

const CHART_CONFIG: Record<ChartType, { label: string; description: string; color: string }> = {
    kda: { label: 'KDA Trend', description: 'Kill/Death/Assist ratio over last games', color: '#7c3aed' },
    gpm: { label: 'GPM Trend', description: 'Gold Per Minute over last games', color: '#f59e0b' },
    wr: { label: 'Win Rate Trend', description: 'Rolling win rate over last games', color: '#10b981' },
};

export async function trend(message: Message, args: string[], userDataService: UserDataService) {
    const parsed = parseArgs(args, message);

    let discordId = message.author.id;
    let targetUser = message.author;
    if (parsed.mentions.length > 0) {
        discordId = parsed.mentions[0];
        targetUser = message.mentions.users.first()!;
    }

    const user = userDataService.getUserByDiscordId(discordId);
    if (!user) return message.reply(Replies.notRegistered(message.author.id, discordId, targetUser.username));

    const chartTypeArg = (parsed.positional[0] || 'kda').toLowerCase() as ChartType;
    const chartType: ChartType = CHART_TYPES.includes(chartTypeArg) ? chartTypeArg : 'kda';
    const gameCount = 20;

    try {
        safeTyping(message.channel);

        const response = await opendotaClient.get<any[]>(
            `/players/${user.steamId}/recentMatches?limit=${gameCount}`
        );
        const matches = response.data;

        if (!matches || matches.length < 3) {
            return message.reply('Not enough recent matches to generate a trend (need at least 3).');
        }

        let chartBuffer: Buffer;
        if (chartType === 'gpm') {
            chartBuffer = renderGPMTrend(matches);
        } else if (chartType === 'wr') {
            chartBuffer = renderWinRateTrend(matches);
        } else {
            chartBuffer = renderKDATrend(matches);
        }

        const config = CHART_CONFIG[chartType];
        const attachment = new AttachmentBuilder(chartBuffer, { name: 'trend.png' });

        const wins = matches.filter((m: any) => {
            const isRadiant = m.player_slot < 128;
            return (isRadiant && m.radiant_win) || (!isRadiant && !m.radiant_win);
        }).length;

        const avgKDA = (matches.reduce((sum: number, m: any) =>
            sum + (m.kills + m.assists) / (m.deaths || 1), 0) / matches.length).toFixed(2);

        // recentMatches mixes modes; turbo GPM/KDA run far higher than ranked, so a
        // mixed sample makes the GPM line in particular swing for reasons that aren't
        // form. Call it out honestly when the sample spans turbo + non-turbo.
        const turboCount = matches.filter((m: any) => m.game_mode === 23).length;
        const mixedModes = turboCount > 0 && turboCount < matches.length;
        const modeNote = mixedModes
            ? `\n⚠️ Mixed modes (${turboCount} turbo / ${matches.length - turboCount} other) — turbo inflates GPM & KDA, so read swings with that in mind.`
            : '';

        const embed = new EmbedBuilder()
            .setColor(config.color as `#${string}`)
            .setTitle(`📈 ${config.label} — ${targetUser.username}`)
            .setDescription(`${config.description}\n**Last ${matches.length} matches**${modeNote}`)
            .setThumbnail(targetUser.displayAvatarURL())
            .addFields(
                { name: 'W/L', value: `${wins}/${matches.length - wins}`, inline: true },
                { name: 'Avg KDA', value: avgKDA, inline: true },
                { name: 'Avg GPM', value: Math.round(matches.reduce((s: number, m: any) => s + m.gold_per_min, 0) / matches.length).toString(), inline: true },
            )
            .setImage('attachment://trend.png')
            .setFooter({ text: `Try +trend gpm | +trend wr | +trend kda` })
            .setTimestamp();

        await message.reply({ embeds: [embed], files: [attachment] });
    } catch (error) {
        logger.error('Error in trend command:', error);
        await message.reply('An error occurred while generating the trend chart. Please try again later.');
    }
}
