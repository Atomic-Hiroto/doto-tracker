// Read-only simulation of the turbo-rank estimate. Writes nothing, deploys nothing.
// Compares three pipelines per player:
//   OLD   = shipped behavior: fetch isParty:false (solo), <15 → also isParty:true,
//           force isParty:false matches to partySize=1.
//   NEW   = unfiltered fetch, classify solo/party from partyId in code.
//   NEW+F = NEW, but for party games (only used when <5 solo) replace the lobby MMR
//           with a friend-subtracted individual estimate  L_adj = S*L - Σ friends.
// Estimate math (recency, party weights, solo-priority, win adj, confidence) is ported
// 1:1 from src/services/turboRankService.ts.

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

// players to test: label -> steamId (+ rough anchor from the user, for sniff-testing only)
const TARGETS = [
  { label: 'law',    id: 168201940, anchor: 'ranked Ancient 4' },
  { label: 'Atomic', id: 121623358, anchor: 'old Legend; solo turbo Immortal/Divine' },
  { label: 'nitr0f', id: 81746167,  anchor: 'unranked; ~Archon or below' },
  { label: 'Caow!!', id: 165196360, anchor: '-' },
  { label: 'SirPryse', id: 109431213, anchor: '-' },
  { label: 'HopE',   id: 407925203, anchor: '-' },
  { label: 'RowDYY', id: 235833417, anchor: '-' },
];

// ── ported constants ─────────────────────────────────────────────────────────
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

// ── fetch ────────────────────────────────────────────────────────────────────
const Q = `
query ($steamAccountId: Long!, $take: Int!, $startDateTime: Long, $isParty: Boolean) {
  player(steamAccountId: $steamAccountId) {
    steamAccount { name seasonRank }
    matches(request: { gameModeIds: [23], take: $take, orderBy: DESC, startDateTime: $startDateTime, isParty: $isParty }) {
      id startDateTime didRadiantWin
      players { steamAccountId partyId isRadiant steamAccount { seasonRank } }
    }
  }
}`;
async function fetchM(id, isParty) {
  const res = await axios.post(GQL, { query: Q, variables: { steamAccountId: id, take: 100, startDateTime: ONE_YEAR_AGO, isParty } }, { headers, timeout: 30000 });
  if (res.data?.errors) throw new Error(JSON.stringify(res.data.errors).slice(0, 200));
  return res.data?.data?.player;
}

// ── observation extraction ───────────────────────────────────────────────────
function partySize(match, sid) {
  const me = match.players.find(p => p.steamAccountId === sid);
  const pid = me?.partyId;
  if (pid == null || pid === 0) return 1;
  const n = match.players.filter(p => p.partyId === pid).length;
  return n <= 1 ? 1 : n;
}
// mode: 'old' forces solo; 'new' uses partyId; 'newF' uses partyId + friend adj when party
function extractObs(match, sid, mode) {
  const me = match.players.find(p => p.steamAccountId === sid);
  if (!me) return null;
  let ps = mode === 'old' ? 1 : partySize(match, sid);

  const others = match.players.filter(p => p.steamAccountId !== sid);
  const mmrs = others.map(p => rankTierToMMR(p.steamAccount?.seasonRank)).filter(v => v != null);
  if (mmrs.length < MIN_VISIBLE_RANKS) return null;
  let lobbyMMR = mmrs.reduce((s, v) => s + v, 0) / mmrs.length;

  if (mode === 'newF' && ps > 1) {
    // friends = same-party teammates (excluding me), use their seasonRank
    const pid = me.partyId;
    const friends = match.players.filter(p => p.steamAccountId !== sid && p.partyId === pid && pid);
    const friendMMRs = friends.map(p => rankTierToMMR(p.steamAccount?.seasonRank)).filter(v => v != null);
    if (friendMMRs.length === ps - 1) {
      let adj = ps * lobbyMMR - friendMMRs.reduce((s, v) => s + v, 0);
      adj = Math.min(6000, Math.max(800, adj));
      lobbyMMR = adj;
    }
  }

  const won = typeof match.didRadiantWin === 'boolean' ? (me.isRadiant === match.didRadiantWin) : undefined;
  return { lobbyMMR: Math.round(lobbyMMR), partySize: ps, partyWeight: PARTY_WEIGHTS[Math.min(ps, 5)] ?? 0.1, timestamp: match.startDateTime, won };
}

