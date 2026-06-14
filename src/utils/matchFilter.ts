import { Message } from 'discord.js';
import { opendotaClient } from '../services/apiClient';
import { dotaDataService } from '../services/dotaDataService';
import { UserDataService } from '../services/userDataService';

export interface MatchFilterResult {
    openDotaParams: Record<string, string | number>;
    residualPredicates: Array<(match: any) => boolean>;
    descriptionParts: string[];
    consumedAny: boolean;
    lastOnly: boolean;
}

const STOP_WORDS = new Set([
    'won', 'win', 'wins', 'lost', 'loss', 'losses',
    'turbo', 'ranked', 'unranked', 'ap', 'allpick', 'all', 'pick',
    'as', 'with', 'without', 'against', 'vs',
    'today', 'week', 'month', 'last', 'days', 'day', 'since',
]);

let patchCache: Array<{ name: string; date: number }> | null = null;

function normalize(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9.]+/g, '');
}

function didWin(match: any): boolean {
    const isRadiant = Number(match.player_slot) < 128;
    return (isRadiant && !!match.radiant_win) || (!isRadiant && !match.radiant_win);
}

function tokenAt(tokens: string[], index: number): string {
    return normalize(tokens[index] || '');
}

async function patchAgeDays(patchName: string): Promise<number | null> {
    try {
        if (!patchCache) {
            const response = await opendotaClient.get<Record<string, any> | any[]>('/constants/patch');
            const values = Array.isArray(response.data) ? response.data : Object.values(response.data || {});
            patchCache = values
                .map((patch: any) => ({
                    name: String(patch.name || patch.patch || patch.number || ''),
                    date: Number(patch.date || patch.timestamp || 0),
                }))
                .filter((patch) => patch.name && Number.isFinite(patch.date) && patch.date > 0);
        }
        const wanted = normalize(patchName);
        const patch = patchCache.find((entry) => normalize(entry.name) === wanted || normalize(entry.name).startsWith(wanted));
        if (!patch) return null;
        const secondsAgo = Math.max(0, Math.floor(Date.now() / 1000) - patch.date);
        return Math.max(1, Math.ceil(secondsAgo / 86400));
    } catch {
        return null;
    }
}

function readHero(tokens: string[], start: number): { heroId: number; heroName: string; nextIndex: number } | null {
    let best: { heroId: number; heroName: string; nextIndex: number } | null = null;
    for (let end = start + 1; end <= Math.min(tokens.length, start + 4); end++) {
        const next = tokenAt(tokens, end);
        if (end > start + 1 && STOP_WORDS.has(next)) break;
        const text = tokens.slice(start, end).join(' ');
        const hero = dotaDataService.findHeroByName(text);
        if (hero) {
            best = { heroId: hero.id, heroName: hero.localized_name, nextIndex: end };
        }
    }
    return best;
}

async function resolveMentionSteamId(message: Message, userDataService: UserDataService | undefined, token: string): Promise<string | null> {
    const mention = token.match(/^<@!?(\d+)>$/);
    if (!mention || !userDataService) return null;
    const user = userDataService.getUserByDiscordId(mention[1]);
    return user?.steamId ?? null;
}

