import fs from 'fs';
import { UserData } from '../models/UserData';
import { logger } from './loggerService';

export interface StreakEvent {
    discordId: string;
    type: 'win' | 'loss';
    count: number;
}

// Milestones worth announcing
const NOTABLE_STREAK_COUNTS = [3, 5, 7, 10, 15, 20];

class StreakService {
    private readonly streakFile = 'streakData.json';
    private streakData: Map<string, { current: number; longestWin: number; longestLoss: number }> = new Map();

    constructor() {
        this.loadStreakData();
    }

    private loadStreakData() {
        try {
            if (fs.existsSync(this.streakFile)) {
                const raw = JSON.parse(fs.readFileSync(this.streakFile, 'utf8'));
                for (const [id, data] of Object.entries(raw)) {
                    this.streakData.set(id, data as any);
                }
                logger.info(`Streak data loaded for ${this.streakData.size} players`);
            }
        } catch (error) {
            logger.error('Error loading streak data:', error);
        }
    }

    private saveStreakData() {
        try {
            const obj: Record<string, any> = {};
            this.streakData.forEach((v, k) => { obj[k] = v; });
            fs.writeFileSync(this.streakFile, JSON.stringify(obj, null, 2));
        } catch (error) {
            logger.error('Error saving streak data:', error);
        }
    }

    // Returns a StreakEvent when a notable milestone is hit, otherwise null
    updateStreak(discordId: string, won: boolean): StreakEvent | null {
        if (!this.streakData.has(discordId)) {
            this.streakData.set(discordId, { current: 0, longestWin: 0, longestLoss: 0 });
        }

        const data = this.streakData.get(discordId)!;

        if (won) {
            // If currently on a loss streak, reset to 1 win
            data.current = data.current < 0 ? 1 : data.current + 1;
            if (data.current > data.longestWin) data.longestWin = data.current;
        } else {
            // If currently on a win streak, reset to -1 loss
            data.current = data.current > 0 ? -1 : data.current - 1;
            const lossCount = Math.abs(data.current);
            if (lossCount > data.longestLoss) data.longestLoss = lossCount;
        }

        this.saveStreakData();

        const count = Math.abs(data.current);
        const type = data.current > 0 ? 'win' : 'loss';

        if (NOTABLE_STREAK_COUNTS.includes(count)) {
            return { discordId, type, count };
        }

        return null;
    }

    getStreakInfo(discordId: string): { current: number; longestWin: number; longestLoss: number } | null {
        return this.streakData.get(discordId) ?? null;
    }

    getStreakAnnouncement(event: StreakEvent, username: string): string {
        if (event.type === 'win') {
            const messages: Record<number, string> = {
                3: `🔥 **${username}** is on a **${event.count} win streak!** They're heating up!`,
                5: `🔥🔥 **${username}** is on a **${event.count} win streak!!** They're ON FIRE!`,
                7: `⚡ **${username}** — **${event.count} W STREAK!!** Someone call the fire department!!`,
                10: `🏆 **${username}** — **${event.count} WIN STREAK!!!** CERTIFIED POPPING OFF!!!`,
                15: `👑 **${username}** — **${event.count} WIN STREAK!!!!** THIS IS INSANE, ARREST THIS MAN`,
                20: `🌋 **${username}** — **${event.count} WIN STREAK!!!!!** THE CHOSEN ONE HAS ARRIVED`,
            };
            return messages[event.count] ?? `🔥 **${username}** is dominating with a ${event.count} game win streak!`;
        } else {
            const messages: Record<number, string> = {
                3: `💀 **${username}** is on a **${event.count} loss streak...** it do be like that sometimes`,
                5: `💀💀 **${username}** — **${event.count} LOSSES IN A ROW** lmaooo get diff'd`,
                7: `🗑️ **${username}** — **${event.count} losses?!** the enemies are not cooking, ur just serving`,
                10: `☠️ **${username}** — **${event.count} LOSS STREAK** bro is single-handedly funding the enemy mmr`,
                15: `🪦 **${username}** — **${event.count} losses** I would uninstall at this point but here we are`,
                20: `🌊 **${username}** — **${event.count} loss streak** bro really said let me speedrun to ancient 1`,
            };
            return messages[event.count] ?? `💀 **${username}** has lost ${event.count} in a row...`;
        }
    }
}

export const streakService = new StreakService();
