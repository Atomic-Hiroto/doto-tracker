import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import turboStatsModule from '../dist/services/turboStatsService.js';

const { TurboStatsService } = turboStatsModule;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doto-turbo-party-'));
const statsPath = path.join(tempDir, 'stats.json');
const roster = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => ({ discordId: id, steamId: String(index + 1) }));
const service = new TurboStatsService(statsPath);

function historicalMatch(id) {
  return {
    id,
    startDateTime: 1_750_000_000 + id,
    didRadiantWin: true,
    players: roster.map((player, index) => ({
      steamAccountId: Number(player.steamId),
      isRadiant: index < 5,
      playerSlot: index < 5 ? index : 128,
      partyId: index < 5 ? 77 : 88
    }))
  };
}

try {
  const legacyPath = path.join(tempDir, 'legacy.json');
  fs.writeFileSync(legacyPath, JSON.stringify({
    playerStats: [{ discordId: 'a', steamId: '1', wins: 20, losses: 10, rating: 0, lastUpdated: 1 }],
    pairings: [],
    lastProcessedMatch: null
  }));
  const legacyService = new TurboStatsService(legacyPath);
  assert.equal(legacyService.processTurboMatch({
    match_id: 999,
    game_mode: 23,
    start_time: 1_740_000_000,
    radiant_win: true,
    players: [{ account_id: 1, player_slot: 0 }]
  }, roster), true);
  assert.equal(legacyService.getPlayerStats('a')?.wins, 21, 'a new ledger match must preserve pre-ledger tracked totals');

  for (let i = 0; i < 12; i++) {
    assert.equal(service.processTurboMatch(historicalMatch(1000 + i), roster, 'historical', true), true);
  }
  assert.equal(service.processTurboMatch(historicalMatch(1000), roster, 'historical', true), false, 'duplicate match must not be counted twice');
  service.markBackfillComplete();

  const historyPair = service.getPairingLeaderboard(20, 1, 'history').find(pair => pair.player1 === 'a' && pair.player2 === 'b');
  assert.ok(historyPair);
  assert.equal(historyPair.wins, 12);
  assert.equal(historyPair.losses, 0);
  assert.equal(historyPair.verifiedPartyGames, 12);

  const live = {
    match_id: 2000,
    game_mode: 23,
    start_time: 1_760_000_000,
    radiant_win: true,
    players: roster.map((player, index) => ({ account_id: Number(player.steamId), player_slot: index < 5 ? index : 128, party_id: index < 5 ? 22 : 33 }))
  };
  assert.equal(service.processTurboMatch(live, roster), true);
  assert.equal(service.processTurboMatch(live, roster), false, 'live replay must be idempotent');
  assert.equal(service.getPairingLeaderboard(20, 1, 'tracked').find(pair => pair.player1 === 'a' && pair.player2 === 'b')?.wins, 1);
  assert.equal(service.getPairingLeaderboard(20, 1, 'all').find(pair => pair.player1 === 'a' && pair.player2 === 'b')?.wins, 13);
  assert.equal(service.getPairingLeaderboard(20, 1, 'all', 1_755_000_000).find(pair => pair.player1 === 'a' && pair.player2 === 'b')?.wins, 1, 'date windows must exclude older ledger matches');

  const recommendations = service.recommendParties(roster.map(player => player.discordId), 'all', 1);
  assert.equal(recommendations.length, 1);
  assert.deepEqual(new Set(recommendations[0].playerIds), new Set(['a', 'b', 'c', 'd', 'e']));
  assert.equal(recommendations[0].exactLineupGames, 13);
  assert.equal(recommendations[0].coveredPairs, 10);
  console.log('Turbo ledger, evidence scopes, and five-player optimizer tests passed.');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
