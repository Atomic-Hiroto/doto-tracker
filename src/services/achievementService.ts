import fs from 'fs';
import { TextChannel } from 'discord.js';
import { logger } from './loggerService';

export interface AchievementDefinition {
    id: string;
    name: string;
    description: string;
    emoji: string;
}

export interface UnlockedAchievement {
    discordId: string;
    achievementId: string;
    unlockedAt: number;
    matchId?: number;
    rulesVersion?: number;
    requirementAtUnlock?: string;
}

const ACHIEVEMENT_RULES_VERSION = 2;

export const ACHIEVEMENTS: AchievementDefinition[] = [
    // ── Onboarding & match count ──────────────────────────────────────────────
    { id: 'first_blood', name: 'First Steps', emoji: '🎮', description: 'Play your first tracked Turbo match' },
    { id: 'century_club', name: 'Century Club', emoji: '💯', description: 'Play 100 tracked Turbo matches' },
    { id: 'marathoner', name: 'Marathoner', emoji: '🏃', description: 'Play 250 tracked Turbo matches' },
    { id: 'veteran', name: 'Veteran', emoji: '🎖️', description: 'Play 500 tracked Turbo matches' },
    { id: 'no_lifer', name: 'No Lifer', emoji: '🛌', description: 'Play 1000 tracked Turbo matches' },

    // ── Kills (win) ───────────────────────────────────────────────────────────
    { id: 'carry_enjoyer', name: 'Carry Enjoyer', emoji: '👑', description: 'Win with 10+ kills in one game' },
    { id: 'bloodthirsty', name: 'Bloodthirsty', emoji: '🗡️', description: 'Win with 13+ kills in one game' },
    { id: 'massacre', name: 'Massacre', emoji: '🩸', description: 'Win with 16+ kills in one game' },
    { id: 'unstoppable', name: 'Unstoppable', emoji: '⚔️', description: 'Win with 19+ kills in one game' },
    { id: 'god_of_slaughter', name: 'God of Slaughter', emoji: '💀', description: 'Win with 22+ kills in one game' },
    { id: 'kill_legend', name: 'Living Legend', emoji: '☠️', description: 'Win with 25+ kills in one game' },
    { id: 'thirty_bomb', name: 'Thirty Bomb', emoji: '💣', description: 'Win with 30+ kills in one game' },

    // ── Assists (win) ─────────────────────────────────────────────────────────
    { id: 'team_player', name: 'Team Player', emoji: '🤝', description: 'Win with 14+ assists in one game' },
    { id: 'support_god', name: 'Support God', emoji: '💚', description: 'Win a game with 18+ assists' },
    { id: 'guardian_angel', name: 'Guardian Angel', emoji: '😇', description: 'Win with 22+ assists in one game' },
    { id: 'assist_master', name: 'Assist Master', emoji: '🎗️', description: 'Win with 26+ assists in one game' },
    { id: 'battle_medic', name: 'Battle Medic', emoji: '🚑', description: 'Win a game with 30+ assists' },
    { id: 'hand_of_god', name: 'Hand of God', emoji: '✋', description: 'Win with 34+ assists in one game' },
    { id: 'the_saint', name: 'The Saint', emoji: '🕊️', description: 'Win with 40+ assists in one game' },

    // ── Deaths while still winning ────────────────────────────────────────────
    { id: 'feeder_redeemed', name: 'Feeder Redeemed', emoji: '🔄', description: 'Win a game with 9+ deaths' },
    { id: 'unkillable_feeder', name: 'Unkillable Feeder', emoji: '🧟', description: 'Win a game with 13+ deaths' },
    { id: 'int_diff', name: 'Int Diff', emoji: '🤡', description: 'Win a game despite 16+ deaths' },

    // ── KDA combos (win) ──────────────────────────────────────────────────────
    { id: 'clean_sweep', name: 'Clean Sweep', emoji: '🧹', description: 'Win a game with 0 deaths' },
    { id: 'flawless_execution', name: 'Flawless Execution', emoji: '💎', description: 'Win with 10+ kills and 0 deaths' },
    { id: 'untouchable', name: 'Untouchable', emoji: '🫧', description: 'Win with 15+ kills and 0 deaths' },
    { id: 'godlike_kda', name: 'Godlike', emoji: '🌟', description: 'Win with 20+ kills and 0 deaths' },
    { id: 'one_man_army', name: 'One Man Army', emoji: '🪖', description: 'Win with 20+ kills and 5 or fewer assists' },
    { id: 'pure_support', name: 'Pure Support', emoji: '💉', description: 'Win with 25+ assists and 3 or fewer kills' },
    { id: 'glass_cannon', name: 'Glass Cannon', emoji: '🔫', description: 'Win with 20+ kills AND 15+ deaths' },
    { id: 'triple_threat', name: 'Triple Threat', emoji: '🎯', description: 'Win with 10+ kills, 10+ assists, 0 deaths' },
    { id: 'raid_boss', name: 'Raid Boss', emoji: '🛡️', description: 'Win with 20+ kills and 20+ assists' },

    // ── Farm / economy (any game) ─────────────────────────────────────────────
    { id: 'gold_digger', name: 'Gold Digger', emoji: '💰', description: 'Hit 1100+ GPM in a game' },
    { id: 'midas_touch', name: 'Midas Touch', emoji: '🤑', description: 'Hit 1350+ GPM in a game' },
    { id: 'greedy', name: 'Greedy', emoji: '🪙', description: 'Hit 1550+ GPM in a game' },
    { id: 'economy_god', name: 'Economy God', emoji: '🏦', description: 'Hit 1750+ GPM in a game' },
    { id: 'money_printer', name: 'Money Printer', emoji: '🖨️', description: 'Hit 1950+ GPM in a game' },
    { id: 'farmhand', name: 'Farmhand', emoji: '🌾', description: 'Get 150+ last hits in a game' },
    { id: 'last_hit_machine', name: 'Last-Hit Machine', emoji: '🚜', description: 'Get 230+ last hits in a game' },
    { id: 'creep_god', name: 'Creep God', emoji: '🌽', description: 'Get 320+ last hits in a game' },
    { id: 'free_real_estate', name: 'Free Real Estate', emoji: '🏡', description: 'Get 420+ last hits in a game' },

    // ── Experience ────────────────────────────────────────────────────────────
    { id: 'fast_learner', name: 'Fast Learner', emoji: '📗', description: 'Hit 1900+ XPM in a game' },
    { id: 'scholar', name: 'Scholar', emoji: '🎓', description: 'Hit 2300+ XPM in a game' },
    { id: 'galaxy_brain', name: 'Galaxy Brain', emoji: '🧠', description: 'Hit 2700+ XPM in a game' },

    // ── Damage & healing ──────────────────────────────────────────────────────
    { id: 'damage_dealer', name: 'Damage Dealer', emoji: '💥', description: 'Deal 30k+ hero damage in a game' },
    { id: 'nuker', name: 'Nuker', emoji: '☢️', description: 'Deal 55k+ hero damage in a game' },
    { id: 'devastation', name: 'Devastation', emoji: '🌶️', description: 'Deal 78k+ hero damage in a game' },
    { id: 'apocalypse', name: 'Apocalypse', emoji: '🔆', description: 'Deal 100k+ hero damage in a game' },
    { id: 'field_medic', name: 'Field Medic', emoji: '➕', description: 'Heal 5k+ in a game' },
    { id: 'field_hospital', name: 'Field Hospital', emoji: '🏥', description: 'Heal 12k+ in a game' },
    { id: 'lifesaver', name: 'Lifesaver', emoji: '💗', description: 'Heal 20k+ in a game' },

    // ── Real Dota combat events (parsed matches) ──────────────────────────────
    { id: 'actual_first_blood', name: 'First Blood', emoji: '🩸', description: 'Claim First Blood' },
    { id: 'ultra_kill', name: 'Ultra Kill', emoji: '⚔️', description: 'Get an Ultra Kill (4 rapid kills)' },
    { id: 'true_rampage', name: 'Rampage!', emoji: '🐉', description: 'Get a real Rampage (5 rapid kills)' },
    { id: 'godlike_spree', name: 'Beyond Godlike', emoji: '👿', description: 'Reach a 10+ hero kill streak' },

    // ── Objectives & team contribution (parsed matches) ──────────────────────
    { id: 'siege_engine', name: 'Siege Engine', emoji: '🏰', description: 'Win with 10k+ tower damage' },
    { id: 'demolition_crew', name: 'Demolition Crew', emoji: '🧨', description: 'Win after last-hitting 3+ towers' },
    { id: 'roshan_hunter', name: 'Roshan Hunter', emoji: '🪨', description: 'Last-hit Roshan in a game' },
    { id: 'visionary', name: 'Visionary', emoji: '👁️', description: 'Place 12+ observer/sentry wards' },
    { id: 'deward_specialist', name: 'Lights Out', emoji: '🌑', description: 'Destroy 4+ enemy wards' },
    { id: 'stack_master', name: 'Stack Master', emoji: '📚', description: 'Stack 5+ neutral camps' },
    { id: 'chain_controller', name: 'Chain Controller', emoji: '⛓️', description: 'Accumulate 50+ seconds of stuns' },
    { id: 'teamfight_fixture', name: 'Always There', emoji: '🫡', description: 'Reach 85%+ teamfight participation' },
    { id: 'comeback_king', name: 'Comeback King', emoji: '📈', description: 'Win after trailing by 10k+ gold' },

    // ── Miscellaneous match feats (parsed matches) ────────────────────────────
    { id: 'deny_this', name: 'Deny This', emoji: '🚫', description: 'Get 20+ denies' },
    { id: 'rune_collector', name: 'Rune Collector', emoji: '🔮', description: 'Pick up 10+ runes' },
    { id: 'button_masher', name: 'Button Masher', emoji: '🎮', description: 'Reach 300+ actions per minute' },
    { id: 'buyback_victory', name: 'Second Wind', emoji: '♻️', description: 'Buy back and go on to win' },
    { id: 'rapier_victory', name: 'High Stakes', emoji: '🗡️', description: 'Win after purchasing a Divine Rapier' },
    { id: 'heavy_hitter', name: 'Heavy Hitter', emoji: '💢', description: 'Deal 2500+ damage in a single hit' },

    // ── Game length (win) ─────────────────────────────────────────────────────
    { id: 'gg_ez', name: 'GG EZ', emoji: '😎', description: 'Win a game in under 13 minutes' },
    { id: 'blitzkrieg', name: 'Blitzkrieg', emoji: '🏎️', description: 'Win a game in under 16 minutes' },
    { id: 'endurance', name: 'Endurance', emoji: '⏳', description: 'Win a game over 38 minutes long' },
    { id: 'trench_warfare', name: 'Trench Warfare', emoji: '🕰️', description: 'Win a game over 48 minutes long' },

    // ── Party (win) ───────────────────────────────────────────────────────────
    { id: 'lone_wolf', name: 'Lone Wolf', emoji: '🐺', description: 'Win a solo-queue game' },
    { id: 'dynamic_duo', name: 'Dynamic Duo', emoji: '👯', description: 'Win a game in a party of 2' },
    { id: 'squad_goals', name: 'Squad Goals', emoji: '🖐️', description: 'Win a game in a 5-stack' },

    // ── Win streaks ───────────────────────────────────────────────────────────
    { id: 'on_fire', name: 'On Fire', emoji: '🔥', description: 'Win 3 tracked Turbo games in a row' },
    { id: 'blazing', name: 'Blazing', emoji: '♨️', description: 'Win 5 tracked Turbo games in a row' },
    { id: 'inferno_streak', name: 'Inferno Streak', emoji: '🌪️', description: 'Win 7 tracked Turbo games in a row' },
    { id: 'godlike_streak', name: 'Godlike Streak', emoji: '😈', description: 'Win 10 tracked Turbo games in a row' },
    { id: 'beyond_godlike', name: 'Unbreakable', emoji: '🛡️', description: 'Win 12 tracked Turbo games in a row' },
    { id: 'rampage_streak', name: 'Dynasty', emoji: '👑', description: 'Win 15 tracked Turbo games in a row' },

    // ── Hero pool (cumulative distinct heroes) ────────────────────────────────
    { id: 'dabbler', name: 'Dabbler', emoji: '🎭', description: 'Play 10 different heroes in tracked Turbo matches' },
    { id: 'hero_collector', name: 'Hero Collector', emoji: '📚', description: 'Play 25 different heroes in tracked Turbo matches' },
    { id: 'jack_of_all', name: 'Jack of All Trades', emoji: '🃏', description: 'Play 50 different heroes in tracked Turbo matches' },
    { id: 'the_completionist', name: 'The Completionist', emoji: '🏆', description: 'Play 100 different heroes in tracked Turbo matches' },

    // ── Hero mastery (tracked Turbo matches) ──────────────────────────────────
    { id: 'hero_regular', name: 'Comfort Pick', emoji: '🧸', description: 'Play 25 tracked Turbo games on one hero' },
    { id: 'hero_specialist', name: 'Hero Specialist', emoji: '🎯', description: 'Play 50 tracked Turbo games on one hero' },
    { id: 'hero_master', name: 'Hero Master', emoji: '🏅', description: 'Play 100 tracked Turbo games on one hero' },

    // ── Turbo grind ───────────────────────────────────────────────────────────
    { id: 'turbo_addict', name: 'Turbo Addict', emoji: '⚡', description: 'Play 50 turbo games' },
    { id: 'turbo_centurion', name: 'Turbo Centurion', emoji: '💠', description: 'Play 100 turbo games' },
    { id: 'turbo_lifer', name: 'Turbo Lifer', emoji: '🌀', description: 'Play 250 turbo games' },
    { id: 'turbo_maniac', name: 'Turbo Maniac', emoji: '🚀', description: 'Play 500 turbo games' },
    { id: 'turbo_legend', name: 'Turbo Legend', emoji: '🛸', description: 'Play 1000 turbo games' },

    // ── Turbo skill rating ────────────────────────────────────────────────────
    { id: 'climbing', name: 'Mountain Climber', emoji: '🏔️', description: 'Reach turbo score 40+' },
    { id: 'overlord', name: 'Overlord', emoji: '🌋', description: 'Reach turbo score 45+' },
    { id: 'apex_predator', name: 'Apex Predator', emoji: '👹', description: 'Reach turbo score 48+' },
    { id: 'turbo_titan', name: 'Turbo Titan', emoji: '🗿', description: 'Reach turbo score 50+' },
];

