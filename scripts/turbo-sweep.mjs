// Read-only PARAMETER SWEEP for the turbo-rank estimator. Writes nothing.
// Pulls each player's true solo set (isParty:false = partyId==null) and party set
// (isParty:true) once, then computes the estimate under many configs so we can pick
// cutoff / win-loss mode / recency BEFORE changing src/services/turboRankService.ts.

import { readFileSync } from 'fs';
import axios from 'axios';

const envRaw = readFileSync('.env', 'utf-8');
const TOKEN = envRaw.split('\n').find(l => l.startsWith('STRATZ_API_KEY'))
  ?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'STRATZ_API', Accept: 'application/json' };
const ONE_YEAR_AGO = Math.floor(Date.now() / 1000) - 365 * 24 * 3600;

const GROUP = { 168201940: 'law', 121623358: 'Atomic', 81746167: 'nitr0f', 165196360: 'Caow', 109431213: 'SirPryse', 407925203: 'HopE', 235833417: 'RowDYY', 109299524: 'Spi<' };
const TARGETS = [
  { label: 'nitr0f', id: 81746167, anchor: '~Archon/below' },
  { label: 'law', id: 168201940, anchor: 'Ancient 4' },
  { label: 'Atomic', id: 121623358, anchor: 'Immortal/Divine solo' },
];

// ── conversions (ported) ──
const FLOORS = { 1: 0, 2: 770, 3: 1540, 4: 2310, 5: 3080, 6: 3850, 7: 4620, 8: 5420 };
const NAMES = { 1: 'Herald', 2: 'Guardian', 3: 'Crusader', 4: 'Archon', 5: 'Legend', 6: 'Ancient', 7: 'Divine', 8: 'Immortal' };
const PARTY_WEIGHTS = { 1: 1.0, 2: 0.1, 3: 0.02, 4: 0.005, 5: 0.001 };
const r2m = rt => { if (!rt || rt <= 0) return null; const t = Math.floor(rt / 10), s = rt % 10; return FLOORS[t] == null ? null : FLOORS[t] + s * 77; };
const m2m = mmr => { for (let t = 8; t >= 1; t--) if (mmr >= FLOORS[t]) { const s = Math.min(Math.max(Math.round((mmr - FLOORS[t]) / 77), 0), t === 8 ? 0 : 5); return s > 0 ? `${NAMES[t]} ${s}` : NAMES[t]; } return 'Herald'; };

const Q = `query($id:Long!,$ip:Boolean){player(steamAccountId:$id){matches(request:{gameModeIds:[23],take:100,orderBy:DESC,startDateTime:${ONE_YEAR_AGO},isParty:$ip}){id startDateTime didRadiantWin players{steamAccountId partyId isRadiant steamAccount{seasonRank}}}}}`;
async function fetchM(id, ip) {
  const res = await axios.post('https://api.stratz.com/graphql', { query: Q, variables: { id, ip } }, { headers });
  if (res.data?.errors) throw new Error(JSON.stringify(res.data.errors).slice(0, 200));
  return res.data?.data?.player?.matches ?? [];
}

function toObs(m, id, forcedSolo) {
  const me = m.players.find(p => p.steamAccountId === id); if (!me) return null;
  const mmrs = m.players.filter(p => p.steamAccountId !== id).map(p => r2m(p.steamAccount?.seasonRank)).filter(v => v != null);
  if (mmrs.length < 3) return null;
  let ps;
  if (forcedSolo) ps = 1;
  else {
    const pid = me.partyId;
    const byPid = (pid != null && pid !== 0) ? m.players.filter(p => p.partyId === pid).length : 1;
    const friends = m.players.filter(p => p.steamAccountId !== id && p.isRadiant === me.isRadiant && GROUP[p.steamAccountId]).length + 1;
    ps = Math.min(5, Math.max(2, byPid, friends)); // party set: at least 2
  }
  return {
    lobby: Math.round(mmrs.reduce((s, v) => s + v, 0) / mmrs.length),
    partySize: ps, partyWeight: PARTY_WEIGHTS[Math.min(ps, 5)] ?? 0.1,
    ts: m.startDateTime, won: typeof m.didRadiantWin === 'boolean' ? me.isRadiant === m.didRadiantWin : undefined,
  };
}

