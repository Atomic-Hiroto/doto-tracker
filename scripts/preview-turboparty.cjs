// Prints what +turboparty would post, using the real command against a copy of the data in cwd.
// Usage (from a folder holding copies of turboStats.json and turboRankData.json):
//   node preview-turboparty.cjs [args...]     e.g. `plan`, `90`, `<discordId>` to name a player
const path = require('path');
const dist = process.env.DIST || path.join(__dirname, '..', 'dist');
const { turboParty } = require(path.join(dist, 'commands/turboParty.js'));
const { TurboStatsService } = require(path.join(dist, 'services/turboStatsService.js'));

const args = process.argv.slice(2);
const mentioned = args.filter(arg => /^\d{15,}$/.test(arg));
const message = {
  author: { id: process.env.AUTHOR_ID || '0' },
  mentions: { users: new Map(mentioned.map(id => [id, { id }])) },
  client: { users: { fetch: async () => { throw new Error('offline preview'); } } },
  reply: async (out) => {
    if (typeof out === 'string') return console.log(out);
    for (const embed of out.embeds || []) {
      const d = embed.data || embed;
      console.log(`\n=== ${d.title} ===\n${d.description || ''}`);
      for (const field of d.fields || []) console.log(`\n-- ${field.name}\n${field.value}`);
      if (d.footer) console.log(`\n(${d.footer.text})`);
    }
  }
};
turboParty(message, new TurboStatsService(), args.filter(arg => !mentioned.includes(arg)));
