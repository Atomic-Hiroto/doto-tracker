// Read-only PAPER experiment for the two NEVER-BUILT ideas. Writes nothing.
// Targets: law, nitr0f, Atomic.
//
// A) BASELINE        = shipped solo-only estimate (recency × completeness), for reference.
// B) PERF NUDGE      = "did I play well vs my lobby?" using Stratz imp + KDA-vs-lobby on SOLO games.
//                      Reports avg imp, avg KDA ratio, solo win-rate, and a candidate MMR nudge.
// C) TEAM-BALANCE    = duo/friend adjustment generalised: myMMR ≈ 5*enemyAvg - Σ(my teammates).
//    INVERSION         Backs your own skill out of every game (esp. party games), then aggregates
//                      recency-weighted. Lets us check if PARTY games agree with the SOLO anchor.

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
  { label: 'law',    id: 168201940, anchor: 'ranked Ancient 4 (~3 solo)' },
  { label: 'nitr0f', id: 81746167,  anchor: 'unranked; ~Archon 5' },
  { label: 'Atomic', id: 121623358, anchor: 'solo turbo ~Divine 2 / 4743 (~12 solo)' },
];

// ── ported constants ───────────────────────────────────────────────────────────
const MEDAL_MMR_FLOORS = { 1: 0, 2: 770, 3: 1540, 4: 2310, 5: 3080, 6: 3850, 7: 4620, 8: 5420 };
const MEDAL_NAMES = { 1: 'Herald', 2: 'Guardian', 3: 'Crusader', 4: 'Archon', 5: 'Legend', 6: 'Ancient', 7: 'Divine', 8: 'Immortal' };
const MMR_PER_STAR = 77;
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