// cfg: { mode:'blend'|'cutoff', cutoff?, win:'none'|'flat'|'elo', K?, hl }
function estimate(obs, cfg) {
  if (!obs.length) return null;
  const now = Date.now() / 1000, decay = Math.LN2 / (cfg.hl * 86400);
  const solo = obs.filter(o => o.partySize === 1);
  let targets, soloFull = false;
  if (cfg.mode === 'cutoff') {
    if (solo.length >= cfg.cutoff) { targets = solo; soloFull = true; } else targets = obs;
  } else { targets = obs; } // blend
  // baseline weighted lobby
  let ws = 0, tw = 0; const W = [];
  for (const o of targets) {
    const rec = Math.exp(-decay * Math.max(0, now - o.ts));
    const w = (soloFull ? 1.0 : o.partyWeight) * rec;
    ws += o.lobby * w; tw += w; W.push({ o, w });
  }
  if (tw === 0) return null;
  const baseline = ws / tw;
  // outcome
  let adj = 0;
  if (cfg.win === 'flat') {
    let aw = 0, aS = 0;
    for (const { o, w } of W) { if (typeof o.won !== 'boolean') continue; aS += (o.won ? 100 : -100) * w; aw += w; }
    adj = aw ? aS / aw : 0;
  } else if (cfg.win === 'elo') {
    let aw = 0, aS = 0;
    for (const { o, w } of W) { if (typeof o.won !== 'boolean') continue; const exp = 1 / (1 + Math.pow(10, (o.lobby - baseline) / 400)); aS += (cfg.K ?? 200) * ((o.won ? 1 : 0) - exp) * w; aw += w; }
    adj = aw ? aS / aw : 0;
  }
  const mmr = Math.round(baseline + adj);
  return { mmr, medal: m2m(mmr), eff: Math.round(tw * 100) / 100, soloN: solo.length };
}

const CONFIGS = [
  { name: 'SHIPPED (cut5,flat,60d)', mode: 'cutoff', cutoff: 5, win: 'flat', hl: 60 },
  { name: 'A blend,none,60d      ', mode: 'blend', win: 'none', hl: 60 },
  { name: 'A blend,flat,60d      ', mode: 'blend', win: 'flat', hl: 60 },
  { name: 'A blend,elo200,60d    ', mode: 'blend', win: 'elo', K: 200, hl: 60 },
  { name: 'A blend,elo200,120d   ', mode: 'blend', win: 'elo', K: 200, hl: 120 },
  { name: 'A blend,elo300,120d   ', mode: 'blend', win: 'elo', K: 300, hl: 120 },
  { name: 'cut3,elo200,60d       ', mode: 'cutoff', cutoff: 3, win: 'elo', K: 200, hl: 60 },
  { name: 'soloOnly(cut1),none,120d', mode: 'cutoff', cutoff: 1, win: 'none', hl: 120 },
  { name: 'soloOnly(cut1),elo200,120d', mode: 'cutoff', cutoff: 1, win: 'elo', K: 200, hl: 120 },
];

(async () => {
  if (!TOKEN) { console.error('No STRATZ_API_KEY'); process.exit(1); }
  for (const t of TARGETS) {
    const soloRaw = await fetchM(t.id, false); await new Promise(r => setTimeout(r, 1400));
    const partyRaw = await fetchM(t.id, true); await new Promise(r => setTimeout(r, 1400));
    const soloObs = soloRaw.map(m => toObs(m, t.id, true)).filter(Boolean);
    const partyObs = partyRaw.map(m => toObs(m, t.id, false)).filter(Boolean);
    const all = [...soloObs, ...partyObs];
    const plainSolo = soloObs.length ? Math.round(soloObs.reduce((s, o) => s + o.lobby, 0) / soloObs.length) : null;
    console.log(`\n══ ${t.label}  (anchor: ${t.anchor})`);
    console.log(`   solo games: ${soloObs.length}   party games: ${partyObs.length}   plain-solo-avg: ${plainSolo != null ? m2m(plainSolo) + ' (~' + plainSolo + ')' : '-'}`);
    for (const c of CONFIGS) {
      const e = estimate(all, c);
      console.log(`   ${c.name}  →  ${e ? `${e.medal.padEnd(11)} ~${String(e.mmr).padEnd(5)} eff=${e.eff}` : '(none)'}`);
    }
  }
})();