// ── estimate (1:1 port) ──────────────────────────────────────────────────────
function computeEstimate(obs) {
  if (!obs.length) return null;
  const now = Date.now() / 1000;
  const decay = Math.LN2 / (RECENCY_HALF_LIFE_DAYS * 86400);
  const solo = obs.filter(o => o.partySize === 1);
  const useSolo = solo.length >= 5;
  const targets = useSolo ? solo : obs;
  let ws = 0, tw = 0;
  for (const o of targets) {
    const age = Math.max(0, now - o.timestamp);
    const w = (useSolo ? 1.0 : o.partyWeight) * Math.exp(-decay * age);
    const winAdj = o.won === true ? 100 : o.won === false ? -100 : 0;
    ws += (o.lobbyMMR + winAdj) * w; tw += w;
  }
  if (tw === 0) return null;
  const mmr = Math.round(ws / tw);
  const cdecay = Math.LN2 / (180 * 86400);
  let cs = 0;
  for (const o of targets) {
    const age = Math.max(0, now - o.timestamp);
    const mc = o.partySize === 1 ? 10 : o.partySize === 2 ? 3 : o.partySize === 3 ? 1 : 0.2;
    cs += mc * Math.exp(-cdecay * age);
  }
  return { mmr, medal: mmrToMedal(mmr), confidence: Math.min(100, Math.max(10, Math.round(cs))), solo: solo.length, total: obs.length };
}

function fmt(e) { return e ? `${e.medal.padEnd(11)} ~${String(e.mmr).padEnd(4)} ${e.confidence}%`.padEnd(26) : '(no estimate)'.padEnd(26); }

(async () => {
  if (!TOKEN) { console.error('No STRATZ_API_KEY'); process.exit(1); }
  for (const t of TARGETS) {
    try {
      // NEW: unfiltered
      const uf = await fetchM(t.id, null);
      const name = uf?.steamAccount?.name ?? t.label;
      const um = uf?.matches ?? [];
      const newObs = um.map(m => extractObs(m, t.id, 'new')).filter(Boolean);
      const newFObs = um.map(m => extractObs(m, t.id, 'newF')).filter(Boolean);

      // OLD: isParty:false, then isParty:true if <15
      await new Promise(r => setTimeout(r, 1200));
      let oldRaw = (await fetchM(t.id, false))?.matches ?? [];
      let oldObs = oldRaw.map(m => extractObs(m, t.id, 'old')).filter(Boolean);
      if (oldObs.length < 15) {
        await new Promise(r => setTimeout(r, 1200));
        const party = (await fetchM(t.id, true))?.matches ?? [];
        // shipped code marks these party (not forced solo): partySize from partyId, min 3
        for (const m of party) {
          const o = extractObs(m, t.id, 'new');
          if (o) { if (o.partySize <= 1) { o.partySize = 3; o.partyWeight = PARTY_WEIGHTS[3]; } oldObs.push(o); }
        }
      }

      const eOld = computeEstimate(oldObs), eNew = computeEstimate(newObs), eNewF = computeEstimate(newFObs);
      console.log(`\n■ ${name}  (${t.label}, ${t.id})  anchor: ${t.anchor}`);
      console.log(`   unfiltered games: ${um.length}, solo(new): ${newObs.filter(o => o.partySize === 1).length}`);
      console.log(`   OLD   : ${fmt(eOld)}  [${oldObs.length} obs, ${oldObs.filter(o=>o.partySize===1).length} solo]`);
      console.log(`   NEW   : ${fmt(eNew)}  [${newObs.length} obs, ${newObs.filter(o=>o.partySize===1).length} solo]`);
      console.log(`   NEW+F : ${fmt(eNewF)}  (friend-adj only affects <5-solo players)`);
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      console.log(`\n■ ${t.label} (${t.id}) FAILED: ${e.message}`);
    }
  }
})();
