export interface Match {
    match_id: number;
    hero_id: number;
    players: Array<{
        hero_id: number;
        isRadiant: boolean;
        account_id?: number;
        personaname?: string;
        kills?: number;
        deaths?: number;
        assists?: number;
        last_hits?: number;
        gold_per_min?: number;
        xp_per_min?: number;
    }>;
    radiant_win: boolean;
    duration: number;
    game_mode?: number;
    start_time: number;
}