import dotenv from 'dotenv'

dotenv.config();

export const PREFIX = process.env.PREFIX || '+';
export const SPACE = ' ';
export const BOT_TOKEN = process.env.BOT_TOKEN;
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
export const USER_DATA_FILE = process.env.USER_DATA_FILE || 'users.json';
export const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || '1200000', 10);