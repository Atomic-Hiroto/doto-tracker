// Read-only PAPER experiment: continuous solo/party blend vs shipped solo-only.
// Writes nothing, deploys nothing, touches no source.
//
// CURRENT (shipped, src/services/turboRankService.ts:299-315):
//   partyFallback = (soloObs.length === 0)
//   targets = partyFallback ? allObs : soloObs
//   weight  = recency * (partyFallback ? partyWeight : 1.0)
//   => if ANY solo game exists, party games are IGNORED entirely.
//
// BLEND (proposal #1):
//   targets = allObs
//   weight  = recency * partyWeight        (solo partyWeight = 1.0)
//   => solo still dominates; party games add a tiny, stack-shrinking pull.
//
// The question: does BLEND move the trusted anchors (Atomic ~Divine2, nitr0f ~Archon,
// law ~Ancient)? If a stack-of-friends lobby drags a low-solo player, we'll see it here.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import axios from 'axios';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');
const envRaw = readFileSync(join(root, '.env'), 'utf-8');
const TOKEN = envRaw.split('\n').find(l => l.startsWith('STRATZ_API_KEY'))
  ?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');

const GQL = 'https://api.stratz.com/graphql';
const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'STRATZ_API', Accept: 'application/json' };
const ONE_YEAR_AGO = Math.floor(Date.now() / 1000) - 365 * 24 * 3600;

const TARGETS = [
  { label: 'law',      id: 168201940, anchor: 'ranked Ancient 4 (only ~3 solo)' },
  { label: 'Atomic',   id: 121623358, anchor: 'solo turbo ~Divine 2 / 4743 (~12 solo)' },
  { label: 'nitr0f',   id: 81746167,  anchor: 'unranked; ~Archon 5' },
  { label: 'Caow!!',   id: 165196360, anchor: '-' },
  { label: 'SirPryse', id: 109431213, anchor: '-' },
  { label: 'HopE',     id: 407925203, anchor: '-' },
  { label: 'RowDYY',   id: 235833417, anchor: '- (~11 games/yr)' },
];

// ── ported constants (1:1) ─────────────────────────────────────────────────────
const MEDAL_MMR_FLOORS = { 1: 0, 2: 770, 3: 1540, 4: 2310, 5: 3080, 6: 3850, 7: 4620, 8: 5420 };
const MEDAL_NAMES = { 1: 'Herald', 2: 'Guardian', 3: 'Crusader', 4: 'Archon', 5: 'Legend', 6: 'Ancient', 7: 'Divine', 8: 'Immortal' };
const MMR_PER_STAR = 77;
const PARTY_WEIGHTS = { 1: 1.0, 2: 0.1, 3: 0.02, 4: 0.005, 5: 0.001 };
const RECENCY_HALF_LIFE_DAYS = 60;
const MIN_VISIBLE_RANKS = 3;

function rankTierToMMR(rt) {
  if (!rt || rt <= 0) return null;
  const tier = Math.floor(rt / 10), stars = rt % 10;
  const floor = MEDAL_MMR_FLOORS[tier];
  if (floor == null) return null;
  return floor + stars * MMR_PER_STAR;
}
function mmrToMedal(mmr) {
  for (let t = 8; t >= 1; t--) {
    if (mmr >= MEDAL_MMR_FLOORS[t]) {
      const sr = Math.round((mmr - MEDAL_MMR_FLOORS[t]) / MMR_PER_STAR);
      const stars = Math.min(Math.max(sr, 0), t === 8 ? 0 : 5);
      return stars > 0 ? `${MEDAL_NAMES[t]} ${stars}` : MEDAL_NAMES[t];
    }
  }
  return 'Herald';
}

// Replicate shipped: solo via isParty:false (size 1), party via isParty:true (forced size 5).
// Stratz per-player partyId is unreliable for Turbo, so the query flag is the source of truth.
const Q = `
query ($steamAccountId: Long!, $take: Int!, $skip: Int, $startDateTime: Long, $isParty: Boolean) {
  player(steamAccountId: $steamAccountId) {
    steamAccount { name seasonRank }
    matches(request: { gameModeIds: [23], take: $take, skip: $skip, orderBy: DESC, startDateTime: $startDateTime, isParty: $isParty }) {
      id startDateTime didRadiantWin
      players { steamAccountId partyId isRadiant steamAccount { seasonRank } }
    }
  }
}`;
async function fetchSide(id, isParty) {
  let all = [];
  for (let skip = 0; skip < 300; skip += 100) {
    const res = await axios.post(GQL, { query: Q, variables: { steamAccountId: id, take: 100, skip, startDateTime: ONE_YEAR_AGO, isParty } }, { headers, timeout: 30000 });
    if (res.data?.errors) throw new Error(JSON.stringify(res.data.errors).slice(0, 200));
    const p = res.data?.data?.player;
    if (skip === 0 && p?.steamAccount) all.name = p.steamAccount.name;
    const ms = p?.matches ?? [];
    all.push(...ms);
    if (ms.length < 100) break;
    await new Promise(r => setTimeout(r, 1100));
  }
  return all;
}

