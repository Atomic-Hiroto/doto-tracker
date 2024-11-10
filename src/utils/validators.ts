export function isValidSteamId(steamId: string): boolean {
  // Validation for Steam32 ID (32-bit)
  // Steam32 IDs are typically 8-10 digits long
  return /^[0-9]{8,10}$/.test(steamId);
}

export function isValidDiscordId(discordUserId: string) {
  // Discord user IDs are 17 or 18 digits long
  if (discordUserId.length !== 17 && discordUserId.length !== 18) {
    return false;
  }

  // Check if the ID consists of only digits
  if (!/^\d+$/.test(discordUserId)) {
    return false;
  }

  return true;
}