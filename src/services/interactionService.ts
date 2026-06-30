import {
    AttachmentBuilder,
    ButtonInteraction,
    ChatInputCommandInteraction,
    Client,
    EmbedBuilder,
    Interaction,
    SlashCommandBuilder,
} from 'discord.js';
import { logger } from './loggerService';
import { opendotaClient } from './apiClient';
import { dotaDataService } from './dotaDataService';
import { formatDuration } from '../utils/formatters';
import { analyze } from '../commands/aiCommands';
import { UserDataService } from './userDataService';
import { TurboStatsService } from './turboStatsService';
import * as commandHandlers from '../commands';
import { createMatchDetailRow } from '../components/matchButtons';
import { referenceService } from './referenceService';
import { renderMatchAdvantageGraph, renderMatchScoreboard, ScoreboardPlayer, ScoreboardTeam } from './chartService';
import { APIConstants } from '../constants';
import { resolveMatchRankDisplay } from './rankDisplayService';

const GAME_MODE_NAMES: Record<number, string> = {
    0: 'Unknown', 1: 'All Pick', 2: 'Captains Mode', 3: 'Random Draft',
    4: 'Single Draft', 5: 'All Random', 8: 'Reverse Captains Mode',
    16: 'Captains Draft', 22: 'All Draft', 23: 'Turbo', 24: 'Mutation',
};

const activeAnalysisButtons = new Set<string>();

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

