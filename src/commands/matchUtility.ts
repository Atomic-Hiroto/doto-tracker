import { AttachmentBuilder, EmbedBuilder, Message } from 'discord.js';
import { APIConstants, Replies } from '../constants';
import { opendotaClient } from '../services/apiClient';
import { dotaDataService } from '../services/dotaDataService';
import { UserDataService } from '../services/userDataService';
import { logger } from '../services/loggerService';
import { renderInventoryImage, renderRoleDistribution, renderSkillBuildGrid } from '../services/chartService';
import { parseArgs } from '../utils/argParser';
import { formatDuration } from '../utils/formatters';
import { safeTyping } from '../utils/channelHelpers';
import { applyResidualFilters, parseMatchFilter, queryString } from '../utils/matchFilter';
import { referenceService } from '../services/referenceService';

const ROLE_LABELS: Record<number, string> = {
    0: 'Unknown',
    1: 'Safe',
    2: 'Mid',
    3: 'Off',
    4: 'Jungle',
};

function playerWon(match: any, player: any): boolean {
    const isRadiant = Number(player.player_slot) < 128;
    return (isRadiant && !!match.radiant_win) || (!isRadiant && !match.radiant_win);
}

async function resolvePlayer(match: any, query: string | undefined): Promise<any | null> {
    const players = Array.isArray(match.players) ? match.players : [];
    if (!query) return null;
    const q = query.toLowerCase().trim();
    const hero = dotaDataService.findHeroByName(q);
    return players.find((p: any) => String(p.account_id || '') === q)
        || players.find((p: any) => String(p.personaname || '').toLowerCase().includes(q))
        || (hero ? players.find((p: any) => Number(p.hero_id) === hero.id) : null)
        || null;
}

function itemSlots(player: any): number[] {
    return ['item_0', 'item_1', 'item_2', 'item_3', 'item_4', 'item_5']
        .map((slot) => Number(player?.[slot] || 0))
        .filter((id) => id > 0);
}

async function itemNames(ids: number[]): Promise<string[]> {
    return Promise.all(ids.map((id) => dotaDataService.getItemName(id)));
}

export async function skillbuild(message: Message, args: string[]) {
    const matchId = Number(args.find((arg) => /^\d{6,}$/.test(arg)));
    if (!matchId) return message.reply('Usage: `+skillbuild <match_id> <player|hero>`');
    const playerQuery = args.filter((arg) => !/^\d{6,}$/.test(arg)).join(' ').trim();
    if (!playerQuery) return message.reply('Usage: `+skillbuild <match_id> <player|hero>`');

    try {
        safeTyping(message.channel);
        const { data: match } = await opendotaClient.get<any>(`/matches/${matchId}`);
        const player = await resolvePlayer(match, playerQuery);
        if (!player) return message.reply(`Could not find player/hero **${playerQuery}** in match **${matchId}**.`);
        const hero = await dotaDataService.getHeroName(player.hero_id);
        const raw = Array.isArray(player.ability_upgrades_arr) && player.ability_upgrades_arr.length
            ? player.ability_upgrades_arr.map((abilityId: number, index: number) => ({ ability: abilityId, level: index + 1 }))
            : Array.isArray(player.ability_upgrades)
                ? player.ability_upgrades.map((entry: any, index: number) => ({ ability: entry.ability || entry.ability_id || entry, time: entry.time, level: index + 1 }))
                : [];
        const upgrades = await Promise.all(raw.map(async (entry: any) => ({
            time: Number(entry.time),
            level: Number(entry.level),
            abilityName: await dotaDataService.getAbilityName(Number(entry.ability)),
        })));
        const image = renderSkillBuildGrid(upgrades, {
            title: `${player.personaname || 'Player'} — ${hero}`,
            subtitle: `Match #${matchId} • ${match.radiant_win ? 'Radiant' : 'Dire'} won in ${formatDuration(match.duration)}`,
        });
        const attachment = new AttachmentBuilder(image, { name: 'skillbuild.png' });
        const embed = new EmbedBuilder()
            .setColor(playerWon(match, player) ? '#10b981' : '#ef4444')
            .setTitle(`🧬 Skill Build — ${hero}`)
            .setURL(`https://www.opendota.com/matches/${matchId}`)
            .setImage('attachment://skillbuild.png')
            .setTimestamp();
        await message.reply({ embeds: [embed], files: [attachment] });
    } catch (error) {
        logger.error('Error in skillbuild command:', error);
        await message.reply('Could not render skill build. The match may be unparsed or OpenDota may be unavailable.');
    }
}

