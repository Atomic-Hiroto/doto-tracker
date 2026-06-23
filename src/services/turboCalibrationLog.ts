import fs from 'fs';
import { logger } from './loggerService';
import { TurboRankEstimate, TurboRankPlayerData } from '../models/TurboRank';

/**
 * Append-only log of every turbo-rank estimate we compute, each stamped with the
 * player's *visible ranked medal at that moment*. This is the validation loop:
 * it costs almost nothing now, and over a season — once players' real ranked
 * medals shift — it lets us measure predicted-vs-actual instead of arguing about
 * accuracy. Nothing here changes the live `+turborank` output; it only records.
 */

const HISTORY_FILE = 'turboCalibrationHistory.json';
const MAX_SNAPSHOTS = 5000;

export interface CalibrationSnapshot {
  steamId: string;
  steamName?: string;
  /** Unix ms when the estimate was computed. */
  ts: number;
  estimatedMMR: number;
  medal: string;
  medalTier: number;
  confidence: number;
  partyFallback: boolean;
  soloSampleSize: number;
  /** Visible ranked medal tier (rank_tier int) at snapshot time, if any. */
  rankedTier: number | null;
  rankedMMR: number | null;
  /** estimatedMMR − rankedMMR (the turbo-lean), null when unranked. */
  lean: number | null;
  /** Experimental estimator value, if populated. Not used by live ranking. */
  experimentalMMR?: number | null;
  /** experimentalMMR − estimatedMMR, if populated. */
  experimentalDelta?: number | null;
}

interface HistoryFile {
  snapshots: CalibrationSnapshot[];
}

function load(): HistoryFile {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (err) {
    logger.error('Error loading turbo calibration history:', err);
  }
  return { snapshots: [] };
}

/** Record one estimate. De-dupes back-to-back identical snapshots for a player. */
export function logCalibrationSnapshot(player: TurboRankPlayerData, estimate: TurboRankEstimate): void {
  try {
    const history = load();

    const snapshot: CalibrationSnapshot = {
      steamId: player.steamId,
      steamName: player.steamName,
      ts: Date.now(),
      estimatedMMR: estimate.estimatedMMR,
      medal: estimate.medal,
      medalTier: estimate.medalTier,
      confidence: estimate.confidence,
      partyFallback: estimate.partyFallback,
      soloSampleSize: estimate.soloSampleSize,
      rankedTier: estimate.rankedTier ?? null,
      rankedMMR: estimate.rankedMMR ?? null,
      lean: estimate.lean ?? null,
      experimentalMMR: estimate.experimental?.experimentalMMR ?? null,
      experimentalDelta: estimate.experimental?.deltaFromCurrent ?? null,
    };

    // Skip if the previous snapshot for this player is identical in the fields
    // that matter (avoids noise when calibrate is run repeatedly with no change).
    const prev = [...history.snapshots].reverse().find(s => s.steamId === player.steamId);
    if (
      prev &&
      prev.estimatedMMR === snapshot.estimatedMMR &&
      prev.rankedTier === snapshot.rankedTier &&
      prev.confidence === snapshot.confidence
    ) {
      return;
    }

    history.snapshots.push(snapshot);
    if (history.snapshots.length > MAX_SNAPSHOTS) {
      history.snapshots = history.snapshots.slice(-MAX_SNAPSHOTS);
    }
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    logger.error('Error writing turbo calibration snapshot:', err);
  }
}

export function loadCalibrationHistory(): CalibrationSnapshot[] {
  return load().snapshots;
}

export interface RankChangeEvent {
  steamId: string;
  steamName?: string;
  /** Ranked tier before and after the change. */
  fromTier: number;
  toTier: number;
  fromMMR: number;
  toMMR: number;
  /** Our turbo estimate just *before* the ranked medal moved. */
  predictedMMR: number;
  /** Signed error: predictedMMR − new actual ranked MMR. */
  errorMMR: number;
  ts: number;
}

/**
 * Walk each player's snapshot timeline and surface every time their *visible
 * ranked medal* actually moved. For each move we keep the turbo estimate from
 * just before it, so `errorMMR` measures how well the turbo read anticipated the
 * new ranked reality — the real accuracy signal, free of the stale-medal problem.
 */
export function detectRankChanges(): RankChangeEvent[] {
  const history = loadCalibrationHistory();
  const byPlayer = new Map<string, CalibrationSnapshot[]>();
  for (const s of history) {
    if (!byPlayer.has(s.steamId)) byPlayer.set(s.steamId, []);
    byPlayer.get(s.steamId)!.push(s);
  }

  const events: RankChangeEvent[] = [];
  for (const snaps of byPlayer.values()) {
    snaps.sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < snaps.length; i++) {
      const prev = snaps[i - 1];
      const cur = snaps[i];
      if (
        prev.rankedTier != null && cur.rankedTier != null &&
        prev.rankedMMR != null && cur.rankedMMR != null &&
        prev.rankedTier !== cur.rankedTier
      ) {
        events.push({
          steamId: cur.steamId,
          steamName: cur.steamName,
          fromTier: prev.rankedTier,
          toTier: cur.rankedTier,
          fromMMR: prev.rankedMMR,
          toMMR: cur.rankedMMR,
          predictedMMR: prev.estimatedMMR,
          errorMMR: prev.estimatedMMR - cur.rankedMMR,
          ts: cur.ts,
        });
      }
    }
  }
  return events;
}

/** Aggregate accuracy across all observed ranked moves. Null until we have data. */
export function summarizeValidation(): {
  events: number;
  players: number;
  meanAbsError: number;
  meanSignedError: number;
} | null {
  const events = detectRankChanges();
  if (events.length === 0) return null;
  const abs = events.reduce((s, e) => s + Math.abs(e.errorMMR), 0) / events.length;
  const signed = events.reduce((s, e) => s + e.errorMMR, 0) / events.length;
  return {
    events: events.length,
    players: new Set(events.map(e => e.steamId)).size,
    meanAbsError: Math.round(abs),
    meanSignedError: Math.round(signed),
  };
}
