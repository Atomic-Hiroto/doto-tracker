// Read-only sweep v2. Focuses on the half-life trade-off (atomic vs law pull in
// opposite directions) + ultra-aggressive party weights for a unified blend + plain
// no-decay average. Writes nothing.

import { readFileSync } from 'fs';
import axios from 'axios';
const envRaw = readFileSync('.env', 'utf-8');
const TOKEN = envRaw.split('\n').find(l => l.startsWith('STRATZ_API_KEY'))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'STRATZ_API', Accept: 'application/json' };
const ONE_YEAR_AGO = Math.floor(Date.now() / 1000) - 365 * 24 * 3600;
const GROUP = { 168201940: 'law', 121623358: 'Atomic', 81746167: 'nitr0f', 165196360: 'Caow', 109431213: 'SirPryse', 407925203: 'HopE', 235833417: 'RowDYY', 109299524: 'Spi<' };
const TARGETS = [
  { label: 'nitr0f', id: 81746167, anchor: '~Archon' },
  { label: 'law', id: 168201940, anchor: 'Ancient 4' },
  { label: 'Atomic', id: 121623358, anchor: 'Immortal/Divine' },
  { label: 'Caow', id: 165196360, anchor: '?' },
  { label: 'SirPryse', id: 109431213, anchor: '?' },
];
const FLOORS = { 1: 0, 2: 770, 3: 1540, 4: 2310, 5: 3080, 6: 3850, 7: 4620, 8: 5420 };
const NAMES = { 1: 'Herald', 2: 'Guardian', 3: 'Crusader', 4: 'Archon', 5: 'Legend', 6: 'Ancient', 7: 'Divine', 8: 'Immortal' };
const PW_DEFAULT = { 1: 1.0, 2: 0.1, 3: 0.02, 4: 0.005, 5: 0.001 };
const PW_ULTRA = { 1: 1.0, 2: 0.02, 3: 0.002, 4: 0.0003, 5: 0.0001 };
const r2m = rt => { if (!rt || rt <= 0) return null; const t = Math.floor(rt / 10), s = rt % 10; return FLOORS[t] == null ? null : FLOORS[t] + s * 77; };
const m2m = mmr => { for (let t = 8; t >= 1; t--) if (mmr >= FLOORS[t]) { const s = Math.min(Math.max(Math.round((mmr - FLOORS[t]) / 77), 0), t === 8 ? 0 : 5); return s > 0 ? `${NAMES[t]} ${s}` : NAMES[t]; } return 'Herald'; };
const Q = `query($id:Long!,$ip:Boolean){player(steamAccountId:$id){matches(request:{gameModeIds:[23],take:100,orderBy:DESC,startDateTime:${ONE_YEAR_AGO},isParty:$ip}){id startDateTime didRadiantWin players{steamAccountId partyId isRadiant steamAccount{seasonRank}}}}}`;
async function fetchM(id, ip) { const r = await axios.post('https://api.stratz.com/graphql', { query: Q, variables: { id, ip } }, { headers }); if (r.data?.errors) throw new Error(JSON.stringify(r.data.errors).slice(0, 150)); return r.data?.data?.player?.matches ?? []; }
function toObs(m, id, forcedSolo) {
  const me = m.players.find(p => p.steamAccountId === id); if (!me) return null;
  const mmrs = m.players.filter(p => p.steamAccountId !== id).map(p => r2m(p.steamAccount?.seasonRank)).filter(v => v != null);
  if (mmrs.length < 3) return null;
  let ps = 1;
  if (!forcedSolo) { const pid = me.partyId; const byPid = (pid != null && pid !== 0) ? m.players.filter(p => p.partyId === pid).length : 1; const fr = m.players.filter(p => p.steamAccountId !== id && p.isRadiant === me.isRadiant && GROUP[p.steamAccountId]).length + 1; ps = Math.min(5, Math.max(2, byPid, fr)); }
  return { lobby: Math.round(mmrs.reduce((s, v) => s + v, 0) / mmrs.length), partySize: ps, ts: m.startDateTime };
}
// est: soloOnly with given half-life (Infinity = no decay). pw override only matters for blend.
function estSolo(obs, hlDays) {
  const solo = obs.filter(o => o.partySize === 1); if (!solo.length) return null;
  const now = Date.now() / 1000; const decay = hlDays === Infinity ? 0 : Math.LN2 / (hlDays * 86400);
  let ws = 0, tw = 0;
  for (const o of solo) { const w = Math.exp(-decay * Math.max(0, now - o.ts)); ws += o.lobby * w; tw += w; }
  return tw ? m2m(Math.round(ws / tw)) + ' ~' + Math.round(ws / tw) : null;
}
function estBlend(obs, hlDays, pw) {
  if (!obs.length) return null; const now = Date.now() / 1000; const decay = Math.LN2 / (hlDays * 86400);
  let ws = 0, tw = 0;
  for (const o of obs) { const w = (pw[Math.min(o.partySize, 5)] ?? 0.1) * Math.exp(-decay * Math.max(0, now - o.ts)); ws += o.lobby * w; tw += w; }
  return tw ? m2m(Math.round(ws / tw)) + ' ~' + Math.round(ws / tw) : null;
}
(async () => {
  if (!TOKEN) { console.error('No key'); process.exit(1); }
  const HLS = [60, 90, 120, 180, 240, 365, Infinity];
  for (const t of TARGETS) {
    const soloRaw = await fetchM(t.id, false); await new Promise(r => setTimeout(r, 1300));
    const partyRaw = await fetchM(t.id, true); await new Promise(r => setTimeout(r, 1300));
    const solo = soloRaw.map(m => toObs(m, t.id, true)).filter(Boolean);
    const party = partyRaw.map(m => toObs(m, t.id, false)).filter(Boolean);
    const all = [...solo, ...party];
    console.log(`\n══ ${t.label}  anchor:${t.anchor}  | solo:${solo.length} party:${party.length}`);
    console.log('   SOLO-ONLY by half-life:');
    console.log('     ' + HLS.map(h => `${h === Infinity ? 'plain' : h + 'd'}:${(estSolo(all, h) || '-')}`).join('  '));
    console.log(`   BLEND default-pw 120d : ${estBlend(all, 120, PW_DEFAULT)}`);
    console.log(`   BLEND ULTRA-pw   120d : ${estBlend(all, 120, PW_ULTRA)}   (5-stack wt 0.0001)`);
    console.log(`   BLEND ULTRA-pw   240d : ${estBlend(all, 240, PW_ULTRA)}`);
  }
})();
