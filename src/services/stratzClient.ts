import axios from 'axios';
import { STRATZ_API_KEY } from '../constants/process';
import { logger } from './loggerService';

const STRATZ_GQL = 'https://api.stratz.com/graphql';

// Dota 2 game mode IDs used by Stratz
// 1 = All Pick, 2 = Captains Mode, 22 = Ranked All Pick, 23 = Turbo
const STRATZ_GAME_MODES = {
  RANKED: 22,
  TURBO: 23,
  ALL_PICK: 1,
} as const;

export interface StratzHeroLaneStat {
  heroId: number;
  lane: number;       // 1=Safe, 2=Mid, 3=Off, 4=Jungle/Roam
  matchCount: number;
  winCount: number;
  winRate: number;    // computed from winCount/matchCount
}

/**
 * Fetches hero win rates per lane for a given game mode via the Stratz GraphQL API.
 * Returns data for the last 7 days (winWeek).
 *
 * @param gameModeId  22 = Ranked All Pick, 23 = Turbo
 * @param minMatches  minimum matches to filter noise
 */
export async function fetchStratzHeroLaneStats(
  gameModeId: number,
  minMatches = 500
): Promise<StratzHeroLaneStat[]> {
  if (!STRATZ_API_KEY) {
    logger.warn('STRATZ_API_KEY not set — skipping Stratz meta fetch');
    return [];
  }

  const query = `{
  heroStats {
    winWeek(gameModeIds: [${gameModeId}]) {
      heroId
      lane
      matchCount
      winCount
    }
  }
}`;

  try {
    const response = await axios.post(
      STRATZ_GQL,
      { query },
      {
        headers: {
          Authorization: `Bearer ${STRATZ_API_KEY}`,
          'Content-Type': 'application/json',
          'User-Agent': 'STRATZ_API',
          'Accept': 'application/json',
        },
        timeout: 15000,
      }
    );

    const rows: any[] = response.data?.data?.heroStats?.winWeek ?? [];
    logger.debug(`Stratz winWeek returned ${rows.length} rows for gameMode ${gameModeId}`);

    return rows
      .filter((r: any) => (r.matchCount || 0) >= minMatches)
      .map((r: any) => ({
        heroId: r.heroId,
        lane: r.lane,
        matchCount: r.matchCount,
        winCount: r.winCount,
        winRate: r.matchCount > 0 ? r.winCount / r.matchCount : 0,
      }));
  } catch (error: any) {
    logger.error('Stratz API error:', error?.response?.data ?? error?.message ?? error);
    return [];
  }
}

export const StratzGameModes = STRATZ_GAME_MODES;