// ── Rarity (Dota-flavoured: Common → … → Arcana) ──────────────────────────────
export type Rarity = 'common' | 'uncommon' | 'rare' | 'mythical' | 'legendary' | 'immortal' | 'arcana';

export const RARITY_META: Record<Rarity, { label: string; emoji: string; order: number }> = {
    common:    { label: 'Common',    emoji: '⚪', order: 1 },
    uncommon:  { label: 'Uncommon',  emoji: '🟢', order: 2 },
    rare:      { label: 'Rare',      emoji: '🔵', order: 3 },
    mythical:  { label: 'Mythical',  emoji: '🟣', order: 4 },
    legendary: { label: 'Legendary', emoji: '🟡', order: 5 },
    immortal:  { label: 'Immortal',  emoji: '🟠', order: 6 },
    arcana:    { label: 'Arcana',    emoji: '🔴', order: 7 },
};

const RARITY_BY_ID: Record<string, Rarity> = {
    // common
    first_blood: 'common', carry_enjoyer: 'common', team_player: 'common', gold_digger: 'common',
    farmhand: 'common', fast_learner: 'common', damage_dealer: 'common', field_medic: 'common',
    lone_wolf: 'common', dynamic_duo: 'common', dabbler: 'common', turbo_addict: 'common',
    actual_first_blood: 'common', visionary: 'common',
    // uncommon
    century_club: 'uncommon', bloodthirsty: 'uncommon', support_god: 'uncommon', feeder_redeemed: 'uncommon',
    clean_sweep: 'uncommon', midas_touch: 'uncommon', last_hit_machine: 'uncommon', scholar: 'uncommon',
    nuker: 'uncommon', field_hospital: 'uncommon', endurance: 'rare', squad_goals: 'uncommon',
    on_fire: 'uncommon', hero_collector: 'uncommon', turbo_centurion: 'uncommon', climbing: 'uncommon',
    deny_this: 'uncommon', rune_collector: 'uncommon', buyback_victory: 'uncommon', hero_regular: 'uncommon',
    // rare
    marathoner: 'rare', massacre: 'rare', guardian_angel: 'rare', unkillable_feeder: 'rare',
    flawless_execution: 'rare', one_man_army: 'rare', pure_support: 'rare', greedy: 'rare',
    creep_god: 'rare', galaxy_brain: 'rare', devastation: 'rare', lifesaver: 'rare',
    blitzkrieg: 'rare', trench_warfare: 'legendary', blazing: 'rare', jack_of_all: 'rare',
    turbo_lifer: 'rare', overlord: 'rare',
    ultra_kill: 'rare', siege_engine: 'rare', demolition_crew: 'rare', roshan_hunter: 'rare',
    deward_specialist: 'rare', stack_master: 'rare', chain_controller: 'rare',
    teamfight_fixture: 'rare', button_masher: 'rare', hero_specialist: 'rare',
    // mythical
    veteran: 'mythical', thirty_bomb: 'arcana', assist_master: 'mythical', int_diff: 'mythical',
    untouchable: 'mythical', glass_cannon: 'mythical', triple_threat: 'mythical', economy_god: 'mythical',
    free_real_estate: 'mythical', gg_ez: 'mythical', inferno_streak: 'mythical', apex_predator: 'mythical',
    turbo_maniac: 'mythical',
    godlike_spree: 'mythical', comeback_king: 'mythical', heavy_hitter: 'mythical', hero_master: 'mythical',
    // legendary
    no_lifer: 'legendary', unstoppable: 'mythical', battle_medic: 'legendary', godlike_kda: 'legendary',
    raid_boss: 'legendary', money_printer: 'legendary', apocalypse: 'legendary', godlike_streak: 'legendary',
    the_completionist: 'legendary', turbo_legend: 'legendary', turbo_titan: 'legendary',
    rapier_victory: 'legendary',
    // immortal
    god_of_slaughter: 'legendary', hand_of_god: 'immortal', beyond_godlike: 'immortal',
    // arcana
    kill_legend: 'immortal', the_saint: 'arcana', rampage_streak: 'arcana', true_rampage: 'arcana',
};

