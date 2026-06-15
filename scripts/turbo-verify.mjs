// Read-only verification for the turbo-rank "isParty bug" claim from the
// antigrav handoff. Writes nothing. For each tracked player it:
//   1. Resolves their Stratz name.
//   2. Counts solo matches via the OLD path (GQL isParty:false).
//   3. Counts solo matches via the NEW path (unfiltered fetch, classify by partyId in code).
// This directly tests whether `isParty:false` is really starving solo games.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import axios from 'axios';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');

const envRaw = readFileSync(join(root, '.env'), 'utf-8');
const keyLine = envRaw.split('\n').find(l => l.startsWith('STRATZ_API_KEY'));
const TOKEN = keyLine?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');

const users = JSON.parse(readFileSync(join(root, 'users.json'), 'utf-8'));

const GQL = 'https://api.stratz.com/graphql';
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
  'User-Agent': 'STRATZ_API',
  Accept: 'application/json',
};

const ONE_YEAR_AGO = Math.floor(Date.now() / 1000) - 365 * 24 * 3600;

// Mirrors the query used in stratzClient.ts, plus steamAccount.name to resolve identity.
const Q = `
query ($steamAccountId: Long!, $take: Int!, $startDateTime: Long, $isParty: Boolean) {
  player(steamAccountId: $steamAccountId) {
    steamAccount { name seasonRank }
    matches(request: { gameModeIds: [23], take: $take, orderBy: DESC, startDateTime: $startDateTime, isParty: $isParty }) {
      id
      startDateTime
      players { steamAccountId partyId }
    }
  }
}`;

async function fetchMatches({ steamAccountId, take, startDateTime, isParty }) {
  const res = await axios.post(
    GQL,
    { query: Q, variables: { steamAccountId, take, startDateTime, isParty } },
    { headers, timeout: 30000 },
  );
  if (res.data?.errors) {
    throw new Error(JSON.stringify(res.data.errors).slice(0, 300));
  }
  return res.data?.data?.player;
}

// Classify solo vs party from partyId, the way the NEW code would.
function classify(match, steamAccountId) {
  const me = match.players.find(p => p.steamAccountId === steamAccountId);
  if (!me) return { partySize: 0, missing: true };
  const pid = me.partyId;
  if (pid == null || pid === 0) return { partySize: 1 };
  const size = match.players.filter(p => p.partyId === pid).length;
  return { partySize: size <= 1 ? 1 : size };
}

async function analyze(steamId) {
  const sid = parseInt(steamId, 10);

  // NEW path: unfiltered fetch, last 1 year, classify in code
  const unfiltered = await fetchMatches({ steamAccountId: sid, take: 100, startDateTime: ONE_YEAR_AGO, isParty: null });
  const name = unfiltered?.steamAccount?.name ?? '(unknown)';
  const seasonRank = unfiltered?.steamAccount?.seasonRank ?? null;
  const um = unfiltered?.matches ?? [];
  const sizes = um.map(m => classify(m, sid).partySize);
  const newSolo = sizes.filter(s => s === 1).length;
  const partyDist = {};
  for (const s of sizes) partyDist[s] = (partyDist[s] || 0) + 1;

  // OLD path: GQL isParty:false (what the shipped code does for solo)
  let oldSolo = 0, oldErr = null;
  try {
    const sf = await fetchMatches({ steamAccountId: sid, take: 100, startDateTime: ONE_YEAR_AGO, isParty: false });
    oldSolo = (sf?.matches ?? []).length;
  } catch (e) { oldErr = e.message; }

  return { name, seasonRank, steamId, total: um.length, newSolo, oldSolo, oldErr, partyDist };
}

(async () => {
  if (!TOKEN) { console.error('No STRATZ_API_KEY'); process.exit(1); }
  console.log(`Verifying ${users.length} tracked players (turbo, last 1 year)\n`);
  console.log('name'.padEnd(22), 'steamId'.padEnd(11), 'total', 'old(isParty:false)', 'new(partyId)', 'party-dist');
  console.log('-'.repeat(100));
  for (const u of users) {
    try {
      const r = await analyze(u.steamId);
      const dist = Object.entries(r.partyDist).sort().map(([k, v]) => `${k}x:${v}`).join(' ');
      console.log(
        String(r.name).slice(0, 21).padEnd(22),
        String(r.steamId).padEnd(11),
        String(r.total).padEnd(5),
        String(r.oldErr ? 'ERR' : r.oldSolo).padEnd(19),
        String(r.newSolo).padEnd(12),
        dist,
      );
      if (r.oldErr) console.log('   old-path error:', r.oldErr);
    } catch (e) {
      console.log(String(u.steamId).padEnd(22), 'FAILED:', e.message);
    }
    await new Promise(r => setTimeout(r, 1500)); // be gentle on rate limit
  }
})();
