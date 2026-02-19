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
                    'User-Agent': 'doto-tracker-bot/1.0',
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
