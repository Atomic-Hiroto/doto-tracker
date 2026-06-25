import axios from 'axios';
import { STRATZ_API_KEY } from '../constants/process';
import { logger } from './loggerService';

const STRATZ_GQL = 'https://api.stratz.com/graphql';

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
  won?: boolean;
  purchases: { time: number; itemId: number }[];
}

export interface TurboHeroPerformanceMatch extends TurboHeroMatchItems {
  position?: string | null;
  kills: number;
  deaths: number;
  assists: number;
  lastHits: number;
  gpm: number;
  xpm: number;
  heroDamage: number;
  towerDamage: number;
  heroHealing: number;
  wardsPlaced: number;
  wardsDestroyed: number;
  stacks: number;
}

export interface TurboDeepPlayerMatch {
  matchId: number;
  startDateTime: number;
  durationSeconds: number;
  won?: boolean;
  averageRank?: number | null;
  isParty: boolean;
  position?: string | null;
  heroId: number | null;
  kills: number;
  deaths: number;
  assists: number;
  lastHits: number;
  gpm: number;
  xpm: number;
  heroDamage: number;
  towerDamage: number;
  heroHealing: number;
  wardsPlaced: number;
  wardsDestroyed: number;
  stacks: number;
  otherRanks: number[];
  allyRanks: number[];
  enemyRanks: number[];
}

