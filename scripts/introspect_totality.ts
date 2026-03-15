import axios from 'axios';
import fs from 'fs';

const STRATZ_GQL = 'https://api.stratz.com/graphql';
const STRATZ_API_KEY = process.env.STRATZ_API_KEY;

const INTROSPECTION_QUERY = `
{
  __type(name: "MatchType") {
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

const PLAYER_INTROSPECTION_QUERY = `
{
  __type(name: "MatchPlayerType") {
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

const STATS_INTROSPECTION_QUERY = `
{
  __type(name: "MatchPlayerStatsType") {
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

async function introspect() {
  const headers = {
    Authorization: `Bearer ${STRATZ_API_KEY}`,
    'Content-Type': 'application/json',
    'User-Agent': 'STRATZ_API'
  };

  const matchRes = await axios.post(STRATZ_GQL, { query: INTROSPECTION_QUERY }, { headers });
  const playerRes = await axios.post(STRATZ_GQL, { query: PLAYER_INTROSPECTION_QUERY }, { headers });
  const statsRes = await axios.post(STRATZ_GQL, { query: STATS_INTROSPECTION_QUERY }, { headers });

  fs.writeFileSync('match_fields.json', JSON.stringify(matchRes.data.data.__type.fields, null, 2));
  fs.writeFileSync('player_fields.json', JSON.stringify(playerRes.data.data.__type.fields, null, 2));
  fs.writeFileSync('stats_fields.json', JSON.stringify(statsRes.data.data.__type.fields, null, 2));
  
  console.log("Introspection complete. Files generated: match_fields.json, player_fields.json, stats_fields.json");
}

introspect().catch(console.error);