export async function parseMatchFilter(
    args: string[],
    message: Message,
    userDataService?: UserDataService,
): Promise<MatchFilterResult> {
    const result: MatchFilterResult = {
        openDotaParams: {},
        residualPredicates: [],
        descriptionParts: [],
        consumedAny: false,
        lastOnly: false,
    };

    let i = 0;
    while (i < args.length) {
        const token = tokenAt(args, i);

        if (token === 'last' && /^\d+$/.test(tokenAt(args, i + 1)) && ['day', 'days'].includes(tokenAt(args, i + 2))) {
            const days = Math.max(1, Math.min(3650, Number(tokenAt(args, i + 1))));
            result.openDotaParams.date = days;
            result.descriptionParts.push(`last ${days} days`);
            result.consumedAny = true;
            i += 3;
            continue;
        }

        if (token === 'last') {
            const next = tokenAt(args, i + 1);
            if (next === 'match' || next === 'game') i++;
            result.lastOnly = true;
            result.consumedAny = true;
            result.descriptionParts.push('last match');
            i++;
            continue;
        }

        if (['won', 'win', 'wins'].includes(token)) {
            result.openDotaParams.win = 1;
            result.residualPredicates.push(didWin);
            result.descriptionParts.push('wins');
            result.consumedAny = true;
            i++;
            continue;
        }
        if (['lost', 'loss', 'losses'].includes(token)) {
            result.openDotaParams.win = 0;
            result.residualPredicates.push((match) => !didWin(match));
            result.descriptionParts.push('losses');
            result.consumedAny = true;
            i++;
            continue;
        }
        if (token === 'turbo') {
            result.openDotaParams.game_mode = 23;
            result.descriptionParts.push('Turbo');
            result.consumedAny = true;
            i++;
            continue;
        }
        if (token === 'ranked') {
            result.openDotaParams.lobby_type = 7;
            result.descriptionParts.push('ranked');
            result.consumedAny = true;
            i++;
            continue;
        }
        if (token === 'unranked') {
            result.openDotaParams.lobby_type = 0;
            result.descriptionParts.push('unranked');
            result.consumedAny = true;
            i++;
            continue;
        }
        if (token === 'ap' || (token === 'all' && tokenAt(args, i + 1) === 'pick') || token === 'allpick') {
            result.openDotaParams.game_mode = 1;
            result.descriptionParts.push('All Pick');
            result.consumedAny = true;
            i += token === 'all' ? 2 : 1;
            continue;
        }

        if (token === 'as') {
            const hero = readHero(args, i + 1);
            if (hero) {
                result.openDotaParams.hero_id = hero.heroId;
                result.descriptionParts.push(`as ${hero.heroName}`);
                result.consumedAny = true;
                i = hero.nextIndex;
                continue;
            }
        }

        if (token === 'with' || token === 'against' || token === 'vs') {
            const hero = readHero(args, i + 1);
            if (hero) {
                result.openDotaParams[token === 'with' ? 'with_hero_id' : 'against_hero_id'] = hero.heroId;
                result.descriptionParts.push(`${token === 'with' ? 'with' : 'against'} ${hero.heroName}`);
                result.consumedAny = true;
                i = hero.nextIndex;
                continue;
            }
            const steamId = await resolveMentionSteamId(message, userDataService, args[i + 1] || '');
            if (steamId) {
                result.openDotaParams.included_account_id = steamId;
                result.descriptionParts.push(`with <@${args[i + 1].replace(/\D/g, '')}>`);
                result.consumedAny = true;
                i += 2;
                continue;
            }
        }

        if (token === 'without') {
            const steamId = await resolveMentionSteamId(message, userDataService, args[i + 1] || '');
            if (steamId) {
                result.openDotaParams.excluded_account_id = steamId;
                result.descriptionParts.push(`without <@${args[i + 1].replace(/\D/g, '')}>`);
                result.consumedAny = true;
                i += 2;
                continue;
            }
        }

        if (token === 'today') {
            result.openDotaParams.date = 1;
            result.descriptionParts.push('today');
            result.consumedAny = true;
            i++;
            continue;
        }
        if (token === 'this' && tokenAt(args, i + 1) === 'week') {
            result.openDotaParams.date = 7;
            result.descriptionParts.push('this week');
            result.consumedAny = true;
            i += 2;
            continue;
        }
        if (token === 'this' && tokenAt(args, i + 1) === 'month') {
            result.openDotaParams.date = 30;
            result.descriptionParts.push('this month');
            result.consumedAny = true;
            i += 2;
            continue;
        }
        if (token === 'since' && args[i + 1]) {
            const days = await patchAgeDays(args[i + 1]);
            if (days) {
                result.openDotaParams.date = days;
                result.descriptionParts.push(`since ${args[i + 1]}`);
                result.consumedAny = true;
                i += 2;
                continue;
            }
        }

        i++;
    }

    return result;
}

export function queryString(params: Record<string, string | number>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : '';
}

export function applyResidualFilters(matches: any[], filter: MatchFilterResult): any[] {
    return filter.residualPredicates.reduce((rows, predicate) => rows.filter(predicate), matches);
}
