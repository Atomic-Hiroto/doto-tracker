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

export interface PlaybackRoshanEvent {
    time: number;
    hp?: number;
    maxHp?: number;
    createTime?: number;
    x?: number;
    y?: number;
    totalDamageTaken?: number;
    item0?: number;
    item1?: number;
    item2?: number;
    item3?: number;
    item4?: number;
    item5?: number;
}

export interface PlaybackBuildingEvent {
    time: number;
    indexId?: number;
    type?: string;
    hp?: number;
    maxHp?: number;
    positionX?: number;
    positionY?: number;
    isRadiant?: boolean;
    npcId?: number;
}

export interface ItemPurchaseEvent {
    time: number;
    itemId: number;
}

export interface PlaybackData {
    roshanEvents?: PlaybackRoshanEvent[];
    buildingEvents?: PlaybackBuildingEvent[];
}

export interface LaneReportFactionLane {
    meleeCount: number;
    rangeCount: number;
    siegeCount: number;
    denyCount: number;
    neutralCount: number;
}

export interface LaneReportFaction {
    midLane?: LaneReportFactionLane;
    offLane?: LaneReportFactionLane;
    safeLane?: LaneReportFactionLane;
}

export interface LaneReport {
    radiant?: LaneReportFaction;
    dire?: LaneReportFaction;
}

export interface BuffEvent {
    time: number;
    abilityId?: number;
    itemId?: number;
    stackCount?: number;
}

export interface TowerDamageReport {
    npcId: number;
    damage: number;
    damageCreeps: number;
    damageFromAbility: number;
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
    itemPurchases?: ItemPurchaseEvent[];
    matchPlayerBuffEvent?: BuffEvent[];
    towerDamageReport?: TowerDamageReport[];
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
    goldPerMinute?: number;
    experiencePerMinute?: number;
    gold?: number;
    goldSpent?: number;
    leaverStatus?: number;
    streakPrediction?: number;
    invisibleSeconds?: number;
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
    towerDeaths?: TowerDeath[];
    chatEvents?: ChatEvent[];
    playbackData?: PlaybackData;
    towerStatusRadiant?: number;
    towerStatusDire?: number;
    barracksStatusRadiant?: number;
    barracksStatusDire?: number;
    rank?: number;
    bracket?: number;
    radiantKills?: number[];
    direKills?: number[];
    laneReport?: LaneReport;
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

