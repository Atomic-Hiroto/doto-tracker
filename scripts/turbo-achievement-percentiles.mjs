// Read-only: pool the crew's recent TURBO games (OpenDota, not Stratz) and print
// percentiles per stat, so achievement thresholds can be set to real turbo difficulty.
import axios from 'axios';

const CREW = [121623358, 81746167, 165196360, 407925203, 235833417]; // Atomic, nitr0f, Caow, HopE, RowDYY
const FIELDS = ['kills', 'deaths', 'assists', 'gold_per_min', 'xp_per_min', 'last_hits', 'hero_damage', 'duration'];
const proj = FIELDS.map(f => `project=${f}`).join('&');

const pools = Object.fromEntries(FIELDS.map(f => [f, []]));
for (const id of CREW) {
  try {
    const rows = (await axios.get(`https://api.opendota.com/api/players/${id}/matches?game_mode=23&significant=0&limit=200&${proj}`, { timeout: 30000 })).data || [];
    for (const r of rows) for (const f of FIELDS) if (typeof r[f] === 'number') pools[f].push(r[f]);
    await new Promise(r => setTimeout(r, 400));
  } catch (e) { console.log('fail', id, e?.message); }
}

const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; };
console.log(`pooled games per field (kills sample = ${pools.kills.length})\n`);
console.log('STAT'.padEnd(13), ['p50', 'p70', 'p85', 'p93', 'p97', 'p99', 'max'].map(s => s.padStart(7)).join(''));
for (const f of FIELDS) {
  const a = pools[f];
  if (!a.length) { console.log(f.padEnd(13), '(no data)'); continue; }
  const row = [0.50, 0.70, 0.85, 0.93, 0.97, 0.99].map(p => pct(a, p));
  row.push(Math.max(...a));
  const disp = f === 'duration' ? row.map(v => `${Math.round(v / 60)}m`) : row.map(v => String(Math.round(v)));
  console.log(f.padEnd(13), disp.map(s => s.padStart(7)).join(''));
}
