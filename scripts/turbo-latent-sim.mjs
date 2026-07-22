// Read-only research harness for a candidate hidden Turbo matchmaking estimator.
//
// It compares, on the same fresh STRATZ solo-match data:
//   OLD-FRESH   production formula: recency x visible-rank completeness weighted lobby mean
//   ROBUST      65% trimmed weighted mean + 35% weighted median
//   LATENT      robust placement + shrunk team-balance inversion + result likelihood
//
// Evaluation is chronological per player: oldest 70% trains the estimate, newest
// 30% tests whether it predicts future lobby placement and match outcomes. The
// script never mutates bot data and never recalibrates the production service.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import axios from 'axios';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');

const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const hasFlag = flag => args.includes(flag);

const dataPath = resolve(valueAfter('--data', join(root, 'turboRankData.json')));
const envPath = resolve(valueAfter('--env', join(root, '.env')));
const delayMs = Math.max(0, Number(valueAfter('--delay-ms', '1100')) || 0);
const requestedLimit = Number(valueAfter('--limit', '0')) || 0;
const focusNames = valueAfter('--focus', '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
const useCachedObservations = hasFlag('--cached-observations');
const quiet = hasFlag('--quiet');

const envRaw = readFileSync(envPath, 'utf8');
const TOKEN = envRaw.split('\n').find(line => line.startsWith('STRATZ_API_KEY'))
  ?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
if (!TOKEN) throw new Error('STRATZ_API_KEY is missing');

const source = JSON.parse(readFileSync(dataPath, 'utf8'));
let cohort = (source.players ?? []).filter(player => player.estimate);
const cohortBucket = valueAfter('--cohort-bucket', '');
if (cohortBucket === '0' || cohortBucket === '1') {
  const wanted = BigInt(cohortBucket);
  cohort = cohort.filter(player => BigInt(player.steamId) % 2n === wanted);
}
if (focusNames.length) {
  cohort = cohort.filter(player => focusNames.some(q =>
    (player.steamName ?? '').toLowerCase().includes(q)
    || String(player.steamId) === q));
}
if (requestedLimit > 0) cohort = cohort.slice(0, requestedLimit);

const GQL = 'https://api.stratz.com/graphql';
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
  'User-Agent': 'STRATZ_API',
  Accept: 'application/json',
};
const ONE_YEAR_AGO = Math.floor(Date.now() / 1000) - 365 * 86400;
const QUERY = `
query ($steamAccountId: Long!, $take: Int!, $startDateTime: Long!, $isParty: Boolean!) {
  player(steamAccountId: $steamAccountId) {
    steamAccount { name seasonRank seasonLeaderboardRank }
    matches(request: { gameModeIds: [23], take: $take, orderBy: DESC, startDateTime: $startDateTime, isParty: $isParty }) {
      id
      startDateTime
      averageRank
      didRadiantWin
      players {
        steamAccountId
        isRadiant
        steamAccount { seasonRank seasonLeaderboardRank }
      }
    }
  }
}`;

const FLOORS = { 1: 0, 2: 770, 3: 1540, 4: 2310, 5: 3080, 6: 3850, 7: 4620, 8: 5420 };
const NAMES = { 1: 'Herald', 2: 'Guardian', 3: 'Crusader', 4: 'Archon', 5: 'Legend', 6: 'Ancient', 7: 'Divine', 8: 'Immortal' };
const MMR_PER_STAR = 153;
const HALF_LIFE_SECONDS = 60 * 86400;
const MIN_VISIBLE_RANKS = 3;
const ELO_TEAM_AVG_SCALE = Math.max(100, Number(valueAfter('--elo-scale', '800')) || 800);
const RESULT_PRIOR_SIGMA = Math.max(25, Number(valueAfter('--result-prior-sigma', '250')) || 250);
const MAX_BALANCE_WEIGHT = clampConfig(Number(valueAfter('--max-balance-weight', '0.05')), 0, 1, 0.05);

function clampConfig(value, lo, hi, fallback) {
  return Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : fallback;
}

function rankTierToMMR(rankTier) {
  if (!rankTier || rankTier <= 0) return null;
  const tier = Math.floor(rankTier / 10);
  const stars = rankTier % 10;
  return FLOORS[tier] == null ? null : FLOORS[tier] + stars * MMR_PER_STAR;
}

function mmrToMedal(mmr) {
  for (let tier = 8; tier >= 1; tier--) {
    if (mmr >= FLOORS[tier]) {
      const rawStars = Math.round((mmr - FLOORS[tier]) / MMR_PER_STAR);
      const stars = Math.min(Math.max(rawStars, 0), tier === 8 ? 0 : 5);
      return stars > 0 ? `${NAMES[tier]} ${stars}` : NAMES[tier];
    }
  }
  return 'Herald';
}

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

