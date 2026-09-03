import { opendotaClient } from './apiClient';
import { logger } from './loggerService';

interface HeroData {
    id: number;
    localized_name: string;
    name: string;
    roles?: string[];
}

interface ItemData {
    id: number;
    dname: string;
    img?: string;
    cost?: number | null;
    qual?: string;
    components?: string[] | null;
    internalName?: string;
}

// OpenDota item icons live behind cdn.steamstatic.com (the cloudflare host
// 301-redirects, which canvas/Discord won't follow).
const OD_IMG_BASE = 'https://cdn.steamstatic.com';

interface AbilityData {
    id: number;
    dname: string;
}

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const EMPTY_RETRY_INTERVAL_MS = 60 * 1000; // a failed load is worth retrying soon

// Nothing logs into Discord until these three have resolved, and the default
// client rides a 60s timeout through three retries per endpoint — so a provider
// outage used to keep the whole bot offline for eight minutes at boot. The load
// retries on demand now, so waiting out the full ladder here buys nothing.
const CONSTANTS_FETCH: any = { timeout: 20_000, 'axios-retry': { retries: 1 } };
const HERO_ALIASES: Record<string, string> = {
    am: 'antimage',
    aa: 'ancientapparition',
    bh: 'bountyhunter',
    bm: 'beastmaster',
    bs: 'bloodseeker',
    ck: 'chaosknight',
    cm: 'crystalmaiden',
    dp: 'deathprophet',
    dk: 'dragonknight',
    et: 'eldertitan',
    gyro: 'gyrocopter',
    invo: 'invoker',
    jugg: 'juggernaut',
    kotl: 'keeperofthelight',
    lc: 'legioncommander',
    ld: 'lonedruid',
    ls: 'lifestealer',
    mk: 'monkeyking',
    np: 'naturesprophet',
    od: 'outworlddestroyer',
    pa: 'phantomassassin',
    pl: 'phantomlancer',
    potm: 'mirana',
    qop: 'queenofpain',
    sb: 'spiritbreaker',
    sd: 'shadowdemon',
    sf: 'shadowfiend',
    sk: 'sandking',
    spec: 'spectre',
    ta: 'templarassassin',
    tb: 'terrorblade',
    timber: 'timbersaw',
    treant: 'treantprotector',
    venge: 'vengefulspirit',
    vs: 'vengefulspirit',
    void: 'facelessvoid',
    wd: 'witchdoctor',
    wk: 'wraithking',
    wr: 'windranger',
};

class DotaDataService {
    private heroes: Map<number, HeroData> = new Map();
    private items: Map<number, ItemData> = new Map();
    private abilities: Map<number, AbilityData> = new Map();
    private lastRefresh: number = 0;
    private initialized = false;
    private refreshing: Promise<void> | null = null;

    async initialize(): Promise<void> {
        logger.info('Initializing DotaDataService — loading hero, item and ability data...');
        await Promise.all([this.fetchHeroes(), this.fetchItems(), this.fetchAbilities()]);
        this.lastRefresh = Date.now();
        this.initialized = this.heroes.size > 0;
        const line = `DotaDataService ready: ${this.heroes.size} heroes, ${this.items.size} items, ${this.abilities.size} abilities loaded.`;
        if (this.initialized) logger.info(line);
        else logger.error(`${line} The provider was unreachable at boot — retrying on demand.`);
    }

    private async fetchHeroes(): Promise<void> {
        try {
            const response = await opendotaClient.get<HeroData[]>('/heroes', CONSTANTS_FETCH);
            this.heroes.clear();
            for (const hero of response.data) {
                this.heroes.set(hero.id, hero);
            }
        } catch (error) {
            logger.error('Failed to fetch hero data:', error);
        }
    }

    private async fetchItems(): Promise<void> {
        try {
            const response = await opendotaClient.get<Record<string, ItemData>>('/constants/items', CONSTANTS_FETCH);
            this.items.clear();
            for (const [internalName, item] of Object.entries(response.data)) {
                if (item.id !== undefined) {
                    item.internalName = internalName;
                    this.items.set(item.id, item);
                }
            }
        } catch (error) {
            logger.error('Failed to fetch item data:', error);
        }
    }

    private async fetchAbilities(): Promise<void> {
        try {
            const [abilitiesResponse, abilityIdsResponse] = await Promise.all([
                opendotaClient.get<Record<string, any>>('/constants/abilities', CONSTANTS_FETCH),
                opendotaClient.get<Record<string, string>>('/constants/ability_ids', CONSTANTS_FETCH),
            ]);
            const abilities = abilitiesResponse.data || {};
            const abilityIds = abilityIdsResponse.data || {};
            this.abilities.clear();
            for (const [idText, internalName] of Object.entries(abilityIds)) {
                const id = Number(idText);
                if (!Number.isFinite(id)) continue;
                const ability = abilities[internalName] || {};
                this.abilities.set(id, {
                    id,
                    dname: ability.dname || internalName.replace(/^special_bonus_/, 'Talent: ').replace(/_/g, ' ')
                });
            }
        } catch (error) {
            logger.error('Failed to fetch ability data:', error);
        }
    }

