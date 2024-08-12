export function isValidSteamId(steamId: string): boolean {
    // Validation for Steam32 ID (32-bit)
    // Steam32 IDs are typically 8-10 digits long
    return /^[0-9]{8,10}$/.test(steamId);
  }