async function sleep(ms) {
  if (ms > 0) await new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

async function fetchFreshPlayer(steamId) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await axios.post(
        GQL,
        {
          query: QUERY,
          variables: {
            steamAccountId: Number(steamId),
            take: 100,
            startDateTime: ONE_YEAR_AGO,
            isParty: false,
          },
        },
        { headers, timeout: 35000 },
      );
      if (response.data?.errors?.length) {
        throw new Error(JSON.stringify(response.data.errors).slice(0, 500));
      }
      return response.data?.data?.player ?? null;
    } catch (error) {
      lastError = error;
      const status = error?.response?.status;
      if (attempt === 3 || (status && status < 429)) break;
      await sleep(1200 * attempt);
    }
  }
  throw lastError;
}

function extractObservations(matches, steamId) {
  const sid = String(steamId);
  const observations = [];
  for (const match of matches ?? []) {
    const players = match.players ?? [];
    const tracked = players.find(player => String(player.steamAccountId) === sid);
    if (!tracked) continue;

    const allies = players.filter(player =>
      String(player.steamAccountId) !== sid && player.isRadiant === tracked.isRadiant);
    const enemies = players.filter(player => player.isRadiant !== tracked.isRadiant);
    const allyMMRs = allies.map(player => rankTierToMMR(player.steamAccount?.seasonRank)).filter(Number.isFinite);
    const enemyMMRs = enemies.map(player => rankTierToMMR(player.steamAccount?.seasonRank)).filter(Number.isFinite);
    const allMMRs = [...allyMMRs, ...enemyMMRs];
    if (allMMRs.length < MIN_VISIBLE_RANKS) continue;

    const won = typeof match.didRadiantWin === 'boolean'
      ? tracked.isRadiant === match.didRadiantWin
      : null;
    observations.push({
      matchId: Number(match.id),
      timestamp: Number(match.startDateTime || 0),
      lobbyMMR: mean(allMMRs),
      allyMMRs,
      enemyMMRs,
      visibleRanks: allMMRs.length,
      won,
    });
  }
  return observations.sort((a, b) => a.timestamp - b.timestamp);
}

function extractCachedObservations(player) {
  return (player.observations ?? [])
    .filter(obs => obs.partySize === 1 && obs.timestamp >= ONE_YEAR_AGO)
    .map(obs => ({
      matchId: Number(obs.matchId),
      timestamp: Number(obs.timestamp || 0),
      lobbyMMR: Number(obs.lobbyMMR),
      allyMMRs: Number.isFinite(obs.allyMMR)
        ? Array(Math.max(0, Number(obs.allyVisibleRanks || 0))).fill(Number(obs.allyMMR))
        : [],
      enemyMMRs: Number.isFinite(obs.enemyMMR)
        ? Array(Math.max(0, Number(obs.enemyVisibleRanks || 0))).fill(Number(obs.enemyMMR))
        : [],
      visibleRanks: Number(obs.visibleRanks || 0),
      won: typeof obs.won === 'boolean' ? obs.won : null,
    }))
    .filter(obs => Number.isFinite(obs.lobbyMMR) && obs.visibleRanks >= MIN_VISIBLE_RANKS)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function weightedRows(observations, anchorTimestamp) {
  const anchor = anchorTimestamp ?? Math.max(...observations.map(obs => obs.timestamp), 0);
  return observations.map(obs => {
    const age = Math.max(0, anchor - obs.timestamp);
    const recency = Math.exp(-Math.LN2 * age / HALF_LIFE_SECONDS);
    const completeness = Math.min(obs.visibleRanks, 9) / 9;
    return { obs, w: recency * completeness };
  }).filter(row => row.w > 0);
}

function weightedMean(rows, getter) {
  const total = rows.reduce((sum, row) => sum + row.w, 0);
  return total ? rows.reduce((sum, row) => sum + getter(row.obs) * row.w, 0) / total : null;
}

function weightedMedian(rows, getter) {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => getter(a.obs) - getter(b.obs));
  const total = sorted.reduce((sum, row) => sum + row.w, 0);
  let cumulative = 0;
  for (const row of sorted) {
    cumulative += row.w;
    if (cumulative >= total / 2) return getter(row.obs);
  }
  return getter(sorted.at(-1).obs);
}