export const MATCH_QUERY = `
query ($matchId: Long!) {
  match(id: $matchId) {
    id
    parsedDateTime
    didRadiantWin
    durationSeconds
    startDateTime
    endDateTime
    gameMode
    lobbyType
    averageRank
    actualRank
    firstBloodTime
    radiantKills
    direKills
    towerStatusRadiant
    towerStatusDire
    barracksStatusRadiant
    barracksStatusDire
    rank
    bracket
    gameVersionId
    regionId
    numHumanPlayers
    league { id name displayName }
    series { id type lastMatchDateTime }
    playbackData {
      roshanEvents {
        time hp maxHp createTime x y totalDamageTaken
        item0 item1 item2 item3 item4 item5
      }
      buildingEvents {
        time indexId type hp maxHp positionX positionY isRadiant npcId
      }
    }
    towerDeaths { time isRadiant }
    chatEvents { time type fromHeroId value isRadiant }
    laneReport {
      radiant {
        midLane { meleeCount rangeCount siegeCount denyCount neutralCount }
        offLane { meleeCount rangeCount siegeCount denyCount neutralCount }
        safeLane { meleeCount rangeCount siegeCount denyCount neutralCount }
      }
      dire {
        midLane { meleeCount rangeCount siegeCount denyCount neutralCount }
        offLane { meleeCount rangeCount siegeCount denyCount neutralCount }
        safeLane { meleeCount rangeCount siegeCount denyCount neutralCount }
      }
    }
    radiantNetworthLeads
    radiantExperienceLeads
    pickBans { isPick isRadiant heroId order }
    players {
      steamAccountId
      playerSlot
      isRadiant
      level
      kills
      deaths
      assists
      networth
      heroDamage
      towerDamage
      heroHealing
      numLastHits
      numDenies
      role
      lane
      position
      partyId
      isRandom
      variant
      invisibleSeconds
      goldPerMinute
      experiencePerMinute
      gold
      goldSpent
      leaverStatus
      item0Id item1Id item2Id item3Id item4Id item5Id
      backpack0Id backpack1Id backpack2Id neutral0Id
      abilities { abilityId level time isTalent }
      stats {
        actionsPerMinute
        heroDamageReceivedPerMinute
        goldPerMinute
        experiencePerMinute
        lastHitsPerMinute
        networthPerMinute
        healPerMinute
        heroDamagePerMinute
        towerDamagePerMinute
        courierKills { time }
        tripsFountainPerMinute
        wardDestruction { time gold }
        campStack
        runes { time rune action }
        wards { time type }
        matchPlayerBuffEvent { time abilityId itemId stackCount }
        towerDamageReport { npcId damage damageCreeps damageFromAbility }
        killEvents { time target assist isSolo isSmoke }
        deathEvents { time }
        assistEvents { time target gold xp positionX positionY }
        itemPurchases { time itemId }
        itemUsed { itemId count }
        allTalks { time message pausedTick }
        chatWheels { time chatWheelId pauseTick }
        actionReport { moveToPosition moveToTarget attackPosition attackTarget castPosition castTarget castNoTarget heldPosition glyphCast scanUsed pingUsed }
        locationReport { positionX positionY }
        inventoryReport {
          item0 { itemId charges secondaryCharges }
          item1 { itemId charges secondaryCharges }
          item2 { itemId charges secondaryCharges }
          item3 { itemId charges secondaryCharges }
          item4 { itemId charges secondaryCharges }
          item5 { itemId charges secondaryCharges }
          backPack0 { itemId charges secondaryCharges }
          backPack1 { itemId charges secondaryCharges }
          backPack2 { itemId charges secondaryCharges }
          neutral0 { itemId charges secondaryCharges }
        }
        farmDistributionReport {
          creepType { count gold xp }
          buildings { count gold xp }
          bountyGold { count gold xp }
          other { count gold xp }
        }
        abilityCastReport { abilityId count }
        heroDamageReport {
          dealtTotal { physicalDamage magicalDamage pureDamage }
          receivedTotal { physicalDamage magicalDamage pureDamage }
        }
        deniesPerMinute
        spiritBearInventoryReport {
          item0Id item1Id item2Id item3Id item4Id item5Id
          backPack0Id backPack1Id backPack2Id neutral0Id
        }
      }
      hero { id displayName shortName }
      steamAccount { name seasonRank }
    }
  }
}
`;

import { StratzMatch } from '../models/StratzMatchData';

/**
 * Fetches a full match's details from the Stratz GraphQL API.
 * 
 * @param matchId  The ID of the match to fetch
 */
export async function fetchStratzMatch(matchId: number): Promise<StratzMatch | null> {
  if (!STRATZ_API_KEY) {
    logger.warn('STRATZ_API_KEY not set — cannot fetch Stratz match data');
    return null;
  }

  try {
    const response = await axios.post(
      STRATZ_GQL,
      {
        query: MATCH_QUERY,
        variables: { matchId }
      },
      {
        headers: {
          Authorization: `Bearer ${STRATZ_API_KEY}`,
          'Content-Type': 'application/json',
          'User-Agent': 'STRATZ_API',
          'Accept': 'application/json',
        },
        timeout: 30000,
      }
    );

    if (response.data?.errors) {
      logger.warn(`Stratz API GraphQL Errors for match ${matchId} (some fields may be missing):`, JSON.stringify(response.data.errors));
      // We don't return null here because data might still contain the match
    }

    const match: StratzMatch | undefined = response.data?.data?.match;

    if (!match) {
      logger.warn(`Stratz API returned no match data for ${matchId}`);
      return null;
    }

    // Map fields for backward compatibility if needed
    match.match_id = match.id || matchId;
    match.radiant_win = !!match.didRadiantWin;
    match.duration = match.durationSeconds || 0;
    match.start_time = match.startDateTime || 0;

    return match;
  } catch (error: any) {
    logger.error(`Stratz fetch match error for ${matchId}:`, error?.response?.data ?? error?.message ?? error);
    return null;
  }
}

/**
 * Polls the Stratz API until the match is parsed.
 */
