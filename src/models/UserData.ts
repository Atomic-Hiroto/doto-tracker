export interface UserData {
    discordId: string,
    steamId: string,
    autoShow: boolean,
    /** False for roster-only identities whose match history is private/unavailable. */
    historyAccessible?: boolean,
    lastCheckedMatch: number | null,
    matchesTracked?: number,
    heroesPlayed?: number[],
    turboMatchesTracked?: number,
    turboHeroesPlayed?: number[],
    turboWinStreak?: number,
    turboHeroStats?: Record<string, { games: number; wins: number }>,
    pendingParsedAchievements?: number[],
}
