require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

const STRATZ_GQL = 'https://api.stratz.com/graphql';
const STRATZ_API_KEY = process.env.STRATZ_API_KEY;

const TYPES_TO_INTROSPECT = [
  "MatchPlayerSpiritBearInventoryType"
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

  fs.writeFileSync('inventory_introspection_results.json', JSON.stringify(results, null, 2));
  console.log('Results saved to inventory_introspection_results.json');
}

introspect().catch(console.error);
