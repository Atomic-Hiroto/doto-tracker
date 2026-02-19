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
    { id: 'century_club', name: 'Century Club', emoji: '💯', description: 'Play 100 tracked matches' },
    { id: 'on_fire', name: 'On Fire', emoji: '🔥', description: 'Win 5 games in a row' },
    { id: 'feeder_redeemed', name: 'Feeder Redeemed', emoji: '🔄', description: 'Win a game with 10+ deaths' },
    { id: 'turbo_addict', name: 'Turbo Addict', emoji: '⚡', description: 'Play 50 turbo games' },
    { id: 'clean_sweep', name: 'Clean Sweep', emoji: '🧹', description: 'Win a game with 0 deaths' },
    { id: 'carry_enjoyer', name: 'Carry Enjoyer', emoji: '👑', description: 'Win with 15+ kills in one game' },
    { id: 'support_god', name: 'Support God', emoji: '💚', description: 'Win a game with 20+ assists' },
    { id: 'climbing', name: 'Mountain Climber', emoji: '🏔️', description: 'Reach turbo rating 50+' },
    { id: 'overlord', name: 'Overlord', emoji: '🌋', description: 'Reach turbo rating 100+' },
    { id: 'first_blood', name: 'First Steps', emoji: '🎮', description: 'Play your first tracked match' },
];

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

        if (ctx.totalMatches !== undefined) {
            if (ctx.totalMatches >= 1) tryUnlock('first_blood');
            if (ctx.totalMatches >= 100) tryUnlock('century_club');
        }

        if (ctx.won && ctx.deaths === 0) tryUnlock('clean_sweep');
        if (ctx.won && (ctx.deaths || 0) >= 10) tryUnlock('feeder_redeemed');
        if (ctx.won && (ctx.kills || 0) >= 15) tryUnlock('carry_enjoyer');
        if (ctx.won && (ctx.assists || 0) >= 20) tryUnlock('support_god');

        if (ctx.turboRating !== undefined) {
            if (ctx.turboRating >= 50) tryUnlock('climbing');
            if (ctx.turboRating >= 100) tryUnlock('overlord');
        }

        if (ctx.turboGames !== undefined && ctx.turboGames >= 50) {
            tryUnlock('turbo_addict');
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

    async announceNewAchievements(achievements: AchievementDefinition[], username: string, channel: TextChannel) {
        for (const ach of achievements) {
            await channel.send(
                `🎉 **Achievement Unlocked!** ${ach.emoji}\n**${username}** earned **${ach.name}** — *${ach.description}*`
            );
        }
    }
}

export const achievementService = new AchievementService();