export async function matchInventory(message: Message, args: string[], userDataService: UserDataService) {
    const parsed = parseArgs(args, message);
    try {
        safeTyping(message.channel);
        const explicitMatchId = parsed.positional.find((arg) => /^\d{6,}$/.test(arg));
        if (explicitMatchId) {
            const { data: match } = await opendotaClient.get<any>(`/matches/${explicitMatchId}`);
            const rows = await Promise.all((match.players || []).map(async (player: any) => ({
                label: `${player.personaname || 'Unknown'} — ${await dotaDataService.getHeroName(player.hero_id)}`,
                items: await itemNames(itemSlots(player)),
            })));
            const image = renderInventoryImage(rows, {
                title: `End Inventories — Match ${explicitMatchId}`,
                subtitle: `${match.radiant_win ? 'Radiant' : 'Dire'} victory • ${formatDuration(match.duration)}`,
            });
            const attachment = new AttachmentBuilder(image, { name: 'inventory.png' });
            return message.reply({
                embeds: [new EmbedBuilder().setColor('#7c3aed').setTitle(`🎒 Match Inventory — #${explicitMatchId}`).setImage('attachment://inventory.png').setURL(`https://www.opendota.com/matches/${explicitMatchId}`)],
                files: [attachment],
            });
        }

        let discordId = message.author.id;
        let targetUser = message.author;
        if (parsed.mentions.length > 0) {
            discordId = parsed.mentions[0];
            targetUser = message.mentions.users.first()!;
        }
        const user = userDataService.getUserByDiscordId(discordId);
        if (!user) return message.reply(Replies.notRegistered(message.author.id, discordId, targetUser.username));
        const filter = await parseMatchFilter(parsed.positional, message, userDataService);
        const recent = await opendotaClient.get<any[]>(`/players/${user.steamId}/matches${queryString({ ...filter.openDotaParams, limit: 30, significant: 0 })}`);
        const matches = applyResidualFilters(recent.data || [], filter).slice(0, 12);
        const detailed = await Promise.all(matches.map((m) => opendotaClient.get<any>(`/matches/${m.match_id}`).then((res) => res.data).catch(() => null)));
        const counts = new Map<string, number>();
        for (const match of detailed.filter(Boolean)) {
            const player = (match.players || []).find((p: any) => String(p.account_id || '') === String(user.steamId));
            if (!player) continue;
            for (const name of await itemNames(itemSlots(player))) counts.set(name, (counts.get(name) || 0) + 1);
        }
        const rows = [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 14)
            .map(([label, count]) => ({ label, count, items: [`Appeared in ${count}/${matches.length} sampled matches`] }));
        const image = renderInventoryImage(rows, {
            title: `Common End Items — ${targetUser.username}`,
            subtitle: `${matches.length} matches${filter.descriptionParts.length ? ` • ${filter.descriptionParts.join(' • ')}` : ''}`,
        });
        const attachment = new AttachmentBuilder(image, { name: 'inventory.png' });
        return message.reply({ embeds: [new EmbedBuilder().setColor('#7c3aed').setTitle('🎒 Inventory Slice').setImage('attachment://inventory.png')], files: [attachment] });
    } catch (error) {
        logger.error('Error in inventory command:', error);
        await message.reply('Could not build inventory slice. Try a narrower filter or a parsed match.');
    }
}

