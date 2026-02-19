import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import axios from 'axios';

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dir, '..', '.env');
const raw = readFileSync(envPath, 'utf-8');
const line = raw.split('\n').find(l => l.startsWith('STRATZ_API_KEY'));
const TOKEN = line?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');

const headers = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    // Mimic what a browser extension or Postman would send
    'User-Agent': 'PostmanRuntime/7.36.0',
    'Accept': 'application/json',
};

async function check(label, fn) {
    try {
        const res = await fn();
        const preview = JSON.stringify(res.data).slice(0, 300);
        console.log(`✅ ${label}: HTTP ${res.status}\n   ${preview}\n`);
        return res.data;
    } catch (e) {
        const body = String(e.response?.data ?? '').slice(0, 200);
        console.log(`❌ ${label}: HTTP ${e.response?.status} — ${e.message}`);
        if (body && !body.includes('DOCTYPE')) console.log(`   ${body}`);
        console.log();
        return null;
    }
}

// --- REST API endpoints ---
await check('GET /api/v1/hero',
    () => axios.get('https://api.stratz.com/api/v1/hero', { headers, timeout: 10000 }));

await check('GET /api/v1/league',
    () => axios.get('https://api.stratz.com/api/v1/league', { headers, timeout: 10000 }));

// Hero stats via REST (known Stratz REST endpoint)
await check('GET /api/v1/heroItem',
    () => axios.get('https://api.stratz.com/api/v1/heroItem', { headers, timeout: 10000 }));

// GraphQL with Postman UA
await check('GraphQL winWeek (Postman UA)',
    () => axios.post('https://api.stratz.com/graphql',
        { query: `{ heroStats { winWeek { heroId lane matchCount winCount } } }` },
        { headers, timeout: 15000 }
    ));
