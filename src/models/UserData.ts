export interface UserData {
    discordId: string,
    steamId: string,
    autoShow: boolean,
    lastCheckedMatch: number | null,
    matchesTracked?: number,
    heroesPlayed?: number[],
}
