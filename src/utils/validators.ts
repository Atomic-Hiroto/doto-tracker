export function isValidSteamId(steamId: string): boolean {
  // Validation for Steam32 ID (32-bit)
  // Steam32 IDs are typically 8-10 digits long
  return /^[0-9]{8,10}$/.test(steamId);
}

const STEAM64_BASE = BigInt('76561197960265728');

/**
 * Normalises a user-supplied Steam identifier to a 32-bit account id (the form Dota
 * APIs use). Accepts: a raw 32-bit id, a 64-bit SteamID, a steamcommunity /profiles/
 * URL, or a dotabuff/opendota/stratz player URL. Returns null if it can't be resolved
 * (e.g. a vanity name or /id/ URL, which need a Steam Web API key we don't have).
 */
export function normalizeSteamId(input: string): string | null {
  let s = (input || '').trim();

  // Pull the id out of common profile URLs.
  const profile64 = s.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  if (profile64) s = profile64[1];
  const playerUrl = s.match(/(?:dotabuff\.com\/players|opendota\.com\/players|stratz\.com\/players)\/(\d{4,12})/i);
  if (playerUrl) s = playerUrl[1];

  // Vanity URLs / names can't be resolved without a Steam Web API key.
  if (/steamcommunity\.com\/id\//i.test(s)) return null;
  if (!/^\d+$/.test(s)) return null;

  // 64-bit SteamID -> subtract the base to get the 32-bit account id.
  if (s.length === 17) {
    try {
      const v = BigInt(s) - STEAM64_BASE;
      return v > BigInt(0) && v < BigInt('9999999999') ? v.toString() : null;
    } catch {
      return null;
    }
  }

  // Already a 32-bit account id.
  return /^\d{4,11}$/.test(s) ? s : null;
}
