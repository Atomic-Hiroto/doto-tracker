/** A single match data point for rank estimation. */
export interface TurboRankObservation {
  matchId: number;
  /** Weighted-average MMR of observable ranked players in the lobby. */
  lobbyMMR: number;
  /** How many party members the tracked player had (1 = solo). */
  partySize: number;
  /** Weight derived from party size (1.0 solo → 0.1 five-stack). */
  partyWeight: number;
  /** Unix epoch seconds when the match started. */
  timestamp: number;
  /** How many of the 10 players had visible rank data. */
  visibleRanks: number;
}

/** Computed rank estimate for a player. */
export interface TurboRankEstimate {
  /** Estimated hidden Turbo MMR (number on Dota's ~0-6000+ scale). */
  estimatedMMR: number;
  /** Medal tier (1 = Herald … 8 = Immortal). */
  medalTier: number;
  /** Stars within the medal (0-5). */
  stars: number;
  /** Human-readable medal string, e.g. "Archon 3". */
  medal: string;
  /** 0-100 confidence score based on effective sample size. */
  confidence: number;
  /** Total number of observations used. */
  sampleSize: number;
  /** Number of solo-queue observations. */
  soloSampleSize: number;
  /** Sum of all weights (effective sample). */
  effectiveSample: number;
  /** Unix ms when estimate was last computed. */
  lastUpdated: number;
}

/** Persisted per-player turbo rank data. */
export interface TurboRankPlayerData {
  discordId: string;
  steamId: string;
  observations: TurboRankObservation[];
  estimate: TurboRankEstimate | null;
}

/** Root shape of turboRankData.json */
export interface TurboRankData {
  players: TurboRankPlayerData[];
  /** Unix ms of last full calibration run. */
  lastCalibrated: number | null;
}