function asSlashMessageAdapter(interaction: ChatInputCommandInteraction, mentionUserId?: string): any {
    const noop = async () => undefined;
    const mentionUser = mentionUserId ? interaction.options.getUser('user') : null;
    const users = new Map<string, any>();
    if (mentionUserId && mentionUser) users.set(mentionUserId, mentionUser);
    return {
        author: interaction.user,
        user: interaction.user,
        member: interaction.member,
        channel: interaction.channel,
        client: interaction.client,
        guild: interaction.guild,
        id: interaction.id,
        content: '',
        mentions: {
            users: {
                first: () => mentionUser,
                forEach: (fn: (user: any) => void) => users.forEach(fn),
            },
            has: () => false,
        },
        reply: (payload: any) => interaction.deferred || interaction.replied ? interaction.followUp(payload) : interaction.reply(payload),
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

function splitQuery(value?: string | null): string[] {
    return value?.trim() ? value.trim().split(/\s+/) : [];
}

async function handleSlashCommand(interaction: ChatInputCommandInteraction, userDataService: UserDataService, turboStatsService: TurboStatsService) {
    const name = interaction.commandName;
    const query = interaction.options.getString('query') || '';
    const user = interaction.options.getUser('user');
    const args = splitQuery(query);
    if (user) args.unshift(`<@${user.id}>`);
    const message = asSlashMessageAdapter(interaction, user?.id);

    switch (name) {
        case 'register':
            return commandHandlers.register(message, [interaction.options.getString('steam_id', true)], userDataService);
        case 'profile':
            return commandHandlers.profile(message, args, userDataService, turboStatsService);
        case 'rs':
            return commandHandlers.recentStats(message, args, userDataService);
        case 'matches':
            return commandHandlers.matches(message, args, userDataService);
        case 'analyze': {
            const matchOrFilter = interaction.options.getString('match_or_filter', true);
            const player = interaction.options.getString('player');
            return analyze(message, [...splitQuery(matchOrFilter), ...splitQuery(player)], userDataService);
        }
        case 'coach':
            return commandHandlers.coach(message, args, userDataService);
        case 'hero':
            return commandHandlers.hero(message, splitQuery(interaction.options.getString('name', true)));
        case 'item':
            return commandHandlers.item(message, splitQuery(interaction.options.getString('name', true)));
        case 'ability':
            return commandHandlers.ability(message, splitQuery(interaction.options.getString('name', true)));
        case 'aghs':
            return commandHandlers.aghs(message, splitQuery(interaction.options.getString('hero', true)));
        case 'talents':
            return commandHandlers.talents(message, splitQuery(interaction.options.getString('hero', true)));
        case 'graph':
            return commandHandlers.graph(message, [interaction.options.getString('match_id', true)]);
        case 'skillbuild':
            return commandHandlers.skillbuild(message, [interaction.options.getString('match_id', true), ...splitQuery(interaction.options.getString('player', true))]);
        case 'inventory':
            return commandHandlers.matchInventory(message, args, userDataService);
        case 'roles':
            return commandHandlers.roles(message, args, userDataService);
        case 'percent':
            return commandHandlers.percent(message, args, userDataService);
        default:
            return interaction.reply({ content: 'Unknown slash command.', ephemeral: true });
    }
}

async function handleAutocomplete(interaction: Interaction) {
    if (!interaction.isAutocomplete()) return false;
    const focused = interaction.options.getFocused(true);
    const value = String(focused.value || '');
    if ((focused.name === 'name' && interaction.commandName === 'item') || focused.name === 'item') {
        const items = await referenceService.searchItems(value, 20);
        await interaction.respond(items.map(({ key, item }) => ({ name: item.dname || key, value: item.dname || key })));
        return true;
    }
    if (['hero', 'name', 'player'].includes(focused.name)) {
        const heroes = await referenceService.searchHeroes(value, 20);
        await interaction.respond(heroes.map((hero) => ({ name: hero.localized_name, value: hero.localized_name })));
        return true;
    }
    return false;
}

export async function registerSlashCommands(client: Client) {
    if (!client.application) return;
    const queryOption = (builder: any) => builder
        .addUserOption((option: any) => option.setName('user').setDescription('Registered player').setRequired(false))
        .addStringOption((option: any) => option.setName('query').setDescription('Filters, e.g. "10 won as invoker this week"').setRequired(false));
    const commands = [
        new SlashCommandBuilder().setName('register').setDescription('Register your Steam ID')
            .addStringOption((option) => option.setName('steam_id').setDescription('Steam account id').setRequired(true)),
        queryOption(new SlashCommandBuilder().setName('profile').setDescription('Show player profile')),
        queryOption(new SlashCommandBuilder().setName('rs').setDescription('Show recent matches with optional filters')),
        queryOption(new SlashCommandBuilder().setName('matches').setDescription('Pick a recent match to analyze from a list')),
        new SlashCommandBuilder().setName('analyze').setDescription('Fact-grounded match analysis or filtered latest match')
            .addStringOption((option) => option.setName('match_or_filter').setDescription('Match id or filter phrase').setRequired(true))
            .addStringOption((option) => option.setName('player').setDescription('Optional player/hero focus').setRequired(false).setAutocomplete(true)),
        queryOption(new SlashCommandBuilder().setName('coach').setDescription('Trend coach with optional filters')),
        new SlashCommandBuilder().setName('hero').setDescription('Hero overview')
            .addStringOption((option) => option.setName('name').setDescription('Hero name').setRequired(true).setAutocomplete(true)),
        new SlashCommandBuilder().setName('item').setDescription('Item details')
            .addStringOption((option) => option.setName('name').setDescription('Item name').setRequired(true).setAutocomplete(true)),
        new SlashCommandBuilder().setName('ability').setDescription('Ability details')
            .addStringOption((option) => option.setName('name').setDescription('Ability name').setRequired(true)),
        new SlashCommandBuilder().setName('aghs').setDescription("Hero Aghanim's upgrades")
            .addStringOption((option) => option.setName('hero').setDescription('Hero name').setRequired(true).setAutocomplete(true)),
        new SlashCommandBuilder().setName('talents').setDescription('Hero talent tree')
            .addStringOption((option) => option.setName('hero').setDescription('Hero name').setRequired(true).setAutocomplete(true)),
        new SlashCommandBuilder().setName('graph').setDescription('Gold/XP advantage graph')
            .addStringOption((option) => option.setName('match_id').setDescription('Match ID').setRequired(true)),
        new SlashCommandBuilder().setName('skillbuild').setDescription('Ability level-up order')
            .addStringOption((option) => option.setName('match_id').setDescription('Match ID').setRequired(true))
            .addStringOption((option) => option.setName('player').setDescription('Player or hero').setRequired(true).setAutocomplete(true)),
        queryOption(new SlashCommandBuilder().setName('inventory').setDescription('End inventory view or common items slice')),
        queryOption(new SlashCommandBuilder().setName('roles').setDescription('Role distribution over recent matches')),
        queryOption(new SlashCommandBuilder().setName('percent').setDescription('Percent query, e.g. "turbo wins as PA with BKB"')),
    ];
    await client.application.commands.set(commands.map((command) => command.toJSON()));
    logger.info(`Registered ${commands.length} slash commands`);
}

export function registerInteractionHandler(client: Client, userDataService: UserDataService, turboStatsService: TurboStatsService) {
    client.on('interactionCreate', async (interaction: Interaction) => {
        if (await handleAutocomplete(interaction)) return;
        if (interaction.isChatInputCommand()) {
            try {
                await handleSlashCommand(interaction, userDataService, turboStatsService);
            } catch (error) {
                logger.error(`Error handling slash command "${interaction.commandName}":`, error);
                if (interaction.deferred || interaction.replied) {
                    await interaction.followUp({ content: 'An error occurred while handling this command.', ephemeral: true }).catch(() => null);
                } else {
                    await interaction.reply({ content: 'An error occurred while handling this command.', ephemeral: true }).catch(() => null);
                }
            }
            return;
        }
        if (!interaction.isButton()) return;

        const { customId, user } = interaction;

        try {
            // 'analyze_' is the current button; 'story_' is kept so older posted
            // messages keep working — both now run fact-grounded whole-match analysis.
            if (customId.startsWith('analyze_') || customId.startsWith('story_')) {
                const matchId = parseInt(customId.replace(/^(analyze|story)_/, ''), 10);
                const lockKey = `match:${matchId}`;
                if (activeAnalysisButtons.has(lockKey)) {
                    return interaction.reply({
                        content: `Analysis for match #${matchId} is already running. I’ll post it here when it finishes.`,
                        ephemeral: true,
                    });
                }
                activeAnalysisButtons.add(lockKey);
                try {
                    await interaction.reply({ content: `🔍 Analyzing match #${matchId}...`, ephemeral: false });
                    await analyze(asMessageAdapter(interaction), [String(matchId)], userDataService);
                } finally {
                    activeAnalysisButtons.delete(lockKey);
                }

            } else if (customId.startsWith('details_')) {
                const matchId = parseInt(customId.replace('details_', ''), 10);
                await interaction.deferReply();

                const response = await opendotaClient.get(`/matches/${matchId}`);
                const match = response.data;

                if (!match) {
                    return interaction.followUp({ content: 'Could not fetch match details.', ephemeral: true });
                }

                const clicker = userDataService.getUserByDiscordId(interaction.user.id);
                const focusSteamId = clicker ? String(clicker.steamId) : undefined;
                const rankDisplay = await resolveMatchRankDisplay(match);

                const toScoreboardPlayer = async (p: any): Promise<ScoreboardPlayer> => {
                    const hero = await dotaDataService.getHeroName(p.hero_id);
                    const itemImageUrls = ['item_0', 'item_1', 'item_2', 'item_3', 'item_4', 'item_5']
                        .map((slot) => dotaDataService.getItemImageUrl(Number(p[slot] || 0)));
                    const rank = rankDisplay?.playersBySteamId.get(String(p.account_id || ''));
                    return {
                        heroName: hero,
                        heroImageUrl: APIConstants.IMAGE_URL(hero),
                        personaName: p.personaname || 'Anonymous',
                        rankLabel: rank?.label,
                        rankTier: rank?.rankTier,
                        level: Number(p.level || 0),
                        kills: p.kills ?? 0,
                        deaths: p.deaths ?? 0,
                        assists: p.assists ?? 0,
                        gpm: p.gold_per_min ?? 0,
                        lastHits: p.last_hits ?? 0,
                        netWorth: Number(p.net_worth ?? p.total_gold ?? 0),
                        itemImageUrls,
                        isFocus: !!focusSteamId && String(p.account_id) === focusSteamId,
                    };
                };

                const radiantPlayers = match.players.filter((p: any) => p.player_slot < 128);
                const direPlayers = match.players.filter((p: any) => p.player_slot >= 128);
                const modeName = GAME_MODE_NAMES[Number(match.game_mode)] || `Mode ${match.game_mode ?? '?'}`;

                const radiantTeam: ScoreboardTeam = {
                    name: 'Radiant', won: !!match.radiant_win, score: match.radiant_score ?? 0,
                    players: await Promise.all(radiantPlayers.map(toScoreboardPlayer)),
                };
                const direTeam: ScoreboardTeam = {
                    name: 'Dire', won: !match.radiant_win, score: match.dire_score ?? 0,
                    players: await Promise.all(direPlayers.map(toScoreboardPlayer)),
                };

                const files: AttachmentBuilder[] = [];
                const embeds: EmbedBuilder[] = [];

                // Visual scoreboard: hero icons, name+level, K/D/A, GPM, net worth, items.
                try {
                    const scoreboard = await renderMatchScoreboard(radiantTeam, direTeam, {
                        matchId,
                        durationSec: match.duration,
                        mode: modeName,
                        lobbyRankLabel: rankDisplay?.lobbyRankLabel,
                        visibleRankCount: rankDisplay?.visibleRankCount,
                    });
                    files.push(new AttachmentBuilder(scoreboard, { name: 'scoreboard.png' }));
                    embeds.push(new EmbedBuilder()
                        .setColor(match.radiant_win ? '#66bb6a' : '#ef5350')
                        .setTitle(`Match #${matchId} — ${match.radiant_win ? 'Radiant Victory' : 'Dire Victory'}`)
                        .setURL(`https://www.opendota.com/matches/${matchId}`)
                        .setImage('attachment://scoreboard.png')
                        .setTimestamp(new Date(match.start_time * 1000)));
                } catch (boardError) {
                    logger.error(`Failed to render scoreboard for match ${matchId}:`, boardError);
                    // Fall back to a text scoreboard so Details still works if rendering fails.
                    const line = (p: ScoreboardPlayer) => {
                        const rank = p.rankLabel ? ` | ${p.rankLabel}` : '';
                        return `**${p.personaName}** (${p.heroName}): ${p.kills}/${p.deaths}/${p.assists} | ${p.gpm} GPM${rank}`;
                    };
                    embeds.push(new EmbedBuilder()
                        .setColor(match.radiant_win ? '#66bb6a' : '#ef5350')
                        .setTitle(`Match #${matchId} — ${match.radiant_win ? 'Radiant Victory' : 'Dire Victory'}`)
                        .addFields(
                            { name: `🟢 Radiant ${match.radiant_win ? '👑' : ''}`.trim(), value: radiantTeam.players.map(line).join('\n') || 'N/A', inline: false },
                            { name: `🔴 Dire ${!match.radiant_win ? '👑' : ''}`.trim(), value: direTeam.players.map(line).join('\n') || 'N/A', inline: false },
                            { name: 'Score', value: `${match.radiant_score ?? '?'}–${match.dire_score ?? '?'}`, inline: true },
                            { name: 'Duration', value: formatDuration(match.duration), inline: true },
                            { name: 'Mode', value: modeName, inline: true },
                        )
                        .setURL(`https://www.opendota.com/matches/${matchId}`));
                }

                // Gold/XP advantage graph as a second embed when timeline data exists.
                const goldAdv: number[] = match.radiant_gold_adv || [];
                const xpAdv: number[] = match.radiant_xp_adv || [];
                if (goldAdv.length >= 2) {
                    try {
                        const buffer = renderMatchAdvantageGraph(goldAdv, xpAdv, {
                            title: `Gold & XP Advantage — Match ${matchId}`,
                            radiantWin: !!match.radiant_win,
                        });
                        files.push(new AttachmentBuilder(buffer, { name: 'advantage.png' }));
                        embeds.push(new EmbedBuilder()
                            .setColor(match.radiant_win ? '#10b981' : '#ef4444')
                            .setImage('attachment://advantage.png')
                            .setFooter({ text: 'Green = Radiant ahead • Red = Dire ahead • dashed = XP' }));
                    } catch (graphError) {
                        logger.error(`Failed to render advantage graph for match ${matchId}:`, graphError);
                    }
                } else {
                    embeds[embeds.length - 1].setFooter({ text: 'No timeline yet — parse this match on OpenDota for the advantage graph.' });
                }

                await interaction.followUp({ embeds, files });

            } else if (customId.startsWith('pickmatch_')) {
                const matchId = parseInt(customId.replace('pickmatch_', ''), 10);
                // Ephemeral so the chooser detail stays private to the clicker and
                // doesn't clutter the channel; the Analyze buttons post publicly.
                await interaction.deferReply({ ephemeral: true });

                const { data: match } = await opendotaClient.get<any>(`/matches/${matchId}`);
                if (!match || !match.match_id) {
                    return interaction.followUp({ content: 'Could not fetch that match.', ephemeral: true });
                }

                const clicker = userDataService.getUserByDiscordId(interaction.user.id);
                const mine = clicker && match.players?.find((p: any) => String(p.account_id) === String(clicker.steamId));
                const lines: string[] = [
                    `**${match.radiant_win ? '🟢 Radiant Victory' : '🔴 Dire Victory'}** — ${match.radiant_score ?? '?'}–${match.dire_score ?? '?'} in ${formatDuration(match.duration)}`,
                ];
                if (mine) {
                    const hero = await dotaDataService.getHeroName(mine.hero_id);
                    lines.push(`You (**${hero}**): ${mine.kills}/${mine.deaths}/${mine.assists} • ${mine.gold_per_min} GPM`);
                }

                const embed = new EmbedBuilder()
                    .setColor(match.radiant_win ? '#66bb6a' : '#ef5350')
                    .setTitle(`Match #${matchId}`)
                    .setDescription(lines.join('\n'))
                    .setURL(`https://www.opendota.com/matches/${matchId}`);

                await interaction.followUp({
                    embeds: [embed],
                    components: [createMatchDetailRow(matchId, { showAnalyzeMe: !!clicker })],
                    ephemeral: true,
                });

            } else if (customId.startsWith('analyzeme_')) {
                const matchId = parseInt(customId.replace('analyzeme_', ''), 10);
                const clicker = userDataService.getUserByDiscordId(interaction.user.id);
                if (!clicker) {
                    return interaction.reply({ content: 'Register first with `+register <steam_id>` to analyze your own performance.', ephemeral: true });
                }
                const lockKey = `player:${matchId}:${clicker.steamId}`;
                if (activeAnalysisButtons.has(lockKey)) {
                    return interaction.reply({
                        content: `Your focused analysis for match #${matchId} is already running. I’ll post it here when it finishes.`,
                        ephemeral: true,
                    });
                }
                activeAnalysisButtons.add(lockKey);
                try {
                    await interaction.reply({ content: `🎓 Analyzing your game in match #${matchId}...`, ephemeral: false });
                    await analyze(asMessageAdapter(interaction), [String(matchId), clicker.steamId], userDataService);
                } finally {
                    activeAnalysisButtons.delete(lockKey);
                }

            } else if (customId.startsWith('coachme_')) {
                const [, matchIdRaw, steamId] = customId.split('_');
                const matchId = parseInt(matchIdRaw, 10);
                if (!matchId || !steamId) {
                    return interaction.reply({ content: 'Invalid coach request.', ephemeral: true });
                }
                const lockKey = `player:${matchId}:${steamId}`;
                if (activeAnalysisButtons.has(lockKey)) {
                    return interaction.reply({
                        content: `Focused coaching for match #${matchId} is already running. I’ll post it here when it finishes.`,
                        ephemeral: true,
                    });
                }
                activeAnalysisButtons.add(lockKey);
                try {
                    await interaction.reply({ content: `🎓 Running focused coaching for match #${matchId}...`, ephemeral: false });
                    await analyze(asMessageAdapter(interaction), [String(matchId), steamId]);
                } finally {
                    activeAnalysisButtons.delete(lockKey);
                }

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
