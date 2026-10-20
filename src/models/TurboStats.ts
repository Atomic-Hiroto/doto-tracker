export type TurboStatsScope = 'all' | 'tracked' | 'history';
export type TurboMatchSource = 'live' | 'historical' | 'both';

export interface TurboPlayerStats {
  discordId: string;
  steamId: string;
  wins: number;
  losses: number;
  rating: number;
  lastUpdated: number;
}

export interface TurboPairing {
  player1: string;
  player2: string;
  wins: number;
  losses: number;
  rating: number;
  /** 5th-percentile lower bound of the Beta posterior behind `rating`; the sort key. */
  confidenceFloor?: number;
  lastUpdated: number;
  liveGames?: number;
  historicalGames?: number;
  verifiedPartyGames?: number;
}

export interface TurboMatchParticipant {
  discordId: string;
  steamId: string;
  team: 'radiant' | 'dire';
  partyId: number | null;
}

export interface TurboTrackedMatch {
  matchId: string;
  timestamp: number;
  radiantWon: boolean;
  /**
   * Average lobby rank, on the source's own scale — Stratz `averageRank`, OpenDota `avg_rank_tier`.
   * Stored raw and unnormalised: nothing reads it yet, and the two scales must be reconciled before
   * anything does. Captured now so it lands on the next backfill rather than needing another one.
   */
  averageRank?: number | null;
  /**
   * Average visible ranked medal of the team facing our players, as MMR, and how many of its five
   * showed one. Null when we sat on both sides or nobody showed a medal. Stratz reports each
   * player's current season medal, so on an old match this is who they are now, not who they were.
   */
  enemyRank?: { mmr: number; visible: number } | null;
  /**
   * Unregistered players on the tracked players' team, so `+turboparty` can see the friends who fill
   * a stack. Kept apart from `players` so no win-rate or pairing board counts them. Absent on
   * matches stored before it existed (a backfill fills it), empty when we sat on both sides.
   */
  teammates?: { steamId: string; name?: string }[];
  source: TurboMatchSource;
  players: TurboMatchParticipant[];
}

export interface TurboStatsData {
  playerStats: TurboPlayerStats[];
  pairings: TurboPairing[];
  lastProcessedMatch: number | null;
  matches?: TurboTrackedMatch[];
  ledgerVersion?: number;
  statsBuiltFromLedger?: boolean;
  lastBackfillAt?: number;
  /** Snapshot of the pre-ledger tracked aggregate, retained for the default view. */
  legacyTrackedPairings?: TurboPairing[];
}

export interface TurboPartyRecommendation {
  playerIds: string[];
  predictedWinRate: number;
  lowWinRate: number;
  highWinRate: number;
  score: number;
  coveredPairs: number;
  totalPairs: number;
  averagePairGames: number;
  exactLineupGames: number;
  exactLineupWins: number;
  /** Lineups that cleared the evidence filter and were ranked against this one. */
  evaluatedLineups: number;
  /** How many of those sit inside the leader's confidence interval. */
  indistinguishableLineups: number;
  strongestPair?: TurboPairing;
  weakestPair?: TurboPairing;
}