/** Bulk-fetches a player's Turbo matches on one hero, each with that player's item-purchase timings. */
export async function fetchPlayerHeroItemTimings(
  steamAccountId: number,
  heroId: number,
  take = 20,
  timeoutMs = 30000,
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
              didRadiantWin
              players { steamAccountId isRadiant stats { itemPurchases { time itemId } } }
            }
          }
        }`,
        variables: { id: steamAccountId, take },
      },
      { headers: STRATZ_HEADERS, timeout: timeoutMs },
    );
    if (response.data?.errors) {
      logger.warn(`Stratz hero item timings errors for ${steamAccountId}/${heroId}:`, JSON.stringify(response.data.errors).slice(0, 200));
    }
    const matches = response.data?.data?.player?.matches ?? [];
    return matches
      .map((m: any): TurboHeroMatchItems => {
        const me = (m.players ?? []).find((p: any) => String(p.steamAccountId) === String(steamAccountId));
        const won = typeof m.didRadiantWin === 'boolean' && typeof me?.isRadiant === 'boolean'
          ? me.isRadiant === m.didRadiantWin
          : undefined;
        return { matchId: m.id, durationSeconds: m.durationSeconds ?? 0, won, purchases: me?.stats?.itemPurchases ?? [] };
      })
      .filter((x: TurboHeroMatchItems) => x.purchases.length > 0);
  } catch (error: any) {
    logger.error(`Stratz hero item timings fetch error for ${steamAccountId}/${heroId}:`, error?.response?.data ?? error?.message ?? error);
    return [];
  }
}

/** Fetches recent Turbo matches for one player with rank, role, hero and impact stats. */
export async function fetchPlayerTurboDeepMatches(
  steamAccountId: number,
  take = 20,
  isParty = false,
  timeoutMs = 25000,
): Promise<TurboDeepPlayerMatch[]> {
  if (!STRATZ_API_KEY) return [];
  try {
    const response = await axios.post(
      STRATZ_GQL,
      {
        query: `query ($id: Long!, $take: Int!, $isParty: Boolean) {
          player(steamAccountId: $id) {
            matches(request: { gameModeIds: [23], take: $take, orderBy: DESC, isParty: $isParty }) {
              id
              startDateTime
              durationSeconds
              didRadiantWin
              averageRank
              players {
                steamAccountId
                isRadiant
                position
                heroId
                kills
                deaths
                assists
                numLastHits
                goldPerMinute
                experiencePerMinute
                heroDamage
                towerDamage
                heroHealing
                stats {
                  wards { time type }
                  wardDestruction { time gold }
                  campStack
                }
                steamAccount { seasonRank }
              }
            }
          }
        }`,
        variables: { id: steamAccountId, take, isParty },
      },
      { headers: STRATZ_HEADERS, timeout: timeoutMs },
    );
    if (response.data?.errors) {
      logger.warn(`Stratz deep turbo errors for ${steamAccountId}:`, JSON.stringify(response.data.errors).slice(0, 300));
    }

    const matches = response.data?.data?.player?.matches ?? [];
    return matches
      .map((m: any): TurboDeepPlayerMatch | null => {
        const players = m.players ?? [];
        const me = players.find((p: any) => String(p.steamAccountId) === String(steamAccountId));
        if (!me) return null;
        const won = typeof m.didRadiantWin === 'boolean' && typeof me.isRadiant === 'boolean'
          ? me.isRadiant === m.didRadiantWin
          : undefined;
        const otherRanks: number[] = [];
        const allyRanks: number[] = [];
        const enemyRanks: number[] = [];
        for (const p of players) {
          if (String(p.steamAccountId) === String(steamAccountId)) continue;
          const rank = Number(p.steamAccount?.seasonRank || 0);
          if (!rank) continue;
          otherRanks.push(rank);
          if (p.isRadiant === me.isRadiant) allyRanks.push(rank);
          else enemyRanks.push(rank);
        }
        return {
          matchId: m.id,
          startDateTime: Number(m.startDateTime || 0),
          durationSeconds: Number(m.durationSeconds || 0),
          won,
          averageRank: m.averageRank ?? null,
          isParty,
          position: POSITION_LABEL[me.position] ?? null,
          heroId: me.heroId == null ? null : Number(me.heroId),
          kills: Number(me.kills || 0),
          deaths: Number(me.deaths || 0),
          assists: Number(me.assists || 0),
          lastHits: Number(me.numLastHits || 0),
          gpm: Number(me.goldPerMinute || 0),
          xpm: Number(me.experiencePerMinute || 0),
          heroDamage: Number(me.heroDamage || 0),
          towerDamage: Number(me.towerDamage || 0),
          heroHealing: Number(me.heroHealing || 0),
          wardsPlaced: Array.isArray(me.stats?.wards) ? me.stats.wards.length : 0,
          wardsDestroyed: Array.isArray(me.stats?.wardDestruction) ? me.stats.wardDestruction.length : 0,
          stacks: Number(me.stats?.campStack || 0),
          otherRanks,
          allyRanks,
          enemyRanks,
        };
      })
      .filter((x: TurboDeepPlayerMatch | null): x is TurboDeepPlayerMatch => !!x && typeof x.won === 'boolean');
  } catch (error: any) {
    logger.error(`Stratz deep turbo fetch error for ${steamAccountId}:`, error?.response?.data ?? error?.message ?? error);
    return [];
  }
}

/** Fetches recent Turbo games on one hero with role-aware performance stats. */
export async function fetchPlayerHeroPerformance(
  steamAccountId: number,
  heroId: number,
  take = 15,
  timeoutMs = 15000,
): Promise<TurboHeroPerformanceMatch[]> {
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
              didRadiantWin
              players {
                steamAccountId
                isRadiant
                position
                kills
                deaths
                assists
                numLastHits
                goldPerMinute
                experiencePerMinute
                heroDamage
                towerDamage
                heroHealing
                stats {
                  wards { time type }
                  wardDestruction { time gold }
                  campStack
                  itemPurchases { time itemId }
                }
              }
            }
          }
        }`,
        variables: { id: steamAccountId, take },
      },
      { headers: STRATZ_HEADERS, timeout: timeoutMs },
    );
    if (response.data?.errors) {
      logger.warn(`Stratz hero performance errors for ${steamAccountId}/${heroId}:`, JSON.stringify(response.data.errors).slice(0, 200));
    }
    const matches = response.data?.data?.player?.matches ?? [];
    return matches
      .map((m: any): TurboHeroPerformanceMatch | null => {
        const me = (m.players ?? []).find((p: any) => String(p.steamAccountId) === String(steamAccountId));
        if (!me) return null;
        const won = typeof m.didRadiantWin === 'boolean' && typeof me.isRadiant === 'boolean'
          ? me.isRadiant === m.didRadiantWin
          : undefined;
        return {
          matchId: m.id,
          durationSeconds: Number(m.durationSeconds || 0),
          won,
          position: POSITION_LABEL[me.position] ?? null,
          kills: Number(me.kills || 0),
          deaths: Number(me.deaths || 0),
          assists: Number(me.assists || 0),
          lastHits: Number(me.numLastHits || 0),
          gpm: Number(me.goldPerMinute || 0),
          xpm: Number(me.experiencePerMinute || 0),
          heroDamage: Number(me.heroDamage || 0),
          towerDamage: Number(me.towerDamage || 0),
          heroHealing: Number(me.heroHealing || 0),
          wardsPlaced: Array.isArray(me.stats?.wards) ? me.stats.wards.length : 0,
          wardsDestroyed: Array.isArray(me.stats?.wardDestruction) ? me.stats.wardDestruction.length : 0,
          stacks: Number(me.stats?.campStack || 0),
          purchases: me.stats?.itemPurchases ?? [],
        };
      })
      .filter((x: TurboHeroPerformanceMatch | null): x is TurboHeroPerformanceMatch => !!x && typeof x.won === 'boolean');
  } catch (error: any) {
    logger.error(`Stratz hero performance fetch error for ${steamAccountId}/${heroId}:`, error?.response?.data ?? error?.message ?? error);
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
  const h = Math.trunc(heroId);
  try {
    const response = await axios.post(
      STRATZ_GQL,
      { query: `{ heroStats {
        itemFullPurchase(heroId: ${h}) { itemId time matchCount }
        itemBootPurchase(heroId: ${h}) { itemId time matchCount }
      } }` },
      { headers: STRATZ_HEADERS, timeout: 30000 },
    );
    const out = new Map<number, number>();

    // itemFullPurchase: histogram, `time` is a per-row MINUTE value -> weight-average by matchCount.
    const acc = new Map<number, { t: number; n: number }>();
    for (const r of response.data?.data?.heroStats?.itemFullPurchase ?? []) {
      if (r?.time == null || !r?.matchCount) continue;
      const e = acc.get(r.itemId) ?? { t: 0, n: 0 };
      e.t += r.time * r.matchCount;
      e.n += r.matchCount;
      acc.set(r.itemId, e);
    }
    for (const [id, { t, n }] of acc) if (n >= 200) out.set(id, t / n);

    // itemBootPurchase: one row per boot, `time` is TOTAL seconds -> avg seconds / 60 = minutes.
    const boot = new Map<number, { t: number; n: number }>();
    for (const r of response.data?.data?.heroStats?.itemBootPurchase ?? []) {
      if (r?.time == null || !r?.matchCount) continue;
      const e = boot.get(r.itemId) ?? { t: 0, n: 0 };
      e.t += r.time;
      e.n += r.matchCount;
      boot.set(r.itemId, e);
    }
    for (const [id, { t, n }] of boot) if (n >= 200) out.set(id, t / n / 60);

    return out;
  } catch (error: any) {
    logger.error(`Stratz hero item benchmark error for ${heroId}:`, error?.response?.data ?? error?.message ?? error);
    return new Map();
  }
}

