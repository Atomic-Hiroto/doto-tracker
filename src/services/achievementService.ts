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
}

export const ACHIEVEMENTS: AchievementDefinition[] = [
    // ── Onboarding & match count ──────────────────────────────────────────────
    { id: 'first_blood', name: 'First Steps', emoji: '🎮', description: 'Play your first tracked match' },
    { id: 'century_club', name: 'Century Club', emoji: '💯', description: 'Play 100 tracked matches' },
    { id: 'marathoner', name: 'Marathoner', emoji: '🏃', description: 'Play 250 tracked matches' },
    { id: 'veteran', name: 'Veteran', emoji: '🎖️', description: 'Play 500 tracked matches' },
    { id: 'no_lifer', name: 'No Lifer', emoji: '🛌', description: 'Play 1000 tracked matches' },

    // ── Kills (win) ───────────────────────────────────────────────────────────
    { id: 'carry_enjoyer', name: 'Carry Enjoyer', emoji: '👑', description: 'Win with 15+ kills in one game' },
    { id: 'bloodthirsty', name: 'Bloodthirsty', emoji: '🗡️', description: 'Win with 20+ kills in one game' },
    { id: 'massacre', name: 'Massacre', emoji: '🩸', description: 'Win with 25+ kills in one game' },
    { id: 'thirty_bomb', name: 'Thirty Bomb', emoji: '💣', description: 'Win with 30+ kills in one game' },
    { id: 'unstoppable', name: 'Unstoppable', emoji: '⚔️', description: 'Win with 35+ kills in one game' },
    { id: 'god_of_slaughter', name: 'God of Slaughter', emoji: '💀', description: 'Win with 40+ kills in one game' },
    { id: 'kill_legend', name: 'Living Legend', emoji: '☠️', description: 'Win with 50+ kills in one game' },

    // ── Assists (win) ─────────────────────────────────────────────────────────
    { id: 'team_player', name: 'Team Player', emoji: '🤝', description: 'Win with 15+ assists in one game' },
    { id: 'support_god', name: 'Support God', emoji: '💚', description: 'Win a game with 20+ assists' },
    { id: 'guardian_angel', name: 'Guardian Angel', emoji: '😇', description: 'Win with 25+ assists in one game' },
    { id: 'assist_master', name: 'Assist Master', emoji: '🎗️', description: 'Win with 30+ assists in one game' },
    { id: 'battle_medic', name: 'Battle Medic', emoji: '🚑', description: 'Win a game with 35+ assists' },
    { id: 'hand_of_god', name: 'Hand of God', emoji: '✋', description: 'Win with 40+ assists in one game' },
    { id: 'the_saint', name: 'The Saint', emoji: '🕊️', description: 'Win with 50+ assists in one game' },

    // ── Deaths while still winning ────────────────────────────────────────────
    { id: 'feeder_redeemed', name: 'Feeder Redeemed', emoji: '🔄', description: 'Win a game with 10+ deaths' },
    { id: 'unkillable_feeder', name: 'Unkillable Feeder', emoji: '🧟', description: 'Win a game with 15+ deaths' },
    { id: 'int_diff', name: 'Int Diff', emoji: '🤡', description: 'Win a game despite 20+ deaths' },

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
    { id: 'gold_digger', name: 'Gold Digger', emoji: '💰', description: 'Hit 600+ GPM in a game' },
    { id: 'midas_touch', name: 'Midas Touch', emoji: '🤑', description: 'Hit 800+ GPM in a game' },
    { id: 'greedy', name: 'Greedy', emoji: '🪙', description: 'Hit 1000+ GPM in a game' },
    { id: 'economy_god', name: 'Economy God', emoji: '🏦', description: 'Hit 1200+ GPM in a game' },
    { id: 'money_printer', name: 'Money Printer', emoji: '🖨️', description: 'Hit 1400+ GPM in a game' },
    { id: 'farmhand', name: 'Farmhand', emoji: '🌾', description: 'Get 250+ last hits in a game' },
    { id: 'last_hit_machine', name: 'Last-Hit Machine', emoji: '🚜', description: 'Get 400+ last hits in a game' },
    { id: 'creep_god', name: 'Creep God', emoji: '🌽', description: 'Get 600+ last hits in a game' },
    { id: 'free_real_estate', name: 'Free Real Estate', emoji: '🏡', description: 'Get 800+ last hits in a game' },

    // ── Experience ────────────────────────────────────────────────────────────
    { id: 'fast_learner', name: 'Fast Learner', emoji: '📗', description: 'Hit 700+ XPM in a game' },
    { id: 'scholar', name: 'Scholar', emoji: '🎓', description: 'Hit 900+ XPM in a game' },
    { id: 'galaxy_brain', name: 'Galaxy Brain', emoji: '🧠', description: 'Hit 1100+ XPM in a game' },

    // ── Damage & healing ──────────────────────────────────────────────────────
    { id: 'damage_dealer', name: 'Damage Dealer', emoji: '💥', description: 'Deal 40k+ hero damage in a game' },
    { id: 'nuker', name: 'Nuker', emoji: '☢️', description: 'Deal 60k+ hero damage in a game' },
    { id: 'devastation', name: 'Devastation', emoji: '🌶️', description: 'Deal 80k+ hero damage in a game' },
    { id: 'apocalypse', name: 'Apocalypse', emoji: '🔆', description: 'Deal 100k+ hero damage in a game' },
    { id: 'field_medic', name: 'Field Medic', emoji: '➕', description: 'Heal 5k+ in a game' },
    { id: 'field_hospital', name: 'Field Hospital', emoji: '🏥', description: 'Heal 12k+ in a game' },
    { id: 'lifesaver', name: 'Lifesaver', emoji: '💗', description: 'Heal 20k+ in a game' },

    // ── Game length (win) ─────────────────────────────────────────────────────
    { id: 'gg_ez', name: 'GG EZ', emoji: '😎', description: 'Win a game in under 12 minutes' },
    { id: 'blitzkrieg', name: 'Blitzkrieg', emoji: '🏎️', description: 'Win a game in under 15 minutes' },
    { id: 'endurance', name: 'Endurance', emoji: '⏳', description: 'Win a game over 45 minutes long' },
    { id: 'trench_warfare', name: 'Trench Warfare', emoji: '🕰️', description: 'Win a game over 60 minutes long' },

    // ── Party (win) ───────────────────────────────────────────────────────────
    { id: 'lone_wolf', name: 'Lone Wolf', emoji: '🐺', description: 'Win a solo-queue game' },
    { id: 'dynamic_duo', name: 'Dynamic Duo', emoji: '👯', description: 'Win a game in a party of 2' },
    { id: 'squad_goals', name: 'Squad Goals', emoji: '🖐️', description: 'Win a game in a 5-stack' },

    // ── Win streaks ───────────────────────────────────────────────────────────
    { id: 'on_fire', name: 'On Fire', emoji: '🔥', description: 'Win 5 games in a row' },
    { id: 'blazing', name: 'Blazing', emoji: '♨️', description: 'Win 7 games in a row' },
    { id: 'inferno_streak', name: 'Inferno Streak', emoji: '🌪️', description: 'Win 10 games in a row' },
    { id: 'godlike_streak', name: 'Godlike Streak', emoji: '😈', description: 'Win 15 games in a row' },
    { id: 'beyond_godlike', name: 'Beyond Godlike', emoji: '👿', description: 'Win 20 games in a row' },
    { id: 'rampage_streak', name: 'Rampage', emoji: '🐲', description: 'Win 25 games in a row' },

    // ── Hero pool (cumulative distinct heroes) ────────────────────────────────
    { id: 'dabbler', name: 'Dabbler', emoji: '🎭', description: 'Play 10 different heroes' },
    { id: 'hero_collector', name: 'Hero Collector', emoji: '📚', description: 'Play 25 different heroes' },
    { id: 'jack_of_all', name: 'Jack of All Trades', emoji: '🃏', description: 'Play 50 different heroes' },
    { id: 'the_completionist', name: 'The Completionist', emoji: '🏆', description: 'Play 100 different heroes' },

    // ── Turbo grind ───────────────────────────────────────────────────────────
    { id: 'turbo_addict', name: 'Turbo Addict', emoji: '⚡', description: 'Play 50 turbo games' },
    { id: 'turbo_centurion', name: 'Turbo Centurion', emoji: '💠', description: 'Play 100 turbo games' },
    { id: 'turbo_lifer', name: 'Turbo Lifer', emoji: '🌀', description: 'Play 250 turbo games' },
    { id: 'turbo_maniac', name: 'Turbo Maniac', emoji: '🚀', description: 'Play 500 turbo games' },
    { id: 'turbo_legend', name: 'Turbo Legend', emoji: '🛸', description: 'Play 1000 turbo games' },

    // ── Turbo skill rating ────────────────────────────────────────────────────
    { id: 'climbing', name: 'Mountain Climber', emoji: '🏔️', description: 'Reach turbo score 40+' },
    { id: 'overlord', name: 'Overlord', emoji: '🌋', description: 'Reach turbo score 55+' },
    { id: 'apex_predator', name: 'Apex Predator', emoji: '👹', description: 'Reach turbo score 65+' },
    { id: 'turbo_titan', name: 'Turbo Titan', emoji: '🗿', description: 'Reach turbo score 72+' },
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
    // uncommon
    century_club: 'uncommon', bloodthirsty: 'uncommon', support_god: 'uncommon', feeder_redeemed: 'uncommon',
    clean_sweep: 'uncommon', midas_touch: 'uncommon', last_hit_machine: 'uncommon', scholar: 'uncommon',
    nuker: 'uncommon', field_hospital: 'uncommon', endurance: 'uncommon', squad_goals: 'uncommon',
    on_fire: 'uncommon', hero_collector: 'uncommon', turbo_centurion: 'uncommon', climbing: 'uncommon',
    // rare
    marathoner: 'rare', massacre: 'rare', guardian_angel: 'rare', unkillable_feeder: 'rare',
    flawless_execution: 'rare', one_man_army: 'rare', pure_support: 'rare', greedy: 'rare',
    creep_god: 'rare', galaxy_brain: 'rare', devastation: 'rare', lifesaver: 'rare',
    blitzkrieg: 'rare', trench_warfare: 'rare', blazing: 'rare', jack_of_all: 'rare',
    turbo_lifer: 'rare', overlord: 'rare',
    // mythical
    veteran: 'mythical', thirty_bomb: 'mythical', assist_master: 'mythical', int_diff: 'mythical',
    untouchable: 'mythical', glass_cannon: 'mythical', triple_threat: 'mythical', economy_god: 'mythical',
    free_real_estate: 'mythical', gg_ez: 'mythical', inferno_streak: 'mythical', apex_predator: 'mythical',
    turbo_maniac: 'mythical',
    // legendary
    no_lifer: 'legendary', unstoppable: 'legendary', battle_medic: 'legendary', godlike_kda: 'legendary',
    raid_boss: 'legendary', money_printer: 'legendary', apocalypse: 'legendary', godlike_streak: 'legendary',
    the_completionist: 'legendary', turbo_legend: 'legendary', turbo_titan: 'legendary',
    // immortal
    god_of_slaughter: 'immortal', hand_of_god: 'immortal', beyond_godlike: 'immortal',
    // arcana
    kill_legend: 'arcana', the_saint: 'arcana', rampage_streak: 'arcana',
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
    // cumulative
    heroPoolSize?: number;
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

    private unlock(discordId: string, achievementId: string, matchId?: number): AchievementDefinition | null {
        if (this.hasUnlocked(discordId, achievementId)) return null;

        const def = ACHIEVEMENTS.find(a => a.id === achievementId);
        if (!def) return null;

        if (!this.store.has(discordId)) this.store.set(discordId, new Set());
        this.store.get(discordId)!.add(achievementId);

        this.allUnlocked.push({
            discordId,
            achievementId,
            unlockedAt: Date.now(),
            matchId,
        });

        this.save();
        logger.info(`Achievement unlocked: ${discordId} earned "${def.name}"`);
        return def;
    }

    checkAchievements(discordId: string, ctx: MatchContext): AchievementDefinition[] {
        const newlyUnlocked: AchievementDefinition[] = [];
        const tryUnlock = (id: string) => {
            const result = this.unlock(discordId, id, ctx.matchId);
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
        if (won && K >= 15) tryUnlock('carry_enjoyer');
        if (won && K >= 20) tryUnlock('bloodthirsty');
        if (won && K >= 25) tryUnlock('massacre');
        if (won && K >= 30) tryUnlock('thirty_bomb');
        if (won && K >= 35) tryUnlock('unstoppable');
        if (won && K >= 40) tryUnlock('god_of_slaughter');
        if (won && K >= 50) tryUnlock('kill_legend');

        // Assists (win)
        if (won && A >= 15) tryUnlock('team_player');
        if (won && A >= 20) tryUnlock('support_god');
        if (won && A >= 25) tryUnlock('guardian_angel');
        if (won && A >= 30) tryUnlock('assist_master');
        if (won && A >= 35) tryUnlock('battle_medic');
        if (won && A >= 40) tryUnlock('hand_of_god');
        if (won && A >= 50) tryUnlock('the_saint');

        // Deaths (win)
        if (won && D >= 10) tryUnlock('feeder_redeemed');
        if (won && D >= 15) tryUnlock('unkillable_feeder');
        if (won && D >= 20) tryUnlock('int_diff');

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
            if (ctx.gpm >= 600) tryUnlock('gold_digger');
            if (ctx.gpm >= 800) tryUnlock('midas_touch');
            if (ctx.gpm >= 1000) tryUnlock('greedy');
            if (ctx.gpm >= 1200) tryUnlock('economy_god');
            if (ctx.gpm >= 1400) tryUnlock('money_printer');
        }
        if (ctx.lastHits !== undefined) {
            if (ctx.lastHits >= 250) tryUnlock('farmhand');
            if (ctx.lastHits >= 400) tryUnlock('last_hit_machine');
            if (ctx.lastHits >= 600) tryUnlock('creep_god');
            if (ctx.lastHits >= 800) tryUnlock('free_real_estate');
        }
        if (ctx.xpm !== undefined) {
            if (ctx.xpm >= 700) tryUnlock('fast_learner');
            if (ctx.xpm >= 900) tryUnlock('scholar');
            if (ctx.xpm >= 1100) tryUnlock('galaxy_brain');
        }

        // Damage & healing (any game)
        if (ctx.heroDamage !== undefined) {
            if (ctx.heroDamage >= 40000) tryUnlock('damage_dealer');
            if (ctx.heroDamage >= 60000) tryUnlock('nuker');
            if (ctx.heroDamage >= 80000) tryUnlock('devastation');
            if (ctx.heroDamage >= 100000) tryUnlock('apocalypse');
        }
        if (ctx.heroHealing !== undefined) {
            if (ctx.heroHealing >= 5000) tryUnlock('field_medic');
            if (ctx.heroHealing >= 12000) tryUnlock('field_hospital');
            if (ctx.heroHealing >= 20000) tryUnlock('lifesaver');
        }

        // Game length (win)
        if (won && ctx.durationMin !== undefined && ctx.durationMin > 0) {
            if (ctx.durationMin < 12) tryUnlock('gg_ez');
            if (ctx.durationMin < 15) tryUnlock('blitzkrieg');
            if (ctx.durationMin >= 45) tryUnlock('endurance');
            if (ctx.durationMin >= 60) tryUnlock('trench_warfare');
        }

        // Party (win)
        if (won && ctx.partySize != null) {
            if (ctx.partySize === 1) tryUnlock('lone_wolf');
            if (ctx.partySize === 2) tryUnlock('dynamic_duo');
            if (ctx.partySize >= 5) tryUnlock('squad_goals');
        }

        // Win streaks
        if (ctx.winStreak !== undefined) {
            if (ctx.winStreak >= 5) tryUnlock('on_fire');
            if (ctx.winStreak >= 7) tryUnlock('blazing');
            if (ctx.winStreak >= 10) tryUnlock('inferno_streak');
            if (ctx.winStreak >= 15) tryUnlock('godlike_streak');
            if (ctx.winStreak >= 20) tryUnlock('beyond_godlike');
            if (ctx.winStreak >= 25) tryUnlock('rampage_streak');
        }

        // Hero pool (cumulative)
        if (ctx.heroPoolSize !== undefined) {
            if (ctx.heroPoolSize >= 10) tryUnlock('dabbler');
            if (ctx.heroPoolSize >= 25) tryUnlock('hero_collector');
            if (ctx.heroPoolSize >= 50) tryUnlock('jack_of_all');
            if (ctx.heroPoolSize >= 100) tryUnlock('the_completionist');
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
            if (ctx.turboRating >= 55) tryUnlock('overlord');
            if (ctx.turboRating >= 65) tryUnlock('apex_predator');
            if (ctx.turboRating >= 72) tryUnlock('turbo_titan');
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