export function rarityOf(id: string): Rarity {
    return RARITY_BY_ID[id] ?? 'common';
}

interface AchievementStore {
    unlocked: UnlockedAchievement[];
}

export interface MatchContext {
    kills?: number;
    deaths?: number;
    assists?: number;
    won?: boolean;
    matchId?: number;
    isRadiant?: boolean;
    gameMode?: number;
    totalMatches?: number;
    turboRating?: number;
    turboGames?: number;
    winStreak?: number;
    // per-match performance (OpenDota recentMatches)
    gpm?: number;
    xpm?: number;
    heroDamage?: number;
    heroHealing?: number;
    lastHits?: number;
    durationMin?: number;
    partySize?: number | null;
    firstBloodClaimed?: boolean;
    maxMultiKill?: number;
    maxKillStreak?: number;
    denies?: number;
    towerDamage?: number;
    towerKills?: number;
    roshanKills?: number;
    wardsPlaced?: number;
    wardsDestroyed?: number;
    campsStacked?: number;
    stunDuration?: number;
    teamfightParticipation?: number;
    comebackDeficit?: number;
    runePickups?: number;
    actionsPerMinute?: number;
    buybacks?: number;
    boughtDivineRapier?: boolean;
    maxHeroHit?: number;
    // cumulative
    heroPoolSize?: number;
    heroGames?: number;
}

