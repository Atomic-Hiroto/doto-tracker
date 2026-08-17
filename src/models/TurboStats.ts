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
