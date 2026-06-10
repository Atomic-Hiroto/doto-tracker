import Database from 'better-sqlite3';
import { ProcessConstants } from '../constants';
import { logger } from './loggerService';

export type AnalysisMode = 'match' | 'player';
export type PlanStatus = 'active' | 'graded';

export interface StoredAnalysis {
    matchId: number;
    steamId: string | null;
    mode: AnalysisMode;
    structuredJson: any;
    factPrompt: string | null;
    model: string;
    source: string;
    createdAt: number;
}

export interface StoredCoachingPlan {
    id: number;
    steamId: string;
    matchId: number;
    planJson: any;
    status: PlanStatus;
    createdAt: number;
}

class CoachingDbService {
    private db: Database.Database;

    constructor() {
        this.db = new Database(ProcessConstants.COACHING_DB_FILE);
        this.db.pragma('journal_mode = WAL');
        this.migrate();
    }

    private migrate() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS analyses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                match_id INTEGER NOT NULL,
                steam_id TEXT NULL,
                mode TEXT NOT NULL CHECK (mode IN ('match', 'player')),
                structured_json TEXT NOT NULL,
                fact_prompt TEXT NULL,
                model TEXT NOT NULL,
                source TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_analyses_cache_key
                ON analyses(match_id, COALESCE(steam_id, ''), mode, source, model);

