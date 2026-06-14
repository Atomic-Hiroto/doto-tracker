import { opendotaClient } from './apiClient';
import { logger } from './loggerService';

interface HeroData {
    id: number;
    localized_name: string;
    name: string;
}

interface ItemData {
    id: number;
    dname: string;
}

interface AbilityData {
    id: number;
    dname: string;
}

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

class DotaDataService {
    private heroes: Map<number, HeroData> = new Map();
    private items: Map<number, ItemData> = new Map();
    private abilities: Map<number, AbilityData> = new Map();
    private lastRefresh: number = 0;
    private initialized = false;

    async initialize(): Promise<void> {
        logger.info('Initializing DotaDataService — loading hero, item and ability data...');
        await Promise.all([this.fetchHeroes(), this.fetchItems(), this.fetchAbilities()]);
        this.lastRefresh = Date.now();
        this.initialized = true;
        logger.info(`DotaDataService ready: ${this.heroes.size} heroes, ${this.items.size} items, ${this.abilities.size} abilities loaded.`);
    }

    private async fetchHeroes(): Promise<void> {
        try {
            const response = await opendotaClient.get<HeroData[]>('/heroes');
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
            const response = await opendotaClient.get<Record<string, ItemData>>('/constants/items');
            this.items.clear();
            for (const item of Object.values(response.data)) {
                if (item.id !== undefined) {
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
                opendotaClient.get<Record<string, any>>('/constants/abilities'),
                opendotaClient.get<Record<string, string>>('/constants/ability_ids'),
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
        if (Date.now() - this.lastRefresh > REFRESH_INTERVAL_MS) {
            logger.info('DotaDataService: refreshing stale hero/item/ability cache...');
            await Promise.all([this.fetchHeroes(), this.fetchItems(), this.fetchAbilities()]);
            this.lastRefresh = Date.now();
        }
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

    async getAbilityName(abilityId: number): Promise<string> {
        await this.refreshIfStale();
        const ability = this.abilities.get(abilityId);
        return ability ? ability.dname : `Ability ${abilityId}`;
    }

    getHeroById(heroId: number): HeroData | undefined {
        return this.heroes.get(heroId);
    }

    getAllHeroes(): HeroData[] {
        return Array.from(this.heroes.values());
    }

    // Fuzzy hero name lookup for user input (e.g. "Anti-Mage", "antimage", "AM")
    findHeroByName(query: string): HeroData | undefined {
        const q = query.toLowerCase().replace(/[^a-z0-9]/g, '');
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
