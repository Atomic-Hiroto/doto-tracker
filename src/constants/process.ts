import dotenv from 'dotenv'

dotenv.config();

export const PREFIX = process.env.PREFIX || '+';
export const SPACE = ' ';
export const BOT_TOKEN = process.env.BOT_TOKEN;
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
export const USER_DATA_FILE = process.env.USER_DATA_FILE || 'users.json';
export const COACHING_DB_FILE = process.env.COACHING_DB_FILE || 'coaching.sqlite';
export const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || '1800000', 10);
// Re-checking matches still awaiting OpenDota's replay parse is the single
// biggest draw on a 2000/day budget, and parses land in minutes-to-hours, so it
// runs far less often than the match poll rather than once per cycle.
export const PARSED_RECHECK_INTERVAL = parseInt(process.env.PARSED_RECHECK_INTERVAL || '3600000', 10);
// OpenDota simply never parses some matches. Without a cutoff those entries sit
// in pendingParsedAchievements and get re-fetched forever.
export const PARSED_PENDING_MAX_AGE_MS = parseInt(process.env.PARSED_PENDING_MAX_AGE_MS || String(24 * 60 * 60 * 1000), 10);
export const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
export const STRATZ_API_KEY = process.env.STRATZ_API_KEY;
export const BOT_OWNER_ID = process.env.BOT_OWNER_ID || '78168838910246912';
