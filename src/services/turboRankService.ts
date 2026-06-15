import fs from 'fs';
import { logger } from './loggerService';
import { opendotaClient } from './apiClient';
import {
  TurboRankData,
  TurboRankPlayerData,
  TurboRankObservation,
  TurboRankEstimate,
} from '../models/TurboRank';
import { fetchPlayerTurboMatches } from './stratzClient';

const TURBO_RANK_FILE = 'turboRankData.json';
const TURBO_GAME_MODE = 23;

// ── Medal / MMR conversion tables ────────────────────────────────────────────

/** Approximate MMR floor for each medal tier (1-indexed). */
const MEDAL_MMR_FLOORS: Record<number, number> = {
  1: 0,     // Herald
  2: 770,   // Guardian
  3: 1540,  // Crusader
  4: 2310,  // Archon
  5: 3080,  // Legend
  6: 3850,  // Ancient
  7: 4620,  // Divine
  8: 5420,  // Immortal
};

const MEDAL_NAMES: Record<number, string> = {
  1: 'Herald',
  2: 'Guardian',
  3: 'Crusader',
  4: 'Archon',
  5: 'Legend',
  6: 'Ancient',
  7: 'Divine',
  8: 'Immortal',
};

/** MMR per star within a medal tier (~154 per 2 stars ≈ 77 per star). */
const MMR_PER_STAR = 77;

/** Party-size to observation weight. Solo = strongest signal.
 *  Spread is aggressive: a single solo game is worth 50× a 5-stack game. */
const PARTY_WEIGHTS: Record<number, number> = {
  1: 1.0,
  2: 0.45,
  3: 0.15,
  4: 0.05,
  5: 0.02,
};

/** Half-life for recency decay in days. */
const RECENCY_HALF_LIFE_DAYS = 90;

/** Minimum visible ranks in a match to consider it a useful observation. */
const MIN_VISIBLE_RANKS = 3;

/** Max observations to keep per player (oldest pruned on save). */
const MAX_OBSERVATIONS = 200;

// ── Conversion helpers ───────────────────────────────────────────────────────

/** Convert a Dota rank_tier integer (e.g. 42 = Archon 2) to an MMR estimate. */
export function rankTierToMMR(rankTier: number): number | null {
  if (!rankTier || rankTier <= 0) return null;
  const tier = Math.floor(rankTier / 10);
  const stars = rankTier % 10;
  const floor = MEDAL_MMR_FLOORS[tier];
  if (floor == null) return null;
  return floor + stars * MMR_PER_STAR;
}

/** Convert an MMR number to { tier, stars, medal } */
export function mmrToMedal(mmr: number): { tier: number; stars: number; medal: string } {
  // Walk tiers from highest to lowest
  for (let t = 8; t >= 1; t--) {
    if (mmr >= MEDAL_MMR_FLOORS[t]) {
      const starsRaw = Math.round((mmr - MEDAL_MMR_FLOORS[t]) / MMR_PER_STAR);
      const stars = Math.min(Math.max(starsRaw, 0), t === 8 ? 0 : 5);
      const name = MEDAL_NAMES[t];
      return {
        tier: t,
        stars,
        medal: stars > 0 ? `${name} ${stars}` : name,
      };
    }
  }
  return { tier: 1, stars: 0, medal: 'Herald' };
}

/** Star characters for medal display. */
function starString(stars: number): string {
  return stars > 0 ? ' ' + '★'.repeat(stars) : '';
}

// ── Service ──────────────────────────────────────────────────────────────────

export class TurboRankService {
  private data: TurboRankData = { players: [], lastCalibrated: null };

  constructor() {
    this.load();
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  private load() {
    try {
      if (fs.existsSync(TURBO_RANK_FILE)) {
        this.data = JSON.parse(fs.readFileSync(TURBO_RANK_FILE, 'utf8'));
        logger.info(`Turbo rank data loaded — ${this.data.players.length} players`);
      }
    } catch (err) {
      logger.error('Error loading turbo rank data:', err);
      this.data = { players: [], lastCalibrated: null };
    }
  }

  private save() {
    try {
      // Prune old observations on save
      for (const p of this.data.players) {
        if (p.observations.length > MAX_OBSERVATIONS) {
          p.observations = p.observations
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, MAX_OBSERVATIONS);
        }
      }
      fs.writeFileSync(TURBO_RANK_FILE, JSON.stringify(this.data, null, 2));
    } catch (err) {
      logger.error('Error saving turbo rank data:', err);
    }
  }