class AchievementService {
    private readonly achievementFile = 'achievements.json';
    private store: Map<string, Set<string>> = new Map(); // discordId → Set<achievementId>
    private allUnlocked: UnlockedAchievement[] = [];

    constructor() {
        this.load();
    }

    private load() {
        try {
            if (fs.existsSync(this.achievementFile)) {
                const data: AchievementStore = JSON.parse(fs.readFileSync(this.achievementFile, 'utf8'));
                this.allUnlocked = data.unlocked || [];
                for (const unlock of this.allUnlocked) {
                    if (!this.store.has(unlock.discordId)) this.store.set(unlock.discordId, new Set());
                    this.store.get(unlock.discordId)!.add(unlock.achievementId);
                }
                logger.info(`Achievements loaded: ${this.allUnlocked.length} total unlocks`);
            }
        } catch (error) {
            logger.error('Error loading achievements:', error);
        }
    }

    private save() {
        try {
            fs.writeFileSync(this.achievementFile, JSON.stringify({ unlocked: this.allUnlocked }, null, 2));
        } catch (error) {
            logger.error('Error saving achievements:', error);
        }
    }

    private hasUnlocked(discordId: string, achievementId: string): boolean {
        return this.store.get(discordId)?.has(achievementId) ?? false;
    }

    private unlock(discordId: string, achievementId: string, ctx: MatchContext): AchievementDefinition | null {
        if (this.hasUnlocked(discordId, achievementId)) return null;

        const def = ACHIEVEMENTS.find(a => a.id === achievementId);
        if (!def) return null;

        if (!this.store.has(discordId)) this.store.set(discordId, new Set());
        this.store.get(discordId)!.add(achievementId);

        this.allUnlocked.push({
            discordId,
            achievementId,
            unlockedAt: Date.now(),
            matchId: ctx.matchId,
            rulesVersion: ACHIEVEMENT_RULES_VERSION,
            requirementAtUnlock: def.description,
        });

        this.save();
        logger.info(`Achievement unlocked: ${discordId} earned "${def.name}"`);
        return def;
    }

