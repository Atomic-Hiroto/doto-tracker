import { Message, EmbedBuilder } from 'discord.js';
import { UserDataService } from '../services/userDataService';
import { TurboStatsService } from '../services/turboStatsService';
import { logger } from '../services/loggerService';
import { opendotaClient } from '../services/apiClient';
import { dotaDataService } from '../services/dotaDataService';
import { turboRankService, rankTierToMedal, tierToEmoji, MMR_PER_STAR } from '../services/turboRankService';
import { TurboRankEstimate } from '../models/TurboRank';
import { safeTyping } from '../utils/channelHelpers';
import { pullRatingsById, turboSummary } from './turboSummary';
import { winRateText } from './turboPairings';

interface Target {
    discordId?: string;
    steamId: string;
    name: string;
}

interface Side {
    discordId?: string;
    name: string;
    rankTier?: number;
    winRate: number;
    games: number;
    heroes: any[];
    turbo: ReturnType<typeof turboSummary>;
}

/**
 * Who reads higher on the hidden Turbo rank, and whether the gap clears both estimates' error.
 * That rank is the one ladder both players share; all-mode win rates sit in each player's own
 * bracket, so they are never used to pick a winner.
 */
function verdict(a: Side, b: Side): string {
    const ea: TurboRankEstimate | null = a.turbo.estimate;
    const eb: TurboRankEstimate | null = b.turbo.estimate;
    if (!ea || !eb) {
        const missing = [!ea ? a.name : null, !eb ? b.name : null].filter(Boolean).join(' and ');
        return `No call yet: **${missing}** needs a hidden Turbo rank first (\`+turborank calibrate\`). `
            + 'All-mode win rates sit in different brackets, so they can\'t settle it.';
    }
    const gap = ea.estimatedMMR - eb.estimatedMMR;
    const higher = gap >= 0 ? a : b;
    const lower = gap >= 0 ? b : a;
    const error = Math.round(Math.sqrt((ea.precisionSD ?? 0) ** 2 + (eb.precisionSD ?? 0) ** 2));
    const stars = Math.round(Math.abs(gap) / MMR_PER_STAR);
    if (Math.abs(gap) <= error) {
        return `**Too close to call.** ${higher.name} reads ~${Math.abs(gap)} MMR higher on hidden Turbo rank, `
            + `inside the combined ±${error} error.`;
    }
    return `**${higher.name}** reads higher on hidden Turbo rank: ~${Math.abs(gap)} MMR${stars ? ` (about ${stars}★)` : ''} `
        + `above ${lower.name}, beyond the combined ±${error} error.`;
}

/** "a vs b", or two tokens; a lone player is compared against whoever asked. */
function splitVsArgs(args: string[]): [string, string] | [string] | null {
    const raw = args.join(' ').trim();
    const vs = raw.match(/^(.+?)\s+(?:vs|v|versus)\s+(.+)$/i);
    if (vs) return [vs[1].trim(), vs[2].trim()];
    if (args.length >= 2) return [args[0], args.slice(1).join(' ')];
    return args.length === 1 ? [args[0]] : null;
}

/** A @mention, a Steam id, or a name the hidden-rank tracker knows. Unregistered players still compare by Steam id. */
async function resolveTarget(message: Message, query: string, userDataService: UserDataService): Promise<Target | null> {
    const mention = query.match(/^<@!?(\d+)>$/);
    if (mention) {
        const registered = userDataService.getUserByDiscordId(mention[1]);
        if (!registered) return null;
        const user = await message.client.users.fetch(mention[1]).catch(() => null);
        return { discordId: mention[1], steamId: registered.steamId, name: user?.username ?? 'player' };
    }
    const player = /^\d{4,}$/.test(query) ? turboRankService.getPlayerBySteamId(query) : turboRankService.getPlayerByName(query);
    const steamId = player?.steamId ?? (/^\d{4,}$/.test(query) ? query : undefined);
    if (!steamId) return null;
    const discordId = player?.discordId || userDataService.getUserBySteamId(steamId)?.discordId;
    return { discordId, steamId, name: player?.steamName ?? query };
}

