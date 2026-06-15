import fs from 'fs';
import { logger } from './loggerService';
import { opendotaClient } from './apiClient';
import {
  TurboRankData,
  TurboRankPlayerData,
  TurboRankObservation,
  TurboRankEstimate,
} from '../models/TurboRank';
import { fetchPlayerTurboMatches, fetchStratzPlayerProfile } from './stratzClient';

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

/** Coloured medal emoji for visual flair in embeds / leaderboards. */
const MEDAL_EMOJI: Record<number, string> = {
  1: '🟤', // Herald
  2: '🟢', // Guardian
  3: '🔵', // Crusader
  4: '🟣', // Archon
  5: '🟡', // Legend
  6: '🟠', // Ancient
  7: '🔴', // Divine
  8: '⭐', // Immortal
};

/** MMR per star within a medal tier (~154 per 2 stars ≈ 77 per star). */
const MMR_PER_STAR = 77;

/** Party-size to discount weight, used only when a player has zero solo games. */
const PARTY_WEIGHTS: Record<number, number> = {
  1: 1.0,
  2: 0.1,
  3: 0.02,
  4: 0.005,
  5: 0.001,
};

/** Half-life for recency decay in days — short, to reflect *current* form. */
const RECENCY_HALF_LIFE_DAYS = 60;

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

/** Medal string for a raw rank_tier int (e.g. 71 → "Divine 1"), 'Unranked' for none. */
export function rankTierToMedal(rankTier: number | null | undefined): string {
  if (!rankTier || rankTier <= 0) return 'Unranked';
  const tier = Math.floor(rankTier / 10);
  const stars = rankTier % 10;
  const name = MEDAL_NAMES[tier] ?? '?';
  return stars > 0 ? `${name} ${stars}` : name;
}

/** Emoji for an MMR value's medal tier. */
export function mmrToEmoji(mmr: number): string {
  return MEDAL_EMOJI[mmrToMedal(mmr).tier] ?? '⚪';
}

