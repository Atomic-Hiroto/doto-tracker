// Backtest for a "most successful party" board.
//
// Each game gives the tracked stack a strength reading: the enemy team's MMR, nudged up on a win and
// down on a loss (matchmaking holds regular stacks near 50%, so the level they hold it at is the
// signal). We fit party strength = mean(player strengths) + pair bonuses, on the oldest 70% of games,
// and check on the newest 30% whether pair bonuses help rank stacks, including stacks never seen in
// training. Run from the folder holding turboStats.json and turboRankData.json:
//   node scripts/turbo-party-strength-sim.mjs [dataDir]
import fs from 'fs';
import path from 'path';

const dir = process.argv[2] || '.';
const stats = JSON.parse(fs.readFileSync(path.join(dir, 'turboStats.json'), 'utf8'));
const rank = JSON.parse(fs.readFileSync(path.join(dir, 'turboRankData.json'), 'utf8'));

// Same enemy reading as +turbopull: registered players' observations with 2+ visible medals, else the ledger's.
const sums = new Map();
for (const player of rank.players || []) {
  if (!player.discordId) continue;
  for (const o of player.observations || []) {
    if (!Number.isFinite(o.enemyMMR) || !o.enemyMMR || (o.enemyVisibleRanks ?? 0) < 2) continue;
    const e = sums.get(String(o.matchId)) || { t: 0, n: 0 };
    e.t += o.enemyMMR; e.n++;
    sums.set(String(o.matchId), e);
  }
}

const games = [];
for (const m of stats.matches || []) {
  const ledger = m.enemyRank && m.enemyRank.visible >= 2 ? m.enemyRank.mmr : undefined;
  const s = sums.get(String(m.matchId));
  const y = s ? s.t / s.n : ledger;
  if (y === undefined) continue;
  const sides = [...new Set(m.players.map(p => p.team))];
  if (sides.length !== 1) continue;
  const ids = [...new Set(m.players.map(p => p.discordId))].sort();
  games.push({ ids, y, won: sides[0] === 'radiant' ? m.radiantWon : !m.radiantWon, t: m.timestamp });
}
games.sort((a, b) => a.t - b.t);
console.log(`${games.length} scored games`);

const lineupKey = ids => ids.join(',');
const sizeCounts = {};
const lineups = new Map();
for (const g of games) {
  const key = lineupKey(g.ids);
  lineups.set(key, (lineups.get(key) || 0) + 1);
}
for (const [key, n] of lineups) {
  const size = key.split(',').length;
  if (size < 3) continue;
  const c = sizeCounts[size] ||= { lineups: 0, with10: 0, with20: 0 };
  c.lineups++;
  if (n >= 10) c.with10++;
  if (n >= 20) c.with20++;
}
console.log('Repeat stacks by tracked size:', sizeCounts);

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c || !M[r][c]) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

const pairsOf = ids => {
  const out = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) out.push(`${ids[i]}:${ids[j]}`);
  return out;
};

// Ridge fit: player strengths shrink to the mean by `playerRidge` games, pair bonuses to 0 by `pairRidge`.
function fit(train, W, pairRidge, minPairGames = 3) {
  const target = g => g.y + (g.won ? W : -W);
  const prior = train.reduce((s, g) => s + target(g), 0) / train.length;
  const playerGames = new Map(), pairGames = new Map();
  for (const g of train) {
    for (const id of g.ids) playerGames.set(id, (playerGames.get(id) || 0) + 1);
    for (const p of pairsOf(g.ids)) pairGames.set(p, (pairGames.get(p) || 0) + 1);
  }
  const players = [...playerGames.keys()];
  const pairs = pairRidge === null ? [] : [...pairGames].filter(([, n]) => n >= minPairGames).map(([p]) => p);
  const slot = new Map([...players, ...pairs].map((k, i) => [k, i]));
  const n = slot.size;
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  for (const g of train) {
    const x = new Map();
    for (const id of g.ids) x.set(slot.get(id), 1 / g.ids.length);
    for (const p of pairsOf(g.ids)) if (slot.has(p)) x.set(slot.get(p), 1);
    for (const [i, xi] of x) {
      b[i] += xi * (target(g) - prior);
      for (const [j, xj] of x) A[i][j] += xi * xj;
    }
  }
  players.forEach(id => { A[slot.get(id)][slot.get(id)] += 3; });
  pairs.forEach(p => { A[slot.get(p)][slot.get(p)] += pairRidge; });
  const w = solve(A, b);
  const predict = ids => prior
    + ids.reduce((s, id) => s + (slot.has(id) ? w[slot.get(id)] : 0), 0) / ids.length
    + pairsOf(ids).reduce((s, p) => s + (slot.has(p) ? w[slot.get(p)] : 0), 0);
  return { predict, target, playerGames, pairGames };
}

function spearman(a, b) {
  const ranks = v => { const o = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]); const r = []; o.forEach(([, i], k) => { r[i] = k; }); return r; };
  const ra = ranks(a), rb = ranks(b), n = a.length;
  const d2 = ra.reduce((s, r, i) => s + (r - rb[i]) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

const cut = Math.floor(games.length * 0.7);
const train = games.slice(0, cut), test = games.slice(cut);
console.log(`train ${train.length} · test ${test.length}`);

for (const W of [0, 150, 300]) {
  for (const pairRidge of [null, 30, 10, 3]) {
    const m = fit(train, W, pairRidge);
    const err = test.map(g => (m.predict(g.ids) - m.target(g)) ** 2);
    const rmse = Math.sqrt(err.reduce((s, e) => s + e, 0) / err.length);
    // Lineup-level: held-out stacks of 3+ tracked with 5+ test games. "Unseen" = never together in train.
    const byLineup = new Map();
    for (const g of test) {
      if (g.ids.length < 3) continue;
      const k = lineupKey(g.ids);
      const r = byLineup.get(k) || { ids: g.ids, t: [], wins: 0 };
      r.t.push(m.target(g)); if (g.won) r.wins++;
      byLineup.set(k, r);
    }
    const trainKeys = new Set(train.map(g => lineupKey(g.ids)));
    const rows = [...byLineup.values()].filter(r => r.t.length >= 5);
    const corr = list => list.length >= 4
      ? spearman(list.map(r => m.predict(r.ids)), list.map(r => r.t.reduce((s, x) => s + x, 0) / r.t.length)).toFixed(2)
      : 'n/a';
    const unseen = rows.filter(r => !trainKeys.has(lineupKey(r.ids)));
    console.log(
      `W=${String(W).padStart(3)} pairs=${pairRidge === null ? 'off ' : `λ${String(pairRidge).padEnd(3)}`}`
      + ` game RMSE ${rmse.toFixed(0)} · stack rank corr ${corr(rows)} (${rows.length})`
      + ` · unseen stacks ${corr(unseen)} (${unseen.length})`
    );
  }
}
