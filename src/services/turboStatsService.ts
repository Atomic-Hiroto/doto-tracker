import fs from 'fs';
import { TurboStatsData, TurboPlayerStats, TurboPairing } from '../models/TurboStats';
import { ProcessConstants } from '../constants';
import { logger } from './loggerService';

const TURBO_STATS_FILE = 'turboStats.json';
const TURBO_GAME_MODE = 23; // Turbo mode ID in Dota 2

export class TurboStatsService {
  private turboStats: TurboStatsData = {
    playerStats: [],
    pairings: [],
    lastProcessedMatch: null
  };

  constructor() {
    this.loadTurboStats();
  }

  private loadTurboStats() {
    try {
      if (fs.existsSync(TURBO_STATS_FILE)) {
        this.turboStats = JSON.parse(fs.readFileSync(TURBO_STATS_FILE, 'utf8'));
        // Recompute every rating with the current formula so a formula change
        // applies to existing records immediately, not only when a player next
        // plays. (Ratings are derived from wins/losses, so this is lossless.)
        for (const p of this.turboStats.playerStats) p.rating = this.calculateRating(p.wins, p.losses);
        for (const p of this.turboStats.pairings) p.rating = this.calculateRating(p.wins, p.losses);
        this.saveTurboStats();
        logger.info('Turbo stats loaded and ratings recomputed');
      }
    } catch (error) {
      logger.error('Error loading turbo stats:', error);
      this.turboStats = {
        playerStats: [],
        pairings: [],
        lastProcessedMatch: null
      };
    }
  }

  private saveTurboStats() {
    try {
      fs.writeFileSync(TURBO_STATS_FILE, JSON.stringify(this.turboStats, null, 2));
    } catch (error) {
      logger.error('Error saving turbo stats:', error);
    }
  }

  // Wilson lower bound of the win rate (95% confidence) + a small, capped
  // activity nudge. This ranks by a *conservative* win-rate estimate: small
  // samples are pulled down automatically, and grinding a low win rate no longer
  // beats genuine skill. Score is ~0–100 (skilled players land ~50–65).
  private calculateRating(wins: number, losses: number): number {
    const n = wins + losses;
    if (n === 0) return 0;

    const z = 1.96; // 95% confidence
    const p = wins / n;
    const denom = 1 + (z * z) / n;
    const centre = p + (z * z) / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
    const wilson = (centre - margin) / denom;

    const activityBonus = Math.min(n, 100) * 0.02; // max +2, just a tiebreaker
    return Math.round((wilson * 100 + activityBonus) * 100) / 100;
  }

  updatePlayerStats(discordId: string, steamId: string, won: boolean) {
    let playerStats = this.turboStats.playerStats.find(p => p.discordId === discordId);

    if (!playerStats) {
      playerStats = {
        discordId,
        steamId,
        wins: 0,
        losses: 0,
        rating: 0,
        lastUpdated: Date.now()
      };
      this.turboStats.playerStats.push(playerStats);
    }

    if (won) {
      playerStats.wins++;
    } else {
      playerStats.losses++;
    }

    playerStats.rating = this.calculateRating(playerStats.wins, playerStats.losses);
    playerStats.lastUpdated = Date.now();

    this.saveTurboStats();
  }

  updatePairingStats(player1Id: string, player2Id: string, won: boolean) {
    // Ensure consistent ordering for pairing key
    const [p1, p2] = [player1Id, player2Id].sort();

    let pairing = this.turboStats.pairings.find(
      p => (p.player1 === p1 && p.player2 === p2)
    );

    if (!pairing) {
      pairing = {
        player1: p1,
        player2: p2,
        wins: 0,
        losses: 0,
        rating: 0,
        lastUpdated: Date.now()
      };
      this.turboStats.pairings.push(pairing);
    }

    if (won) {
      pairing.wins++;
    } else {
      pairing.losses++;
    }

    pairing.rating = this.calculateRating(pairing.wins, pairing.losses);
    pairing.lastUpdated = Date.now();

    this.saveTurboStats();
  }

  getPlayerLeaderboard(limit = 10): TurboPlayerStats[] {
    return [...this.turboStats.playerStats]
      .filter(p => p.wins + p.losses >= 10) // Minimum 10 games to appear on leaderboard
      .sort((a, b) => b.rating - a.rating)
      .slice(0, limit);
  }

  getPairingLeaderboard(limit = 10): TurboPairing[] {
    return [...this.turboStats.pairings]
      .filter(p => p.wins + p.losses >= 10) // Minimum 10 games together
      .sort((a, b) => b.rating - a.rating)
      .slice(0, limit);
  }

  getPlayerStats(discordId: string): TurboPlayerStats | undefined {
    return this.turboStats.playerStats.find(p => p.discordId === discordId);
  }

  processTurboMatch(matchData: any, registeredPlayers: Array<{ discordId: string; steamId: string }>): boolean {
    // Check if it's a turbo game
    if (matchData.game_mode !== TURBO_GAME_MODE) {
      return false;
    }

    const playersInMatch = registeredPlayers.filter(player =>
      matchData.players.some((p: any) =>
        p.account_id && p.account_id.toString() === player.steamId
      )
    );

    if (playersInMatch.length === 0) {
      return false;
    }

    // Update individual player stats
    playersInMatch.forEach(player => {
      const playerInMatch = matchData.players.find((p: any) =>
        p.account_id && p.account_id.toString() === player.steamId
      );

      if (playerInMatch) {
        const isRadiant = playerInMatch.player_slot < 128;
        const won = (isRadiant && matchData.radiant_win) || (!isRadiant && !matchData.radiant_win);
        this.updatePlayerStats(player.discordId, player.steamId, won);
      }
    });

    // Update pairing stats for players who played together
    if (playersInMatch.length > 1) {
      const radiantPlayers = playersInMatch.filter(player => {
        const playerInMatch = matchData.players.find((p: any) =>
          p.account_id && p.account_id.toString() === player.steamId
        );
        return playerInMatch && playerInMatch.player_slot < 128;
      });

      const direPlayers = playersInMatch.filter(player => {
        const playerInMatch = matchData.players.find((p: any) =>
          p.account_id && p.account_id.toString() === player.steamId
        );
        return playerInMatch && playerInMatch.player_slot >= 128;
      });

      // Update stats for players on the same team
      this.updateTeamPairings(radiantPlayers, matchData.radiant_win);
      this.updateTeamPairings(direPlayers, !matchData.radiant_win);
    }

    return true;
  }

  private updateTeamPairings(teamPlayers: Array<{ discordId: string; steamId: string }>, won: boolean) {
    for (let i = 0; i < teamPlayers.length; i++) {
      for (let j = i + 1; j < teamPlayers.length; j++) {
        this.updatePairingStats(teamPlayers[i].discordId, teamPlayers[j].discordId, won);
      }
    }
  }

  getAllStats(): TurboStatsData {
    return this.turboStats;
  }
}