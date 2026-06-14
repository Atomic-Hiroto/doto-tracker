import { Message, EmbedBuilder } from 'discord.js';
import { referenceService, ItemConstant, AbilityConstant, HeroConstant } from '../services/referenceService';
import { logger } from '../services/loggerService';
import { safeTyping } from '../utils/channelHelpers';

const EMBED_COLOR = '#6366f1';
const OD_IMG_BASE = 'https://cdn.cloudflare.steamstatic.com';

const ATTR_LABEL: Record<string, string> = {
    str: 'Strength', agi: 'Agility', int: 'Intelligence', all: 'Universal',
};

function clean(text?: string): string {
    if (!text) return '';
    // Strip simple html-ish tags and tidy whitespace OpenDota descriptions carry.
    return text.replace(/<[^>]+>/g, '').replace(/\\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function truncate(text: string, max: number): string {
    return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

function joinList(v?: string | string[]): string {
    if (!v) return '';
    return Array.isArray(v) ? v.join(', ') : v;
}

// --- +item ----------------------------------------------------------------

export async function item(message: Message, args: string[]) {
    const query = args.join(' ').trim();
    if (!query) return message.reply('Usage: `+item <name>` — e.g. `+item black king bar`');

    try {
        safeTyping(message.channel);
        const hit = await referenceService.findItem(query);
        if (!hit) return message.reply(`No item found matching **${query}**.`);
        const it: ItemConstant = hit.item;

        const embed = new EmbedBuilder()
            .setColor(qualityColor(it.qual))
            .setTitle(`🛒 ${it.dname || hit.key}`);

        if (it.img) embed.setThumbnail(OD_IMG_BASE + it.img.split('?')[0]);

        const meta: string[] = [];
        if (typeof it.cost === 'number' && it.cost > 0) meta.push(`💰 **${it.cost}** gold`);
        if (it.qual) meta.push(`✨ ${it.qual}`);
        const mc = firstNum(it.mc);
        const cd = firstNum(it.cd);
        if (mc) meta.push(`🔵 ${mc} mana`);
        if (cd) meta.push(`⏱️ ${cd}s CD`);
        if (meta.length) embed.setDescription(meta.join('  •  '));

        // Stat bonuses
        const stats = (it.attrib || [])
            .filter((a) => a.display && !/^max_level$/i.test(a.key))
            .map((a) => clean((a.display || '').replace('{value}', String(Array.isArray(a.value) ? a.value.join('/') : a.value))))
            .filter(Boolean);
        if (stats.length) {
            embed.addFields({ name: 'Bonuses', value: truncate(stats.join('\n'), 1024), inline: false });
        }

        // Active/passive abilities
        for (const ab of (it.abilities || []).slice(0, 3)) {
            const title = `${ab.type ? `[${ab.type}] ` : ''}${ab.title || 'Ability'}`;
            const desc = clean(ab.description);
            if (desc) embed.addFields({ name: truncate(title, 256), value: truncate(desc, 1024), inline: false });
        }

        // Recipe components
        if (it.components && it.components.length) {
            const parts = it.components.map((c) => {
                const comp = referenceService.getItemByName(c);
                return comp?.dname || c;
            });
            embed.addFields({ name: 'Builds from', value: parts.join(' + '), inline: false });
        }

        if (it.notes) embed.addFields({ name: 'Notes', value: truncate(clean(it.notes), 1024), inline: false });
        if (it.lore) embed.setFooter({ text: truncate(clean(it.lore), 200) });

        await message.reply({ embeds: [embed] });
    } catch (error) {
        logger.error('Error in item command:', error);
        await message.reply('An error occurred while fetching item info. Please try again later.');
    }
}

// --- +ability -------------------------------------------------------------

export async function ability(message: Message, args: string[]) {
    const query = args.join(' ').trim();
    if (!query) return message.reply('Usage: `+ability <name>` — e.g. `+ability black hole`');

    try {
        safeTyping(message.channel);
        const hit = await referenceService.findAbility(query);
        if (!hit) return message.reply(`No ability found matching **${query}**.`);
        const ab: AbilityConstant = hit.ability;

        const embed = new EmbedBuilder()
            .setColor(EMBED_COLOR)
            .setTitle(`✨ ${ab.dname || hit.key}`);

        if (ab.desc) embed.setDescription(truncate(clean(ab.desc), 2048));

        const meta: string[] = [];
        if (ab.behavior) meta.push(`🎯 ${truncate(joinList(ab.behavior), 80)}`);
        if (ab.dmg_type) meta.push(`💥 ${ab.dmg_type}`);
        if (ab.bkbpierce) meta.push(`🛡️ Pierces BKB: ${ab.bkbpierce}`);
        const mc = joinList(ab.mc as any);
        const cd = joinList(ab.cd as any);
        if (mc) meta.push(`🔵 Mana: ${mc}`);
        if (cd) meta.push(`⏱️ CD: ${cd}`);
        if (meta.length) embed.addFields({ name: 'Details', value: truncate(meta.join('\n'), 1024), inline: false });

        const attribs = (ab.attrib || [])
            .map((a) => {
                const label = a.header || a.key || '';
                const val = Array.isArray(a.value) ? a.value.join(' / ') : a.value;
                return label && val ? `${clean(label)} ${val}` : '';
            })
            .filter(Boolean);
        if (attribs.length) embed.addFields({ name: 'Values', value: truncate(attribs.join('\n'), 1024), inline: false });

        if (ab.lore) embed.setFooter({ text: truncate(clean(ab.lore), 200) });

        await message.reply({ embeds: [embed] });
    } catch (error) {
        logger.error('Error in ability command:', error);
        await message.reply('An error occurred while fetching ability info. Please try again later.');
    }
}

// --- +hero ----------------------------------------------------------------

export async function hero(message: Message, args: string[]) {
    const query = args.join(' ').trim();
    if (!query) return message.reply('Usage: `+hero <name>` — e.g. `+hero invoker`');

    try {
        safeTyping(message.channel);
        const h = await referenceService.findHero(query);
        if (!h) return message.reply(`No hero found matching **${query}**.`);

        const embed = new EmbedBuilder()
            .setColor(EMBED_COLOR)
            .setTitle(`🦸 ${h.localized_name}`);

        const header: string[] = [];
        if (h.primary_attr) header.push(`**${ATTR_LABEL[h.primary_attr] || h.primary_attr}**`);
        if (h.attack_type) header.push(h.attack_type);
        if (h.roles && h.roles.length) header.push(h.roles.join(', '));
        if (header.length) embed.setDescription(header.join(' • '));

        // Base stats
        const stats: string[] = [];
        if (h.base_str !== undefined) stats.push(`🔴 STR ${h.base_str} +${h.str_gain ?? 0}`);
        if (h.base_agi !== undefined) stats.push(`🟢 AGI ${h.base_agi} +${h.agi_gain ?? 0}`);
        if (h.base_int !== undefined) stats.push(`🔵 INT ${h.base_int} +${h.int_gain ?? 0}`);
        if (stats.length) embed.addFields({ name: 'Attributes', value: stats.join('\n'), inline: true });

        const combat: string[] = [];
        if (h.base_attack_min !== undefined) combat.push(`⚔️ Dmg ${h.base_attack_min}-${h.base_attack_max}`);
        if (h.move_speed !== undefined) combat.push(`👟 MS ${h.move_speed}`);
        if (h.base_armor !== undefined) combat.push(`🛡️ Armor ${h.base_armor}`);
        if (h.attack_range !== undefined) combat.push(`🎯 Range ${h.attack_range}`);
        if (combat.length) embed.addFields({ name: 'Combat', value: combat.join('\n'), inline: true });

        // Abilities (skip generic/hidden/talent entries)
        const kit = referenceService.getHeroAbilities(h.name);
        if (kit) {
            const abilityNames = kit.abilities
                .filter((a) => a && !a.includes('empty') && !a.includes('generic'))
                .map((a) => referenceService.getAbilityByName(a)?.dname || a)
                .filter(Boolean);
            if (abilityNames.length) {
                embed.addFields({ name: 'Abilities', value: abilityNames.join(' • '), inline: false });
            }
        }

        // Aghs summary
        const aghs = referenceService.getAghs(h.id);
        if (aghs) {
            if (aghs.has_scepter && aghs.scepter_desc) {
                embed.addFields({ name: `🔱 Scepter — ${aghs.scepter_skill_name || ''}`.trim(), value: truncate(clean(aghs.scepter_desc), 1024), inline: false });
            }
            if (aghs.has_shard && aghs.shard_desc) {
                embed.addFields({ name: `💠 Shard — ${aghs.shard_skill_name || ''}`.trim(), value: truncate(clean(aghs.shard_desc), 1024), inline: false });
            }
        }

        embed.setFooter({ text: 'Tip: +talents, +aghs <hero> • +ability <name> for full ability text' });
        await message.reply({ embeds: [embed] });
    } catch (error) {
        logger.error('Error in hero command:', error);
        await message.reply('An error occurred while fetching hero info. Please try again later.');
    }
}

// --- +aghs ----------------------------------------------------------------

export async function aghs(message: Message, args: string[]) {
    const query = args.join(' ').trim();
    if (!query) return message.reply('Usage: `+aghs <hero>` — e.g. `+aghs zeus`');

    try {
        safeTyping(message.channel);
        const h = await referenceService.findHero(query);
        if (!h) return message.reply(`No hero found matching **${query}**.`);
        const a = referenceService.getAghs(h.id);
        if (!a || (!a.has_scepter && !a.has_shard)) {
            return message.reply(`**${h.localized_name}** has no Aghanim's upgrades on record.`);
        }

        const embed = new EmbedBuilder()
            .setColor(EMBED_COLOR)
            .setTitle(`🔱 ${h.localized_name} — Aghanim's Upgrades`);

        if (a.has_scepter && a.scepter_desc) {
            const tag = a.scepter_new_skill ? ' (new ability)' : '';
            embed.addFields({ name: `Scepter — ${a.scepter_skill_name || ''}${tag}`.trim(), value: truncate(clean(a.scepter_desc), 1024), inline: false });
        }
        if (a.has_shard && a.shard_desc) {
            const tag = a.shard_new_skill ? ' (new ability)' : '';
            embed.addFields({ name: `Shard — ${a.shard_skill_name || ''}${tag}`.trim(), value: truncate(clean(a.shard_desc), 1024), inline: false });
        }

        await message.reply({ embeds: [embed] });
    } catch (error) {
        logger.error('Error in aghs command:', error);
        await message.reply('An error occurred while fetching Aghanim info. Please try again later.');
    }
}

// --- +talents -------------------------------------------------------------

export async function talents(message: Message, args: string[]) {
    const query = args.join(' ').trim();
    if (!query) return message.reply('Usage: `+talents <hero>` — e.g. `+talents juggernaut`');

    try {
        safeTyping(message.channel);
        const h = await referenceService.findHero(query);
        if (!h) return message.reply(`No hero found matching **${query}**.`);
        const kit = referenceService.getHeroAbilities(h.name);
        if (!kit || !kit.talents || !kit.talents.length) {
            return message.reply(`No talent data found for **${h.localized_name}**.`);
        }

        // Talents come as 8 entries (4 levels, left/right). Pair them by level.
        const byLevel = new Map<number, string[]>();
        for (const t of kit.talents) {
            const name = referenceService.getAbilityByName(t.name)?.dname || t.name.replace(/^special_bonus_/, '').replace(/_/g, ' ');
            if (!byLevel.has(t.level)) byLevel.set(t.level, []);
            byLevel.get(t.level)!.push(clean(name));
        }

        const embed = new EmbedBuilder()
            .setColor(EMBED_COLOR)
            .setTitle(`🌟 ${h.localized_name} — Talents`);

        for (const level of [...byLevel.keys()].sort((a, b) => b - a)) {
            const opts = byLevel.get(level)!;
            const value = opts.length === 2 ? `${opts[0]}\n— or —\n${opts[1]}` : opts.join('\n');
            embed.addFields({ name: `Level ${level}`, value: truncate(value, 1024), inline: true });
        }

        await message.reply({ embeds: [embed] });
    } catch (error) {
        logger.error('Error in talents command:', error);
        await message.reply('An error occurred while fetching talent info. Please try again later.');
    }
}

// --- helpers --------------------------------------------------------------

function firstNum(v?: number | number[] | false): number | null {
    if (v === false || v === undefined || v === null) return null;
    if (Array.isArray(v)) return v[0] ?? null;
    return typeof v === 'number' && v > 0 ? v : null;
}

function qualityColor(qual?: string): `#${string}` {
    switch (qual) {
        case 'component': return '#9aa0a6';
        case 'common': return '#5bc0de';
        case 'rare': return '#3b82f6';
        case 'epic': return '#a855f7';
        case 'artifact': return '#f59e0b';
        case 'consumable': return '#22c55e';
        case 'secret_shop': return '#ec4899';
        default: return EMBED_COLOR;
    }
}
