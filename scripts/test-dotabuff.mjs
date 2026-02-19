import puppeteer from 'puppeteer-core';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const POSITIONS = {
    'core-safe': 'Safe Lane',
    'core-mid': 'Mid Lane',
    'core-off': 'Off Lane',
    'support-soft': 'Soft Support',
    'support-hard': 'Hard Support',
};

async function scrapePosition(page, position, mode = 'turbo', date = '7d') {
    const url = `https://www.dotabuff.com/heroes?view=meta&mode=${mode}&date=${date}&position=${position}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const lines = await page.evaluate(() =>
        document.body.innerText.split('\n').map(l => l.trim()).filter(Boolean)
    );

    // Find data start: first line after the column headers
    // Headers appear as: "Hero Facet", "Tier", "Win rate", "Change", "Pick rate" etc.
    const headerIdx = lines.findIndex(l => l === 'Win rate' || l === 'Win Rate');
    if (headerIdx === -1) return [];

    const heroes = [];
    const tierRe = /^[SABCD]$/;
    const pctRe = /^\d{1,3}\.\d{1,2}%$/;
    const deltaRe = /^[+-]?\d+\.\d+%$/;

    let i = headerIdx + 3; // skip "Change", "Pick rate" header cells
    while (i < lines.length - 8) {
        const l = lines[i];

        // Detect a hero entry: hero name followed by facet name, then tier
        if (
            !pctRe.test(l) && !deltaRe.test(l) && !tierRe.test(l) &&
            l.length > 2 && l.length < 50 &&
            tierRe.test(lines[i + 2]) &&
            pctRe.test(lines[i + 3]) &&
            deltaRe.test(lines[i + 4])
        ) {
            const heroName = l;
            const facetName = lines[i + 1];
            const tier = lines[i + 2];
            const winRate = parseFloat(lines[i + 3]);
            const pickRate = parseFloat(lines[i + 5]);

            heroes.push({ heroName, facetName, tier, winRate, pickRate });
            i += 8; // skip all 8 lines of this entry
        } else {
            i++;
        }
    }

    return heroes;
}

async function main() {
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: false,
        args: ['--no-sandbox', '--start-maximized'], defaultViewport: null,
    });
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');

    for (const [pos, label] of Object.entries(POSITIONS)) {
        const heroes = await scrapePosition(page, pos);
        console.log(`\n=== ${label} (${pos}) — ${heroes.length} heroes ===`);
        heroes.slice(0, 8).forEach(h =>
            console.log(`  [${h.tier}] ${h.heroName} (${h.facetName}) — WR: ${h.winRate}% | Pick: ${h.pickRate}%`)
        );
    }

    await browser.close();
}
main().catch(console.error);