function weightedTrimmedMean(rows, getter, trimFraction = 0.1) {
  if (rows.length < 5) return weightedMean(rows, getter);
  const sorted = [...rows].sort((a, b) => getter(a.obs) - getter(b.obs));
  const total = sorted.reduce((sum, row) => sum + row.w, 0);
  const lower = total * trimFraction;
  const upper = total * (1 - trimFraction);
  let cumulative = 0;
  let keptWeight = 0;
  let sum = 0;
  for (const row of sorted) {
    const next = cumulative + row.w;
    const overlap = Math.max(0, Math.min(next, upper) - Math.max(cumulative, lower));
    if (overlap > 0) {
      sum += getter(row.obs) * overlap;
      keptWeight += overlap;
    }
    cumulative = next;
  }
  return keptWeight ? sum / keptWeight : weightedMean(rows, getter);
}

function placementEstimates(observations, anchorTimestamp) {
  const rows = weightedRows(observations, anchorTimestamp);
  if (!rows.length) return null;
  const raw = weightedMean(rows, obs => obs.lobbyMMR);
  const trimmed = weightedTrimmedMean(rows, obs => obs.lobbyMMR);
  const median = weightedMedian(rows, obs => obs.lobbyMMR);
  const robust = trimmed * 0.65 + median * 0.35;
  return { raw, robust, rows };
}

function filledSides(obs) {
  const fill = obs.lobbyMMR;
  const allySum = obs.allyMMRs.reduce((sum, value) => sum + value, 0) + (4 - obs.allyMMRs.length) * fill;
  const enemySum = obs.enemyMMRs.reduce((sum, value) => sum + value, 0) + (5 - obs.enemyMMRs.length) * fill;
  return { allySum, enemySum };
}

function balanceEstimate(rows) {
  const usable = rows
    .filter(row => row.obs.allyMMRs.length >= 2 && row.obs.enemyMMRs.length >= 3)
    .map(row => {
      const { allySum, enemySum } = filledSides(row.obs);
      return {
        obs: { value: clamp(enemySum - allySum, 0, 8000) },
        w: row.w * ((row.obs.allyMMRs.length + row.obs.enemyMMRs.length) / 9),
      };
    });
  if (!usable.length) return null;
  const trimmed = weightedTrimmedMean(usable, obs => obs.value, 0.15);
  const median = weightedMedian(usable, obs => obs.value);
  return {
    mmr: trimmed * 0.5 + median * 0.5,
    games: usable.length,
    effectiveWeight: usable.reduce((sum, row) => sum + row.w, 0),
  };
}

function expectedWin(rating, obs) {
  const { allySum, enemySum } = filledSides(obs);
  const ownTeamAverage = (rating + allySum) / 5;
  const enemyTeamAverage = enemySum / 5;
  const diff = ownTeamAverage - enemyTeamAverage;
  return 1 / (1 + Math.pow(10, -diff / ELO_TEAM_AVG_SCALE));
}

function fitResultPosterior(rows, priorMean, priorSigma = RESULT_PRIOR_SIGMA) {
  const usable = rows.filter(row => typeof row.obs.won === 'boolean');
  let rating = priorMean;
  const dz = Math.LN10 / (5 * ELO_TEAM_AVG_SCALE);
  let information = 1 / (priorSigma * priorSigma);

  for (let iteration = 0; iteration < 20; iteration++) {
    let gradient = -(rating - priorMean) / (priorSigma * priorSigma);
    let hessian = -1 / (priorSigma * priorSigma);
    for (const row of usable) {
      const probability = clamp(expectedWin(rating, row.obs), 1e-6, 1 - 1e-6);
      const actual = row.obs.won ? 1 : 0;
      gradient += row.w * dz * (actual - probability);
      hessian -= row.w * dz * dz * probability * (1 - probability);
    }
    const step = gradient / hessian;
    rating = clamp(rating - step, 0, 8000);
    if (Math.abs(step) < 0.01) break;
  }

  information = 1 / (priorSigma * priorSigma);
  for (const row of usable) {
    const probability = expectedWin(rating, row.obs);
    information += row.w * dz * dz * probability * (1 - probability);
  }
  return {
    mmr: rating,
    resultDelta: rating - priorMean,
    posteriorSd: Math.sqrt(1 / information),
    games: usable.length,
  };
}