export async function roles(message: Message, args: string[], userDataService: UserDataService) {
    const parsed = parseArgs(args, message);
    let discordId = message.author.id;
    let targetUser = message.author;
    if (parsed.mentions.length > 0) {
        discordId = parsed.mentions[0];
        targetUser = message.mentions.users.first()!;
    }
    const user = userDataService.getUserByDiscordId(discordId);
    if (!user) return message.reply(Replies.notRegistered(message.author.id, discordId, targetUser.username));
    try {
        safeTyping(message.channel);
        const filter = await parseMatchFilter(parsed.positional, message, userDataService);
        const recent = await opendotaClient.get<any[]>(`/players/${user.steamId}/matches${queryString({ ...filter.openDotaParams, limit: 40, significant: 0 })}`);
        const matches = applyResidualFilters(recent.data || [], filter).slice(0, 20);
        const detailed = await Promise.all(matches.map((m) => opendotaClient.get<any>(`/matches/${m.match_id}`).then((res) => res.data).catch(() => null)));
        const counts = new Map<string, number>();
        for (const match of detailed.filter(Boolean)) {
            const player = (match.players || []).find((p: any) => String(p.account_id || '') === String(user.steamId));
            if (!player) continue;
            const label = ROLE_LABELS[Number(player.lane_role ?? 0)] || 'Unknown';
            counts.set(label, (counts.get(label) || 0) + 1);
        }
        const colors = ['#10b981', '#60a5fa', '#f59e0b', '#ef4444', '#a78bfa'];
        const rows = [...counts.entries()].map(([label, value], index) => ({ label, value, color: colors[index % colors.length] }));
        const image = renderRoleDistribution(rows, {
            title: `Role Distribution — ${targetUser.username}`,
            subtitle: `${matches.length} parsed/recent matches${filter.descriptionParts.length ? ` • ${filter.descriptionParts.join(' • ')}` : ''}`,
        });
        const attachment = new AttachmentBuilder(image, { name: 'roles.png' });
        await message.reply({ embeds: [new EmbedBuilder().setColor('#7c3aed').setTitle('🧭 Role Distribution').setImage('attachment://roles.png')], files: [attachment] });
    } catch (error) {
        logger.error('Error in roles command:', error);
        await message.reply('Could not build role distribution. Try again later.');
    }
}

export async function percent(message: Message, args: string[], userDataService: UserDataService) {
    const parsed = parseArgs(args, message);
    let discordId = message.author.id;
    let targetUser = message.author;
    if (parsed.mentions.length > 0) {
        discordId = parsed.mentions[0];
        targetUser = message.mentions.users.first()!;
    }
    const user = userDataService.getUserByDiscordId(discordId);
    if (!user) return message.reply(Replies.notRegistered(message.author.id, discordId, targetUser.username));
    const words = parsed.positional.filter((word) => word.toLowerCase() !== 'of');
    const withIndex = words.findIndex((word) => word.toLowerCase() === 'with');
    const itemQuery = withIndex >= 0 ? words.slice(withIndex + 1).join(' ') : '';
    const filterWords = withIndex >= 0 ? words.slice(0, withIndex) : words;
    if (!itemQuery) return message.reply('Usage: `+% [filters] with <item>` — example: `+% turbo wins as PA with BKB`');
    try {
        safeTyping(message.channel);
        const found = await referenceService.findItem(itemQuery);
        if (!found?.item.id) return message.reply(`Could not find item **${itemQuery}**.`);
        const filter = await parseMatchFilter(filterWords, message, userDataService);
        const recent = await opendotaClient.get<any[]>(`/players/${user.steamId}/matches${queryString({ ...filter.openDotaParams, limit: 60, significant: 0 })}`);
        const matches = applyResidualFilters(recent.data || [], filter).slice(0, 25);
        const detailed = await Promise.all(matches.map((m) => opendotaClient.get<any>(`/matches/${m.match_id}`).then((res) => res.data).catch(() => null)));
        let total = 0;
        let hits = 0;
        let wins = 0;
        for (const match of detailed.filter(Boolean)) {
            const player = (match.players || []).find((p: any) => String(p.account_id || '') === String(user.steamId));
            if (!player) continue;
            total++;
            const hasItem = itemSlots(player).includes(found.item.id);
            if (hasItem) hits++;
            if (hasItem && playerWon(match, player)) wins++;
        }
        if (!total) return message.reply('No parsed matches found for that query.');
        const pct = Math.round((hits / total) * 100);
        const embed = new EmbedBuilder()
            .setColor('#7c3aed')
            .setTitle(`📐 Percent Query — ${targetUser.username}`)
            .setDescription(`**${found.item.dname || found.key}** appeared in **${hits}/${total}** sampled matches (**${pct}%**).`)
            .addFields(
                { name: 'Filter', value: filter.descriptionParts.join(' • ') || 'recent matches', inline: false },
                { name: 'Wins with item', value: `${wins}/${hits || 1}`, inline: true },
            )
            .setTimestamp();
        await message.reply({ embeds: [embed] });
    } catch (error) {
        logger.error('Error in percent command:', error);
        await message.reply('Could not answer that percent query. Try a narrower filter.');
    }
}
