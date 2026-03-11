export interface CreepTypeData {
    count: number;
    gold: number;
    xp: number;
}

export interface CreepLocationData {
    creepLocation?: string | number;
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
}

export interface PlayerAbility {
    abilityId: number;
    level: number;
    time: number;
    isTalent: boolean;
}

export interface MatchPlayer {
    steamAccountId?: number; // In template as account_id
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
    last_hits?: number; // From user template
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
    hero_id?: number; // From user template
    steamAccount?: {
        name: string;
        seasonRank: number;
    };
    personaname?: string; // From user template
}

export interface TowerDeath {
    time: number;
    isRadiant: boolean;
}

export interface ChatEvent {
    time: number;
    type: string; // ChatType: e.g. "ALL", "TEAM", "CHAT_WHEEL", "HERO_CHAT_WHEEL"
    fromHeroId: number;
    value: string; // the actual message text or raw chat wheel
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
    match_id: number; // mapped from id
    parsedDateTime?: number;
    didRadiantWin?: boolean;
    radiant_win: boolean; // mapped from didRadiantWin
    durationSeconds?: number;
    duration: number; // mapped from durationSeconds
    startDateTime?: number;
    start_time: number; // mapped from startDateTime
    gameMode?: number; // Also game_mode
    game_mode?: number;
    lobbyType?: number;
    averageRank?: number;
    firstBloodTime?: number;
    radiantKills?: number[] | number;
    direKills?: number[] | number;
    towerDeaths?: TowerDeath[];
    chatEvents?: ChatEvent[];
    topLaneOutcome?: number; // 0=draw, 1=radiant, 2=dire ?
    midLaneOutcome?: number;
    bottomLaneOutcome?: number;
    radiantNetworthLeads?: number[];
    radiantExperienceLeads?: number[];
    winRates?: number[];
    predictedWinRates?: number[];
    pickBans?: PickBan[];
    players: MatchPlayer[];
}