export async function waitForStratzParse(
  matchId: number,
  opts: {
    maxAttempts?: number;
    intervalMs?: number;
    onTick?: (attempt: number, max: number) => void;
  } = {}
): Promise<boolean> {
  const { maxAttempts = 15, intervalMs = 20000, onTick } = opts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    onTick?.(attempt, maxAttempts);

    const match = await fetchStratzMatch(matchId);
    if (match && match.parsedDateTime) {
      return true;
    }

    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  return false;
}

// ── Turbo rank calibration query ─────────────────────────────────────────────

/** Fetches turbo matches with support for take, skip, startDateTime, and isParty filtering. */
const PLAYER_TURBO_MATCHES_QUERY = `
query ($steamAccountId: Long!, $take: Int!, $skip: Int, $startDateTime: Long, $isParty: Boolean) {
  player(steamAccountId: $steamAccountId) {
    matches(request: { gameModeIds: [23], take: $take, skip: $skip, orderBy: DESC, startDateTime: $startDateTime, isParty: $isParty }) {
      id
      startDateTime
      averageRank
      didRadiantWin
      players {
        steamAccountId
        playerSlot
        isRadiant
        partyId
        steamAccount { seasonRank }
      }
    }
  }
}
`;

/**
 * Fetches a player's Turbo matches with rank data, supporting pagination, date filter, and party filter.
 */
export async function fetchPlayerTurboMatches(
  steamAccountId: number,
  take = 100,
  skip = 0,
  startDateTime: number | null = null,
  isParty: boolean | null = null,
): Promise<any[]> {
  if (!STRATZ_API_KEY) {
    logger.warn('STRATZ_API_KEY not set — cannot fetch turbo rank data');
    return [];
  }

  try {
    const response = await axios.post(
      STRATZ_GQL,
      {
        query: PLAYER_TURBO_MATCHES_QUERY,
        variables: { steamAccountId, take, skip, startDateTime, isParty },
      },
      {
        headers: {
          Authorization: `Bearer ${STRATZ_API_KEY}`,
          'Content-Type': 'application/json',
          'User-Agent': 'STRATZ_API',
          Accept: 'application/json',
        },
        timeout: 30000,
      },
    );

    if (response.data?.errors) {
      logger.warn(
        `Stratz turbo matches errors for ${steamAccountId}:`,
        JSON.stringify(response.data.errors),
      );
    }

    const matches = response.data?.data?.player?.matches ?? [];
    logger.debug(`Stratz returned ${matches.length} turbo matches for ${steamAccountId}`);
    return matches;
  } catch (error: any) {
    logger.error(
      `Stratz turbo matches fetch error for ${steamAccountId}:`,
      error?.response?.data ?? error?.message ?? error,
    );
    return [];
  }
}

const STRATZ_HEADERS = {
  Authorization: `Bearer ${STRATZ_API_KEY}`,
  'Content-Type': 'application/json',
  'User-Agent': 'STRATZ_API',
  Accept: 'application/json',
};

/** The player's most-played Turbo hero over their recent matches, or null. */
export async function fetchPlayerTopTurboHero(steamAccountId: number, sample = 40): Promise<number | null> {
  if (!STRATZ_API_KEY) return null;
  try {
    const response = await axios.post(
      STRATZ_GQL,
      {
        query: `query ($id: Long!, $take: Int!) { player(steamAccountId: $id) { matches(request: { gameModeIds: [23], take: $take, orderBy: DESC }) { players { steamAccountId heroId } } } }`,
        variables: { id: steamAccountId, take: sample },
      },
      { headers: STRATZ_HEADERS, timeout: 30000 },
    );
    const matches = response.data?.data?.player?.matches ?? [];
    const tally = new Map<number, number>();
    for (const m of matches) {
      const me = (m.players ?? []).find((p: any) => String(p.steamAccountId) === String(steamAccountId));
      if (me?.heroId != null) tally.set(me.heroId, (tally.get(me.heroId) ?? 0) + 1);
    }
    let top: number | null = null, best = 0;
    for (const [hero, n] of tally) if (n > best) { best = n; top = hero; }
    return top;
  } catch (error: any) {
    logger.error(`Stratz top-turbo-hero error for ${steamAccountId}:`, error?.response?.data ?? error?.message ?? error);
    return null;
  }
}

export interface TurboHeroMatchItems {
  matchId: number;
  durationSeconds: number;
  purchases: { time: number; itemId: number }[];
}