            CREATE TABLE IF NOT EXISTS coaching_plans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                steam_id TEXT NOT NULL,
                match_id INTEGER NOT NULL,
                plan_json TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('active', 'graded')),
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_coaching_plans_player_status
                ON coaching_plans(steam_id, status, created_at);

            CREATE TABLE IF NOT EXISTS plan_grades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                plan_id INTEGER NOT NULL,
                match_id INTEGER NOT NULL,
                results_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(plan_id) REFERENCES coaching_plans(id)
            );
        `);
        try {
            this.db.prepare(`ALTER TABLE analyses ADD COLUMN fact_prompt TEXT NULL`).run();
        } catch (error: any) {
            if (!String(error?.message || '').includes('duplicate column name')) {
                throw error;
            }
        }
        logger.info(`Coaching DB ready at ${ProcessConstants.COACHING_DB_FILE}`);
    }

    getFreshAnalysis(args: {
        matchId: number;
        steamId?: string | null;
        mode: AnalysisMode;
        source: string;
        model: string;
        ttlMs: number;
    }): StoredAnalysis | null {
        const row = this.db.prepare(`
            SELECT match_id, steam_id, mode, structured_json, fact_prompt, model, source, created_at
            FROM analyses
            WHERE match_id = ?
              AND COALESCE(steam_id, '') = COALESCE(?, '')
              AND mode = ?
              AND source = ?
              AND model = ?
            LIMIT 1
        `).get(args.matchId, args.steamId ?? null, args.mode, args.source, args.model) as any;

        if (!row) return null;
        if (Date.now() - Number(row.created_at) >= args.ttlMs) return null;

        try {
            return {
                matchId: Number(row.match_id),
                steamId: row.steam_id ?? null,
                mode: row.mode,
                structuredJson: JSON.parse(row.structured_json),
                factPrompt: row.fact_prompt ?? null,
                model: row.model,
                source: row.source,
                createdAt: Number(row.created_at),
            };
        } catch (error) {
            logger.warn('Failed to parse cached analysis JSON:', error);
            return null;
        }
    }

    saveAnalysis(args: {
        matchId: number;
        steamId?: string | null;
        mode: AnalysisMode;
        structuredJson: any;
        factPrompt?: string | null;
        model: string;
        source: string;
    }) {
        const tx = this.db.transaction(() => {
            this.db.prepare(`
                DELETE FROM analyses
                WHERE match_id = ?
                  AND COALESCE(steam_id, '') = COALESCE(?, '')
                  AND mode = ?
                  AND source = ?
                  AND model = ?
            `).run(args.matchId, args.steamId ?? null, args.mode, args.source, args.model);
            this.db.prepare(`
                INSERT INTO analyses (match_id, steam_id, mode, structured_json, fact_prompt, model, source, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                args.matchId,
                args.steamId ?? null,
                args.mode,
                JSON.stringify(args.structuredJson),
                args.factPrompt ?? null,
                args.model,
                args.source,
                Date.now(),
            );
        });
        tx();
    }

    getLatestAnalysisForMatch(matchId: number): StoredAnalysis | null {
        const row = this.db.prepare(`
            SELECT match_id, steam_id, mode, structured_json, fact_prompt, model, source, created_at
            FROM analyses
            WHERE match_id = ?
            ORDER BY created_at DESC
            LIMIT 1
        `).get(matchId) as any;
        if (!row) return null;
        try {
            return {
                matchId: Number(row.match_id),
                steamId: row.steam_id ?? null,
                mode: row.mode,
                structuredJson: JSON.parse(row.structured_json),
                factPrompt: row.fact_prompt ?? null,
                model: row.model,
                source: row.source,
                createdAt: Number(row.created_at),
            };
        } catch (error) {
            logger.warn('Failed to parse latest analysis JSON:', error);
            return null;
        }
    }

    replaceActivePlan(args: {
        steamId: string;
        matchId: number;
        planJson: any;
    }) {
        const tx = this.db.transaction(() => {
            this.db.prepare(`
                UPDATE coaching_plans
                SET status = 'graded'
                WHERE steam_id = ? AND status = 'active'
            `).run(args.steamId);
            this.db.prepare(`
                INSERT INTO coaching_plans (steam_id, match_id, plan_json, status, created_at)
                VALUES (?, ?, ?, 'active', ?)
            `).run(args.steamId, args.matchId, JSON.stringify(args.planJson), Date.now());
        });
        tx();
    }

    getActivePlan(steamId: string): StoredCoachingPlan | null {
        const row = this.db.prepare(`
            SELECT id, steam_id, match_id, plan_json, status, created_at
            FROM coaching_plans
            WHERE steam_id = ? AND status = 'active'
            ORDER BY created_at DESC
            LIMIT 1
        `).get(steamId) as any;
        if (!row) return null;
        try {
            return {
                id: Number(row.id),
                steamId: row.steam_id,
                matchId: Number(row.match_id),
                planJson: JSON.parse(row.plan_json),
                status: row.status,
                createdAt: Number(row.created_at),
            };
        } catch (error) {
            logger.warn('Failed to parse active coaching plan JSON:', error);
            return null;
        }
    }

    savePlanGrade(args: { planId: number; matchId: number; resultsJson: any }) {
        const tx = this.db.transaction(() => {
            this.db.prepare(`
                INSERT INTO plan_grades (plan_id, match_id, results_json, created_at)
                VALUES (?, ?, ?, ?)
            `).run(args.planId, args.matchId, JSON.stringify(args.resultsJson), Date.now());
            this.db.prepare(`
                UPDATE coaching_plans
                SET status = 'graded'
                WHERE id = ?
            `).run(args.planId);
        });
        tx();
    }

    getRecentPlayerAnalyses(steamId: string, limit = 20): StoredAnalysis[] {
        const rows = this.db.prepare(`
            SELECT match_id, steam_id, mode, structured_json, fact_prompt, model, source, created_at
            FROM analyses
            WHERE steam_id = ? AND mode = 'player'
            ORDER BY created_at DESC
            LIMIT ?
        `).all(steamId, limit) as any[];
        return rows.flatMap((row) => {
            try {
                return [{
                    matchId: Number(row.match_id),
                    steamId: row.steam_id ?? null,
                    mode: row.mode,
                    structuredJson: JSON.parse(row.structured_json),
                    factPrompt: row.fact_prompt ?? null,
                    model: row.model,
                    source: row.source,
                    createdAt: Number(row.created_at),
                }];
            } catch {
                return [];
            }
        });
    }

    getRecentPlanGrades(steamId: string, limit = 20): Array<{ planId: number; matchId: number; resultsJson: any; createdAt: number }> {
        const rows = this.db.prepare(`
            SELECT pg.plan_id, pg.match_id, pg.results_json, pg.created_at
            FROM plan_grades pg
            JOIN coaching_plans cp ON cp.id = pg.plan_id
            WHERE cp.steam_id = ?
            ORDER BY pg.created_at DESC
            LIMIT ?
        `).all(steamId, limit) as any[];
        return rows.flatMap((row) => {
            try {
                return [{
                    planId: Number(row.plan_id),
                    matchId: Number(row.match_id),
                    resultsJson: JSON.parse(row.results_json),
                    createdAt: Number(row.created_at),
                }];
            } catch {
                return [];
            }
        });
    }
}

export const coachingDbService = new CoachingDbService();
