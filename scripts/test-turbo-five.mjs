import assert from 'node:assert/strict';
import turboFiveModule from '../dist/services/turboFiveService.js';

const { assignRoles, buildRoleTable } = turboFiveModule;

const games = (heroId, position, wins, losses) => [
  ...Array.from({ length: wins }, () => ({ heroId, position, won: true })),
  ...Array.from({ length: losses }, () => ({ heroId, position, won: false })),
];

// Everyone is a mid player on hero 1, but each also has a distinct second string.
const players = [
  { id: 'a', table: buildRoleTable([...games(1, 2, 20, 5), ...games(10, 1, 6, 4)]) },
  { id: 'b', table: buildRoleTable([...games(1, 2, 12, 8), ...games(20, 3, 15, 5)]) },
  { id: 'c', table: buildRoleTable([...games(1, 2, 10, 10), ...games(30, 4, 9, 6)]) },
  { id: 'd', table: buildRoleTable([...games(1, 2, 10, 10), ...games(40, 5, 12, 3)]) },
  { id: 'e', table: buildRoleTable([...games(50, 1, 8, 2), ...games(51, 1, 1, 0)]) },
];

const result = assignRoles(players);
assert.ok(result);
const slots = result.slots;
assert.deepEqual(slots.map(slot => slot.position), [1, 2, 3, 4, 5], 'every position filled once, in order');
const heroes = slots.map(slot => slot.heroId).filter(id => id !== null);
assert.equal(new Set(heroes).size, heroes.length, 'no hero picked twice');
const byPlayer = Object.fromEntries(slots.map(slot => [slot.playerId, slot]));
assert.equal(byPlayer.a.position, 2, 'the strongest mid record keeps mid');
assert.equal(byPlayer.a.heroId, 1, 'and keeps the contested hero');
assert.equal(byPlayer.b.heroId, 20);
assert.equal(byPlayer.c.heroId, 30);
assert.equal(byPlayer.d.heroId, 40);
assert.equal(byPlayer.e.heroId, 50, 'a 1-0 hero is below the games bar and never picked');

// Five players who only ever play one position: four of them must flex, and flex is scored lower.
const stuck = ['p', 'q', 'r', 's', 't'].map((id, i) => ({ id, table: buildRoleTable(games(100 + i, 3, 10 - i, i)) }));
const forced = assignRoles(stuck);
assert.ok(forced);
assert.equal(forced.slots.filter(slot => slot.heroId === null).length, 4);
assert.equal(forced.slots.find(slot => slot.position === 3).playerId, 'p', 'the best offlaner keeps offlane');

// A short hot streak must not beat the hero someone mains, and a hero under the bar never counts.
const mains = buildRoleTable([...games(60, 3, 5, 1), ...games(61, 3, 40, 30), ...games(62, 3, 3, 1)]).get(3);
assert.equal(mains[0].heroId, 61, 'a 40-30 main outranks a 5-1');
assert.ok(!mains.some(option => option.heroId === 62), 'a 4-game hero is below the bar');

// A five-game hero shouldn't pull a support onto a position they almost never play.
const support = buildRoleTable([...games(70, 2, 4, 1), ...games(71, 5, 50, 45)]);
assert.ok(support.get(5)[0].value > support.get(2)[0].value, 'their main position scores higher');

// No history at all still yields a full, valid lineup.
const blank = assignRoles(['v', 'w', 'x', 'y', 'z'].map(id => ({ id, table: buildRoleTable([]) })));
assert.ok(blank);
assert.equal(blank.slots.length, 5);
assert.equal(assignRoles(players.slice(0, 4)), null, 'only a full five is slotted');

console.log('Turbo five role assignment tests passed.');