// Stratz position enum -> short lane label (POSITION_1 safe carry … POSITION_5 hard support).
const POSITION_LABEL: Record<string, string> = {
  POSITION_1: 'Safelane',
  POSITION_2: 'Mid',
  POSITION_3: 'Offlane',
  POSITION_4: 'Soft Sup',
  POSITION_5: 'Hard Sup',
};

/**
 * The player's most-common Stratz-inferred position per Turbo hero, over recent matches.
 * One call covers the whole command. Returns heroId -> short label ("Mid", "Offlane", …).
 * Stratz infers position for every match (parsed or not), so coverage is good.
 */
export async function fetchPlayerTurboPositions(
  steamAccountId: number,
  take = 100,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!STRATZ_API_KEY) return out;
  try {
    const response = await axios.post(
      STRATZ_GQL,
      {
        query: `query ($id: Long!, $take: Int!) {
          player(steamAccountId: $id) {
            matches(request: { gameModeIds: [23], take: $take, orderBy: DESC }) {
              players { steamAccountId heroId position }
            }
          }
        }`,
        variables: { id: steamAccountId, take },
      },
      { headers: STRATZ_HEADERS, timeout: 30000 },
    );
    const matches = response.data?.data?.player?.matches ?? [];
    // Tally position votes per hero, then pick the plurality.
    const votes = new Map<number, Map<string, number>>();
    for (const m of matches) {
      const me = (m.players ?? []).find((p: any) => String(p.steamAccountId) === String(steamAccountId));
      const label = POSITION_LABEL[me?.position];
      if (me?.heroId == null || !label) continue;
      const tally = votes.get(me.heroId) ?? new Map<string, number>();
      tally.set(label, (tally.get(label) ?? 0) + 1);
      votes.set(me.heroId, tally);
    }
    for (const [heroId, tally] of votes) {
      let best = '', n = 0;
      for (const [label, count] of tally) if (count > n) { n = count; best = label; }
      if (best) out.set(heroId, best);
    }
    return out;
  } catch (error: any) {
    logger.error(`Stratz turbo positions error for ${steamAccountId}:`, error?.response?.data ?? error?.message ?? error);
    return out;
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

// ── Turbo meta by position (current patch / last 7 days) ─────────────────────

export interface TurboMetaPositionHero {
  heroId: number;
  matchCount: number;
  winCount: number;
}

/** Stratz position enum keys, in pos 1→5 order, used by the turbo meta query. */
export const TURBO_META_POSITIONS = ['POSITION_1', 'POSITION_2', 'POSITION_3', 'POSITION_4', 'POSITION_5'] as const;

/** RankBracket enum values, low→high (UNCALIBRATED excluded — it's not a skill tier). */
export const TURBO_META_BRACKETS = ['HERALD', 'GUARDIAN', 'CRUSADER', 'ARCHON', 'LEGEND', 'ANCIENT', 'DIVINE', 'IMMORTAL'] as const;

export interface TurboMetaOptions {
  /** RankBracket enum names to include (e.g. ['DIVINE','IMMORTAL']). Empty/undefined = all brackets. */
  brackets?: string[];
  /**
   * Use the wider 30-day window instead of the rolling 7-day one. Labelled "current patch"
   * because Turbo patches run for months, so the last 30 days are all the live patch.
   * NOTE: Stratz's per-version endpoint (`winGameVersion`) does not expose the current Turbo
   * patch (it lags by a version), and the only time-filterable endpoint (`stats`) can't filter
   * to Turbo — so true patch-boundary pinning isn't possible; a 30-day window is the best proxy.
   */
  patch?: boolean;
}

export interface TurboMetaResult {
  byPosition: Record<number, TurboMetaPositionHero[]>;
  /** Human-readable window label, e.g. "last 7 days" or "last 30 days". */
  windowLabel: string;
}

// Short-lived in-memory cache. The per-position meta barely moves hour-to-hour, but every
// call fires 5 aliased sub-queries — so we cache successful results by window+brackets for
// 45 min to spare the Stratz API (especially the default no-arg call everyone runs).
const TURBO_META_TTL_MS = 45 * 60 * 1000;
const turboMetaCache = new Map<string, { ts: number; result: TurboMetaResult }>();

/**
 * Per-position Turbo hero stats, via Stratz. Default uses `winWeek` (rolling 7 days); `opts.patch`
 * switches to `winMonth` (30 days) for a larger current-patch sample. Both endpoints return one
 * row per hero per medal bracket, so we sum across brackets to pool the requested rank range per
 * hero. `opts.brackets` filters to a rank range server-side. Empty positions on missing key/error.
 * Successful results are cached for 45 min (keyed by window + bracket filter).
 */
export async function fetchStratzTurboMetaByPosition(opts: TurboMetaOptions = {}): Promise<TurboMetaResult> {
  const out: Record<number, TurboMetaPositionHero[]> = {};
  for (let i = 1; i <= 5; i++) out[i] = [];
  if (!STRATZ_API_KEY) {
    logger.warn('STRATZ_API_KEY not set — skipping Stratz turbo meta fetch');
    return { byPosition: out, windowLabel: 'unavailable' };
  }

  const brackets = (opts.brackets ?? []).filter((b) => (TURBO_META_BRACKETS as readonly string[]).includes(b));
  const bracketArg = brackets.length ? `, bracketIds:[${brackets.join(',')}]` : '';
  const field = opts.patch ? 'winMonth' : 'winWeek';

  const cacheKey = `${field}|${[...brackets].sort().join(',')}`;
  const cached = turboMetaCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TURBO_META_TTL_MS) {
    return cached.result;
  }

  const aliases = TURBO_META_POSITIONS
    .map((pos, i) => `p${i + 1}: ${field}(gameModeIds:[TURBO], positionIds:[${pos}]${bracketArg}) { heroId matchCount winCount }`)
    .join('\n      ');
  const query = `{ heroStats {\n      ${aliases}\n  } }`;

  try {
    const response = await axios.post(
      STRATZ_GQL,
      { query },
      { headers: STRATZ_HEADERS, timeout: 30000 },
    );
    if (response.data?.errors) {
      logger.warn('Stratz turbo meta errors:', JSON.stringify(response.data.errors).slice(0, 300));
    }
    const hs = response.data?.data?.heroStats ?? {};

    for (let i = 1; i <= 5; i++) {
      const rows: any[] = hs[`p${i}`] ?? [];
      const agg = new Map<number, TurboMetaPositionHero>();
      for (const r of rows) {
        const heroId = Number(r.heroId);
        const e = agg.get(heroId) ?? { heroId, matchCount: 0, winCount: 0 };
        e.matchCount += r.matchCount || 0;
        e.winCount += r.winCount || 0;
        agg.set(heroId, e);
      }
      out[i] = [...agg.values()];
    }

    const result: TurboMetaResult = { byPosition: out, windowLabel: opts.patch ? 'last 30 days' : 'last 7 days' };
    // Only cache a result that actually carries data, so a transient empty response
    // doesn't get pinned for 45 min.
    if (Object.values(out).some((rows) => rows.length > 0)) {
      turboMetaCache.set(cacheKey, { ts: Date.now(), result });
    }
    return result;
  } catch (error: any) {
    logger.error('Stratz turbo meta fetch error:', error?.response?.data ?? error?.message ?? error);
    return { byPosition: out, windowLabel: 'unavailable' };
  }
}
