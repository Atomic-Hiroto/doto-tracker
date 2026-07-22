import assert from 'node:assert/strict';

import { computeTurboExperimentalV2 } from '../dist/services/turboRankService.js';

function observation({
  lobbyMMR = 3000,
  allyMMR = 3000,
  enemyMMR = 3000,
  allyVisibleRanks = 4,
  enemyVisibleRanks = 5,
  won,
} = {}) {
  return {
    matchId: 1,
    lobbyMMR,
    allyMMR,
    enemyMMR,
    allyVisibleRanks,
    enemyVisibleRanks,
    partySize: 1,
    partyWeight: 1,
    timestamp: 1_700_000_000,
    visibleRanks: allyVisibleRanks + enemyVisibleRanks,
    tiers: [],
    won,
  };
}

function weighted(rows) {
  return rows.map((obs) => ({ obs, w: 1 }));
}

const neutral = computeTurboExperimentalV2(
  weighted(Array.from({ length: 20 }, (_, index) => observation({ won: index % 2 === 0 }))),
  3000,
);
assert.equal(neutral.version, 2);
assert.equal(neutral.robustLobbyMMR, 3000);
assert.equal(neutral.balanceInvertedMMR, 3000);
assert.equal(neutral.balanceAdjustment, 0);
assert.ok(Math.abs(neutral.resultAdjustment) <= 1);
assert.ok(Math.abs(neutral.experimentalMMR - 3000) <= 1);

const wins = computeTurboExperimentalV2(
  weighted(Array.from({ length: 20 }, () => observation({ won: true }))),
  3000,
);
assert.ok(wins.experimentalMMR > neutral.experimentalMMR, 'wins should move the estimate upward');
assert.ok(wins.resultAdjustment > 0);
assert.ok(wins.resultAdjustment < 350, 'even an extreme 20-0 record must remain strongly regularized');

const losses = computeTurboExperimentalV2(
  weighted(Array.from({ length: 20 }, () => observation({ won: false }))),
  3000,
);
assert.ok(losses.experimentalMMR < neutral.experimentalMMR, 'losses should move the estimate downward');
assert.ok(losses.resultAdjustment < 0);
assert.ok(Math.abs(losses.resultAdjustment) < 350);

const outlier = computeTurboExperimentalV2(
  weighted([
    observation({ lobbyMMR: 3000, won: undefined }),
    observation({ lobbyMMR: 3000, won: undefined }),
    observation({ lobbyMMR: 3000, won: undefined }),
    observation({ lobbyMMR: 3000, won: undefined }),
    observation({ lobbyMMR: 6000, won: undefined }),
  ]),
  3600,
);
assert.ok(outlier.robustLobbyMMR < 3600, 'robust placement should damp a single lobby outlier');
assert.equal(outlier.resultSampleSize, 0);

const balanceCap = computeTurboExperimentalV2(
  weighted(Array.from({ length: 1000 }, () => observation({
    allyMMR: 1000,
    enemyMMR: 6000,
    won: undefined,
  }))),
  3000,
);
assert.ok(balanceCap.balanceWeight <= 0.05);
assert.ok(Math.abs(balanceCap.balanceAdjustment) <= 45, 'balance pull is capped at 5% of a 900-MMR residual');

console.log('Experimental Turbo Estimator V2 regression checks passed.');