    checkAchievements(discordId: string, ctx: MatchContext): AchievementDefinition[] {
        const newlyUnlocked: AchievementDefinition[] = [];
        if (ctx.gameMode !== 23) return newlyUnlocked;

        const tryUnlock = (id: string) => {
            const result = this.unlock(discordId, id, ctx);
            if (result) newlyUnlocked.push(result);
        };

        const K = ctx.kills || 0, D = ctx.deaths || 0, A = ctx.assists || 0;
        const won = !!ctx.won;

        // Match count
        if (ctx.totalMatches !== undefined) {
            if (ctx.totalMatches >= 1) tryUnlock('first_blood');
            if (ctx.totalMatches >= 100) tryUnlock('century_club');
            if (ctx.totalMatches >= 250) tryUnlock('marathoner');
            if (ctx.totalMatches >= 500) tryUnlock('veteran');
            if (ctx.totalMatches >= 1000) tryUnlock('no_lifer');
        }

        // Kills (win)
        if (won && K >= 10) tryUnlock('carry_enjoyer');
        if (won && K >= 13) tryUnlock('bloodthirsty');
        if (won && K >= 16) tryUnlock('massacre');
        if (won && K >= 30) tryUnlock('thirty_bomb');
        if (won && K >= 19) tryUnlock('unstoppable');
        if (won && K >= 22) tryUnlock('god_of_slaughter');
        if (won && K >= 25) tryUnlock('kill_legend');

        // Assists (win)
        if (won && A >= 14) tryUnlock('team_player');
        if (won && A >= 18) tryUnlock('support_god');
        if (won && A >= 22) tryUnlock('guardian_angel');
        if (won && A >= 26) tryUnlock('assist_master');
        if (won && A >= 30) tryUnlock('battle_medic');
        if (won && A >= 34) tryUnlock('hand_of_god');
        if (won && A >= 40) tryUnlock('the_saint');

        // Deaths (win)
        if (won && D >= 9) tryUnlock('feeder_redeemed');
        if (won && D >= 13) tryUnlock('unkillable_feeder');
        if (won && D >= 16) tryUnlock('int_diff');

        // KDA combos (win)
        if (won && D === 0) tryUnlock('clean_sweep');
        if (won && D === 0 && K >= 10) tryUnlock('flawless_execution');
        if (won && D === 0 && K >= 15) tryUnlock('untouchable');
        if (won && D === 0 && K >= 20) tryUnlock('godlike_kda');
        if (won && K >= 20 && A <= 5) tryUnlock('one_man_army');
        if (won && A >= 25 && K <= 3) tryUnlock('pure_support');
        if (won && K >= 20 && D >= 15) tryUnlock('glass_cannon');
        if (won && K >= 10 && A >= 10 && D === 0) tryUnlock('triple_threat');
        if (won && K >= 20 && A >= 20) tryUnlock('raid_boss');

        // Farm / economy (any game)
        if (ctx.gpm !== undefined) {
            if (ctx.gpm >= 1100) tryUnlock('gold_digger');
            if (ctx.gpm >= 1350) tryUnlock('midas_touch');
            if (ctx.gpm >= 1550) tryUnlock('greedy');
            if (ctx.gpm >= 1750) tryUnlock('economy_god');
            if (ctx.gpm >= 1950) tryUnlock('money_printer');
        }
        if (ctx.lastHits !== undefined) {
            if (ctx.lastHits >= 150) tryUnlock('farmhand');
            if (ctx.lastHits >= 230) tryUnlock('last_hit_machine');
            if (ctx.lastHits >= 320) tryUnlock('creep_god');
            if (ctx.lastHits >= 420) tryUnlock('free_real_estate');
        }
        if (ctx.xpm !== undefined) {
            if (ctx.xpm >= 1900) tryUnlock('fast_learner');
            if (ctx.xpm >= 2300) tryUnlock('scholar');
            if (ctx.xpm >= 2700) tryUnlock('galaxy_brain');
        }

        // Damage & healing (any game)
        if (ctx.heroDamage !== undefined) {
            if (ctx.heroDamage >= 30000) tryUnlock('damage_dealer');
            if (ctx.heroDamage >= 55000) tryUnlock('nuker');
            if (ctx.heroDamage >= 78000) tryUnlock('devastation');
            if (ctx.heroDamage >= 100000) tryUnlock('apocalypse');
        }
        if (ctx.heroHealing !== undefined) {
            if (ctx.heroHealing >= 5000) tryUnlock('field_medic');
            if (ctx.heroHealing >= 12000) tryUnlock('field_hospital');
            if (ctx.heroHealing >= 20000) tryUnlock('lifesaver');
        }

        // Parsed combat events
        if (ctx.firstBloodClaimed) tryUnlock('actual_first_blood');
        if ((ctx.maxMultiKill ?? 0) >= 4) tryUnlock('ultra_kill');
        if ((ctx.maxMultiKill ?? 0) >= 5) tryUnlock('true_rampage');
        if ((ctx.maxKillStreak ?? 0) >= 10) tryUnlock('godlike_spree');

        // Objectives and team contribution
        if (won && (ctx.towerDamage ?? 0) >= 10000) tryUnlock('siege_engine');
        if (won && (ctx.towerKills ?? 0) >= 3) tryUnlock('demolition_crew');
        if ((ctx.roshanKills ?? 0) >= 1) tryUnlock('roshan_hunter');
        if ((ctx.wardsPlaced ?? 0) >= 12) tryUnlock('visionary');
        if ((ctx.wardsDestroyed ?? 0) >= 4) tryUnlock('deward_specialist');
        if ((ctx.campsStacked ?? 0) >= 5) tryUnlock('stack_master');
        if ((ctx.stunDuration ?? 0) >= 50) tryUnlock('chain_controller');
        if ((ctx.teamfightParticipation ?? 0) >= 0.85) tryUnlock('teamfight_fixture');
        if (won && (ctx.comebackDeficit ?? 0) >= 10000) tryUnlock('comeback_king');

        // Miscellaneous match feats
        if ((ctx.denies ?? 0) >= 20) tryUnlock('deny_this');
        if ((ctx.runePickups ?? 0) >= 10) tryUnlock('rune_collector');
        if ((ctx.actionsPerMinute ?? 0) >= 300) tryUnlock('button_masher');
        if (won && (ctx.buybacks ?? 0) >= 1) tryUnlock('buyback_victory');
        if (won && ctx.boughtDivineRapier) tryUnlock('rapier_victory');
        if ((ctx.maxHeroHit ?? 0) >= 2500) tryUnlock('heavy_hitter');

        // Game length (win)
        if (won && ctx.durationMin !== undefined && ctx.durationMin > 0) {
            if (ctx.durationMin < 13) tryUnlock('gg_ez');
            if (ctx.durationMin < 16) tryUnlock('blitzkrieg');
            if (ctx.durationMin >= 38) tryUnlock('endurance');
            if (ctx.durationMin >= 48) tryUnlock('trench_warfare');
        }

        // Party (win)
        if (won && ctx.partySize != null) {
            if (ctx.partySize === 1) tryUnlock('lone_wolf');
            if (ctx.partySize === 2) tryUnlock('dynamic_duo');
            if (ctx.partySize >= 5) tryUnlock('squad_goals');
        }

        // Win streaks
        if (ctx.winStreak !== undefined) {
            if (ctx.winStreak >= 3) tryUnlock('on_fire');
            if (ctx.winStreak >= 5) tryUnlock('blazing');
            if (ctx.winStreak >= 7) tryUnlock('inferno_streak');
            if (ctx.winStreak >= 10) tryUnlock('godlike_streak');
            if (ctx.winStreak >= 12) tryUnlock('beyond_godlike');
            if (ctx.winStreak >= 15) tryUnlock('rampage_streak');
        }

        // Hero pool (cumulative)
        if (ctx.heroPoolSize !== undefined) {
            if (ctx.heroPoolSize >= 10) tryUnlock('dabbler');
            if (ctx.heroPoolSize >= 25) tryUnlock('hero_collector');
            if (ctx.heroPoolSize >= 50) tryUnlock('jack_of_all');
            if (ctx.heroPoolSize >= 100) tryUnlock('the_completionist');
        }

        if (ctx.heroGames !== undefined) {
            if (ctx.heroGames >= 25) tryUnlock('hero_regular');
            if (ctx.heroGames >= 50) tryUnlock('hero_specialist');
            if (ctx.heroGames >= 100) tryUnlock('hero_master');
        }

        // Turbo grind
        if (ctx.turboGames !== undefined) {
            if (ctx.turboGames >= 50) tryUnlock('turbo_addict');
            if (ctx.turboGames >= 100) tryUnlock('turbo_centurion');
            if (ctx.turboGames >= 250) tryUnlock('turbo_lifer');
            if (ctx.turboGames >= 500) tryUnlock('turbo_maniac');
            if (ctx.turboGames >= 1000) tryUnlock('turbo_legend');
        }

        // Turbo skill rating
        if (ctx.turboRating !== undefined) {
            if (ctx.turboRating >= 40) tryUnlock('climbing');
            if (ctx.turboRating >= 45) tryUnlock('overlord');
            if (ctx.turboRating >= 48) tryUnlock('apex_predator');
            if (ctx.turboRating >= 50) tryUnlock('turbo_titan');
        }

        return newlyUnlocked;
    }

