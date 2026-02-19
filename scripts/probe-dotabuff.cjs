const https = require('https');

function fetch(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9',
            }
        }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
    });
}

async function main() {
    const url = `https://www.dotabuff.com/heroes?show=facets&view=meta&mode=turbo&date=7d&position=core-safe`;
    const { status, body } = await fetch(url);
    console.log('Status:', status, '| Size:', body.length);

    // Find context around "Dragon Knight" to understand the table structure
    const idx = body.indexOf('Dragon Knight');
    if (idx !== -1) {
        console.log('\n=== Context around "Dragon Knight" (200 chars) ===');
        console.log(body.slice(idx - 200, idx + 400));
    }

    // Look for <tr elements with hero data
    const trMatches = body.match(/<tr[^>]*class="[^"]*hero[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi) || [];
    if (trMatches.length > 0) {
        console.log('\n=== First hero <tr> ===');
        console.log(trMatches[0].slice(0, 600));
    } else {
        // Try article or li tags
        const liMatches = body.match(/<li[^>]*>([\s\S]{0,400}Dragon Knight[\s\S]{0,400})<\/li>/i) || [];
        if (liMatches.length > 0) console.log('\nDragon Knight in <li>:', liMatches[0].slice(0, 400));

        // Find tbody or table content
        const tbodyMatch = body.match(/<tbody>([\s\S]{0,2000})<\/tbody>/i);
        if (tbodyMatch) console.log('\ntbody snippet:', tbodyMatch[1].slice(0, 600));
        else console.log('\nNo <tbody> found');
    }

    // Find data-* attrs near win/pick with context  
    const re = /data-(?:win|pick|value|percent)[^=]*="([^"]+)"/gi;
    const attrs = [];
    let m;
    while ((m = re.exec(body)) !== null) attrs.push(m[0]);
    console.log('\ndata-win/pick attrs:', attrs.slice(0, 10));
}

main().catch(console.error);
