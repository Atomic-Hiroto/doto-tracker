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

export interface AssistEvent {
    time: number;
    target?: number;
    gold?: number;
    xp?: number;
    positionX?: number;
    positionY?: number;
}

export interface ItemUsedEvent {
    itemId: number;
    count: number;
}

export interface ChatMessage {
    time: number;
    message: string;
    pausedTick: number;
}

export interface ChatWheelEvent {
    time: number;
    chatWheelId: number;
    pauseTick?: number;
}

export interface ActionReport {
    moveToPosition: number;
    moveToTarget: number;
    attackPosition: number;
    attackTarget: number;
    castPosition: number;
    castTarget: number;
    castNoTarget: number;
    heldPosition: number;
    glyphCast: number;
    scanUsed: number;
    pingUsed: number;
}

export interface LocationReport {
    positionX: number;
    positionY: number;
}

export interface InventoryItem {
    itemId: number;
    charges?: number;
    secondaryCharges?: number;
}

export interface InventoryReport {
    item0?: InventoryItem;
    item1?: InventoryItem;
    item2?: InventoryItem;
    item3?: InventoryItem;
    item4?: InventoryItem;
    item5?: InventoryItem;
    backPack0?: InventoryItem;
    backPack1?: InventoryItem;
    backPack2?: InventoryItem;
    neutral0?: InventoryItem;
}

export interface HeroAverage {
    heroId: number;
    apm?: number;
    casts?: number;
    abilityCasts?: number;
    kills?: number;
    deaths?: number;
    assists?: number;
    networth?: number;
    xp?: number;
    cs?: number;
    dn?: number;
    neutrals?: number;
    heroDamage?: number;
    towerDamage?: number;
    physicalDamage?: number;
    magicalDamage?: number;
    physicalDamageReceived?: number;
    magicalDamageReceived?: number;
    tripleKill?: number;
    ultraKill?: number;
    rampage?: number;
    godLike?: number;
    goldPerMinute?: number;
    disableCount?: number;
    disableDuration?: number;
    stunCount?: number;
    stunDuration?: number;
    slowCount?: number;
    slowDuration?: number;
    healingSelf?: number;
    healingAllies?: number;
    invisibleCount?: number;
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
    assistEvents?: AssistEvent[];
    itemPurchases?: ItemPurchaseEvent[];
    itemUsed?: ItemUsedEvent[];
    allTalks?: ChatMessage[];
    chatWheels?: ChatWheelEvent[];
    actionReport?: ActionReport;
    locationReport?: LocationReport[];
    farmDistributionReport?: FarmDistributionReport;
    abilityCastReport?: AbilityCastReport[];
    inventoryReport?: InventoryReport[];
    matchPlayerBuffEvent?: BuffEvent[];
    towerDamageReport?: TowerDamageReport[];
    heroDamageReport?: HeroDamageReport;
    deniesPerMinute?: number[];
    spiritBearInventoryReport?: any[];
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
    heroAverage?: HeroAverage[];
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
    endDateTime?: number;
    averageImp?: number;
    gameVersionId?: number;
    regionId?: number;
    numHumanPlayers?: number;
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

