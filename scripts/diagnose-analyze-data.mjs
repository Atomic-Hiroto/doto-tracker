import 'dotenv/config';
import axios from 'axios';

const STRATZ_GQL = 'https://api.stratz.com/graphql';
const STRATZ_API_KEY = process.env.STRATZ_API_KEY;

const matchId = Number(process.argv[2]);
const focus = process.argv.slice(3).join(' ').toLowerCase();

if (!Number.isFinite(matchId)) {
  console.error('Usage: node scripts/diagnose-analyze-data.mjs <match_id> [player-or-hero]');
  process.exit(1);
}

if (!STRATZ_API_KEY) {
  console.error('STRATZ_API_KEY is not set');
  process.exit(1);
}

const query = `
query ($matchId: Long!) {
  match(id: $matchId) {
    id
    gameMode
    durationSeconds
    radiantExperienceLeads
    radiantNetworthLeads
    laneReport {
      radiant {
        midLane { meleeCount rangeCount siegeCount denyCount neutralCount }
        offLane { meleeCount rangeCount siegeCount denyCount neutralCount }
        safeLane { meleeCount rangeCount siegeCount denyCount neutralCount }
      }
      dire {
        midLane { meleeCount rangeCount siegeCount denyCount neutralCount }
        offLane { meleeCount rangeCount siegeCount denyCount neutralCount }
        safeLane { meleeCount rangeCount siegeCount denyCount neutralCount }
      }
    }
    players {
      steamAccountId
      playerSlot
      isRadiant
      kills
      deaths
      assists
      goldPerMinute
      experiencePerMinute
      numLastHits
      numDenies
      networth
      stats { deathEvents { time } }
      hero { id displayName }
      steamAccount { name }
    }
  }
}`;

function laneTotals(teamReport, laneName) {
  const rows = Array.isArray(teamReport) ? teamReport : [teamReport].filter(Boolean);
  return rows.reduce((total, row) => {
    const lane = row?.[laneName] || {};
    total.cs += Number(lane.meleeCount || 0) + Number(lane.rangeCount || 0) + Number(lane.siegeCount || 0);
    total.denies += Number(lane.denyCount || 0);
    return total;
  }, { cs: 0, denies: 0 });
}

function printLane(label, teamReport) {
  console.log(`${label} lane rows: ${Array.isArray(teamReport) ? teamReport.length : teamReport ? 1 : 0}`);
  for (const lane of ['safeLane', 'midLane', 'offLane']) {
    const totals = laneTotals(teamReport, lane);
    console.log(`  ${lane}: ${totals.cs} CS / ${totals.denies} denies`);
  }
}

function maxAbs(values) {
  return Math.max(...(values || []).map((value) => Math.abs(Number(value))).filter(Number.isFinite), 0);
}

const stratz = await axios.post(
  STRATZ_GQL,
  { query, variables: { matchId } },
  {
    headers: {
      Authorization: `Bearer ${STRATZ_API_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': 'STRATZ_API',
      Accept: 'application/json',
    },
    timeout: 30000,
  }
);

if (stratz.data?.errors) {
  console.log('Stratz GraphQL errors:', JSON.stringify(stratz.data.errors, null, 2));
}

const match = stratz.data?.data?.match;
if (!match) {
  console.error('No Stratz match returned');
  process.exit(1);
}

console.log(`Match #${match.id} mode=${match.gameMode} duration=${match.durationSeconds}s`);
console.log(`Max abs NW lead: ${maxAbs(match.radiantNetworthLeads).toLocaleString()}`);
console.log(`Max abs XP lead: ${maxAbs(match.radiantExperienceLeads).toLocaleString()}`);
printLane('Radiant', match.laneReport?.radiant);
printLane('Dire', match.laneReport?.dire);

const od = await axios.get(`https://api.opendota.com/api/matches/${matchId}`, { timeout: 30000 }).then((res) => res.data).catch(() => null);

const players = match.players || [];
const focused = focus
  ? players.filter((p) =>
      String(p.steamAccount?.name || '').toLowerCase().includes(focus) ||
      String(p.hero?.displayName || '').toLowerCase().includes(focus))
  : players;

for (const p of focused) {
  const odPlayer = od?.players?.find((op) =>
    Number(op.account_id) === Number(p.steamAccountId) ||
    op.player_slot === p.playerSlot ||
    (op.hero_id === p.hero?.id && (op.player_slot < 128) === !!p.isRadiant)
  );
  const deathTimes = Array.isArray(p.stats?.deathEvents) ? p.stats.deathEvents.map((event) => event.time) : [];
  console.log(`\n${p.isRadiant ? 'Radiant' : 'Dire'} ${p.steamAccount?.name || 'Anonymous'} - ${p.hero?.displayName}`);
  console.log(`  Stratz: ${p.kills}/${p.deaths}/${p.assists}, NW ${p.networth}, GPM ${p.goldPerMinute}, XPM ${p.experiencePerMinute}, LH/DN ${p.numLastHits}/${p.numDenies}`);
  if (odPlayer) {
    console.log(`  OpenDota: NW ${odPlayer.net_worth}, GPM ${odPlayer.gold_per_min}, XPM ${odPlayer.xp_per_min}, LH/DN ${odPlayer.last_hits}/${odPlayer.denies}`);
  }
  console.log(`  Death timing coverage: ${deathTimes.length}/${p.deaths} [${deathTimes.join(', ')}]`);
}
