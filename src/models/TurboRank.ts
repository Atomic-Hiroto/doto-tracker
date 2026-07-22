/** A single match data point for rank estimation. */
export interface TurboRankObservation {
  matchId: number;
  /** Average MMR of the *visible-ranked* other players in the lobby. */
  lobbyMMR: number;
  /** Average visible MMR of same-team players, excluding the tracked player. */
  allyMMR?: number | null;
  /** Average visible MMR of enemy players. */
  enemyMMR?: number | null;
  /** Visible ranked same-team players, excluding the tracked player. */
  allyVisibleRanks?: number;
  /** Visible ranked enemy players. */
  enemyVisibleRanks?: number;
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
  /** Whether the tracked player won the match (used only by Experimental V2, never the official estimate). */
  won?: boolean;
}

/** Non-authoritative estimator outputs used for comparison and validation only. */
export interface TurboRankExperimentalEstimate {
  /** Experimental estimator schema/version. Version 2 is the conservative latent model. */
  version: 2;
  /** The current production estimate, copied here as the raw baseline. */
  rawLobbyMMR: number;
  /** Robust lobby read using median/trimmed averaging to reduce outlier impact. */
  robustLobbyMMR: number;
  /** Team-balance inversion read before shrinkage, when side-complete games exist. */
  balanceInvertedMMR: number | null;
  /** Maximum 0.05 reliability weight applied to the balance inversion. */
  balanceWeight: number;
  /** Shrunk balance pull applied to robustLobbyMMR. */
  balanceAdjustment: number;
  /** Elo-likelihood adjustment applied after the robust/balance prior. */
  resultAdjustment: number;
  /** Matches with a known result used by the likelihood update. */
  resultSampleSize: number;
  /** Posterior SD of the result adjustment model; not total estimator uncertainty. */
  resultPosteriorSD: number;
  /** The experimental headline value. Not used for rank, lean, or leaderboards. */
  experimentalMMR: number;
  medal: string;
  /** experimentalMMR - estimatedMMR. */
  deltaFromCurrent: number;
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
  /**
   * True when there were no solo games in the last year, so the estimate reached
   * back to the player's last active turbo stretch (1 year up to their newest game).
   * Historical, not current form.
   */
  oldGamesFallback?: boolean;
  /** Player's visible *ranked* medal tier (rank_tier int) at compute time, if known. */
  rankedTier?: number | null;
  /** MMR derived from rankedTier (null when unranked / unknown). */
  rankedMMR?: number | null;
  /**
   * Turbo-lean: estimatedMMR − rankedMMR. The headline finding — how far above
   * (or below) their visible ranked medal the player actually plays in turbo.
   * Null when the player has no visible ranked medal to compare against.
   */
  lean?: number | null;
  /** Experimental comparison read. Not used for ranking or leaderboard ordering. */
  experimental?: TurboRankExperimentalEstimate;
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
  /**
   * True when this player was auto-added by peer discovery (a recurring teammate
   * of a seed player), rather than registered or manually calibrated. Hidden from
   * the default leaderboard; a manual `+turborank calibrate` clears the flag.
   */
  discovered?: boolean;
  observations: TurboRankObservation[];
  estimate: TurboRankEstimate | null;
}

/** Root shape of turboRankData.json */
export interface TurboRankData {
  players: TurboRankPlayerData[];
  /** Unix ms of last full calibration run. */
  lastCalibrated: number | null;
}
