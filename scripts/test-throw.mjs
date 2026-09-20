import assert from 'node:assert/strict';
import { leadGames, leadRate, withoutSharedGames } from '../dist/services/throwStats.js';
import { parseThrowArgs, throwReport, comparisonText } from '../dist/commands/throw.js';
import { opendotaClient } from '../dist/services/apiClient.js';

const base = { start_time: Math.floor(Date.now() / 1000), game_mode: 23, player_slot: 0, radiant_win: false };
const rows = [
  { ...base, match_id: 1, throw: 10000, party_size: 1 },
  { ...base, match_id: 2, radiant_win: true, stomp: 15000, party_size: 5 },
  { ...base, match_id: 3, throw: null },
  { ...base, match_id: 4, throw: 0 },
  { ...base, match_id: 5, player_slot: 128, stomp: 20000 },
  { ...base, match_id: 6, player_slot: 128, radiant_win: true, throw: 5000 },
  { ...base, match_id: 7, radiant_win: true, stomp: null, throw: 30000 },
  { ...base, match_id: 8, throw: -25 },
  { ...base, match_id: 9, player_slot: null, throw: 50000 },
];
const games = leadGames([...rows, rows[0]]);
assert.equal(games.length, 6, 'missing gold, invalid slots, and duplicates must not count');
assert.equal(games.find(g => g.id === 5).won, true, 'Dire outcome must be inverted');
assert.equal(games.find(g => g.id === 8).lead, 0);
const rate = leadRate(games, 10000);
assert.equal(rate.n, 3, 'wins that reached a lead belong in the denominator');
assert.equal(rate.lost, 1);
assert.equal(rate.rate, 1 / 3);
assert.ok(rate.low < rate.rate && rate.high > rate.rate);
assert.equal(leadRate([], 10000).rate, null);
assert.ok(leadRate(games.filter(g => g.won), 10000).high > 0, 'zero losses does not mean certainty');
assert.equal(withoutSharedGames(games, [games[0]]).a.length, 5);
assert.equal(withoutSharedGames(games, [], new Set([1])).a.length, 5, 'exclude overlap even if other player lacks usable gold');
assert.deepEqual(parseThrowArgs([]), { days: 90, mode: 'turbo', queue: 'all', targets: [] });
assert.equal(parseThrowArgs(['normal', 'days=180', 'solo']).queue, 'solo');
const sample = (n, losses) => Array.from({ length: n }, (_, id) => ({ id, won: id >= losses, lead: 10000, party: 'party' }));
assert.match(comparisonText('epi', sample(39, 8), 'Atomic', sample(122, 16)), /epi edges it, but it's a close call/);
assert.match(comparisonText('A', sample(20, 4), 'B', sample(20, 4)), /A tie/);
assert.match(comparisonText('A', sample(2, 2), 'B', sample(20, 4)), /Too early/);
for (const args of [['days=0'], ['days=90junk'], ['normal', 'turbo'], ['solo', 'party'], ['a', 'b', 'c']]) {
  assert.throws(() => parseThrowArgs(args));
}

// Exercise the actual handler and Discord embed validation without network calls or credentials.
const originalGet = opendotaClient.get;
const edits = [];
const replies = [];
const message = {
  author: { id: 'author', username: 'A' },
  mentions: { users: new Map() },
  reply: async payload => { replies.push(payload); return { edit: async edit => edits.push(edit) }; },
};
try {
  opendotaClient.get = async url => ({ data: url.includes('/matches?') ? rows : { profile: { personaname: 'Test' } } });
  await throwReport(message, ['325514595', '165196360'], {});
  const embed = edits[0].embeds[0].toJSON();
  assert.match(embed.fields[0].value, /6\/9/);
  assert.match(embed.fields[2].value, /9 games you both played/);
  assert.match(embed.description, /Too early/);
  assert.doesNotMatch(JSON.stringify(embed), /95% interval|percentage points|Wilson/);
  assert.ok(JSON.stringify(embed).length < 6000);
  await throwReport(message, ['325514595', '325514595'], {});
  assert.match(replies.at(-1), /different players/);
  opendotaClient.get = async () => { throw new Error('provider unavailable'); };
  await throwReport(message, ['325514595'], {});
  assert.match(edits.at(-1), /could not supply/);
} finally {
  opendotaClient.get = originalGet;
}
console.log('Throw statistics, input handling, embed output and provider-failure checks passed.');