const Q = `
query ($steamAccountId: Long!, $take: Int!, $skip: Int, $startDateTime: Long, $isParty: Boolean) {
  player(steamAccountId: $steamAccountId) {
    steamAccount { name }
    matches(request: { gameModeIds: [23], take: $take, skip: $skip, orderBy: DESC, startDateTime: $startDateTime, isParty: $isParty }) {
      id startDateTime didRadiantWin
      players { steamAccountId isRadiant kills deaths assists imp steamAccount { seasonRank } }
    }
  }
}`;
async function fetchSide(id, isParty) {
  let all = [];
  for (let skip = 0; skip < 200; skip += 100) {
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

const now = Date.now() / 1000;
const decay = Math.LN2 / (RECENCY_HALF_LIFE_DAYS * 86400);
const recencyOf = ts => Math.exp(-decay * Math.max(0, now - ts));

// ── A) baseline solo estimate ──────────────────────────────────────────────────
function baselineSolo(soloMatches, sid) {
  let ws = 0, tw = 0;
  for (const m of soloMatches) {
    const others = m.players.filter(p => p.steamAccountId !== sid);
    const mmrs = others.map(p => rankTierToMMR(p.steamAccount?.seasonRank)).filter(v => v != null);
    if (mmrs.length < MIN_VISIBLE_RANKS) continue;
    const lobby = mmrs.reduce((s, v) => s + v, 0) / mmrs.length;
    const w = recencyOf(m.startDateTime) * (mmrs.length / 9);
    ws += lobby * w; tw += w;
  }
  if (tw === 0) return null;
  const mmr = Math.round(ws / tw);
  return { mmr, medal: mmrToMedal(mmr) };
}

// ── B) performance signal on solo games ─────────────────────────────────────────
function perfSignal(soloMatches, sid) {
  let impSum = 0, impW = 0, kdaRatioSum = 0, kdaW = 0, wins = 0, n = 0;
  for (const m of soloMatches) {
    const me = m.players.find(p => p.steamAccountId === sid);
    if (!me) continue;
    const w = recencyOf(m.startDateTime);
    n++;
    if (typeof m.didRadiantWin === 'boolean' && (me.isRadiant === m.didRadiantWin)) wins++;
    if (typeof me.imp === 'number') { impSum += me.imp * w; impW += w; }
    const myKDA = (me.kills + me.assists) / Math.max(1, me.deaths);
    const lobbyKDAs = m.players.map(p => (p.kills + p.assists) / Math.max(1, p.deaths));
    const lobbyAvg = lobbyKDAs.reduce((s, v) => s + v, 0) / lobbyKDAs.length;
    if (lobbyAvg > 0) { kdaRatioSum += (myKDA / lobbyAvg) * w; kdaW += w; }
  }
  return {
    n,
    winRate: n ? wins / n : null,
    avgImp: impW ? impSum / impW : null,
    avgKdaRatio: kdaW ? kdaRatioSum / kdaW : null,
  };
}

// ── C) team-balance inversion ────────────────────────────────────────────────────
// myMMR ≈ 5*enemyAvg − Σ(my 4 teammates). Missing teammate ranks filled with enemyAvg
// (assume an unranked teammate ≈ lobby level). Need ≥3 enemies and ≥3 teammates visible.
function teamInversion(matches, sid) {
  let ws = 0, tw = 0, used = 0;
  const samples = [];
  for (const m of matches) {
    const me = m.players.find(p => p.steamAccountId === sid);
    if (!me) continue;
    const team = m.players.filter(p => p.steamAccountId !== sid && p.isRadiant === me.isRadiant);
    const enemies = m.players.filter(p => p.isRadiant !== me.isRadiant);
    const enemyMMRs = enemies.map(p => rankTierToMMR(p.steamAccount?.seasonRank)).filter(v => v != null);
    if (enemyMMRs.length < MIN_VISIBLE_RANKS) continue;
    const enemyAvg = enemyMMRs.reduce((s, v) => s + v, 0) / enemyMMRs.length;
    const teamMMRs = team.map(p => rankTierToMMR(p.steamAccount?.seasonRank));
    const visibleTeam = teamMMRs.filter(v => v != null);
    if (visibleTeam.length < 3) continue;
    const filled = teamMMRs.map(v => v == null ? enemyAvg : v); // fill missing with lobby level
    const teamSum = filled.reduce((s, v) => s + v, 0);
    let myMMR = 5 * enemyAvg - teamSum;       // invert balanced-team assumption
    myMMR = Math.min(7000, Math.max(800, myMMR));
    const completeness = (enemyMMRs.length + visibleTeam.length) / 9;
    const w = recencyOf(m.startDateTime) * completeness;
    ws += myMMR * w; tw += w; used++;
    samples.push(myMMR);
  }
  if (tw === 0) return null;
  const mmr = Math.round(ws / tw);
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  return { mmr, medal: mmrToMedal(mmr), used, median: Math.round(median) };
}

(async () => {
  if (!TOKEN) { console.error('No STRATZ_API_KEY'); process.exit(1); }
  for (const t of TARGETS) {
    try {
      const solo = await fetchSide(t.id, false);
      await new Promise(r => setTimeout(r, 1100));
      const party = await fetchSide(t.id, true);
      const name = solo.name ?? party.name ?? t.label;
      const all = [...solo, ...party];

      const base = baselineSolo(solo, t.id);
      const perf = perfSignal(solo, t.id);
      const invAll = teamInversion(all, t.id);
      const invParty = teamInversion(party, t.id);
      const invSolo = teamInversion(solo, t.id);

      // candidate perf nudge: imp is ~ -10..+10 per game; scale modestly, cap ±300
      const impNudge = perf.avgImp != null ? Math.max(-300, Math.min(300, Math.round(perf.avgImp * 15))) : null;
      const nudged = (base && impNudge != null) ? base.mmr + impNudge : null;

      console.log(`\n■ ${name}  (${t.label})  anchor: ${t.anchor}`);
      console.log(`   solo games ${solo.length}, party games ${party.length}`);
      console.log(`   A) BASELINE solo     : ${base ? `${base.medal.padEnd(11)} ~${base.mmr}` : '(none)'}`);
      console.log(`   B) PERF on solo      : winRate ${perf.winRate != null ? (perf.winRate*100).toFixed(0)+'%' : 'n/a'}, avgImp ${perf.avgImp != null ? perf.avgImp.toFixed(1) : 'n/a'}, KDA-vs-lobby ${perf.avgKdaRatio != null ? perf.avgKdaRatio.toFixed(2)+'x' : 'n/a'}`);
      console.log(`        -> imp nudge ${impNudge != null ? (impNudge>=0?'+':'')+impNudge+' MMR' : 'n/a'}  => nudged ${nudged != null ? `${mmrToMedal(nudged).padEnd(11)} ~${nudged}` : 'n/a'}`);
      console.log(`   C) TEAM-INVERSION    :`);
      console.log(`        all games  : ${invAll ? `${invAll.medal.padEnd(11)} ~${invAll.mmr}  (median ~${invAll.median}, ${invAll.used} games)` : '(none)'}`);
      console.log(`        party only : ${invParty ? `${invParty.medal.padEnd(11)} ~${invParty.mmr}  (median ~${invParty.median}, ${invParty.used} games)` : '(none)'}`);
      console.log(`        solo only  : ${invSolo ? `${invSolo.medal.padEnd(11)} ~${invSolo.mmr}  (median ~${invSolo.median}, ${invSolo.used} games)` : '(none)'}`);
      await new Promise(r => setTimeout(r, 1300));
    } catch (e) {
      console.log(`\n■ ${t.label} FAILED: ${e.message}`);
    }
  }
})();
