const fs = require('fs');
const html = fs.readFileSync('scripts/dotabuff-rendered.html', 'utf8');

// Find hero links that are actual hero pages (not /heroes/meta etc)
const heroRe = /href="\/heroes\/([a-z-]+)"(?!\/)/g;
const seen = new Set();
let m;
let count = 0;

while ((m = heroRe.exec(html)) !== null) {
    const slug = m[1];
    if (['meta', 'new', 'tier', 'agility', 'strength', 'intelligence', 'universal', 'collection'].includes(slug)) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);

    // Print surrounding context for first few
    if (count < 3) {
        const ctx = html.slice(m.index, m.index + 1000);
        console.log(`\n=== Hero: "${slug}" ===`);
        console.log(ctx);
    }
    count++;
}

console.log(`\nTotal unique heroes found: ${count}`);