/** Bulk-fetches a player's Turbo matches on one hero, each with that player's item-purchase timings. */
export async function fetchPlayerHeroItemTimings(
  steamAccountId: number,
  heroId: number,
  take = 20,
): Promise<TurboHeroMatchItems[]> {
  if (!STRATZ_API_KEY) return [];
  try {
    const response = await axios.post(
      STRATZ_GQL,
      {
        query: `query ($id: Long!, $take: Int!) {
          player(steamAccountId: $id) {
            matches(request: { gameModeIds: [23], heroIds: [${Math.trunc(heroId)}], take: $take, orderBy: DESC }) {
              id
              durationSeconds
              players { steamAccountId stats { itemPurchases { time itemId } } }
            }
          }
        }`,
        variables: { id: steamAccountId, take },
      },
      { headers: STRATZ_HEADERS, timeout: 30000 },
    );
    if (response.data?.errors) {
      logger.warn(`Stratz hero item timings errors for ${steamAccountId}/${heroId}:`, JSON.stringify(response.data.errors).slice(0, 200));
    }
    const matches = response.data?.data?.player?.matches ?? [];
    return matches
      .map((m: any): TurboHeroMatchItems => {
        const me = (m.players ?? []).find((p: any) => String(p.steamAccountId) === String(steamAccountId));
        return { matchId: m.id, durationSeconds: m.durationSeconds ?? 0, purchases: me?.stats?.itemPurchases ?? [] };
      })
      .filter((x: TurboHeroMatchItems) => x.purchases.length > 0);
  } catch (error: any) {
    logger.error(`Stratz hero item timings fetch error for ${steamAccountId}/${heroId}:`, error?.response?.data ?? error?.message ?? error);
    return [];
  }
}

/**
 * Average item *completion* timings for a hero from Stratz (normal/ranked games — Stratz
 * does not track Turbo item timings). Returns itemId -> average purchase minute.
 * `itemFullPurchase` comes back as a week/bracket/time-bucket histogram, so we weight-average it.
 */
export async function fetchHeroItemBenchmarks(heroId: number): Promise<Map<number, number>> {
  if (!STRATZ_API_KEY) return new Map();
  try {
    const response = await axios.post(
      STRATZ_GQL,
      { query: `{ heroStats { itemFullPurchase(heroId: ${Math.trunc(heroId)}) { itemId time matchCount } } }` },
      { headers: STRATZ_HEADERS, timeout: 30000 },
    );
    const rows = response.data?.data?.heroStats?.itemFullPurchase ?? [];
    const acc = new Map<number, { t: number; n: number }>();
    for (const r of rows) {
      if (r?.time == null || !r?.matchCount) continue;
      const e = acc.get(r.itemId) ?? { t: 0, n: 0 };
      e.t += r.time * r.matchCount; // time is in minutes
      e.n += r.matchCount;
      acc.set(r.itemId, e);
    }
    const out = new Map<number, number>();
    for (const [id, { t, n }] of acc) if (n > 0) out.set(id, t / n);
    return out;
  } catch (error: any) {
    logger.error(`Stratz hero item benchmark error for ${heroId}:`, error?.response?.data ?? error?.message ?? error);
    return new Map();
  }
}

/** Resolves a Steam account's display name + current ranked medal via Stratz. */
export async function fetchStratzPlayerProfile(
  steamAccountId: number,
): Promise<{ name: string | null; seasonRank: number | null }> {
  if (!STRATZ_API_KEY) return { name: null, seasonRank: null };
  try {
    const response = await axios.post(
      STRATZ_GQL,
      {
        query: `query ($id: Long!) { player(steamAccountId: $id) { steamAccount { name seasonRank } } }`,
        variables: { id: steamAccountId },
      },
      {
        headers: {
          Authorization: `Bearer ${STRATZ_API_KEY}`,
          'Content-Type': 'application/json',
          'User-Agent': 'STRATZ_API',
          Accept: 'application/json',
        },
        timeout: 15000,
      },
    );
    const acc = response.data?.data?.player?.steamAccount;
    return { name: acc?.name ?? null, seasonRank: acc?.seasonRank ?? null };
  } catch (error: any) {
    logger.warn(`Stratz player profile fetch failed for ${steamAccountId}:`, error?.message ?? error);
    return { name: null, seasonRank: null };
  }
}