    private async refreshIfStale(): Promise<void> {
        // An empty cache means the boot-time load ran during a provider outage.
        // Waiting the full day to try again leaves every hero name in the bot
        // reading "Unknown Hero", so an empty cache retries on a short backoff.
        const interval = this.heroes.size === 0 ? EMPTY_RETRY_INTERVAL_MS : REFRESH_INTERVAL_MS;
        if (Date.now() - this.lastRefresh <= interval) return;
        // A scoreboard resolves ten hero names at once, so without this guard a
        // single render would fire ten concurrent reloads of the same tables.
        if (!this.refreshing) {
            logger.info(
                this.heroes.size === 0
                    ? 'DotaDataService: hero cache is empty — retrying the load...'
                    : 'DotaDataService: refreshing stale hero/item/ability cache...'
            );
            this.refreshing = Promise.all([this.fetchHeroes(), this.fetchItems(), this.fetchAbilities()])
                .then(() => {
                    this.lastRefresh = Date.now();
                    this.initialized = this.heroes.size > 0;
                })
                .finally(() => { this.refreshing = null; });
        }
        await this.refreshing;
    }

    async getHeroName(heroId: number): Promise<string> {
        await this.refreshIfStale();
        const hero = this.heroes.get(heroId);
        return hero ? hero.localized_name : 'Unknown Hero';
    }

    async getItemName(itemId: number): Promise<string> {
        await this.refreshIfStale();
        if (itemId === 0) return 'Empty Slot';
        const item = this.items.get(itemId);
        return item ? item.dname : 'Unknown Item';
    }

    /** Item metadata for build analysis. isKey = a finished/notable item worth showing in a build. */
    getItemMeta(itemId: number): { name: string; cost: number; isKey: boolean } | undefined {
        const item = this.items.get(itemId);
        if (!item) return undefined;
        const cost = item.cost ?? 0;
        const hasComponents = Array.isArray(item.components) && item.components.length > 0;
        // Finished/built item (BKB, boots upgrades, cores) or a notable whole-buy (Blink, qual "component").
        // Excludes raw components, consumables, and cheap parts via the cost gate.
        const isKey = cost >= 1400 && (hasComponents || item.qual === 'component');
        return { name: item.dname, cost, isKey };
    }

    /** Internal (OpenDota) name of an item, e.g. "black_king_bar". */
    getItemInternalName(itemId: number): string | undefined {
        return this.items.get(itemId)?.internalName;
    }

    /** Internal names of the components an item is built from. */
    getItemComponentNames(itemId: number): string[] {
        const c = this.items.get(itemId)?.components;
        return Array.isArray(c) ? c : [];
    }

    getItemImageUrl(itemId: number): string | undefined {
        if (!itemId) return undefined;
        const item = this.items.get(itemId);
        if (!item?.img) return undefined;
        return OD_IMG_BASE + item.img.split('?')[0];
    }

    async getAbilityName(abilityId: number): Promise<string> {
        await this.refreshIfStale();
        const ability = this.abilities.get(abilityId);
        return ability ? ability.dname : `Ability ${abilityId}`;
    }

    getHeroById(heroId: number): HeroData | undefined {
        return this.heroes.get(heroId);
    }

    /** OpenDota role tags for a hero, e.g. ['Carry','Escape'] or ['Support','Initiator']. */
    getHeroRoles(heroId: number): string[] {
        return this.heroes.get(heroId)?.roles ?? [];
    }

    getAllHeroes(): HeroData[] {
        return Array.from(this.heroes.values());
    }

    // Fuzzy hero name lookup for user input (e.g. "Anti-Mage", "antimage", "AM")
    findHeroByName(query: string): HeroData | undefined {
        const raw = query.toLowerCase().replace(/[^a-z0-9]/g, '');
        const q = HERO_ALIASES[raw] || raw;
        for (const hero of this.heroes.values()) {
            const name = hero.localized_name.toLowerCase().replace(/[^a-z0-9]/g, '');
            const internalName = hero.name.replace('npc_dota_hero_', '').replace(/_/g, '');
            if (name === q || internalName === q || name.startsWith(q)) {
                return hero;
            }
        }
        return undefined;
    }

    isInitialized(): boolean {
        return this.initialized;
    }
}

export const dotaDataService = new DotaDataService();
