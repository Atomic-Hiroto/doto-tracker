import { Message, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { opendotaClient } from '../services/apiClient';
import { renderMatchAdvantageGraph } from '../services/chartService';
import { logger } from '../services/loggerService';
import { safeTyping } from '../utils/channelHelpers';

function formatDuration(seconds?: number): string {
    if (!seconds) return '—';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

export async function graph(message: Message, args: string[]) {
    const matchId = args.find((a) => /^\d{6,}$/.test(a));
    if (!matchId) return message.reply('Usage: `+graph <match_id>` — renders the gold/XP advantage graph for a match.');

    try {
        safeTyping(message.channel);
        const { data: match } = await opendotaClient.get<any>(`/matches/${matchId}`);
        if (!match || !match.match_id) return message.reply(`Could not find match **${matchId}**.`);

        const goldAdv: number[] = match.radiant_gold_adv || [];
        const xpAdv: number[] = match.radiant_xp_adv || [];

        if (goldAdv.length < 2) {
            return message.reply(
                `Match **${matchId}** has no timeline data yet — it hasn't been parsed by OpenDota. ` +
                `Open it on OpenDota and hit "Parse", then try again in a minute.`
            );
        }

        const radiantWin = !!match.radiant_win;
        const buffer = renderMatchAdvantageGraph(goldAdv, xpAdv, {
            title: `Gold & XP Advantage — Match ${matchId}`,
            radiantWin,
        });
        const attachment = new AttachmentBuilder(buffer, { name: 'advantage.png' });

        // Final swing summary
        const finalGold = goldAdv[goldAdv.length - 1];
        const swing = finalGold >= 0
            ? `Radiant closed +${(finalGold / 1000).toFixed(1)}k gold`
            : `Dire closed +${(Math.abs(finalGold) / 1000).toFixed(1)}k gold`;

        const radiantScore = match.radiant_score ?? '?';
        const direScore = match.dire_score ?? '?';

        const embed = new EmbedBuilder()
            .setColor(radiantWin ? '#10b981' : '#ef4444')
            .setTitle(`📊 Match ${matchId}`)
            .setDescription(`**${radiantWin ? 'Radiant' : 'Dire'} Victory** — ${radiantScore}–${direScore} in ${formatDuration(match.duration)}\n${swing}`)
            .setImage('attachment://advantage.png')
            .setURL(`https://www.opendota.com/matches/${matchId}`)
            .setFooter({ text: 'Green = Radiant ahead • Red = Dire ahead • dashed = XP' })
            .setTimestamp();

        await message.reply({ embeds: [embed], files: [attachment] });
    } catch (error) {
        logger.error('Error in graph command:', error);
        await message.reply('An error occurred while generating the match graph. Please try again later.');
    }
}