/** Emoji for a tier int (1-8). */
export function tierToEmoji(tier: number): string {
  return MEDAL_EMOJI[tier] ?? '⚪';
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
    // Keep discordId in sync, but don't blank an existing one with an unregistered ('') lookup.
    if (discordId) player.discordId = discordId;
    return player;
  }

  // ── Observation extraction ───────────────────────────────────────────────

  /** Live-match path (OpenDota). Solo = no party_id. */
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

    const partyId = trackedPlayer.party_id;
    const isSolo = partyId == null || partyId === 0
      ? players.filter(p => p.party_id === partyId).length <= 1
      : false;
    const partySize = isSolo
      ? 1
      : Math.max(2, players.filter(p => p.party_id === partyId).length);

    const tiers: number[] = [];
    const mmrValues: number[] = [];
    for (const p of players) {
      if (p.account_id && String(p.account_id) === String(steamId)) continue;
      const mmr = rankTierToMMR(p.rank_tier);
      if (mmr != null) {
        mmrValues.push(mmr);
        tiers.push(p.rank_tier);
      }
    }
    if (mmrValues.length < MIN_VISIBLE_RANKS) return null;

    const lobbyMMR = mmrValues.reduce((s, v) => s + v, 0) / mmrValues.length;
    const isRadiant = trackedPlayer.player_slot < 128;
    const won = typeof matchData.radiant_win === 'boolean' ? (isRadiant === matchData.radiant_win) : undefined;

    return {
      matchId: matchData.match_id,
      lobbyMMR: Math.round(lobbyMMR),
      partySize,
      partyWeight: PARTY_WEIGHTS[Math.min(partySize, 5)] ?? 0.1,
      timestamp: matchData.start_time || Math.floor(Date.now() / 1000),
      visibleRanks: mmrValues.length,
      tiers,
      won,
    };
  }

  /**
   * Calibration path (Stratz). `isSolo` is determined by which query bucket the
   * match came from (isParty:false → solo, isParty:true → party), because Stratz's
   * per-player `partyId` is unreliable for Turbo (0 ≠ solo).
   */
  extractObservationFromStratz(
    match: any,
    steamAccountId: number,
    isSolo: boolean,
  ): TurboRankObservation | null {
    const players: any[] = match.players || [];
    const trackedPlayer = players.find((p: any) => p.steamAccountId === steamAccountId);
    if (!trackedPlayer) return null;

    let partySize = 1;
    if (!isSolo) {
      // Stratz Turbo `partyId` is not reliable: known 5-stacks can show partyId=0.
      // If we ever have to fall back to party matches, treat them as maximally
      // contaminated so they are clearly rough and heavily discounted.
      partySize = 5;
    }

    const tiers: number[] = [];
    const mmrValues: number[] = [];
    for (const p of players) {
      if (p.steamAccountId === steamAccountId) continue;
      const rank = p.steamAccount?.seasonRank;
      const mmr = rankTierToMMR(rank);
      if (mmr != null) {
        mmrValues.push(mmr);
        tiers.push(rank);
      }
    }
    if (mmrValues.length < MIN_VISIBLE_RANKS) return null;

    const lobbyMMR = mmrValues.reduce((s, v) => s + v, 0) / mmrValues.length;
    const won = typeof match.didRadiantWin === 'boolean'
      ? (trackedPlayer.isRadiant === match.didRadiantWin)
      : undefined;

    return {
      matchId: match.id,
      lobbyMMR: Math.round(lobbyMMR),
      partySize,
      partyWeight: PARTY_WEIGHTS[Math.min(partySize, 5)] ?? 0.1,
      timestamp: match.startDateTime || Math.floor(Date.now() / 1000),
      visibleRanks: mmrValues.length,
      tiers,
      won,
    };
  }

  // ── Estimate computation ─────────────────────────────────────────────────

  /**
   * Estimate the hidden turbo rank.
   *  - Solo games are the only trustworthy signal, so if any exist we use solo-only.
   *  - Each game is weighted by recency (60-day half-life) × lobby completeness
   *    (visibleRanks / 9), so recent, well-populated lobbies dominate and thin or
   *    stale ones count less.
   *  - Players who never solo-queue fall back to party games (heavily discounted
   *    by party size) with the partyFallback flag set.
   */
  private computeEstimate(observations: TurboRankObservation[]): TurboRankEstimate | null {
    if (observations.length === 0) return null;

    const now = Date.now() / 1000;
    const decayLambda = Math.LN2 / (RECENCY_HALF_LIFE_DAYS * 86400);

    const soloObs = observations.filter(o => o.partySize === 1);
    const partyFallback = soloObs.length === 0;
    const targets = partyFallback ? observations : soloObs;

    let weightedSum = 0;
    let totalWeight = 0;
    let effectiveSample = 0; // visible-rank and recency weighted reliability of the sample

    const weighted: Array<{ obs: TurboRankObservation; w: number }> = [];
    for (const obs of targets) {
      const ageSec = Math.max(0, now - obs.timestamp);
      const recency = Math.exp(-decayLambda * ageSec);
      const completeness = Math.min(obs.visibleRanks, 9) / 9;
      const w = recency * completeness * (partyFallback ? obs.partyWeight : 1.0);
      weightedSum += obs.lobbyMMR * w;
      totalWeight += w;
      effectiveSample += w;
      weighted.push({ obs, w });
    }
    if (totalWeight === 0) return null;

    const estimatedMMR = Math.round(weightedSum / totalWeight);
    const { tier, stars, medal } = mmrToMedal(estimatedMMR);

    // Confidence from recency + visible-rank weighted effective sample.
    // Party fallback is intentionally capped because party games estimate stack
    // matchmaking, not individual hidden Turbo MMR.
    const baseConfidence = Math.min(100, Math.max(10, Math.round(effectiveSample * 8)));
    const confidence = partyFallback ? Math.min(35, baseConfidence) : baseConfidence;

    // Range = ±1 standard error of the weighted mean (clamped to a sensible width).
    let variance = 0;
    for (const { obs, w } of weighted) {
      variance += w * Math.pow(obs.lobbyMMR - estimatedMMR, 2);
    }
    variance = variance / totalWeight;
    const stdErr = Math.sqrt(variance) / Math.sqrt(Math.max(effectiveSample, 1));
    const spread = Math.min(900, Math.max(120, Math.round(stdErr)));
    const rangeLow = mmrToMedal(estimatedMMR - spread).medal;
    const rangeHigh = mmrToMedal(estimatedMMR + spread).medal;

    return {
      estimatedMMR,
      medalTier: tier,
      stars,
      medal,
      rangeLow,
      rangeHigh,
      confidence,
      sampleSize: observations.length,
      soloSampleSize: soloObs.length,
      effectiveSample: Math.round(effectiveSample * 100) / 100,
      partyFallback,
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
   * Retroactive calibration from Stratz. Works for registered (discordId) and
   * unregistered (discordId = '') players. Fetches solo games via isParty:false
   * (the reliable solo signal); only falls back to party games if the player has
   * literally never solo-queued.
   */
  async calibratePlayer(
    discordId: string,
    steamId: string,
    _take = 100,
    onProgress?: (fetched: number, total: number, phase?: string) => void,
  ): Promise<TurboRankEstimate | null> {
    const steamAccountId = parseInt(steamId, 10);
    if (isNaN(steamAccountId)) {
      logger.warn(`Invalid steamId for calibration: ${steamId}`);
      return null;
    }

    try {
      const oneYearAgo = Math.floor(Date.now() / 1000) - 365 * 24 * 3600;
      const player = this.getOrCreatePlayer(discordId, steamId);

      // Resolve display name (so unregistered players show a name, not an id).
      onProgress?.(0, 0, 'Resolving player…');
      const profile = await fetchStratzPlayerProfile(steamAccountId);
      if (profile.name) player.steamName = profile.name;

      // Solo games (the reliable signal).
      onProgress?.(0, 0, 'Fetching solo turbo matches…');
      const soloMatches = await fetchPlayerTurboMatches(steamAccountId, 100, 0, oneYearAgo, false);
      logger.info(`Stratz solo turbo matches: ${soloMatches.length} for ${steamId}`);

      const observations: TurboRankObservation[] = [];
      for (let i = 0; i < soloMatches.length; i++) {
        onProgress?.(i + 1, soloMatches.length, 'Processing solo matches…');
        const obs = this.extractObservationFromStratz(soloMatches[i], steamAccountId, true);
        if (obs) observations.push(obs);
      }

      // Only fall back to party games if there is no solo signal at all.
      if (observations.length === 0) {
        onProgress?.(0, 0, 'No solo games — using party matches…');
        const partyMatches = await fetchPlayerTurboMatches(steamAccountId, 100, 0, oneYearAgo, true);
        logger.info(`Stratz party turbo matches (fallback): ${partyMatches.length} for ${steamId}`);
        for (let i = 0; i < partyMatches.length; i++) {
          onProgress?.(i + 1, partyMatches.length, 'Processing party matches…');
          const obs = this.extractObservationFromStratz(partyMatches[i], steamAccountId, false);
          if (obs) observations.push(obs);
        }
      }

      if (observations.length === 0) {
        logger.info(`No usable Stratz turbo matches for ${steamId}, trying OpenDota`);
        return this.calibratePlayerOpenDota(discordId, steamId, 100, onProgress);
      }

      player.observations = observations;
      player.estimate = this.computeEstimate(observations);
      this.data.lastCalibrated = Date.now();
      this.save();

      const soloN = observations.filter(o => o.partySize === 1).length;
      logger.info(
        `Calibration for ${player.steamName ?? steamId}: ${observations.length} obs (${soloN} solo). ` +
        `Estimate: ${player.estimate?.medal ?? 'N/A'} (~${player.estimate?.estimatedMMR ?? '?'}, ${player.estimate?.confidence ?? 0}%)`,
      );
      return player.estimate;
    } catch (err) {
      logger.error(`Stratz calibration failed for ${steamId}, falling back to OpenDota:`, err);
      return this.calibratePlayerOpenDota(discordId, steamId, 100, onProgress);
    }
  }

  private async calibratePlayerOpenDota(
    discordId: string,
    steamId: string,
    take: number,
    onProgress?: (fetched: number, total: number, phase?: string) => void,
  ): Promise<TurboRankEstimate | null> {
    try {
      const resp = await opendotaClient.get<any[]>(
        `/players/${steamId}/matches`,
        { params: { game_mode: TURBO_GAME_MODE, limit: take } },
      );
      const matchList = resp.data || [];
      if (matchList.length === 0) return null;

      const player = this.getOrCreatePlayer(discordId, steamId);
      const observations: TurboRankObservation[] = [];

      for (let i = 0; i < matchList.length; i++) {
        const m = matchList[i];
        onProgress?.(i + 1, matchList.length, 'Fetching match details from OpenDota…');
        try {
          const detail = await opendotaClient.get(`/matches/${m.match_id}`);
          const obs = this.extractObservationFromOpenDota(detail.data, steamId);
          if (obs) observations.push(obs);
        } catch (fetchErr) {
          logger.warn(`Failed to fetch match ${m.match_id} during calibration:`, fetchErr);
        }
        if (i < matchList.length - 1) await new Promise(r => setTimeout(r, 1200));
      }

      player.observations = observations;
      player.estimate = this.computeEstimate(observations);
      this.data.lastCalibrated = Date.now();
      this.save();
      return player.estimate;
    } catch (err) {
      logger.error(`OpenDota calibration failed for ${steamId}:`, err);
      return null;
    }
  }

  /** Get the current estimate for a registered player. */
  getEstimate(discordId: string): TurboRankEstimate | null {
    const player = this.data.players.find(p => p.discordId === discordId);
    return player?.estimate ?? null;
  }

  getEstimateBySteamId(steamId: string): TurboRankEstimate | null {
    const player = this.data.players.find(p => p.steamId === steamId);
    return player?.estimate ?? null;
  }

  getPlayerBySteamId(steamId: string): TurboRankPlayerData | undefined {
    return this.data.players.find(p => p.steamId === steamId);
  }

  getSteamName(steamId: string): string | undefined {
    return this.data.players.find(p => p.steamId === steamId)?.steamName;
  }

  /** All players with estimates, sorted by MMR descending. */
  getAllEstimates(): Array<{ discordId: string; steamId: string; steamName?: string; estimate: TurboRankEstimate }> {
    return this.data.players
      .filter(p => p.estimate != null)
      .map(p => ({ discordId: p.discordId, steamId: p.steamId, steamName: p.steamName, estimate: p.estimate! }))
      .sort((a, b) => b.estimate.estimatedMMR - a.estimate.estimatedMMR);
  }

  getObservations(discordId: string): TurboRankObservation[] {
    const player = this.data.players.find(p => p.discordId === discordId);
    return player?.observations ?? [];
  }

  getObservationsBySteamId(steamId: string): TurboRankObservation[] {
    const player = this.data.players.find(p => p.steamId === steamId);
    return player?.observations ?? [];
  }

  /** Short string for embedding in other commands. */
  static formatShort(estimate: TurboRankEstimate | null): string {
    if (!estimate) return '🔮 Uncalibrated';
    const conf = estimate.confidence >= 70 ? '✅' : estimate.confidence >= 40 ? '⚠️' : '❓';
    return `🔮 ${estimate.medal}${starString(estimate.stars)} ${conf}`;
  }

  /** Detailed string for the turborank command. */
  static formatDetailed(estimate: TurboRankEstimate): string {
    const confLabel =
      estimate.confidence >= 80 ? '🟢 High confidence'
      : estimate.confidence >= 50 ? '🟡 Moderate confidence'
      : '🔴 Low confidence (need more solo games)';
    return [
      `**${tierToEmoji(estimate.medalTier)} Hidden Turbo Rank: ${estimate.medal}${starString(estimate.stars)}**`,
      `Estimated MMR: **~${estimate.estimatedMMR}** (range ${estimate.rangeLow}–${estimate.rangeHigh})`,
      `${confLabel} (${estimate.confidence}%)`,
      ``,
      `📊 Based on **${estimate.soloSampleSize}** solo matches`,
    ].join('\n');
  }
}

// Singleton
export const turboRankService = new TurboRankService();
