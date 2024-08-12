import dotenv from 'dotenv'

dotenv.config();

export const PREFIX = '+';
export const SPACE = ' ';
export const BOT_TOKEN = process.env.BOT_TOKEN;
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
export const USER_DATA_FILE = 'users.json';
export const CHECK_INTERVAL = 20 * 60 * 1000;