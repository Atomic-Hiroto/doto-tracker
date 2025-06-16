export interface TurboPlayerStats {
  discordId: string;
  steamId: string;
  wins: number;
  losses: number;
  rating: number;
  lastUpdated: number;
}

export interface TurboPairing {
  player1: string; // discordId
  player2: string; // discordId
  wins: number;
  losses: number;
  rating: number;
  lastUpdated: number;
}

export interface TurboStatsData {
  playerStats: TurboPlayerStats[];
  pairings: TurboPairing[];
  lastProcessedMatch: number | null;
}