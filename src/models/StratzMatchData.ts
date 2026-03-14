export interface CreepTypeData {
    count: number;
    gold: number;
    xp: number;
}

export interface FarmDistributionReport {
    creepType?: CreepTypeData[];
    buildings?: CreepTypeData[];
    bountyGold?: CreepTypeData[];
    other?: CreepTypeData[];
}

export interface AbilityCastReport {
    abilityId: number;
    count: number;
}

export interface DamageData {
    physicalDamage: number;
    magicalDamage: number;
    pureDamage: number;
}

export interface HeroDamageReport {
    dealtTotal?: DamageData;
    receivedTotal?: DamageData;
}

export interface RoshanEvent {
    time: number;
    type: string;
    isBoost?: boolean;
    isRadiant?: boolean;
}

export interface BuildingEvent {
    time: number;
    type: string;
    isRadiant: boolean;
    npcResId?: number;
}

export interface ItemEvent {
    time: number;
    itemId: number;
    purchaseTime?: number;
    isEnchanted?: boolean;
}

export interface PlayerStats {
    actionsPerMinute?: number[];
    heroDamageReceivedPerMinute?: number[];
    goldPerMinute?: number[];
    experiencePerMinute?: number[];
    lastHitsPerMinute?: number[];
    networthPerMinute?: number[];
    healPerMinute?: number[];
    heroDamagePerMinute?: number[];
    towerDamagePerMinute?: number[];
    impPerMinute?: number[];
    courierKills?: Array<{ time: number }>;
    tripsFountainPerMinute?: number[];
    wardDestruction?: Array<{ time: number; gold: number }>;
    campStack?: number[];
    runes?: Array<{ time: number; rune: number; action: number }>;
    wards?: Array<{ time: number; type: number }>;
    killEvents?: Array<{ time: number; target: number; assist: number[]; isSolo: boolean; isSmoke: boolean }>;
    deathEvents?: Array<{ time: number }>;
    farmDistributionReport?: FarmDistributionReport;
    abilityCastReport?: AbilityCastReport[];
    heroDamageReport?: HeroDamageReport;
    itemEvents?: ItemEvent[];
    performance?: {
        behavior?: number;
        intentionalFeeding?: boolean;
    };
}

export interface PlayerAbility {
    abilityId: number;
    level: number;
    time: number;
    isTalent: boolean;
}

export interface MatchPlayer {
    steamAccountId?: number;
    account_id?: number;
    playerSlot?: number;
    isRadiant: boolean;
    imp?: number;
    award?: number;
    level?: number;
    kills?: number;
    deaths?: number;
    assists?: number;
    networth?: number;
    heroDamage?: number;
    towerDamage?: number;
    heroHealing?: number;
    numLastHits?: number;
    last_hits?: number;
    numDenies?: number;
    role?: number;
    lane?: number;
    position?: number;
    partyId?: number;
    variant?: number;
    behavior?: number;
    isRandom?: boolean;
    gold_per_min?: number;
    xp_per_min?: number;
    goldPerMinute?: number;
    experiencePerMinute?: number;
    item0Id?: number;
    item1Id?: number;
    item2Id?: number;
    item3Id?: number;
    item4Id?: number;
    item5Id?: number;
    backpack0Id?: number;
    backpack1Id?: number;
    backpack2Id?: number;
    neutral0Id?: number;
    abilities?: PlayerAbility[];
    stats?: PlayerStats;
    hero?: {
        id: number;
        displayName: string;
        shortName: string;
    };
    hero_id?: number;
    steamAccount?: {
        name: string;
        seasonRank: number;
    };
    personaname?: string;
}

export interface TowerDeath {
    time: number;
    isRadiant: boolean;
}

export interface ChatEvent {
    time: number;
    type: string;
    fromHeroId: number;
    value: string;
    isRadiant: boolean;
}

export interface PickBan {
    isPick: boolean;
    isRadiant: boolean;
    heroId: number;
    order: number;
}

export interface StratzMatch {
    id?: number;
    match_id: number;
    parsedDateTime?: number;
    didRadiantWin?: boolean;
    radiant_win: boolean;
    durationSeconds?: number;
    duration: number;
    startDateTime?: number;
    start_time: number;
    gameMode?: number;
    game_mode?: number;
    lobbyType?: number;
    averageRank?: number;
    firstBloodTime?: number;
    radiantKills?: number[] | number;
    direKills?: number[] | number;
    towerDeaths?: TowerDeath[];
    chatEvents?: ChatEvent[];
    roshanEvents?: RoshanEvent[];
    buildingEvents?: BuildingEvent[];
    topLaneOutcome?: number;
    midLaneOutcome?: number;
    bottomLaneOutcome?: number;
    radiantNetworthLeads?: number[];
    radiantExperienceLeads?: number[];
    winRates?: number[];
    predictedWinRates?: number[];
    pickBans?: PickBan[];
    players: MatchPlayer[];
}

