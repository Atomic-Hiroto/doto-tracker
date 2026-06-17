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
        this.recalculateAllRatings();
        logger.info('Turbo stats loaded successfully');
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

  /**
   * Recompute every stored rating with the current formula. Lets a change to
   * calculateRating take effect on existing data without waiting for new games.
   */
  private recalculateAllRatings() {
    let changed = false;
    for (const player of this.turboStats.playerStats) {
      const rating = this.calculateRating(player.wins, player.losses);
      if (rating !== player.rating) {
        player.rating = rating;
        changed = true;
      }
    }
    for (const pairing of this.turboStats.pairings) {
      const rating = this.calculateRating(pairing.wins, pairing.losses);
      if (rating !== pairing.rating) {
        pairing.rating = rating;
        changed = true;
      }
    }
    if (changed) {
      this.saveTurboStats();
    }
  }

  private saveTurboStats() {
    try {
      fs.writeFileSync(TURBO_STATS_FILE, JSON.stringify(this.turboStats, null, 2));
    } catch (error) {
      logger.error('Error saving turbo stats:', error);
    }
  }

  /**
   * Wilson score lower bound for a binomial proportion (95% confidence, z = 1.96),
   * scaled to 0-100.
   *
   * This is the conservative end of the confidence interval for a player's true
   * win rate: it rewards a high win rate *and* a large sample, while holding down
   * small samples until they're proven (a 2-0 start can't leapfrog a steady 60%
   * over 20 games). It converges to the real win rate as games accumulate, so the
   * ranking tracks skill rather than games played.
   */
  private calculateRating(wins: number, losses: number): number {
    const totalGames = wins + losses;
    if (totalGames === 0) return 0;

    const z = 1.96; // 95% confidence
    const z2 = z * z;
    const phat = wins / totalGames;

    const denominator = 1 + z2 / totalGames;
    const center = phat + z2 / (2 * totalGames);
    const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * totalGames)) / totalGames);
    const lowerBound = (center - margin) / denominator;

    return Math.round(lowerBound * 100 * 100) / 100;
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
      .filter(p => p.wins + p.losses >= 3) // Minimum 3 games to appear on leaderboard
      .sort((a, b) => b.rating - a.rating)
      .slice(0, limit);
  }

  getPairingLeaderboard(limit = 10): TurboPairing[] {
    return [...this.turboStats.pairings]
      .filter(p => p.wins + p.losses >= 3) // Minimum 3 games together
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