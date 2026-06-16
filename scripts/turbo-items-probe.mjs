// Read-only probe: can Stratz return item-purchase timings in a BULK per-hero match list?
// Also checks OpenDota item constants carry cost + components for "key item" filtering.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import axios from 'axios';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');
const env = readFileSync(join(root, '.env'), 'utf-8');
const TOKEN = env.split('\n').find(l => l.startsWith('STRATZ_API_KEY'))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'STRATZ_API', Accept: 'application/json' };
const GQL = 'https://api.stratz.com/graphql';
const ID = 121623358; // Atomic

async function gql(query, variables) {
  const r = await axios.post(GQL, { query, variables }, { headers, timeout: 30000 });
  if (r.data?.errors) console.log('  GraphQL errors:', JSON.stringify(r.data.errors).slice(0, 300));
  return r.data?.data;
}

(async () => {
  // 1) top hero in recent turbo games
  const d1 = await gql(`query($id: Long!){ player(steamAccountId:$id){ matches(request:{gameModeIds:[23], take:40, orderBy:DESC}){ id players{ steamAccountId heroId } } } }`, { id: ID });
  const ms = d1?.player?.matches ?? [];
  const tally = {};
  for (const m of ms) { const me = m.players.find(p => p.steamAccountId === ID); if (me) tally[me.heroId] = (tally[me.heroId] || 0) + 1; }
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  console.log(`Recent turbo matches: ${ms.length}. Top hero id ${top?.[0]} (${top?.[1]} games)`);
  if (!top) return;
  const heroId = Number(top[0]);

  // 2) BULK match list WITH nested item purchases for that hero
  console.log(`\nTesting bulk itemPurchases for hero ${heroId}...`);
  const d2 = await gql(
    `query($id: Long!){ player(steamAccountId:$id){ matches(request:{gameModeIds:[23], heroIds:[${heroId}], take:6, orderBy:DESC}){
        id durationSeconds
        players{ steamAccountId heroId stats{ itemPurchases{ time itemId } } }
      } } }`, { id: ID });
  const hm = d2?.player?.matches ?? [];
  console.log(`Got ${hm.length} matches for hero ${heroId}.`);
  for (const m of hm.slice(0, 3)) {
    const me = m.players.find(p => p.steamAccountId === ID);
    const ips = me?.stats?.itemPurchases ?? null;
    console.log(`  match ${m.id} dur ${Math.round((m.durationSeconds||0)/60)}m — itemPurchases: ${ips ? ips.length + ' items' : 'NULL/none'}`);
    if (ips) console.log('    sample:', ips.slice(0, 6).map(p => `${p.itemId}@${Math.round(p.time/60)}m`).join(', '));
  }

  // 3) OpenDota item constants: cost + components present?
  const items = (await axios.get('https://api.opendota.com/api/constants/items', { timeout: 30000 })).data;
  const byId = {};
  for (const [name, it] of Object.entries(items)) if (it?.id != null) byId[it.id] = { name, cost: it.cost, qual: it.qual, comp: it.components };
  const sample = ['blink', 'black_king_bar', 'phase_boots', 'demon_edge', 'tango'];
  console.log('\nOpenDota item constants sample (cost / components / qual):');
  for (const k of sample) {
    const it = items[k];
    console.log(`  ${k.padEnd(16)} id=${it?.id} cost=${it?.cost} qual=${it?.qual} components=${it?.components ? '[' + it.components.length + ']' : 'null'}`);
  }

  // 4) CRITICAL: do FINISHED items appear in Stratz itemPurchases (vs only raw components)?
  const longMatch = hm.find(m => (m.durationSeconds || 0) > 1800);
  if (longMatch) {
    const me = longMatch.players.find(p => p.steamAccountId === ID);
    const late = (me?.stats?.itemPurchases ?? []).filter(p => p.time >= 300);
    console.log(`\nLate purchases (>=5m) in match ${longMatch.id} — finished items should appear:`);
    for (const p of late) {
      const it = byId[p.itemId];
      const isFinished = it && it.cost >= 1400 && (it.comp?.length > 0 || it.qual === 'component');
      console.log(`  ${Math.round(p.time/60)}m  ${(it?.name||('id'+p.itemId)).padEnd(20)} cost=${it?.cost ?? '?'} ${isFinished ? '<= KEY' : ''}`);
    }
  }
})().catch(e => console.error('FAIL', e?.response?.data ?? e?.message ?? e));
