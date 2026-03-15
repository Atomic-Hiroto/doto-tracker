import axios from 'axios';
import fs from 'fs';

const STRATZ_GQL = 'https://api.stratz.com/graphql';
const STRATZ_API_KEY = process.env.STRATZ_API_KEY;

const TYPES_TO_INTROSPECT = [
  "MatchPlayerStatsAssistEventType",
  "MatchPlayerStatsItemUsedEventType",
  "MatchPlayerStatsAllTalkEventType",
  "MatchPlayerStatsChatWheelEventType",
  "MatchPlayerStatsActionReportType",
  "MatchPlayerStatsLocationReportType",
  "MatchPlayerInventoryType",
  "MatchPlayerSpiritBearInventoryType",
  "HeroPositionTimeDetailType"
];

async function introspect() {
  const headers = {
    Authorization: `Bearer ${STRATZ_API_KEY}`,
    'Content-Type': 'application/json',
    'User-Agent': 'STRATZ_API'
  };

  const results = {};
  for (const typeName of TYPES_TO_INTROSPECT) {
    const query = `
    {
      __type(name: "${typeName}") {
        fields {
          name
          type {
            name
            kind
            ofType { name kind }
          }
        }
      }
    }
    `;
    const res = await axios.post(STRATZ_GQL, { query }, { headers });
    results[typeName] = res.data.data.__type.fields;
  }

  fs.writeFileSync('deep_stats_introspection.json', JSON.stringify(results, null, 2));
  console.log("Deep introspection complete. File generated: deep_stats_introspection.json");
}

introspect().catch(console.error);
