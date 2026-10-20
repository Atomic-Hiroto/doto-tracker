// Same loop as +turbobackfill, for running on the server while the bot is stopped (the bot holds the
// ledger in memory and would save over this run). Run from the repo root after `npx tsc`:
//   node scripts/backfill-offline.cjs [days=365] [perPlayer=200]
const path = require('path');
const dist = path.join(__dirname, '..', 'dist');
const { fetchPlayerTurboMatches } = require(path.join(dist, 'services/stratzClient.js'));
const { TurboStatsService } = require(path.join(dist, 'services/turboStatsService.js'));
const { UserDataService } = require(path.join(dist, 'services/userDataService.js'));

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const days = Math.max(7, Math.min(1825, Number.parseInt(process.argv[2] || '365', 10) || 365));
  const maxPerPlayer = Math.max(50, Math.min(1000, Number.parseInt(process.argv[3] || '200', 10) || 200));
  const stats = new TurboStatsService();
  const allUsers = new UserDataService().getAllUsers();
  const roster = allUsers.map(user => ({ discordId: user.discordId, steamId: user.steamId }));
  const anchors = allUsers.filter(user => user.historyAccessible !== false);
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const seen = new Set();
  let rows = 0, changed = 0;
  for (let i = 0; i < anchors.length; i++) {
    for (let skip = 0; skip < maxPerPlayer; skip += 100) {
      const take = Math.min(100, maxPerPlayer - skip);
      const matches = await fetchPlayerTurboMatches(Number(anchors[i].steamId), take, skip, since, null);
      rows += matches.length;
      for (const match of matches) {
        const key = `${anchors[i].steamId}:${match.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (stats.processTurboMatch(match, roster, 'historical', true)) changed++;
      }
      if (matches.length < take) break;
      await delay(500);
    }
    console.log(`${i + 1}/${anchors.length} players · ${rows} rows · ${changed} new/updated`);
    if (i < anchors.length - 1) await delay(700);
  }
  stats.markBackfillComplete();
  const ledger = stats.getAllStats().matches || [];
  console.log(`done: ${ledger.length} matches · ${ledger.filter(m => m.teammates).length} with teammates`);
})().catch(error => { console.error(error); process.exit(1); });