function estimateAll(observations, anchorTimestamp) {
  const placement = placementEstimates(observations, anchorTimestamp);
  if (!placement) return null;
  const balance = balanceEstimate(placement.rows);

  // Team inversion is valuable but substantially noisier than placement because
  // visible ranked medals are imperfect skill proxies. The cohort sweep found that
  // a 5% ceiling preserves future-placement accuracy; larger pulls overfit badly.
  const balanceReliability = balance
    ? Math.min(MAX_BALANCE_WEIGHT, MAX_BALANCE_WEIGHT * balance.effectiveWeight / (balance.effectiveWeight + 12))
    : 0;
  const balanceDelta = balance ? clamp(balance.mmr - placement.robust, -900, 900) : 0;
  const priorMean = placement.robust + balanceReliability * balanceDelta;
  const posterior = fitResultPosterior(placement.rows, priorMean);

  return {
    oldFresh: placement.raw,
    robust: placement.robust,
    balance: balance?.mmr ?? null,
    balanceWeight: balanceReliability,
    priorMean,
    latent: posterior.mmr,
    resultDelta: posterior.resultDelta,
    posteriorSd: posterior.posteriorSd,
    games: observations.length,
  };
}

function logLoss(rating, observations) {
  const usable = observations.filter(obs => typeof obs.won === 'boolean');
  if (!usable.length) return null;
  return mean(usable.map(obs => {
    const p = clamp(expectedWin(rating, obs), 1e-6, 1 - 1e-6);
    return obs.won ? -Math.log(p) : -Math.log(1 - p);
  }));
}

function brier(rating, observations) {
  const usable = observations.filter(obs => typeof obs.won === 'boolean');
  if (!usable.length) return null;
  return mean(usable.map(obs => {
    const p = expectedWin(rating, obs);
    const y = obs.won ? 1 : 0;
    return (p - y) ** 2;
  }));
}

function chronologicalEvaluation(observations) {
  if (observations.length < 12) return null;
  const split = Math.max(8, Math.min(observations.length - 4, Math.floor(observations.length * 0.7)));
  const train = observations.slice(0, split);
  const test = observations.slice(split);
  const estimates = estimateAll(train, train.at(-1).timestamp);
  const future = placementEstimates(test, test.at(-1).timestamp);
  if (!estimates || !future) return null;
  return {
    train: train.length,
    test: test.length,
    futureLobby: future.raw,
    oldLobbyError: Math.abs(estimates.oldFresh - future.raw),
    robustLobbyError: Math.abs(estimates.robust - future.raw),
    latentLobbyError: Math.abs(estimates.latent - future.raw),
    oldLogLoss: logLoss(estimates.oldFresh, test),
    robustLogLoss: logLoss(estimates.robust, test),
    latentLogLoss: logLoss(estimates.latent, test),
    oldBrier: brier(estimates.oldFresh, test),
    robustBrier: brier(estimates.robust, test),
    latentBrier: brier(estimates.latent, test),
  };
}

function pearson(pairs, x, y) {
  if (pairs.length < 3) return null;
  const xs = pairs.map(x);
  const ys = pairs.map(y);
  const xm = mean(xs);
  const ym = mean(ys);
  let covariance = 0;
  let xv = 0;
  let yv = 0;
  for (let i = 0; i < pairs.length; i++) {
    const dx = xs[i] - xm;
    const dy = ys[i] - ym;
    covariance += dx * dy;
    xv += dx * dx;
    yv += dy * dy;
  }
  return xv && yv ? covariance / Math.sqrt(xv * yv) : null;
}

function aggregateEvaluation(results) {
  const evaluated = results.filter(result => result.evaluation);
  const metricMean = key => {
    const values = evaluated.map(result => result.evaluation[key]).filter(Number.isFinite);
    return mean(values);
  };
  return {
    players: evaluated.length,
    oldLobbyMAE: metricMean('oldLobbyError'),
    robustLobbyMAE: metricMean('robustLobbyError'),
    latentLobbyMAE: metricMean('latentLobbyError'),
    oldLogLoss: metricMean('oldLogLoss'),
    robustLogLoss: metricMean('robustLogLoss'),
    latentLogLoss: metricMean('latentLogLoss'),
    oldBrier: metricMean('oldBrier'),
    robustBrier: metricMean('robustBrier'),
    latentBrier: metricMean('latentBrier'),
    oldFutureCorrelation: pearson(evaluated, result => result.full.oldFresh, result => result.evaluation.futureLobby),
    latentFutureCorrelation: pearson(evaluated, result => result.full.latent, result => result.evaluation.futureLobby),
  };
}

const round = value => value == null || !Number.isFinite(value) ? null : Math.round(value);
const fixed = (value, digits = 3) => value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));

