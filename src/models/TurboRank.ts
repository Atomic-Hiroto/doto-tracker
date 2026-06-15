/** A single match data point for rank estimation. */
export interface TurboRankObservation {
  matchId: number;
  /** Average MMR of the *visible-ranked* other players in the lobby. */
  lobbyMMR: number;
  /** How many party members the tracked player had (1 = solo). */
  partySize: number;
  /** Weight derived from party size (1.0 solo → 0.001 five-stack). Only used in party fallback. */
  partyWeight: number;
  /** Unix epoch seconds when the match started. */
  timestamp: number;
  /** How many of the 9 other players had visible rank data (drives reliability weight). */
  visibleRanks: number;
  /** Raw rank_tier ints of the visible other players (for lobby composition display). */
  tiers: number[];
  /** Whether the tracked player won the match (display only — not used in the estimate). */
  won?: boolean;
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
  /** Low/high medal of the confidence range (e.g. "Legend 4" … "Ancient 2"). */
  rangeLow: string;
  rangeHigh: string;
  /** 0-100 confidence score based on visible-rank-weighted effective sample. */
  confidence: number;
  /** Total number of observations used. */
  sampleSize: number;
  /** Number of solo-queue observations. */
  soloSampleSize: number;
  /** Visible-rank-weighted effective sample. */
  effectiveSample: number;
  /** True when the estimate had to fall back to party games (player never solo-queues). */
  partyFallback: boolean;
  /** Unix ms when estimate was last computed. */
  lastUpdated: number;
}

/** Persisted per-player turbo rank data. */
export interface TurboRankPlayerData {
  /** Discord id when registered; '' for an unregistered (steamId-only) player. */
  discordId: string;
  steamId: string;
  /** Resolved Stratz display name (so unregistered players show a name, not an id). */
  steamName?: string;
  observations: TurboRankObservation[];
  estimate: TurboRankEstimate | null;
}

/** Root shape of turboRankData.json */
export interface TurboRankData {
  players: TurboRankPlayerData[];
  /** Unix ms of last full calibration run. */
  lastCalibrated: number | null;
}
