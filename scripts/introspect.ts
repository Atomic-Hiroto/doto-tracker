import axios from 'axios';
import 'dotenv/config';
import fs from 'fs';

const STRATZ_API_KEY = process.env.STRATZ_API_KEY;
const STRATZ_GQL = 'https://api.stratz.com/graphql';

const introspectionQuery = `
  query IntrospectionQuery {
    __type(name: "MatchType") {
      name
      fields {
        name
        type {
          name
          kind
          ofType {
            name
            kind
          }
        }
      }
    }
  }
`;

async function introspect() {
  try {
    const response = await axios.post(
      STRATZ_GQL,
      { query: introspectionQuery },
      {
        headers: {
          Authorization: `Bearer ${STRATZ_API_KEY}`,
          'Content-Type': 'application/json',
          'User-Agent': 'DotoTracker/1.0',
        },
      }
    );
    fs.writeFileSync('introspection_match.json', JSON.stringify(response.data, null, 2));
    console.log('Introspection results saved to introspection_match.json');
  } catch (error) {
    console.error('Error during introspection:', error.response?.data || error.message);
    if (error.response?.status === 403) {
      console.log('403 Forbidden - Stratz might be blocking this IP or User-Agent.');
    }
  }
}

introspect();
