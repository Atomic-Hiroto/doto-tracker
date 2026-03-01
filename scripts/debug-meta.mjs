// Quick debug: run the scraper directly and print the full error + line count
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { existsSync } from 'fs';

puppeteerExtra.use(StealthPlugin());

const CHROME_CANDIDATES = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
];

const chromePath = CHROME_CANDIDATES.find(p => existsSync(p));
console.log('Chrome found at:', chromePath ?? 'NONE FOUND — this is why it falls back!');
if (!chromePath) process.exit(1);

console.log('Launching with headless:true + stealth...');
let browser;
try {
    browser = await puppeteerExtra.launch({
        executablePath: chromePath,
        headless: true,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            '--disable-gpu', '--window-size=1280,900',
        ],
        defaultViewport: { width: 1280, height: 900 },
    });
    console.log('Browser launched OK');

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    const url = 'https://www.dotabuff.com/heroes?view=meta&mode=turbo&date=7d&position=core-safe';
    console.log('Navigating to:', url);

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 2500));

    const lines = await page.evaluate(() =>
        document.body.innerText.split('\n').map(l => l.trim()).filter(Boolean)
    );

    console.log(`\nTotal lines rendered: ${lines.length}`);
    console.log('First 30 lines:');
    lines.slice(0, 30).forEach((l, i) => console.log(`  ${i}: ${l}`));

    const headerIdx = lines.findIndex(l => l === 'Win rate' || l === 'Win Rate');
    console.log('\nHeader "Win rate" found at index:', headerIdx);

    // Check for bot detection page
    const bodyText = lines.join(' ');
    if (bodyText.includes('Cloudflare') || bodyText.includes('challenge')) {
        console.log('\n⚠️  Cloudflare challenge detected!');
    }
    if (lines.length < 20) {
        console.log('\n⚠️  Very few lines — page likely not rendering (JS blocked or bot-detected)');
    }

    await page.close();
} catch (err) {
    console.error('\n❌ Error:', err.message);
} finally {
    if (browser) await browser.close();
}
