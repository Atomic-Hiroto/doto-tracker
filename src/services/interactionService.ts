import { Client, Interaction, EmbedBuilder, ButtonInteraction } from 'discord.js';
import { getDetailedMatchData } from './dotaService';
import { getMatchStory } from './aiService';
import { logger } from './loggerService';
import { opendotaClient } from './apiClient';
import { dotaDataService } from './dotaDataService';
import { formatDuration } from '../utils/formatters';
import { analyze } from '../commands/aiCommands';

function asMessageAdapter(interaction: ButtonInteraction): any {
    const noop = async () => undefined;
    return {
        author: interaction.user,
        user: interaction.user,
        channel: interaction.channel,
        client: interaction.client,
        guild: interaction.guild,
        id: interaction.id,
        content: '',
        mentions: { users: new Map(), has: () => false },
        reply: (payload: any) => interaction.followUp(payload),
        react: noop,
        reactions: {
            cache: {
                get: () => ({
                    users: { remove: noop },
                }),
            },
        },
    };
}

export function registerInteractionHandler(client: Client) {
    client.on('interactionCreate', async (interaction: Interaction) => {
        if (!interaction.isButton()) return;

        const { customId, user } = interaction;

        try {
            if (customId.startsWith('story_')) {
                const matchId = parseInt(customId.replace('story_', ''), 10);
                await interaction.reply({ content: `📖 Generating match story for match #${matchId}...`, ephemeral: false });

                const matchData = await getDetailedMatchData(matchId);
                if (!matchData) {
                    return interaction.followUp({ content: 'Match data not available or not parsed yet.', ephemeral: true });
                }

                await getMatchStory(asMessageAdapter(interaction), matchData);

            } else if (customId.startsWith('details_')) {
                const matchId = parseInt(customId.replace('details_', ''), 10);
                await interaction.deferReply();

                const response = await opendotaClient.get(`/matches/${matchId}`);
                const match = response.data;

                if (!match) {
                    return interaction.followUp({ content: 'Could not fetch match details.', ephemeral: true });
                }

                const radiantPlayers = match.players.filter((p: any) => p.player_slot < 128);
                const direPlayers = match.players.filter((p: any) => p.player_slot >= 128);

                const formatPlayerLine = async (p: any) => {
                    const hero = await dotaDataService.getHeroName(p.hero_id);
                    return `**${p.personaname || 'Unknown'}** (${hero}): ${p.kills}/${p.deaths}/${p.assists} | ${p.gold_per_min} GPM`;
                };

                const radiantLines = await Promise.all(radiantPlayers.map(formatPlayerLine));
                const direLines = await Promise.all(direPlayers.map(formatPlayerLine));

                const embed = new EmbedBuilder()
                    .setColor(match.radiant_win ? '#66bb6a' : '#ef5350')
                    .setTitle(`Match #${matchId} — ${match.radiant_win ? 'Radiant Victory' : 'Dire Victory'}`)
                    .addFields(
                        { name: '🟢 Radiant', value: radiantLines.join('\n') || 'N/A', inline: false },
                        { name: '🔴 Dire', value: direLines.join('\n') || 'N/A', inline: false },
                        { name: 'Duration', value: formatDuration(match.duration), inline: true },
                        { name: 'Mode', value: match.game_mode?.toString() || 'Unknown', inline: true },
                    )
                    .setURL(`https://www.opendota.com/matches/${matchId}`)
                    .setTimestamp(new Date(match.start_time * 1000));

                await interaction.followUp({ embeds: [embed] });

            } else if (customId.startsWith('coachme_')) {
                const [, matchIdRaw, steamId] = customId.split('_');
                const matchId = parseInt(matchIdRaw, 10);
                if (!matchId || !steamId) {
                    return interaction.reply({ content: 'Invalid coach request.', ephemeral: true });
                }
                await interaction.reply({ content: `🎓 Running focused coaching for match #${matchId}...`, ephemeral: false });
                await analyze(asMessageAdapter(interaction), [String(matchId), steamId]);

            } else if (customId.startsWith('page_')) {
                // Pagination buttons — handled by individual commands that registered them
                await interaction.reply({ content: '⏩ Pagination not implemented for this view yet.', ephemeral: true });
            }
        } catch (error) {
            logger.error(`Error handling button interaction "${customId}":`, error);
            try {
                await interaction.reply({ content: 'An error occurred while handling this button. Please try again.', ephemeral: true });
            } catch {
                // Interaction may have already been replied to
            }
        }
    });

    logger.info('Interaction handler registered');
}