    getUnlockedAchievements(discordId: string): { def: AchievementDefinition; unlock: UnlockedAchievement }[] {
        const ids = this.store.get(discordId) ?? new Set<string>();
        return [...ids].map(id => {
            const def = ACHIEVEMENTS.find(a => a.id === id)!;
            const unlock = this.allUnlocked.find(u => u.discordId === discordId && u.achievementId === id)!;
            return { def, unlock };
        }).filter(x => x.def && x.unlock);
    }

    formatAnnouncement(achievements: AchievementDefinition[], discordId: string, username: string): string {
        const mention = `<@${discordId}>`;
        const subject = `${mention} (${username})`;
        // Show the rarest first so the cool unlocks lead.
        const sorted = [...achievements].sort(
            (a, b) => RARITY_META[rarityOf(b.id)].order - RARITY_META[rarityOf(a.id)].order,
        );

        if (sorted.length === 1) {
            const ach = sorted[0];
            const rm = RARITY_META[rarityOf(ach.id)];
            return `🎉 **${rm.emoji} ${rm.label} Achievement Unlocked!**\n${subject} earned ${ach.emoji} **${ach.name}** — *${ach.description}*`;
        }

        const MAX_SHOWN = 12;
        const shown = sorted.slice(0, MAX_SHOWN);
        const lines = shown
            .map((ach) => `${RARITY_META[rarityOf(ach.id)].emoji} ${ach.emoji} **${ach.name}** — *${ach.description}*`)
            .join('\n');
        const more = sorted.length > MAX_SHOWN
            ? `\n…and **${sorted.length - MAX_SHOWN}** more.`
            : '';
        const top = RARITY_META[rarityOf(sorted[0].id)];
        return `🎉 **Achievements Unlocked!** _(rarest: ${top.emoji} ${top.label})_\n${subject} earned **${sorted.length}**:\n${lines}${more}`;
    }

    async announceNewAchievements(achievements: AchievementDefinition[], discordId: string, username: string, channel: TextChannel) {
        if (achievements.length === 0) return;
        await channel.send(this.formatAnnouncement(achievements, discordId, username));
    }
}

export const achievementService = new AchievementService();
