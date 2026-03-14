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
    gameMode
    lobbyType
    averageRank
    firstBloodTime
    radiantKills
    direKills
    towerDeaths {
      time
      isRadiant
    }
    chatEvents {
      time
      type
      fromHeroId
      value
      isRadiant
    }
    topLaneOutcome
    midLaneOutcome
    bottomLaneOutcome
    radiantNetworthLeads
    radiantExperienceLeads
    winRates
    predictedWinRates
    roshanEvents {
      time
      type
      isBoost
      isRadiant
    }
    buildingEvents {
      time
      type
      isRadiant
      npcResId
    }
    pickBans {
      isPick
      isRadiant
      heroId
      order
    }
    players {
      steamAccountId
      playerSlot
      isRadiant
      imp
      award
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
      behavior
      intentionalFeeding
      invisibleSeconds
      goldPerMinute
      experiencePerMinute
      item0Id item1Id item2Id item3Id item4Id item5Id
      backpack0Id backpack1Id backpack2Id neutral0Id
      abilities {
        abilityId
        level
        time
        isTalent
      }
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
        impPerMinute
        courierKills {
          time
        }
        tripsFountainPerMinute
        wardDestruction {
          time
          gold
        }
        campStack
        runes {
          time
          rune
          action
        }
        wards {
          time
          type
        }
        killEvents {
          time
          target
          assist
          isSolo
          isSmoke
        }
        deathEvents {
          time
        }
        itemEvents {
          time
          itemId
          purchaseTime
          isEnchanted
        }
        farmDistributionReport {
          creepType { count gold xp }
          buildings { count gold xp }
          bountyGold { count gold xp }
          other { count gold xp }
        }
        abilityCastReport {
          abilityId
          count
        }
        heroDamageReport {
          dealtTotal { physicalDamage magicalDamage pureDamage }
          receivedTotal { physicalDamage magicalDamage pureDamage }
        }
      }
      hero {
        id
        displayName
        shortName
      }
      steamAccount {
        name
        seasonRank
      }
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
        timeout: 15000,
      }
    );

    if (response.data?.errors) {
      logger.error(`Stratz API GraphQL Errors for match ${matchId}:`, response.data.errors);
      return null;
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

