import fs from 'fs';
import {
  TurboMatchParticipant,
  TurboMatchSource,
  TurboPairing,
  TurboPartyRecommendation,
  TurboPlayerStats,
  TurboStatsData,
  TurboStatsScope,
  TurboTrackedMatch
} from '../models/TurboStats';
import { logger } from './loggerService';
import { rankTierToMMR } from './turboRankService';

const TURBO_STATS_FILE = 'turboStats.json';
const TURBO_GAME_MODE = 23;

type RegisteredPlayer = { discordId: string; steamId: string };

export class TurboStatsService {
  private turboStats: TurboStatsData = {
    playerStats: [],
    pairings: [],
    lastProcessedMatch: null,
    matches: [],
    ledgerVersion: 1,
    statsBuiltFromLedger: false
  };

  /** Latest Steam name seen for each unregistered teammate. */
  private readonly teammateNames = new Map<string, string>();

  constructor(private readonly filePath = TURBO_STATS_FILE) {
    this.loadTurboStats();
  }

  private loadTurboStats() {
    try {
      if (fs.existsSync(this.filePath)) {
        const loaded = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as TurboStatsData;
        this.turboStats = {
          playerStats: loaded.playerStats || [],
          pairings: loaded.pairings || [],
          lastProcessedMatch: loaded.lastProcessedMatch ?? null,
          matches: loaded.matches || [],
          ledgerVersion: 1,
          statsBuiltFromLedger: loaded.statsBuiltFromLedger || false,
          lastBackfillAt: loaded.lastBackfillAt,
          legacyTrackedPairings: loaded.legacyTrackedPairings
        };
        for (const p of this.turboStats.playerStats) p.rating = this.calculateRating(p.wins, p.losses);
        for (const p of this.turboStats.pairings) {
          p.rating = this.calculatePairRating(p.wins, p.losses);
          p.confidenceFloor = this.calculatePairFloor(p.wins, p.losses);
        }
        for (const p of this.turboStats.legacyTrackedPairings || []) {
          p.rating = this.calculatePairRating(p.wins, p.losses);
          p.confidenceFloor = this.calculatePairFloor(p.wins, p.losses);
        }
        this.saveTurboStats();
        logger.info(`Turbo stats loaded (${this.turboStats.matches?.length || 0} ledger matches)`);
      }
    } catch (error) {
      logger.error('Error loading turbo stats:', error);
    }
  }