const results = [];
const failures = [];
for (let index = 0; index < cohort.length; index++) {
  const player = cohort[index];
  const label = player.steamName ?? player.steamId;
  if (!quiet) process.stderr.write(`[${index + 1}/${cohort.length}] ${label}\n`);
  try {
    const fresh = useCachedObservations ? null : await fetchFreshPlayer(player.steamId);
    const observations = useCachedObservations
      ? extractCachedObservations(player)
      : extractObservations(fresh?.matches ?? [], player.steamId);
    const full = estimateAll(observations, Math.floor(Date.now() / 1000));
    if (!full) {
      failures.push({ name: label, steamId: player.steamId, error: 'no usable fresh solo observations' });
    } else {
      results.push({
        name: fresh?.steamAccount?.name ?? label,
        steamId: player.steamId,
        rankedTier: fresh?.steamAccount?.seasonRank ?? player.estimate.rankedTier ?? null,
        storedMMR: player.estimate.estimatedMMR,
        storedMedal: player.estimate.medal,
        full,
        evaluation: chronologicalEvaluation(observations),
      });
    }
  } catch (error) {
    failures.push({ name: label, steamId: player.steamId, error: error?.message ?? String(error) });
  }
  if (!useCachedObservations && index < cohort.length - 1) await sleep(delayMs);
}

const evaluation = aggregateEvaluation(results);
const rankedRows = results.filter(result => {
  const tier = Math.floor((result.rankedTier ?? 0) / 10);
  return tier >= 1 && tier < 8;
});
const rankedMAE = getter => mean(rankedRows.map(result => {
  const rankedMMR = rankTierToMMR(result.rankedTier);
  return Math.abs(getter(result) - rankedMMR);
}));

const summary = {
  generatedAt: new Date().toISOString(),
  cohort: cohort.length,
  successful: results.length,
  failures: failures.length,
  method: {
    recencyHalfLifeDays: 60,
    robustBlend: '65% weighted trimmed mean + 35% weighted median',
    maxBalanceWeight: MAX_BALANCE_WEIGHT,
    resultPriorSigma: RESULT_PRIOR_SIGMA,
    eloTeamAverageScale: ELO_TEAM_AVG_SCALE,
    chronologicalSplit: 'oldest 70% train / newest 30% test; min 8 train, 4 test',
  },
  evaluation: Object.fromEntries(Object.entries(evaluation).map(([key, value]) =>
    [key, key.includes('Correlation') || key.includes('Loss') || key.includes('Brier') ? fixed(value) : round(value)])),
  rankedAnchorMAE: {
    players: rankedRows.length,
    stored: round(rankedMAE(result => result.storedMMR)),
    oldFresh: round(rankedMAE(result => result.full.oldFresh)),
    robust: round(rankedMAE(result => result.full.robust)),
    latent: round(rankedMAE(result => result.full.latent)),
  },
  players: results
    .map(result => ({
      name: result.name,
      steamId: result.steamId,
      games: result.full.games,
      storedMMR: round(result.storedMMR),
      storedMedal: result.storedMedal,
      oldFreshMMR: round(result.full.oldFresh),
      oldFreshMedal: mmrToMedal(result.full.oldFresh),
      refreshDelta: round(result.full.oldFresh - result.storedMMR),
      robustMMR: round(result.full.robust),
      balanceMMR: round(result.full.balance),
      balanceWeight: fixed(result.full.balanceWeight, 2),
      resultDelta: round(result.full.resultDelta),
      latentMMR: round(result.full.latent),
      latentMedal: mmrToMedal(result.full.latent),
      modelDelta: round(result.full.latent - result.full.oldFresh),
      totalDelta: round(result.full.latent - result.storedMMR),
      posteriorSd: round(result.full.posteriorSd),
      evaluated: !!result.evaluation,
    }))
    .sort((a, b) => Math.abs(b.modelDelta) - Math.abs(a.modelDelta)),
  failureDetails: failures,
};

if (hasFlag('--summary-only')) {
  console.log(JSON.stringify({ method: summary.method, evaluation: summary.evaluation, rankedAnchorMAE: summary.rankedAnchorMAE }, null, 2));
} else if (hasFlag('--json')) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('\nAGGREGATE EVALUATION');
  console.log(JSON.stringify({ evaluation: summary.evaluation, rankedAnchorMAE: summary.rankedAnchorMAE }, null, 2));
  console.log('\nPLAYER MOVEMENTS');
  console.log('name\tgames\tstored\toldFresh\tlatent\tmodelDelta\tstoredMedal\tlatentMedal\tresultDelta');
  for (const player of summary.players) {
    console.log([
      player.name,
      player.games,
      player.storedMMR,
      player.oldFreshMMR,
      player.latentMMR,
      player.modelDelta,
      player.storedMedal,
      player.latentMedal,
      player.resultDelta,
    ].join('\t'));
  }
  if (failures.length) console.log('\nFAILURES\n' + JSON.stringify(failures, null, 2));
}
