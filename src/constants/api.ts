export const RECENT_MATCHES = (steamId: string) => `https://api.opendota.com/api/players/${steamId}/recentMatches`;
export const HEROES_API = 'https://api.opendota.com/api/heroes';
export const ITEMS_API = 'https://api.opendota.com/api/constants/items';
export const MATCH_DETAILS = (matchId: number) => `https://api.opendota.com/api/matches/${matchId}`;
export const PARSE_REQUEST = (matchId: number) => `https://api.opendota.com/api/request/${matchId}`;