/** `+compare @a @b` (also `+turbovs`, names, or `a vs b`) — a side-by-side scouting report on two players. */
export async function compare(
    message: Message,
    args: string[],
    userDataService: UserDataService,
    turboStatsService: TurboStatsService
) {
    const queries = splitVsArgs(args);
    if (!queries) {
        return message.reply('Compare two players: `+compare @player1 @player2`, `+compare name1 vs name2`, or `+compare @player` for you vs them.');
    }
    const pair = queries.length === 1 ? [`<@${message.author.id}>`, queries[0]] : queries;
    const [target1, target2] = await Promise.all(pair.map(query => resolveTarget(message, query, userDataService)));
    if (!target1 || !target2) {
        const missing = !target1 ? pair[0] : pair[1];
        const who = missing === `<@${message.author.id}>` ? 'You aren\'t' : `\`${missing}\` isn't`;
        return message.reply(`${who} registered or tracked yet. Use a @mention of a registered player, a Steam id, or a name from \`+turborank all\`.`);
    }
    if (target1.steamId === target2.steamId) return message.reply('That\'s the same player twice.');

    try {
        safeTyping(message.channel);

        // significant=0 keeps this turbo-inclusive, matching the rest of the bot.
        const fetchSide = (steamId: string) => Promise.all([
            opendotaClient.get<any>(`/players/${steamId}`),
            opendotaClient.get<any>(`/players/${steamId}/wl?significant=0`),
            opendotaClient.get<any[]>(`/players/${steamId}/heroes?significant=0`),
        ]);
        const [raw1, raw2] = await Promise.all([fetchSide(target1.steamId), fetchSide(target2.steamId)]);
        const pullById = pullRatingsById(turboStatsService);

        const buildSide = (target: Target, [profile, wl, heroes]: Awaited<ReturnType<typeof fetchSide>>): Side => {
            const games = (wl.data.win || 0) + (wl.data.lose || 0);
            return {
                discordId: target.discordId,
                name: profile.data?.profile?.personaname || target.name,
                rankTier: profile.data?.rank_tier,
                winRate: games ? wl.data.win / games : 0,
                games,
                heroes: (heroes.data || []).filter((h: any) => h.games >= 3).sort((x: any, y: any) => y.games - x.games),
                turbo: turboSummary(turboStatsService, target.discordId ?? '', target.steamId, pullById),
            };
        };
        const a = buildSide(target1, raw1);
        const b = buildSide(target2, raw2);

        const heroLine = async (h: any) => `**${await dotaDataService.getHeroName(h.hero_id)}** ${h.games}G · ${Math.round((h.win / h.games) * 100)}%`;
        const sideValue = async (side: Side) => {
            const ranked = side.rankTier
                ? `${tierToEmoji(Math.floor(side.rankTier / 10))} Ranked **${rankTierToMedal(side.rankTier)}**`
                : '⚪ Ranked **Unranked**';
            const heroes = await Promise.all(side.heroes.slice(0, 3).map(heroLine));
            return [
                ranked,
                ...side.turbo.lines,
                `📊 ${(side.winRate * 100).toFixed(1)}% all modes · ${side.games.toLocaleString()} games`,
                '',
                heroes.length ? heroes.join('\n') : '_No hero data_',
            ].join('\n');
        };

        // Shared heroes across each player's top 10 by games.
        const topIds = new Set(a.heroes.slice(0, 10).map((h: any) => h.hero_id));
        const sharedIds = b.heroes.slice(0, 10).filter((h: any) => topIds.has(h.hero_id)).map((h: any) => h.hero_id);
        const sharedNames = await Promise.all(sharedIds.slice(0, 5).map((id: number) => dotaDataService.getHeroName(id)));

        // Same deduplicated ledger view `+turbopairs` reads.
        const pairing = a.discordId && b.discordId
            ? turboStatsService.getPairingsForPlayer(a.discordId, 'all').find(p => p.player1 === b.discordId || p.player2 === b.discordId)
            : undefined;
        const duoGames = pairing ? pairing.wins + pairing.losses : 0;
        const duoText = duoGames
            ? `${winRateText(pairing!.wins, duoGames)} win rate · ${pairing!.wins}W–${pairing!.losses}L in ${duoGames} games\n`
              + '-# ± is how far luck alone could push it. Duo records didn\'t repeat in later games.'
            : a.discordId && b.discordId
                ? 'No tracked Turbo games on the same team yet.'
                : 'Only tracked between two registered players.';

        const embed = new EmbedBuilder()
            .setColor('#6366f1')
            .setTitle(`⚔️ ${a.name} vs ${b.name}`)
            .setDescription(verdict(a, b))
            .addFields(
                { name: `👤 ${a.name}`, value: await sideValue(a), inline: true },
                { name: `👤 ${b.name}`, value: await sideValue(b), inline: true },
                { name: '🤝 Together in Turbo', value: duoText, inline: false },
                { name: '🦸 Shared heroes', value: sharedNames.length ? sharedNames.join(' · ') : 'None in common', inline: false },
            )
            .setFooter({ text: 'Hidden Turbo rank is the shared ladder · all-mode win rates sit in each player\'s own bracket' })
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    } catch (error) {
        logger.error('Error in compare command:', error);
        await message.reply('An error occurred while comparing players. Please try again later.');
    }
}
