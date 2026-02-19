/**
 * dotabuffScraper.ts
 * Scrapes Dotabuff hero meta stats per lane position.
 *
 * Uses puppeteer-extra + stealth plugin so it works headlessly on Linux servers
 * (Oracle Cloud, VPS, etc.) without being bot-detected by Dotabuff.
 * Results are cached for 1 hour.
 */

import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser } from 'puppeteer-core';
import { existsSync } from 'fs';
import { logger } from './loggerService';

// Register stealth plugin once
puppeteerExtra.use(StealthPlugin());

// ─── Chrome path resolution ────────────────────────────────────────────────────
const CHROME_CANDIDATES = [
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    // Linux - Google Chrome
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    // Linux - Chromium
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findChrome(): string | undefined {
    return CHROME_CANDIDATES.find(p => existsSync(p));
}

// ─── Types ─────────────────────────────────────────────────────────────────────
export interface DotabuffHeroStat {
    heroName: string;
    facetName: string;
    tier: string;         // S / A / B / C / D
    winRate: number;      // 0–100
    pickRate: number;     // 0–100
}

export interface LaneMeta {
    positionKey: string;
    positionLabel: string;
    heroes: DotabuffHeroStat[];
    fetchedAt: number;
}

const POSITIONS: Record<string, string> = {
    'core-safe': 'Safe Lane',
    'core-mid': 'Mid Lane',
    'core-off': 'Off Lane',
    'support-soft': 'Soft Support',
    'support-hard': 'Hard Support',
};

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let cachedResult: { data: LaneMeta[]; fetchedAt: number } | null = null;

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
    if (browser && browser.connected) return browser;

    const chromePath = findChrome();
    if (!chromePath) {
        throw new Error(
            'No Chrome/Chromium found. On Linux: sudo apt install -y chromium-browser'
        );
    }
    logger.info(`Dotabuff scraper: launching Chrome at ${chromePath}`);

    const isLinux = process.platform === 'linux';

    browser = await puppeteerExtra.launch({
        executablePath: chromePath,
        // Stealth works best with headless:'new' (Chrome's new headless mode)
        // On Linux servers there's no display so headless is mandatory
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',   // required on Linux servers (small /dev/shm)
            '--disable-gpu',              // no GPU on VPS
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',           // helps on low-core VMs
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-sync',
            '--disable-translate',
            '--metrics-recording-only',
            '--safebrowsing-disable-auto-update',
            '--window-size=1280,900',
            ...(isLinux ? ['--disable-features=VizDisplayCompositor'] : []),
        ],
        defaultViewport: { width: 1280, height: 900 },
    }) as unknown as Browser;

    return browser;
}

// ─── Per-lane scrape ────────────────────────────────────────────────────────────
async function scrapeLane(position: string): Promise<DotabuffHeroStat[]> {
    const b = await getBrowser();
    const page = await (b as any).newPage();

    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    );
    // Extra headers to look like a real browser
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
    });

    try {
        const url = `https://www.dotabuff.com/heroes?view=meta&mode=turbo&date=7d&position=${position}`;
        logger.debug(`Dotabuff scraping: ${url}`);

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
        // Small wait for any deferred rendering
        await new Promise<void>(r => setTimeout(r, 2500));

        const lines: string[] = await page.evaluate(() =>
            document.body.innerText.split('\n').map((l: string) => l.trim()).filter(Boolean)
        );

        // Find column header row
        const headerIdx = lines.findIndex(l => l === 'Win rate' || l === 'Win Rate');
        if (headerIdx === -1) {
            logger.warn(`Dotabuff: header not found for position=${position}. Lines: ${lines.slice(0, 15).join(' | ')}`);
            return [];
        }

        const heroes: DotabuffHeroStat[] = [];
        const tierRe = /^[SABCD]$/;
        const pctRe = /^\d{1,3}\.\d{1,2}%$/;
        const deltaRe = /^[+-]?\d+\.\d+%$/;

        // Pattern per entry (8 lines):
        // [i+0] Hero Name
        // [i+1] Facet Name
        // [i+2] Tier (S/A/B/C/D)
        // [i+3] Win Rate %
        // [i+4] WR Change
        // [i+5] Pick Rate %
        // [i+6] Pick Change
        // [i+7] Ban Rate %
        let i = headerIdx + 3;
        while (i < lines.length - 8) {
            const l = lines[i];
            if (
                !pctRe.test(l) && !deltaRe.test(l) && !tierRe.test(l) &&
                l.length > 2 && l.length < 50 &&
                tierRe.test(lines[i + 2]) &&
                pctRe.test(lines[i + 3]) &&
                deltaRe.test(lines[i + 4])
            ) {
                heroes.push({
                    heroName: l,
                    facetName: lines[i + 1] ?? '',
                    tier: lines[i + 2],
                    winRate: parseFloat(lines[i + 3]),
                    pickRate: parseFloat(lines[i + 5]),
                });
                i += 8;
            } else {
                i++;
            }
        }

        logger.info(`Dotabuff: scraped ${heroes.length} entries for position=${position}`);
        return heroes;
    } finally {
        await page.close();
    }
}

// ─── Public API ─────────────────────────────────────────────────────────────────
/**
 * Fetch top heroes for all 5 lane positions from Dotabuff turbo meta.
 * Results are cached for 1 hour to avoid re-launching Chrome on every +meta.
 */
export async function fetchDotabuffTurboMeta(): Promise<LaneMeta[]> {
    const now = Date.now();
    if (cachedResult && now - cachedResult.fetchedAt < CACHE_TTL_MS) {
        logger.debug('Dotabuff: returning cached meta');
        return cachedResult.data;
    }

    const results: LaneMeta[] = [];
    for (const [posKey, posLabel] of Object.entries(POSITIONS)) {
        try {
            const heroes = await scrapeLane(posKey);
            results.push({ positionKey: posKey, positionLabel: posLabel, heroes, fetchedAt: now });
        } catch (err) {
            logger.error(`Dotabuff scrape failed for ${posKey}:`, err);
            results.push({ positionKey: posKey, positionLabel: posLabel, heroes: [], fetchedAt: now });
        }
    }

    cachedResult = { data: results, fetchedAt: now };
    return results;
}

/** Close the browser during graceful shutdown. */
export async function closeDotabuffBrowser(): Promise<void> {
    if (browser) {
        await (browser as any).close().catch(() => null);
        browser = null;
    }
}