  private getOrCreatePlayer(discordId: string, steamId: string): TurboRankPlayerData {
    let player = this.data.players.find(p => p.steamId === steamId);
    if (!player) {
      player = { discordId, steamId, observations: [], estimate: null };
      this.data.players.push(player);
    }
    // Keep discordId in sync
    player.discordId = discordId;
    return player;
  }

  // ── Observation extraction ───────────────────────────────────────────────

  /**
   * Given full match data (OpenDota format), extract a rank observation for
   * one tracked player. Returns null if insufficient rank data.
   */
  extractObservationFromOpenDota(
    matchData: any,
    steamId: string,
  ): TurboRankObservation | null {
    if (matchData.game_mode !== TURBO_GAME_MODE) return null;

    const players: any[] = matchData.players || [];
    const trackedPlayer = players.find(
      (p: any) => p.account_id && String(p.account_id) === String(steamId),
    );
    if (!trackedPlayer) return null;

    // Determine party size
    const partySize = this.computePartySizeOpenDota(players, trackedPlayer);

    // Collect observable ranks from the OTHER 9 players in the lobby.
    // We deliberately exclude the tracked player's own ranked medal because
    // it may be stale or reflect a completely different MMR than their hidden
    // Turbo rank. We want to see where the matchmaker placed them.
    const mmrValues: number[] = [];
    for (const p of players) {
      // Skip the tracked player
      if (p.account_id && String(p.account_id) === String(steamId)) continue;
      const mmr = rankTierToMMR(p.rank_tier);
      if (mmr != null) mmrValues.push(mmr);
    }

    if (mmrValues.length < MIN_VISIBLE_RANKS) return null;

    const lobbyMMR = mmrValues.reduce((s, v) => s + v, 0) / mmrValues.length;
    const partyWeight = PARTY_WEIGHTS[Math.min(partySize, 5)] ?? 0.1;

    return {
      matchId: matchData.match_id,
      lobbyMMR: Math.round(lobbyMMR),
      partySize,
      partyWeight,
      timestamp: matchData.start_time || Math.floor(Date.now() / 1000),
      visibleRanks: mmrValues.length,
    };
  }

  /**
   * Extract observation from Stratz match data (used during calibration).
   */
  extractObservationFromStratz(
    match: any,
    steamAccountId: number,
    isSoloOverride?: boolean,
  ): TurboRankObservation | null {
    const players: any[] = match.players || [];
    const trackedPlayer = players.find(
      (p: any) => p.steamAccountId === steamAccountId,
    );
    if (!trackedPlayer) return null;

    // Party size from partyId
    let partySize = this.computePartySizeStratz(players, trackedPlayer);
    if (isSoloOverride === true) {
      partySize = 1;
    } else if (isSoloOverride === false && partySize <= 1) {
      // If we know this was a party match, but partyId calculation yielded 1 (due to Stratz parse omissions),
      // treat it as default party size 3 (discounted).
      partySize = 3;
    }

    // Collect MMR values from the OTHER 9 players (exclude tracked player's
    // own ranked medal — it may be outdated or not reflect turbo skill).
    const mmrValues: number[] = [];
    for (const p of players) {
      // Skip the tracked player
      if (p.steamAccountId === steamAccountId) continue;
      const rank = p.steamAccount?.seasonRank;
      if (rank) {
        const mmr = rankTierToMMR(rank);
        if (mmr != null) mmrValues.push(mmr);
      }
    }

    if (mmrValues.length < MIN_VISIBLE_RANKS) return null;

    const lobbyMMR = mmrValues.reduce((s, v) => s + v, 0) / mmrValues.length;
    const partyWeight = PARTY_WEIGHTS[Math.min(partySize, 5)] ?? 0.1;

    return {
      matchId: match.id,
      lobbyMMR: Math.round(lobbyMMR),
      partySize,
      partyWeight,
      timestamp: match.startDateTime || Math.floor(Date.now() / 1000),
      visibleRanks: mmrValues.length,
    };
  }

