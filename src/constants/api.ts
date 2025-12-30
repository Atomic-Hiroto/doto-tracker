import { toSnakeCase } from "../utils/formatters";

export const RECENT_MATCHES = (steamId: string) => `https://api.opendota.com/api/players/${steamId}/recentMatches`;
export const HEROES_API = 'https://api.opendota.com/api/heroes';
export const ITEMS_API = 'https://api.opendota.com/api/constants/items';
export const MATCH_DETAILS = (matchId: number) => `https://api.opendota.com/api/matches/${matchId}`;
export const PARSE_REQUEST = (matchId: number) => `https://api.opendota.com/api/request/${matchId}`;
export const IMAGE_URL = (heroName: string) => `https://raw.githubusercontent.com/ya-kmet/dota2-static/master/vendor/assets/images/dota2/static/heroes/${toSnakeCase(heroName)}.png`

// Player profile endpoints
export const PLAYER_PROFILE = (steamId: string) => `https://api.opendota.com/api/players/${steamId}`;
export const PLAYER_WL = (steamId: string) => `https://api.opendota.com/api/players/${steamId}/wl`;
export const PLAYER_TOTALS = (steamId: string) => `https://api.opendota.com/api/players/${steamId}/totals`;
export const PLAYER_HEROES = (steamId: string) => `https://api.opendota.com/api/players/${steamId}/heroes`;

// Turbo heroes (game_mode=23, significant=0 for turbo, date param = days ago)
export const PLAYER_TURBO_HEROES = (steamId: string, daysAgo: number) =>
    `https://api.opendota.com/api/players/${steamId}/heroes?game_mode=23&significant=0&date=${daysAgo}`;