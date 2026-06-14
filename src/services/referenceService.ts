import { opendotaClient } from './apiClient';
import { logger } from './loggerService';

// Rich Dota 2 reference data (items, abilities, hero kits, Aghanim's upgrades,
// talents) sourced from OpenDota's /constants endpoints. Loaded lazily on first
// lookup and refreshed every 24h, so it never slows bot boot.

export interface ItemAbility {
    type?: string;
    title?: string;
    description?: string;
}

export interface ItemAttrib {
    key: string;
    display?: string;
    value: string | string[];
}

export interface ItemConstant {
    id?: number;
    img?: string;
    dname?: string;
    qual?: string;
    cost?: number | null;
    behavior?: string | string[];
    notes?: string;
    lore?: string;
    hint?: string[];
    mc?: number | number[] | false;
    cd?: number | number[] | false;
    attrib?: ItemAttrib[];
    abilities?: ItemAbility[];
    components?: string[] | null;
    created?: boolean;
}

export interface AbilityConstant {
    dname?: string;
    desc?: string;
    behavior?: string | string[];
    dmg_type?: string;
    bkbpierce?: string;
    target_type?: string | string[];
    mc?: string | string[] | number | number[] | false;
    cd?: string | string[] | number | number[] | false;
    attrib?: Array<{ key?: string; header?: string; value?: string | string[]; generated?: boolean }>;
    lore?: string;
    is_talent?: boolean;
}

export interface HeroAbilities {
    abilities: string[];
    talents: Array<{ name: string; level: number }>;
    facets?: any[];
}

export interface HeroConstant {
    id: number;
    name: string; // npc_dota_hero_*
    localized_name: string;
    primary_attr?: string;
    attack_type?: string;
    roles?: string[];
    base_health?: number;
    base_mana?: number;
    base_armor?: number;
    base_attack_min?: number;
    base_attack_max?: number;
    move_speed?: number;
    base_str?: number;
    base_agi?: number;
    base_int?: number;
    str_gain?: number;
    agi_gain?: number;
    int_gain?: number;
    attack_range?: number;
}

export interface AghsEntry {
    hero_name: string;
    hero_id: number;
    has_scepter: boolean;
    scepter_desc?: string;
    scepter_skill_name?: string;
    scepter_new_skill?: boolean;
    has_shard: boolean;
    shard_desc?: string;
    shard_skill_name?: string;
    shard_new_skill?: boolean;
}

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

class ReferenceService {
    private items: Record<string, ItemConstant> = {};
    private abilities: Record<string, AbilityConstant> = {};
    private heroAbilities: Record<string, HeroAbilities> = {};
    private heroes: HeroConstant[] = [];
    private aghs: Map<number, AghsEntry> = new Map();
    private lastRefresh = 0;
    private loading: Promise<void> | null = null;

    /** Ensures constants are loaded (and refreshes them if stale). De-duplicates concurrent loads. */
    private async ensureLoaded(): Promise<void> {
        const fresh = Date.now() - this.lastRefresh < REFRESH_INTERVAL_MS && this.heroes.length > 0;
        if (fresh) return;
        if (this.loading) return this.loading;
        this.loading = this.load().finally(() => { this.loading = null; });
        return this.loading;
    }

    private async load(): Promise<void> {
        logger.info('ReferenceService — loading Dota constants (items, abilities, hero kits, aghs)...');
        const [items, abilities, heroAbilities, heroes, aghs] = await Promise.all([
            opendotaClient.get<Record<string, ItemConstant>>('/constants/items'),
            opendotaClient.get<Record<string, AbilityConstant>>('/constants/abilities'),
            opendotaClient.get<Record<string, HeroAbilities>>('/constants/hero_abilities'),
            opendotaClient.get<Record<string, HeroConstant>>('/constants/heroes'),
            opendotaClient.get<AghsEntry[]>('/constants/aghs_desc'),
        ]);
        this.items = items.data || {};
        this.abilities = abilities.data || {};
        this.heroAbilities = heroAbilities.data || {};
        this.heroes = Object.values(heroes.data || {});
        this.aghs = new Map();
        for (const entry of aghs.data || []) this.aghs.set(entry.hero_id, entry);
        this.lastRefresh = Date.now();
        logger.info(`ReferenceService ready: ${Object.keys(this.items).length} items, ${Object.keys(this.abilities).length} abilities, ${this.heroes.length} heroes.`);
    }

    // --- Lookups -----------------------------------------------------------

    /** Finds an item by display name or internal name, fuzzy and case-insensitive. */
    async findItem(query: string): Promise<{ key: string; item: ItemConstant } | null> {
        await this.ensureLoaded();
        return this.fuzzyFind(this.items, (it) => it.dname, query);
    }

    /** Finds an ability by display name or internal name, fuzzy and case-insensitive. */
    async findAbility(query: string): Promise<{ key: string; ability: AbilityConstant } | null> {
        await this.ensureLoaded();
        const hit = this.fuzzyFind(this.abilities, (a) => a.dname, query);
        return hit ? { key: hit.key, ability: hit.item } : null;
    }

    /** Finds a hero by localized name, fuzzy and case-insensitive. */
    async findHero(query: string): Promise<HeroConstant | null> {
        await this.ensureLoaded();
        const q = normalize(query);
        if (!q) return null;
        const heroes = this.heroes;
        let exact = heroes.find((h) => normalize(h.localized_name) === q);
        if (exact) return exact;
        let starts = heroes.find((h) => normalize(h.localized_name).startsWith(q));
        if (starts) return starts;
        return heroes.find((h) => normalize(h.localized_name).includes(q)) || null;
    }

    getHeroAbilities(npcName: string): HeroAbilities | undefined {
        return this.heroAbilities[npcName];
    }

    getAbilityByName(npcName: string): AbilityConstant | undefined {
        return this.abilities[npcName];
    }

    getItemByName(internalName: string): ItemConstant | undefined {
        return this.items[internalName];
    }

    getAghs(heroId: number): AghsEntry | undefined {
        return this.aghs.get(heroId);
    }

    private fuzzyFind<T extends { dname?: string }>(
        record: Record<string, T>,
        nameOf: (v: T) => string | undefined,
        query: string
    ): { key: string; item: T } | null {
        const q = normalize(query);
        if (!q) return null;
        const entries = Object.entries(record);
        // exact display name
        for (const [key, val] of entries) {
            if (normalize(nameOf(val) || '') === q) return { key, item: val };
        }
        // exact internal name (with/without spaces vs underscores)
        const qKey = q.replace(/\s+/g, '_');
        if (record[qKey]) return { key: qKey, item: record[qKey] };
        // prefix on display name
        for (const [key, val] of entries) {
            if (normalize(nameOf(val) || '').startsWith(q)) return { key, item: val };
        }
        // substring on display name
        for (const [key, val] of entries) {
            if (normalize(nameOf(val) || '').includes(q)) return { key, item: val };
        }
        return null;
    }
}

function normalize(s: string): string {
    return (s || '').toLowerCase().replace(/['._-]/g, '').replace(/\s+/g, ' ').trim();
}

export const referenceService = new ReferenceService();