  private computePartySizeOpenDota(players: any[], trackedPlayer: any): number {
    const partyId = trackedPlayer.party_id;
    // party_id is null or 0 for solo players
    if (partyId == null || partyId === 0) return 1;
    const sameParty = players.filter(p => p.party_id === partyId).length;
    // If only 1 player has this partyId, they're solo
    return sameParty <= 1 ? 1 : sameParty;
  }

  private computePartySizeStratz(players: any[], trackedPlayer: any): number {
    const partyId = trackedPlayer.partyId;
    // partyId is null or 0 for solo players
    if (partyId == null || partyId === 0) return 1;
    const sameParty = players.filter((p: any) => p.partyId === partyId).length;
    // If only 1 player has this partyId, they're solo
    return sameParty <= 1 ? 1 : sameParty;
  }

  // ── Estimate computation ─────────────────────────────────────────────────

  private computeEstimate(observations: TurboRankObservation[]): TurboRankEstimate | null {
    if (observations.length === 0) return null;

    const now = Date.now() / 1000; // current time in seconds
    const decayLambda = Math.LN2 / (RECENCY_HALF_LIFE_DAYS * 86400);

    let weightedSum = 0;
    let totalWeight = 0;
    let soloCount = 0;

    for (const obs of observations) {
      const ageSec = Math.max(0, now - obs.timestamp);
      const recencyWeight = Math.exp(-decayLambda * ageSec);
      const w = obs.partyWeight * recencyWeight;
      weightedSum += obs.lobbyMMR * w;
      totalWeight += w;
      if (obs.partySize === 1) soloCount++;
    }

    if (totalWeight === 0) return null;

    const estimatedMMR = Math.round(weightedSum / totalWeight);
    const { tier, stars, medal } = mmrToMedal(estimatedMMR);

    // Confidence is a blend of effective sample weight AND solo-game presence.
    // Without solo games, confidence is capped at 35% because party games
    // heavily distort the signal.
    const rawConf = Math.min(100, Math.round((totalWeight / 15) * 100));
    const soloBonus = soloCount >= 10 ? 1.0 : soloCount >= 5 ? 0.85 : soloCount >= 1 ? 0.6 : 0.35;
    const confidence = Math.min(100, Math.round(rawConf * soloBonus));

    return {
      estimatedMMR,
      medalTier: tier,
      stars,
      medal,
      confidence,
      sampleSize: observations.length,
      soloSampleSize: soloCount,
      effectiveSample: Math.round(totalWeight * 100) / 100,
      lastUpdated: Date.now(),
    };
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /** Process a single new match (called from match loop). */
  updateFromMatch(matchData: any, discordId: string, steamId: string): void {
    try {
      const obs = this.extractObservationFromOpenDota(matchData, steamId);
      if (!obs) return;

      const player = this.getOrCreatePlayer(discordId, steamId);

      // Deduplicate
      if (player.observations.some(o => o.matchId === obs.matchId)) return;

      player.observations.push(obs);
      player.estimate = this.computeEstimate(player.observations);
      this.save();

      logger.info(
        `Turbo rank updated for ${discordId}: ${player.estimate?.medal ?? '?'} ` +
        `(MMR ~${player.estimate?.estimatedMMR ?? '?'}, confidence ${player.estimate?.confidence ?? 0}%, ` +
        `party=${obs.partySize}, lobby=${obs.lobbyMMR})`,
      );
    } catch (err) {
      logger.error(`Error updating turbo rank for ${discordId}:`, err);
    }
  }

  /**
   * Retroactive calibration from Stratz:
   *  1. Fetches recent solo matches (isParty: false) from the last 1 year (up to 100 matches).
   *  2. If solo matches count is < 15, fetches recent party matches (isParty: true) from the last 1 year (up to 100 matches).
   *  3. Fallback to older matches (no date filter, mix of solo/party) if the player is inactive.
   *  4. Handles overrides during parsing to prevent misclassifying party matches with missing party IDs as solo.
   */
  async calibratePlayer(
    discordId: string,
    steamId: string,
    take = 100,
    onProgress?: (fetched: number, total: number, phase?: string) => void,
  ): Promise<TurboRankEstimate | null> {
    const steamAccountId = parseInt(steamId, 10);
    if (isNaN(steamAccountId)) {
      logger.warn(`Invalid steamId for calibration: ${steamId}`);
      return null;
    }

    try {
      const oneYearAgo = Math.floor(Date.now() / 1000) - 365 * 24 * 3600;
      let finalMatches: Array<{ match: any; isSolo?: boolean }> = [];

      // Pass 1: Fetch solo matches (isParty: false) from the last 1 year
      onProgress?.(0, 0, 'Fetching recent solo matches (last 1 year)…');
      const soloMatches = await fetchPlayerTurboMatches(steamAccountId, 100, 0, oneYearAgo, false);
      logger.info(`Stratz solo matches (last 1 year) fetched: ${soloMatches.length} for ${steamId}`);
      
      for (const m of soloMatches) {
        finalMatches.push({ match: m, isSolo: true });
      }

      // Pass 2: If we have fewer than 15 solo matches, fetch recent party matches (isParty: true) from the last 1 year
      if (finalMatches.length < 15) {
        onProgress?.(0, 0, 'Fetching recent party matches (last 1 year)…');
        const partyMatches = await fetchPlayerTurboMatches(steamAccountId, 100, 0, oneYearAgo, true);
        logger.info(`Stratz party matches (last 1 year) fetched: ${partyMatches.length} for ${steamId}`);
        
        for (const m of partyMatches) {
          finalMatches.push({ match: m, isSolo: false });
        }
      }

      // Fallback: if no matches in the last 1 year, fetch older matches (up to 100, mix of solo/party)
      if (finalMatches.length === 0) {
        logger.info(`No Stratz matches in last year, falling back to older matches for ${steamId}`);
        onProgress?.(0, 0, 'No recent matches. Fetching older matches…');
        const fallbackMatches = await fetchPlayerTurboMatches(steamAccountId, 100, 0, null, null);
        for (const m of fallbackMatches) {
          finalMatches.push({ match: m });
        }
      }

      // Deduplicate by match ID, keeping the solo match entry first if there's any overlap
      const seenIds = new Set<number>();
      const merged: Array<{ match: any; isSolo?: boolean }> = [];
      for (const item of finalMatches) {
        if (!seenIds.has(item.match.id)) {
          seenIds.add(item.match.id);
          merged.push(item);
        }
      }

      if (merged.length === 0) {
        logger.info(`No Stratz turbo matches found for ${steamId}`);
        return this.calibratePlayerOpenDota(discordId, steamId, take, onProgress);
      }

      const player = this.getOrCreatePlayer(discordId, steamId);
      // Clear old observations for a fresh calibration
      player.observations = [];
      let added = 0;

      for (let i = 0; i < merged.length; i++) {
        const item = merged[i];
        onProgress?.(i + 1, merged.length, 'Processing matches…');

        const obs = this.extractObservationFromStratz(item.match, steamAccountId, item.isSolo);
        if (obs) {
          player.observations.push(obs);
          added++;
        }
      }

      player.estimate = this.computeEstimate(player.observations);
      this.data.lastCalibrated = Date.now();
      this.save();

      const soloObs = player.observations.filter(o => o.partySize === 1).length;
      logger.info(
        `Calibration for ${discordId}: ${added} observations (${soloObs} solo) from ${merged.length} matches. ` +
        `Estimate: ${player.estimate?.medal ?? 'N/A'} (MMR ~${player.estimate?.estimatedMMR ?? '?'})`,
      );

      return player.estimate;
    } catch (err) {
      logger.error(`Stratz calibration failed for ${steamId}, falling back to OpenDota:`, err);
      return this.calibratePlayerOpenDota(discordId, steamId, take, onProgress);
    }
  }

  private async calibratePlayerOpenDota(
    discordId: string,
    steamId: string,
    take: number,
    onProgress?: (fetched: number, total: number, phase?: string) => void,
  ): Promise<TurboRankEstimate | null> {
    try {
      // Fetch recent turbo matches via OpenDota
      const resp = await opendotaClient.get<any[]>(
        `/players/${steamId}/matches`,
        { params: { game_mode: TURBO_GAME_MODE, limit: take } },
      );
      const matchList = resp.data || [];
      if (matchList.length === 0) return null;

      const player = this.getOrCreatePlayer(discordId, steamId);
      let added = 0;

      for (let i = 0; i < matchList.length; i++) {
        const m = matchList[i];
        onProgress?.(i + 1, matchList.length, 'Fetching match details from OpenDota…');

        if (player.observations.some(o => o.matchId === m.match_id)) continue;

        try {
          // Fetch full match details for rank_tier data
          const detail = await opendotaClient.get(`/matches/${m.match_id}`);
          const obs = this.extractObservationFromOpenDota(detail.data, steamId);
          if (obs) {
            player.observations.push(obs);
            added++;
          }
        } catch (fetchErr) {
          logger.warn(`Failed to fetch match ${m.match_id} during calibration:`, fetchErr);
        }

        // Rate limit: 60 calls / minute for free OpenDota
        if (i < matchList.length - 1) {
          await new Promise(r => setTimeout(r, 1200));
        }
      }

      player.estimate = this.computeEstimate(player.observations);
      this.data.lastCalibrated = Date.now();
      this.save();

      logger.info(
        `OpenDota calibration for ${discordId}: ${added} new observations from ${matchList.length} matches. ` +
        `Estimate: ${player.estimate?.medal ?? 'N/A'}`,
      );

      return player.estimate;
    } catch (err) {
      logger.error(`OpenDota calibration failed for ${steamId}:`, err);
      return null;
    }
  }

  /** Get the current estimate for a player. */
  getEstimate(discordId: string): TurboRankEstimate | null {
    const player = this.data.players.find(p => p.discordId === discordId);
    return player?.estimate ?? null;
  }

  /** Get the current estimate by steamId. */
  getEstimateBySteamId(steamId: string): TurboRankEstimate | null {
    const player = this.data.players.find(p => p.steamId === steamId);
    return player?.estimate ?? null;
  }

  /** Get all players with estimates, sorted by MMR descending. */
  getAllEstimates(): Array<{ discordId: string; steamId: string; estimate: TurboRankEstimate }> {
    return this.data.players
      .filter(p => p.estimate != null)
      .map(p => ({ discordId: p.discordId, steamId: p.steamId, estimate: p.estimate! }))
      .sort((a, b) => b.estimate.estimatedMMR - a.estimate.estimatedMMR);
  }

  /** Get raw observation data for a player (for debug / detailed view). */
  getObservations(discordId: string): TurboRankObservation[] {
    const player = this.data.players.find(p => p.discordId === discordId);
    return player?.observations ?? [];
  }

  /** Format an estimate as a short string for embedding in other commands. */
  static formatShort(estimate: TurboRankEstimate | null): string {
    if (!estimate) return '🔮 Uncalibrated';
    const conf = estimate.confidence >= 70 ? '✅' : estimate.confidence >= 40 ? '⚠️' : '❓';
    return `🔮 ${estimate.medal}${starString(estimate.stars)} ${conf}`;
  }

  /** Format an estimate as a detailed string for the turborank command. */
  static formatDetailed(estimate: TurboRankEstimate): string {
    const confLabel =
      estimate.confidence >= 80
        ? '🟢 High confidence'
        : estimate.confidence >= 50
          ? '🟡 Moderate confidence'
          : '🔴 Low confidence (need more games)';

    return [
      `**🔮 Hidden Turbo Rank: ${estimate.medal}${starString(estimate.stars)}**`,
      `Estimated MMR: **~${estimate.estimatedMMR}**`,
      `${confLabel} (${estimate.confidence}%)`,
      ``,
      `📊 Based on **${estimate.sampleSize}** matches (${estimate.soloSampleSize} solo)`,
      `Effective sample weight: ${estimate.effectiveSample.toFixed(1)}`,
    ].join('\n');
  }
}

// Singleton
export const turboRankService = new TurboRankService();