  private saveTurboStats() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.turboStats, null, 2));
    } catch (error) {
      logger.error('Error saving turbo stats:', error);
    }
  }

  private calculateRating(wins: number, losses: number): number {
    const n = wins + losses;
    if (n === 0) return 0;
    const z = 1.96;
    const p = wins / n;
    const denom = 1 + (z * z) / n;
    const centre = p + (z * z) / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
    const activityBonus = Math.min(n, 100) * 0.02;
    return Math.round((((centre - margin) / denom) * 100 + activityBonus) * 100) / 100;
  }

  /**
   * Bayesian expected win rate with a neutral Beta(10, 10) prior. The prior is
   * equivalent to 20 games at 50%, keeping hot small samples from dominating
   * while leaving established pairings close to their observed win rate.
   */
  private calculatePairRating(wins: number, losses: number): number {
    const projected = (wins + 10) / (wins + losses + 20);
    return Math.round(projected * 10000) / 100;
  }

  /**
   * 5th-percentile lower bound of the same Beta(wins+10, losses+10) posterior that
   * calculatePairRating reports the mean of. The mean alone is a bad sort key: the prior is
   * only worth 20 games, so a 15-8 duo projects above a 59-44 duo purely on noise. Ranking on
   * the floor keeps the displayed number honest while ordering duos by how much of their win
   * rate is actually evidenced.
   */
  private calculatePairFloor(wins: number, losses: number): number {
    const a = wins + 10;
    const b = losses + 10;
    const mean = a / (a + b);
    const variance = (a * b) / ((a + b) * (a + b) * (a + b + 1));
    return Math.round((mean - 1.645 * Math.sqrt(variance)) * 10000) / 100;
  }

  private sourceMatchesScope(source: TurboMatchSource, scope: TurboStatsScope) {
    return scope === 'all' || (scope === 'tracked' ? source !== 'historical' : source !== 'live');
  }

  private matchesForScope(scope: TurboStatsScope, sinceTimestamp?: number) {
    return (this.turboStats.matches || []).filter(match =>
      this.sourceMatchesScope(match.source, scope)
      && (sinceTimestamp === undefined || match.timestamp >= sinceTimestamp)
    );
  }

  private shouldDeriveFromLedger(scope: TurboStatsScope, sinceTimestamp?: number) {
    // Until the first backfill completes, the legacy aggregate contains tracked
    // matches that predate the ledger. Keep using it so deployment alone does not
    // make existing leaderboards appear to lose their history.
    return Boolean(this.turboStats.statsBuiltFromLedger) || scope === 'history'
      || (sinceTimestamp !== undefined && Boolean(this.turboStats.matches?.length));
  }

  private normalizeMatch(matchData: any, registeredPlayers: RegisteredPlayer[], source: Exclude<TurboMatchSource, 'both'>): TurboTrackedMatch | null {
    if (source === 'live' && Number(matchData.game_mode ?? matchData.gameMode) !== TURBO_GAME_MODE) return null;
    const rawPlayers = Array.isArray(matchData.players) ? matchData.players : [];
    const bySteamId = new Map(registeredPlayers.map(player => [String(player.steamId), player]));
    const participants: TurboMatchParticipant[] = [];
    const seenDiscordIds = new Set<string>();

    for (const raw of rawPlayers) {
      const steamId = String(raw.account_id ?? raw.steamAccountId ?? '');
      const registered = bySteamId.get(steamId);
      if (!registered || seenDiscordIds.has(registered.discordId)) continue;
      const isRadiant = typeof raw.isRadiant === 'boolean' ? raw.isRadiant : Number(raw.player_slot ?? raw.playerSlot) < 128;
      // A party id is a per-match index and it is zero-based, so party 0 is a real party — in
      // practice the most common one. Treating it as falsy discarded roughly half of all party
      // evidence, and did so silently, because both members of party 0 became "solo" together.
      const rawPartyId = raw.party_id ?? raw.partyId;
      const parsedPartyId = rawPartyId === null || rawPartyId === undefined ? NaN : Number(rawPartyId);
      const partyId = Number.isFinite(parsedPartyId) ? parsedPartyId : null;
      participants.push({
        discordId: registered.discordId,
        steamId: registered.steamId,
        team: isRadiant ? 'radiant' : 'dire',
        partyId
      });
      seenDiscordIds.add(registered.discordId);
    }

    const matchId = String(matchData.match_id ?? matchData.id ?? '');
    if (!matchId || participants.length === 0) return null;
    // Read the enemy medals off the same payload rather than leaving them to +turborank, which only
    // samples solo games and so has almost none of the stacks +turbopull needs.
    let enemyRank: TurboTrackedMatch['enemyRank'] = null;
    const sides = new Set(participants.map(participant => participant.team));
    if (sides.size === 1) {
      const enemyIsRadiant = !sides.has('radiant');
      const medals = rawPlayers
        .filter((raw: any) => (typeof raw.isRadiant === 'boolean' ? raw.isRadiant : Number(raw.player_slot ?? raw.playerSlot) < 128) === enemyIsRadiant)
        .map((raw: any) => rankTierToMMR(Number(raw.steamAccount?.seasonRank ?? raw.rank_tier ?? 0)))
        .filter((mmr: number | null): mmr is number => mmr !== null);
      if (medals.length) {
        enemyRank = { mmr: Math.round(medals.reduce((sum: number, mmr: number) => sum + mmr, 0) / medals.length), visible: medals.length };
      }
    }
    // Anonymous accounts come through as 0 or 4294967295 and can't be told apart, so they're skipped.
    let teammates: TurboTrackedMatch['teammates'] = [];
    if (sides.size === 1) {
      const ourRadiant = sides.has('radiant');
      teammates = rawPlayers
        .filter((raw: any) => (typeof raw.isRadiant === 'boolean' ? raw.isRadiant : Number(raw.player_slot ?? raw.playerSlot) < 128) === ourRadiant)
        .map((raw: any) => ({ steamId: String(raw.account_id ?? raw.steamAccountId ?? ''), name: raw.steamAccount?.name ?? raw.personaname ?? undefined }))
        .filter((mate: { steamId: string }) => mate.steamId && !['0', '4294967295'].includes(mate.steamId) && !bySteamId.has(mate.steamId));
    }
    const rawRank = matchData.averageRank ?? matchData.avg_rank_tier;
    const averageRank = rawRank === null || rawRank === undefined || !Number.isFinite(Number(rawRank))
      ? null
      : Number(rawRank);
    return {
      matchId,
      timestamp: Number(matchData.start_time ?? matchData.startDateTime ?? Math.floor(Date.now() / 1000)),
      radiantWon: Boolean(matchData.radiant_win ?? matchData.didRadiantWin),
      averageRank,
      enemyRank,
      teammates,
      source,
      players: participants
    };
  }

  private mergeLedgerMatch(incoming: TurboTrackedMatch): { changed: boolean; inserted: boolean; aggregatesChanged: boolean } {
    const matches = this.turboStats.matches || (this.turboStats.matches = []);
    const existing = matches.find(match => match.matchId === incoming.matchId);
    if (!existing) {
      matches.push(incoming);
      return { changed: true, inserted: true, aggregatesChanged: true };
    }

    // Enemy ranks feed +turbopull only; filling them in must not trigger an aggregate rebuild.
    let annotated = !existing.enemyRank && Boolean(incoming.enemyRank);
    if (annotated) existing.enemyRank = incoming.enemyRank;
    // Teammates feed +turboparty only; like enemy ranks, filling them in needs no rebuild.
    if (!existing.teammates && incoming.teammates) {
      existing.teammates = incoming.teammates;
      annotated = true;
    }

    let changed = false;
    if (existing.source !== incoming.source && existing.source !== 'both') {
      existing.source = 'both';
      changed = true;
    }
    if ((existing.averageRank === null || existing.averageRank === undefined) && incoming.averageRank !== null && incoming.averageRank !== undefined) {
      existing.averageRank = incoming.averageRank;
      changed = true;
    }
    for (const participant of incoming.players) {
      const old = existing.players.find(player => player.discordId === participant.discordId);
      if (!old) {
        existing.players.push(participant);
        changed = true;
      } else if (old.partyId === null && participant.partyId !== null) {
        old.partyId = participant.partyId;
        changed = true;
      }
    }
    return { changed: changed || annotated, inserted: false, aggregatesChanged: changed };
  }

  private addMatchToAggregates(match: TurboTrackedMatch) {
    for (const player of match.players) {
      const won = player.team === 'radiant' ? match.radiantWon : !match.radiantWon;
      this.updatePlayerStatsInMemory(player.discordId, player.steamId, won, match.timestamp * 1000);
    }
    for (const team of ['radiant', 'dire'] as const) {
      const players = match.players.filter(player => player.team === team);
      const won = team === 'radiant' ? match.radiantWon : !match.radiantWon;
      for (let i = 0; i < players.length; i++) {
        for (let j = i + 1; j < players.length; j++) {
          this.updatePairingStatsInMemory(players[i], players[j], won, match.source, match.timestamp * 1000);
        }
      }
    }
  }

  private addMatchToLegacyTrackedPairings(match: TurboTrackedMatch) {
    if (match.source === 'historical') return;
    const aggregatePairings = this.turboStats.pairings;
    this.turboStats.pairings = this.turboStats.legacyTrackedPairings || [];
    for (const team of ['radiant', 'dire'] as const) {
      const players = match.players.filter(player => player.team === team);
      const won = team === 'radiant' ? match.radiantWon : !match.radiantWon;
      for (let i = 0; i < players.length; i++) {
        for (let j = i + 1; j < players.length; j++) {
          this.updatePairingStatsInMemory(players[i], players[j], won, 'live', match.timestamp * 1000);
        }
      }
    }
    this.turboStats.legacyTrackedPairings = this.turboStats.pairings;
    // Same statistic as every other duo view. This used to be calculateRating — a Wilson lower
    // bound plus an activity bonus — while the embed labelled it a Bayesian projected win rate,
    // so an identical 35-26 record rendered as 46.1% here and 55.6% in the ledger view.
    for (const pairing of this.turboStats.legacyTrackedPairings) {
      pairing.rating = this.calculatePairRating(pairing.wins, pairing.losses);
      pairing.confidenceFloor = this.calculatePairFloor(pairing.wins, pairing.losses);
    }
    this.turboStats.pairings = aggregatePairings;
  }

  private updatePlayerStatsInMemory(discordId: string, steamId: string, won: boolean, updatedAt = Date.now()) {
    let stats = this.turboStats.playerStats.find(player => player.discordId === discordId);
    if (!stats) {
      stats = { discordId, steamId, wins: 0, losses: 0, rating: 0, lastUpdated: updatedAt };
      this.turboStats.playerStats.push(stats);
    }
    won ? stats.wins++ : stats.losses++;
    stats.rating = this.calculateRating(stats.wins, stats.losses);
    stats.lastUpdated = Math.max(stats.lastUpdated, updatedAt);
  }

  private updatePairingStatsInMemory(a: TurboMatchParticipant, b: TurboMatchParticipant, won: boolean, source: TurboMatchSource, updatedAt: number) {
    if (a.discordId === b.discordId) return;
    const [player1, player2] = [a.discordId, b.discordId].sort();
    let stats = this.turboStats.pairings.find(pair => pair.player1 === player1 && pair.player2 === player2);
    if (!stats) {
      stats = { player1, player2, wins: 0, losses: 0, rating: 0, lastUpdated: updatedAt, liveGames: 0, historicalGames: 0, verifiedPartyGames: 0 };
      this.turboStats.pairings.push(stats);
    }
    won ? stats.wins++ : stats.losses++;
    if (source !== 'historical') stats.liveGames = (stats.liveGames || 0) + 1;
    if (source !== 'live') stats.historicalGames = (stats.historicalGames || 0) + 1;
    if (a.partyId !== null && a.partyId === b.partyId) stats.verifiedPartyGames = (stats.verifiedPartyGames || 0) + 1;
    stats.rating = this.calculatePairRating(stats.wins, stats.losses);
    stats.confidenceFloor = this.calculatePairFloor(stats.wins, stats.losses);
    stats.lastUpdated = Math.max(stats.lastUpdated, updatedAt);
  }

  private deriveStats(scope: TurboStatsScope, sinceTimestamp?: number) {
    const playerStats: TurboPlayerStats[] = [];
    const pairings: TurboPairing[] = [];
    const serviceData = this.turboStats;
    this.turboStats = { ...serviceData, playerStats, pairings };
    for (const match of this.matchesForScope(scope, sinceTimestamp)) this.addMatchToAggregates(match);
    this.turboStats = serviceData;
    return { playerStats, pairings };
  }

  rebuildAggregatesFromLedger() {
    const derived = this.deriveStats('all');
    this.turboStats.playerStats = derived.playerStats;
    this.turboStats.pairings = derived.pairings;
    this.turboStats.statsBuiltFromLedger = true;
    this.turboStats.ledgerVersion = 1;
    this.saveTurboStats();
  }

  markBackfillComplete() {
    this.turboStats.lastBackfillAt = Date.now();
    this.rebuildAggregatesFromLedger();
  }

  updatePlayerStats(discordId: string, steamId: string, won: boolean) {
    this.updatePlayerStatsInMemory(discordId, steamId, won);
    this.saveTurboStats();
  }

  updatePairingStats(player1Id: string, player2Id: string, won: boolean) {
    const a: TurboMatchParticipant = { discordId: player1Id, steamId: '', team: 'radiant', partyId: null };
    const b: TurboMatchParticipant = { discordId: player2Id, steamId: '', team: 'radiant', partyId: null };
    this.updatePairingStatsInMemory(a, b, won, 'live', Date.now());
    this.saveTurboStats();
  }

  getPlayerLeaderboard(limit = 10, scope: TurboStatsScope = 'all'): TurboPlayerStats[] {
    const stats = this.shouldDeriveFromLedger(scope) ? this.deriveStats(scope).playerStats : this.turboStats.playerStats;
    return [...stats].filter(player => player.wins + player.losses >= 10).sort((a, b) => b.rating - a.rating).slice(0, limit);
  }

  /** Duos are ordered by evidenced win rate, not by the headline projection. */
  pairSortKey(pair: TurboPairing): number {
    return pair.confidenceFloor ?? this.calculatePairFloor(pair.wins, pair.losses);
  }

  /** Resolves a duo view to its pairing set: the legacy snapshot, a windowed derivation, or the stored aggregate. */
  private statsForView(scope: TurboStatsScope, sinceTimestamp?: number, useLegacy = false) {
    // The legacy snapshot is opt-in now. It has no match-id dedupe, so against the ledger its
    // counts run anywhere from 0.27x to 1.99x of the truth; it stays reachable only so the
    // pre-backfill numbers people remember are still inspectable.
    if (useLegacy && this.turboStats.legacyTrackedPairings) {
      return { pairings: this.turboStats.legacyTrackedPairings, playerStats: null as TurboPlayerStats[] | null };
    }
    if (this.shouldDeriveFromLedger(scope, sinceTimestamp)) {
      const derived = this.deriveStats(scope, sinceTimestamp);
      return { pairings: derived.pairings, playerStats: derived.playerStats as TurboPlayerStats[] | null };
    }
    return { pairings: this.turboStats.pairings, playerStats: this.turboStats.playerStats as TurboPlayerStats[] | null };
  }

  /**
   * Straight win rate, highest first, so the order always matches the number on screen. Small
   * samples are held off the board by minGames rather than by shrinking the statistic - the
   * previous attempt ranked on a confidence floor, which put a 65% duo below a 53% one with no
   * visible reason for it.
   */
  getPairingLeaderboard(limit = 10, minGames = 10, scope: TurboStatsScope = 'all', sinceTimestamp?: number, useLegacy = false): TurboPairing[] {
    const { pairings } = this.statsForView(scope, sinceTimestamp, useLegacy);
    const winRate = (pair: TurboPairing) => pair.wins / (pair.wins + pair.losses);
    return [...pairings]
      .filter(pair => pair.wins + pair.losses >= minGames)
      .sort((a, b) => winRate(b) - winRate(a) || (b.wins + b.losses) - (a.wins + a.losses))
      .slice(0, limit);
  }

  /**
   * Duos annotated with the strength of the opposition they faced.
   *
   * Nothing here is weighted. Across 502 scored crew games the win rate by enemy-strength
   * quintile runs 50/41/58/49/51% with a pooled slope of +1.1pp per 1000 MMR: enemy strength
   * spans 306-5420 MMR and predicts nothing, because matchmaking puts you against your own
   * level. An earlier version weighted wins by enemy MMR and produced an order that could not
   * be defended - the duo facing the strongest enemies, and winning more of its harder games,
   * ranked second. So the order is plain win rate and enemy strength is reported alongside it.
   *
   * The low readings are partly a visibility artefact: the weakest-looking quintile has only
   * 2.80 of 5 enemy ranks visible against 3.64 in the fourth, so an unranked or hidden strong
   * player reads as a weak lobby. Controlling for it does not change the answer - restricted to
   * lobbies with 4-5 enemies visible (n=231) the slope is still +0.96pp per 1000 MMR.
   */
  getDuoDifficultyProfiles(
    difficultyByMatch: Map<string, number>,
    limit = 10,
    minGames = 30,
    minScoredGames = 20,
    scope: TurboStatsScope = 'all',
    sinceTimestamp?: number,
    targetId?: string
  ) {
    const matches = this.matchesForScope(scope, sinceTimestamp);

    type Row = { player1: string; player2: string; games: number; wins: number; difficulties: number[] };
    const rows = new Map<string, Row>();

    for (const match of matches) {
      // Same source as +turbopull: the +turborank reading first, the ledger's enemy medals otherwise.
      const ledgerEnemy = match.enemyRank && match.enemyRank.visible >= 2 ? match.enemyRank.mmr : undefined;
      const difficulty = difficultyByMatch.get(String(match.matchId)) ?? ledgerEnemy;
      for (const team of ['radiant', 'dire'] as const) {
        const players = match.players.filter(player => player.team === team);
        const won = team === 'radiant' ? match.radiantWon : !match.radiantWon;
        for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
          if (players[i].discordId === players[j].discordId) continue;
          const [player1, player2] = [players[i].discordId, players[j].discordId].sort();
          const key = `${player1}:${player2}`;
          const row = rows.get(key) || { player1, player2, games: 0, wins: 0, difficulties: [] };
          row.games++;
          if (won) row.wins++;
          if (difficulty !== undefined) row.difficulties.push(difficulty);
          rows.set(key, row);
        }
      }
    }

    const median = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };

    return [...rows.values()]
      .filter(row => !targetId || row.player1 === targetId || row.player2 === targetId)
      .filter(row => row.games >= minGames && row.difficulties.length >= minScoredGames)
      .map(row => ({
        player1: row.player1,
        player2: row.player2,
        games: row.games,
        wins: row.wins,
        losses: row.games - row.wins,
        winRate: (row.wins / row.games) * 100,
        scoredGames: row.difficulties.length,
        medianEnemyMMR: median(row.difficulties)
      }))
      .sort((a, b) => b.winRate - a.winRate || b.games - a.games)
      .slice(0, limit);
  }

  /**
   * Each tracked player's pull rating: how strong an opposition matchmaking finds when they are in
   * the party. Fitted as `enemyMMR ≈ mean(party members' ratings)`, because a Dota party queues on
   * its average. That model predicts held-out enemy rank with RMSE 614 against 674 for an additive
   * one and 1250 for the plain mean, and on stacks rated from solo games alone, a pure average beats
   * every blend toward the strongest member. Fitted on the oldest 70% of games it still cuts error on
   * the newest 30% (739 against 1177), and the shifts it predicts between one player's different
   * parties come out right-sized (observed-on-predicted slope 1.00).
   *
   * This is not `+turborank`. It is fitted from the games a player actually stacks in, so someone
   * whose solo lobbies read Divine can still pull Ancient enemies with their usual party, and the
   * pull is what a party feels.
   *
   * Same-team tracked players are treated as one party: of 305 multi-tracked teams, none had them in
   * different parties - the rest only lacked party data. Tracked players under `minGames` share one
   * "other" slot; untracked members are invisible, so a party is averaged over its tracked members.
   * Ratings are shrunk toward the pool mean by 3 games' worth (held-out error is flat from 0.5 to 3
   * and worsens past 10). `samples` is a fixed-seed bootstrap over whole play days, not single games:
   * one evening's games share form and lobby conditions, and resampling games alone gave intervals
   * up to a third too narrow. Callers can put an interval on any party they build from these ratings.
   */
  /**
   * Our side of every Turbo game with a known enemy rank: the tracked players on it, the enemy team's
   * average MMR (`y`), and whether they won.
   */
  private rankScoredTeams(enemyByMatch: Map<string, number>, sinceTimestamp?: number) {
    const teams: { ids: string[]; mates: string[]; y: number; won: boolean; day: number }[] = [];
    const steamIds = new Map<string, string>();
    const lastPlayed = new Map<string, number>();
    for (const match of this.matchesForScope('all', sinceTimestamp)) {
      // Prefer the +turborank reading, which the model was validated on; the ledger's own enemy
      // medals fill the stacked games it never sampled.
      const ledgerEnemy = match.enemyRank && match.enemyRank.visible >= 2 ? match.enemyRank.mmr : undefined;
      const y = enemyByMatch.get(String(match.matchId)) ?? ledgerEnemy;
      if (y === undefined) continue;
      // Observers never sit on opposite teams in a joined match, so the enemy figure belongs to the
      // only team holding tracked players. Guard anyway rather than credit it to both sides.
      const sides = (['radiant', 'dire'] as const).filter(team => match.players.some(player => player.team === team));
      if (sides.length !== 1) continue;
      const ids = [...new Set(match.players.map(player => player.discordId))].sort();
      for (const player of match.players) {
        steamIds.set(player.discordId, player.steamId);
        lastPlayed.set(player.discordId, Math.max(lastPlayed.get(player.discordId) || 0, match.timestamp));
      }
      const won = sides[0] === 'radiant' ? match.radiantWon : !match.radiantWon;
      const mates = (match.teammates || []).map(mate => mate.steamId);
      for (const mate of match.teammates || []) if (mate.name) this.teammateNames.set(mate.steamId, mate.name);
      teams.push({ ids, mates, y, won, day: Math.floor(match.timestamp / 86400) });
    }
    return { teams, steamIds, lastPlayed };
  }

  /**
   * Every exact stack of tracked players that has played `minGames`+ rank-scored Turbo games
   * together, with a strength score: the average enemy MMR, plus `winWeight` MMR for each game won
   * above 50% and minus it for each game lost (so the score is enemy MMR + winWeight × (2·WR − 1)).
   *
   * Matchmaking holds a regular stack near 50%, and turns its winning into tougher enemies, so the
   * enemy level is most of the score and the win rate only breaks near-ties. A 10-point gap in win
   * rate is worth 30 MMR, a tenth of a medal: a stack winning slightly more against stronger enemies
   * ranks above one winning a lot against weaker ones. In a 70/30 time-split backtest, enemy level
   * alone ranked held-out stacks best (Spearman 0.68), weight 150 cost little (0.64), and adding pair
   * synergy terms only made it worse — so there are none here.
   *
   * Like `getPullRatings`, a score is shrunk toward the mean of all scored games by 3 games' worth,
   * so a lucky 10-game stack cannot top the board on noise, and `low`–`high` is a 5–95% range from
   * a fixed-seed bootstrap over the stack's play days, since one evening's games share form and lobbies.
   *
   * `pairGames` counts rank-scored games each tracked pair shared (key "idA:idB", ids sorted).
   */
  getPartyRecords(enemyByMatch: Map<string, number>, minGames = 10, sinceTimestamp?: number, winWeight = 150) {
    const { teams: tracked, steamIds } = this.rankScoredTeams(enemyByMatch, sinceTimestamp);
    // An unregistered teammate joins a stack only once they're a regular: in REGULAR_GAMES+ of our
    // scored games. Random solo-queue teammates never get there, so they don't split a real stack
    // into one-off lineups. Regulars get the id "steam:<steamId>".
    const REGULAR_GAMES = 10;
    const mateGames = new Map<string, number>();
    for (const team of tracked) for (const mate of team.mates) mateGames.set(mate, (mateGames.get(mate) || 0) + 1);
    const teams = tracked.map(team => ({
      ...team,
      ids: [...team.ids, ...team.mates.filter(mate => (mateGames.get(mate) || 0) >= REGULAR_GAMES).map(mate => `steam:${mate}`)].sort()
    }));
    const names = new Map<string, string>();
    for (const [steamId, count] of mateGames) {
      if (count < REGULAR_GAMES) continue;
      steamIds.set(`steam:${steamId}`, steamId);
      const name = this.teammateNames.get(steamId);
      if (name) names.set(`steam:${steamId}`, name);
    }
    const stacks = new Map<string, { ids: string[]; ys: number[]; wins: number; scores: number[]; days: number[] }>();
    const pairGames = new Map<string, number>();
    for (const team of teams) {
      for (let i = 0; i < team.ids.length; i++) for (let j = i + 1; j < team.ids.length; j++) {
        const key = `${team.ids[i]}:${team.ids[j]}`;
        pairGames.set(key, (pairGames.get(key) || 0) + 1);
      }
      if (team.ids.length < 3) continue;
      const key = team.ids.join(',');
      const stack = stacks.get(key) || { ids: team.ids, ys: [], wins: 0, scores: [], days: [] };
      stack.ys.push(team.y);
      if (team.won) stack.wins++;
      stack.scores.push(team.y + (team.won ? winWeight : -winWeight));
      stack.days.push(team.day);
      stacks.set(key, stack);
    }
    if (!teams.length) return { parties: [], pairGames, steamIds, names, scoredTeams: 0 };

    const RIDGE = 3;
    const BOOTSTRAP = 200;
    const prior = teams.reduce((sum, team) => sum + team.y + (team.won ? winWeight : -winWeight), 0) / teams.length;
    const shrunk = (scores: number[]) => (scores.reduce((sum, value) => sum + value, 0) + RIDGE * prior) / (scores.length + RIDGE);
    let seed = 20261020;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const parties = [...stacks.values()]
      .filter(stack => stack.ys.length >= minGames)
      .map(stack => {
        const games = stack.ys.length;
        const byDay = new Map<number, number[]>();
        stack.scores.forEach((score, i) => byDay.set(stack.days[i], [...(byDay.get(stack.days[i]) || []), score]));
        const days = [...byDay.values()];
        const samples: number[] = [];
        for (let t = 0; t < BOOTSTRAP; t++) {
          const resample: number[] = [];
          while (resample.length < games) resample.push(...days[Math.floor(random() * days.length)]);
          samples.push(shrunk(resample));
        }
        samples.sort((a, b) => a - b);
        return {
          playerIds: stack.ids,
          games,
          wins: stack.wins,
          losses: games - stack.wins,
          enemyMMR: mean(stack.ys),
          score: shrunk(stack.scores),
          low: samples[Math.floor(0.05 * (BOOTSTRAP - 1))],
          high: samples[Math.floor(0.95 * (BOOTSTRAP - 1))],
          playDays: days.length
        };
      })
      .sort((a, b) => b.score - a.score);

    return { parties, pairGames, steamIds, names, scoredTeams: teams.length };
  }

  getPullRatings(enemyByMatch: Map<string, number>, minGames = 20, sinceTimestamp?: number) {
    const { teams, steamIds, lastPlayed } = this.rankScoredTeams(enemyByMatch, sinceTimestamp);
    type Team = (typeof teams)[number];

    const games = new Map<string, number>();
    for (const team of teams) for (const id of team.ids) games.set(id, (games.get(id) || 0) + 1);
    const rated = [...games].filter(([, n]) => n >= minGames).map(([id]) => id);
    if (!rated.length) return { players: [], scoredTeams: teams.length };
    const slot = new Map(rated.map((id, i) => [id, i]));
    const other = rated.length;
    const size = rated.length + 1;
    const prior = teams.reduce((sum, team) => sum + team.y, 0) / teams.length;
    const RIDGE = 3;

    const fit = (sample: Team[]) => {
      const A = Array.from({ length: size }, () => new Array(size).fill(0));
      const b = new Array(size).fill(0);
      for (const team of sample) {
        const x = new Array(size).fill(0);
        for (const id of team.ids) x[slot.get(id) ?? other] += 1 / team.ids.length;
        for (let i = 0; i < size; i++) {
          if (!x[i]) continue;
          b[i] += x[i] * team.y;
          for (let j = 0; j < size; j++) A[i][j] += x[i] * x[j];
        }
      }
      for (let i = 0; i < rated.length; i++) {
        A[i][i] += RIDGE;
        b[i] += RIDGE * prior;
      }
      // The "other" slot is unpenalised and can be absent from a resample; pin it to the prior then.
      if (!A[other][other]) {
        A[other][other] = 1;
        b[other] = prior;
      }
      return solveLinear(A, b);
    };

    const point = fit(teams);
    let seed = 20261017;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const BOOTSTRAP = 200;
    const byDay = new Map<number, Team[]>();
    for (const team of teams) byDay.set(team.day, [...(byDay.get(team.day) || []), team]);
    const days = [...byDay.values()];
    const samples: number[][] = rated.map(() => []);
    for (let t = 0; t < BOOTSTRAP; t++) {
      const resample: Team[] = [];
      while (resample.length < teams.length) resample.push(...days[Math.floor(random() * days.length)]);
      const weights = fit(resample);
      for (let i = 0; i < rated.length; i++) samples[i].push(weights[i]);
    }

    return {
      players: rated.map((discordId, i) => ({
        discordId,
        steamId: steamIds.get(discordId) || '',
        rating: point[i],
        games: games.get(discordId) || 0,
        lastPlayed: lastPlayed.get(discordId) || 0,
        samples: samples[i]
      })),
      scoredTeams: teams.length
    };
  }

  getPlayerStats(discordId: string, scope: TurboStatsScope = 'all', sinceTimestamp?: number): TurboPlayerStats | undefined {
    const stats = this.shouldDeriveFromLedger(scope, sinceTimestamp) ? this.deriveStats(scope, sinceTimestamp).playerStats : this.turboStats.playerStats;
    return stats.find(player => player.discordId === discordId);
  }

  getPairingsForPlayer(discordId: string, scope: TurboStatsScope = 'all', sinceTimestamp?: number, useLegacy = false) {
    return this.statsForView(scope, sinceTimestamp, useLegacy).pairings
      .filter(pair => pair.player1 === discordId || pair.player2 === discordId);
  }

  processTurboMatch(matchData: any, registeredPlayers: RegisteredPlayer[], source: Exclude<TurboMatchSource, 'both'> = 'live', deferRebuild = false): boolean {
    const normalized = this.normalizeMatch(matchData, registeredPlayers, source);
    if (!normalized) return false;
    const result = this.mergeLedgerMatch(normalized);
    if (!result.changed) return false;

    if (!deferRebuild) {
      if (!result.aggregatesChanged) {
        this.saveTurboStats();
      } else if (result.inserted) {
        this.addMatchToAggregates(normalized);
        this.addMatchToLegacyTrackedPairings(normalized);
        this.saveTurboStats();
      } else if (this.turboStats.statsBuiltFromLedger) {
        this.rebuildAggregatesFromLedger();
      } else {
        // Preserve pre-ledger legacy totals. A later backfill will rebuild this
        // expanded match correctly from the deduplicated ledger.
        this.saveTurboStats();
      }
    }
    return true;
  }

  /**
   * Best five-player lineups from a candidate pool. Anyone in `requiredIds` is locked into every
   * lineup considered, which is what answers "what is the best party *for me*" — the unconstrained
   * top three routinely exclude a given player entirely. `minCoveredPairs` is how many of the ten
   * pairs need 5+ games together for a lineup to be ranked at all.
   */
  recommendParties(candidateIds: string[], scope: TurboStatsScope = 'all', limit = 3, sinceTimestamp?: number, requiredIds: string[] = [], minCoveredPairs = 7): TurboPartyRecommendation[] {
    const uniqueIds = [...new Set(candidateIds)];
    if (uniqueIds.length < 5) return [];
    const required = [...new Set(requiredIds)].filter(id => uniqueIds.includes(id));
    if (required.length > 5) return [];
    const optional = uniqueIds.filter(id => !required.includes(id));
    const { playerStats, pairings } = this.shouldDeriveFromLedger(scope, sinceTimestamp) ? this.deriveStats(scope, sinceTimestamp) : { playerStats: this.turboStats.playerStats, pairings: this.turboStats.pairings };
    const playerMap = new Map(playerStats.map(player => [player.discordId, player]));
    const pairMap = new Map(pairings.map(pair => [[pair.player1, pair.player2].sort().join(':'), pair]));
    const matches = this.matchesForScope(scope, sinceTimestamp);
    const exactLineups = new Map<string, { games: number; wins: number }>();
    for (const match of matches) for (const team of ['radiant', 'dire'] as const) {
      const ids = match.players.filter(player => player.team === team).map(player => player.discordId);
      if (ids.length !== 5) continue;
      const key = ids.sort().join(':');
      const result = exactLineups.get(key) || { games: 0, wins: 0 };
      result.games++;
      if ((team === 'radiant') === match.radiantWon) result.wins++;
      exactLineups.set(key, result);
    }
    const recommendations: TurboPartyRecommendation[] = [];

    const evaluate = (ids: string[]) => {
      const individualRates = ids.map(id => {
        const stats = playerMap.get(id);
        return ((stats?.wins || 0) + 10) / ((stats ? stats.wins + stats.losses : 0) + 20);
      });
      const base = individualRates.reduce((sum, rate) => sum + rate, 0) / 5;
      const observedPairs: TurboPairing[] = [];
      let residualTotal = 0;
      let averagePairGames = 0;
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const pair = pairMap.get([ids[i], ids[j]].sort().join(':'));
        const games = pair ? pair.wins + pair.losses : 0;
        const pairRate = ((pair?.wins || 0) + 10) / (games + 20);
        residualTotal += pairRate - (individualRates[i] + individualRates[j]) / 2;
        averagePairGames += games;
        if (pair && games >= 5) observedPairs.push(pair);
      }
      averagePairGames /= 10;
      let predicted = Math.max(0.35, Math.min(0.70, base + 0.75 * (residualTotal / 10)));
      const exact = exactLineups.get([...ids].sort().join(':'));
      const exactLineupGames = exact?.games || 0;
      const exactLineupWins = exact?.wins || 0;
      if (exactLineupGames) {
        const lineupPosterior = (exactLineupWins + 10) / (exactLineupGames + 20);
        const weight = exactLineupGames / (exactLineupGames + 20);
        predicted = predicted * (1 - weight) + lineupPosterior * weight;
      }
      const effectiveN = averagePairGames + exactLineupGames * 2;
      const margin = 1.96 * Math.sqrt(predicted * (1 - predicted) / (effectiveN + 10));
      // Same ordering the duo board uses: strongest means best-evidenced, not the highest
      // projection, or a 15-8 pair gets named the anchor of a lineup over a 59-44 one.
      const sortedPairs = [...observedPairs].sort((a, b) => this.pairSortKey(b) - this.pairSortKey(a));
      recommendations.push({
        playerIds: ids,
        predictedWinRate: predicted,
        lowWinRate: Math.max(0, predicted - margin),
        highWinRate: Math.min(1, predicted + margin),
        score: (predicted - margin * 0.35) * 100,
        coveredPairs: observedPairs.length,
        totalPairs: 10,
        averagePairGames,
        exactLineupGames,
        exactLineupWins,
        evaluatedLineups: 0,
        indistinguishableLineups: 0,
        strongestPair: sortedPairs[0],
        weakestPair: sortedPairs[sortedPairs.length - 1]
      });
    };

    // Seeding the recursion with the required players is both the constraint and the speed-up:
    // only the remaining slots are ever enumerated.
    const choose = (start: number, picked: string[]) => {
      if (picked.length === 5) return evaluate(picked);
      for (let i = start; i <= optional.length - (5 - picked.length); i++) choose(i + 1, [...picked, optional[i]]);
    };
    choose(0, [...required]);

    const ranked = recommendations.filter(rec => rec.coveredPairs >= minCoveredPairs).sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (!best) return [];
    // A lineup whose point estimate sits inside the leader's interval is not distinguishable from
    // the leader on this evidence. Report how much of the field that covers so the caller can say
    // whether the ordering is a real gap or a tiebreak on confidence.
    const indistinguishable = ranked.filter(
      rec => rec.predictedWinRate >= best.lowWinRate && rec.predictedWinRate <= best.highWinRate,
    ).length;
    for (const rec of ranked) {
      rec.evaluatedLineups = ranked.length;
      rec.indistinguishableLineups = indistinguishable;
    }
    return ranked.slice(0, limit);
  }

  getAllStats(): TurboStatsData {
    return this.turboStats;
  }
}

/** Gaussian elimination with partial pivoting; the systems here are ~20 unknowns. */
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[pivot][c])) pivot = r;
    [M[c], M[pivot]] = [M[pivot], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const factor = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= factor * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}