// ps is supplied by caller (1 for the isParty:false side, 5 for the isParty:true side)
function extractObs(match, sid, ps) {
  const me = match.players.find(p => p.steamAccountId === sid);
  if (!me) return null;
  const others = match.players.filter(p => p.steamAccountId !== sid);
  const mmrs = others.map(p => rankTierToMMR(p.steamAccount?.seasonRank)).filter(v => v != null);
  if (mmrs.length < MIN_VISIBLE_RANKS) return null;
  const lobbyMMR = mmrs.reduce((s, v) => s + v, 0) / mmrs.length;
  const completeness = mmrs.length / 9; // fraction of the 9 opponents with visible rank
  const won = typeof match.didRadiantWin === 'boolean' ? (me.isRadiant === match.didRadiantWin) : undefined;
  return { lobbyMMR: Math.round(lobbyMMR), partySize: ps, partyWeight: PARTY_WEIGHTS[Math.min(ps, 5)] ?? 0.1, completeness, timestamp: match.startDateTime, won };
}

const CAP = 0.25; // capped-blend: party total weight <= CAP * solo total weight

function estimate(obs, mode) {
  if (!obs.length) return null;
  const now = Date.now() / 1000;
  const decay = Math.LN2 / (RECENCY_HALF_LIFE_DAYS * 86400);
  const solo = obs.filter(o => o.partySize === 1);

  let targets, soloOnly;
  if (mode === 'current' || mode === 'confonly') {
    soloOnly = solo.length > 0;            // shipped: any solo => solo-only point estimate
    targets = soloOnly ? solo : obs;
  } else {                                  // blend / capped: everything, weighted
    soloOnly = false;
    targets = obs;
  }

  // pre-compute solo vs party recency-weighted mass for the cap
  let soloMass = 0, partyMass = 0;
  for (const o of targets) {
    const recency = Math.exp(-decay * Math.max(0, now - o.timestamp));
    const base = o.partyWeight * recency * o.completeness;
    if (o.partySize === 1) soloMass += base; else partyMass += base;
  }
  // if capping and party would exceed CAP * solo, scale party down
  const partyScale = (mode === 'capped' && partyMass > CAP * soloMass && partyMass > 0)
    ? (CAP * soloMass) / partyMass : 1.0;

  let ws = 0, tw = 0;
  for (const o of targets) {
    const age = Math.max(0, now - o.timestamp);
    const recency = Math.exp(-decay * age);
    let w = (soloOnly ? 1.0 : o.partyWeight) * recency * o.completeness;
    if (!soloOnly && o.partySize > 1) w *= partyScale;
    const winAdj = o.won === true ? 100 : o.won === false ? -100 : 0;
    ws += (o.lobbyMMR + winAdj) * w; tw += w;
  }
  if (tw === 0) return null;
  const mmr = Math.round(ws / tw);

  // confidence: 'confonly' counts ALL games (solo + party); others count only `targets`
  const confPool = mode === 'confonly' ? obs : targets;
  const cdecay = Math.LN2 / (180 * 86400);
  let cs = 0;
  for (const o of confPool) {
    const age = Math.max(0, now - o.timestamp);
    const mc = o.partySize === 1 ? 10 : o.partySize === 2 ? 3 : o.partySize === 3 ? 1 : 0.2;
    cs += mc * Math.exp(-cdecay * age);
  }
  return { mmr, medal: mmrToMedal(mmr), confidence: Math.min(100, Math.max(10, Math.round(cs))), solo: solo.length, total: obs.length };
}

function fmt(e) { return e ? `${e.medal.padEnd(11)} ~${String(e.mmr).padEnd(4)} ${String(e.confidence).padStart(3)}%` : '(no estimate)'; }

(async () => {
  if (!TOKEN) { console.error('No STRATZ_API_KEY'); process.exit(1); }
  console.log('CURRENT = shipped solo-only-if-any-solo   |   BLEND = all games, weight = partyWeight×recency×completeness\n');
  let maxMove = 0, mover = '';
  for (const t of TARGETS) {
    try {
      const soloM = await fetchSide(t.id, false);
      await new Promise(r => setTimeout(r, 1100));
      const partyM = await fetchSide(t.id, true);
      const name = soloM.name ?? partyM.name ?? t.label;
      const obs = [
        ...soloM.map(m => extractObs(m, t.id, 1)),
        ...partyM.map(m => extractObs(m, t.id, 5)),
      ].filter(Boolean);
      const soloN = obs.filter(o => o.partySize === 1).length;
      const eCur = estimate(obs, 'current');
      const eBlend = estimate(obs, 'blend');
      const eConf = estimate(obs, 'confonly');
      const d = (eCur && eBlend) ? eBlend.mmr - eCur.mmr : 0;
      const dConf = (eCur && eConf) ? eConf.mmr - eCur.mmr : 0;
      const dCf = (eCur && eConf) ? eConf.confidence - eCur.confidence : 0;
      if (Math.abs(dConf) > Math.abs(maxMove)) { maxMove = dConf; mover = name; }
      console.log(`■ ${name}  (${t.label})  anchor: ${t.anchor}`);
      console.log(`   games ${obs.length}, solo ${soloN}, party ${obs.length - soloN}`);
      console.log(`   CURRENT  : ${fmt(eCur)}`);
      console.log(`   BLEND    : ${fmt(eBlend)}   Δ ${d >= 0 ? '+' : ''}${d} MMR (point)`);
      console.log(`   CONF-ONLY: ${fmt(eConf)}   Δ ${dConf >= 0 ? '+' : ''}${dConf} MMR (point), conf ${dCf >= 0 ? '+' : ''}${dCf}%\n`);
      await new Promise(r => setTimeout(r, 1300));
    } catch (e) {
      console.log(`■ ${t.label} FAILED: ${e.message}\n`);
    }
  }
  console.log(`Largest CONF-ONLY point swing vs CURRENT: ${mover} ${maxMove >= 0 ? '+' : ''}${maxMove} MMR (should be 0 everywhere)`);
})();
