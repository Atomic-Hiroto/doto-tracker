import { opendotaClient } from './apiClient';
import { logger } from './loggerService';
import axios from 'axios';
import fs from 'fs';

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

// Measured against a Cloudflare 522: axios honoured the 20s timeout on the
// first attempt and then let the retry run for 2m20s, so the HTTP layer's own
// timeout can't be trusted to bound this. The login waits on a wall clock
// instead; a fetch that lands late still populates the cache on its way out.
const BOOT_LOAD_DEADLINE_MS = 25_000;

// These tables have exactly one upstream, and when it is down every hero in the
// bot renders as "Unknown Hero" with no portrait and no items. So: keep the last
// good copy on disk, and know a second host that serves the same data. The
// mirror is the build output OpenDota itself publishes, so the shapes match —
// except that heroes.json is keyed by id where /heroes returns an array.
const CONSTANTS_MIRROR = 'https://raw.githubusercontent.com/odota/dotaconstants/master/build';
const CONSTANTS_CACHE_FILE = process.env.DOTA_CONSTANTS_CACHE || 'dotaConstants.json';

interface ConstantsCacheFile {
    savedAt: number;
    heroes: HeroData[];
    items: ItemData[];
    abilities: AbilityData[];
}

/** Pulls one constants table, preferring OpenDota and falling back to the mirror. */
async function fetchConstants<T>(openDotaPath: string, mirrorFile: string): Promise<T | null> {
    try {
        const response = await opendotaClient.get<T>(openDotaPath, CONSTANTS_FETCH);
        if (response.data) return response.data;
    } catch (error: any) {
        logger.warn(`Constants: OpenDota ${openDotaPath} failed (${error?.response?.status ?? error?.code ?? 'no response'}), trying the mirror`);
    }
    try {
        const response = await axios.get<T>(`${CONSTANTS_MIRROR}/${mirrorFile}`, { timeout: 20_000 });
        return response.data ?? null;
    } catch (error: any) {
        logger.error(`Constants: mirror ${mirrorFile} failed too:`, error?.message ?? error);
        return null;
    }
}
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

        // A cached copy makes the bot usable the moment it logs in, and keeps it
        // usable through an upstream outage. Hero and item tables only change on
        // a patch, so serving yesterday's copy costs nothing worth having.
        if (this.loadFromDisk()) {
            logger.info(`DotaDataService: ${this.heroes.size} heroes restored from ${CONSTANTS_CACHE_FILE}; refreshing in the background.`);
            this.initialized = true;
            void this.reload().catch(() => undefined);
            return;
        }

        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
            this.reload(),
            new Promise<void>((resolve) => { timer = setTimeout(resolve, BOOT_LOAD_DEADLINE_MS); }),
        ]);
        if (timer) clearTimeout(timer);
        this.initialized = this.heroes.size > 0;
        const line = `DotaDataService ready: ${this.heroes.size} heroes, ${this.items.size} items, ${this.abilities.size} abilities loaded.`;
        if (this.initialized) logger.info(line);
        else logger.error(`${line} Every source was unreachable at boot — retrying on demand.`);
    }

    /** Fetches all three tables and, if anything came back, saves them for next boot. */
    private async reload(): Promise<void> {
        await Promise.all([this.fetchHeroes(), this.fetchItems(), this.fetchAbilities()]);
        this.lastRefresh = Date.now();
        if (this.heroes.size > 0) {
            this.initialized = true;
            this.saveToDisk();
        }
    }

    private loadFromDisk(): boolean {
        try {
            if (!fs.existsSync(CONSTANTS_CACHE_FILE)) return false;
            const cache: ConstantsCacheFile = JSON.parse(fs.readFileSync(CONSTANTS_CACHE_FILE, 'utf-8'));
            if (!cache?.heroes?.length) return false;
            for (const hero of cache.heroes) this.heroes.set(hero.id, hero);
            for (const item of cache.items || []) this.items.set(item.id, item);
            for (const ability of cache.abilities || []) this.abilities.set(ability.id, ability);
            return true;
        } catch (error) {
            logger.warn(`DotaDataService: could not read ${CONSTANTS_CACHE_FILE}:`, error);
            return false;
        }
    }

    private saveToDisk(): void {
        try {
            const cache: ConstantsCacheFile = {
                savedAt: Date.now(),
                heroes: [...this.heroes.values()],
                items: [...this.items.values()],
                abilities: [...this.abilities.values()],
            };
            fs.writeFileSync(CONSTANTS_CACHE_FILE, JSON.stringify(cache));
        } catch (error) {
            logger.warn(`DotaDataService: could not write ${CONSTANTS_CACHE_FILE}:`, error);
        }
    }

    private async fetchHeroes(): Promise<void> {
        const data = await fetchConstants<HeroData[] | Record<string, HeroData>>('/heroes', 'heroes.json');
        if (!data) return;
        const heroes = Array.isArray(data) ? data : Object.values(data);
        if (heroes.length === 0) return;
        this.heroes.clear();
        for (const hero of heroes) {
            if (hero?.id != null) this.heroes.set(hero.id, hero);
        }
    }

    private async fetchItems(): Promise<void> {
        const data = await fetchConstants<Record<string, ItemData>>('/constants/items', 'items.json');
        if (!data) return;
        const entries = Object.entries(data);
        if (entries.length === 0) return;
        this.items.clear();
        for (const [internalName, item] of entries) {
            if (item?.id !== undefined) {
                item.internalName = internalName;
                this.items.set(item.id, item);
            }
        }
    }

    private async fetchAbilities(): Promise<void> {
        try {
            const [abilities, abilityIds] = await Promise.all([
                fetchConstants<Record<string, any>>('/constants/abilities', 'abilities.json'),
                fetchConstants<Record<string, string>>('/constants/ability_ids', 'ability_ids.json'),
            ]);
            if (!abilities || !abilityIds) return;
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
            this.refreshing = this.reload().finally(() => { this.refreshing = null; });
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
