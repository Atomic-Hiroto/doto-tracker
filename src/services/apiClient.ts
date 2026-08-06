import axios from 'axios';
import axiosRetry from 'axios-retry';
import { logger } from './loggerService';

// OpenDota's free tier is 60 requests/minute (2000/day). Without a key we stay
// well under it; a paid key raises the ceiling a lot, so allow an override.
const HAS_API_KEY = !!process.env.OPENDOTA_API_KEY;
const RATE_LIMIT_PER_MIN = parseInt(
    process.env.OPENDOTA_RATE_LIMIT || (HAS_API_KEY ? '600' : '45'),
    10
);
const RATE_WINDOW_MS = 60_000;

// The free tier also caps the day, and that ceiling is much easier to walk into
// unnoticed than the per-minute one, so track it and say so in the logs.
const DAILY_BUDGET = parseInt(
    process.env.OPENDOTA_DAILY_BUDGET || (HAS_API_KEY ? '50000' : '2000'),
    10
);

// Match details are effectively immutable once the game ends, and the poll loop
// asks for the same match several times in a row (parsed check → turbo stats →
// scoreboard). Everything else gets a short TTL just to absorb bursts.
const MATCH_CACHE_TTL_MS = 10 * 60_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 500;

const opendotaClient = axios.create({
    baseURL: 'https://api.opendota.com/api',
    timeout: 60000,
    params: HAS_API_KEY ? { api_key: process.env.OPENDOTA_API_KEY } : undefined,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Sliding-window limiter. Reservations are serialized through a promise chain so
// concurrent callers can't claim the same slot, but the requests themselves still
// run in parallel once admitted.
const callTimes: number[] = [];
let reserveChain: Promise<void> = Promise.resolve();

let usageDay = '';
let usageCount = 0;

function recordUsage() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== usageDay) {
        if (usageDay) logger.info(`OpenDota usage for ${usageDay}: ${usageCount}/${DAILY_BUDGET} calls`);
        usageDay = today;
        usageCount = 0;
    }
    usageCount++;
    if (usageCount === Math.floor(DAILY_BUDGET * 0.8)) {
        logger.warn(`OpenDota daily usage at ${usageCount}/${DAILY_BUDGET} — approaching the cap`);
    } else if (usageCount === DAILY_BUDGET) {
        logger.error(`OpenDota daily budget of ${DAILY_BUDGET} exhausted; expect 429s until midnight UTC`);
    }
}

function reserveSlot(): Promise<void> {
    const next = reserveChain.then(async () => {
        for (;;) {
            const now = Date.now();
            while (callTimes.length && now - callTimes[0] >= RATE_WINDOW_MS) callTimes.shift();
            if (callTimes.length < RATE_LIMIT_PER_MIN) {
                callTimes.push(now);
                recordUsage();
                return;
            }
            const waitMs = RATE_WINDOW_MS - (now - callTimes[0]) + 25;
            logger.debug(`OpenDota rate limiter: budget spent, waiting ${waitMs}ms`);
            await sleep(waitMs);
        }
    });
    reserveChain = next.catch(() => undefined);
    return next;
}

// Applies to GET and POST alike, and to axios-retry's retries (they re-enter the
// interceptor chain), so a 429 storm can't feed itself.
opendotaClient.interceptors.request.use(async (config) => {
    await reserveSlot();
    return config;
});

axiosRetry(opendotaClient, {
    retries: 3,
    shouldResetTimeout: true,
    retryDelay: (retryCount, error) => {
        // A per-minute limit needs to be waited out in seconds, not milliseconds.
        if (error.response?.status === 429) {
            const retryAfter = Number(error.response.headers?.['retry-after']);
            if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 65_000);
            return Math.min(5000 * 2 ** (retryCount - 1), 30_000);
        }
        return axiosRetry.exponentialDelay(retryCount, error);
    },
    retryCondition: (error) => {
        return (
            axiosRetry.isNetworkOrIdempotentRequestError(error) ||
            error.response?.status === 429 ||
            error.response?.status === 503 ||
            error.response?.status === 502
        );
    },
    onRetry: (retryCount, error) => {
        logger.warn(`OpenDota API retry #${retryCount} — ${error.message}`);
    },
});

opendotaClient.interceptors.response.use(
    (response) => response,
    (error) => {
        if (axios.isAxiosError(error)) {
            logger.debug(`OpenDota API error: ${error.response?.status} ${error.config?.url}`);
        }
        return Promise.reject(error);
    }
);

interface CacheEntry {
    expiresAt: number;
    response: any;
}

const getCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<any>>();

function ttlFor(url: string): number {
    return url.includes('/matches/') ? MATCH_CACHE_TTL_MS : DEFAULT_CACHE_TTL_MS;
}

function rememberResponse(key: string, url: string, response: any) {
    if (getCache.size >= CACHE_MAX_ENTRIES) {
        const oldest = getCache.keys().next().value;
        if (oldest !== undefined) getCache.delete(oldest);
    }
    getCache.set(key, { expiresAt: Date.now() + ttlFor(url), response });
}

// Transparent cache + in-flight dedupe over the instance's own get(). Every call
// site keeps using opendotaClient.get(...) unchanged; repeated and concurrent
// reads of the same URL collapse into a single upstream request. Pass
// `{ refresh: true }` to skip the cached copy — the fresh result still populates
// the cache, so a poll for changed state (e.g. a match finishing parsing) both
// sees the update and hands it to everyone downstream.
const rawGet = opendotaClient.get.bind(opendotaClient);
opendotaClient.get = function cachedGet(url: string, config?: any) {
    const key = `${url}|${JSON.stringify(config?.params ?? {})}`;
    const cached = getCache.get(key);
    if (!config?.refresh && cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.response);
    if (cached) getCache.delete(key);

    const pending = inFlight.get(key);
    if (pending) return pending;

    const request = rawGet(url, config)
        .then((response: any) => {
            rememberResponse(key, url, response);
            return response;
        })
        .finally(() => inFlight.delete(key));

    inFlight.set(key, request);
    return request;
} as typeof opendotaClient.get;

export { opendotaClient };
