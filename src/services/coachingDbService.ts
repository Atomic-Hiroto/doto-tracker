import Database from 'better-sqlite3';
import { ProcessConstants } from '../constants';
import { logger } from './loggerService';

export type AnalysisMode = 'match' | 'player';
export type PlanStatus = 'active' | 'graded';

export interface StoredAnalysis {
    id: number;
    matchId: number;
    steamId: string | null;
    mode: AnalysisMode;
    structuredJson: any;
    factPrompt: string | null;
    model: string;
    source: string;
    createdAt: number;
}

export interface StoredAnalysisPage {
    messageId: string;
    pageNumber: number;
    renderedText: string;
}

export interface StoredAnalysisMessage {
    messageId: string;
    analysisId: number;
    matchId: number;
    steamId: string | null;
    mode: AnalysisMode;
    pageNumber: number;
    renderedText: string;
    createdAt: number;
    analysis: StoredAnalysis;
    renderedPages: StoredAnalysisPage[];
}

export interface StoredCoachingPlan {
    id: number;
    steamId: string;
    matchId: number;
    planJson: any;
    status: PlanStatus;
    createdAt: number;
}

export interface PlayerNote {
    id: number;
    steamId: string | null;
    matchId: number | null;
    text: string;
    createdAt: number;
}

export interface StoredCoachReport {
    steamId: string;
    reportJson: any;
    sampleText: string;
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

            CREATE INDEX IF NOT EXISTS idx_analyses_cache_key
                ON analyses(match_id, COALESCE(steam_id, ''), mode, source, model, created_at);

            CREATE TABLE IF NOT EXISTS analysis_messages (
                message_id TEXT PRIMARY KEY,
                analysis_id INTEGER NOT NULL,
                page_number INTEGER NOT NULL,
                steam_id TEXT NULL,
                mode TEXT NOT NULL CHECK (mode IN ('match', 'player')),
                rendered_text TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(analysis_id) REFERENCES analyses(id)
            );

            CREATE INDEX IF NOT EXISTS idx_analysis_messages_analysis
                ON analysis_messages(analysis_id, page_number);

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

            CREATE TABLE IF NOT EXISTS player_notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                steam_id TEXT NULL,
                match_id INTEGER NULL,
                text TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_player_notes_player_created
                ON player_notes(steam_id, created_at);

            CREATE TABLE IF NOT EXISTS coach_reports (
                steam_id TEXT PRIMARY KEY,
                report_json TEXT NOT NULL,
                sample_text TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
        `);
        try {
            this.db.prepare(`ALTER TABLE analyses ADD COLUMN fact_prompt TEXT NULL`).run();
        } catch (error: any) {
            if (!String(error?.message || '').includes('duplicate column name')) {
                throw error;
            }
        }
        this.db.exec(`
            DROP INDEX IF EXISTS idx_analyses_cache_key;
            CREATE INDEX IF NOT EXISTS idx_analyses_cache_key
                ON analyses(match_id, COALESCE(steam_id, ''), mode, source, model, created_at);
            DELETE FROM plan_grades
            WHERE id NOT IN (
                SELECT MIN(id)
                FROM plan_grades
                GROUP BY plan_id, match_id
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_grades_plan_match
                ON plan_grades(plan_id, match_id);
        `);
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
            SELECT id, match_id, steam_id, mode, structured_json, fact_prompt, model, source, created_at
            FROM analyses
            WHERE match_id = ?
              AND COALESCE(steam_id, '') = COALESCE(?, '')
              AND mode = ?
              AND source = ?
              AND model = ?
            ORDER BY created_at DESC
            LIMIT 1
        `).get(args.matchId, args.steamId ?? null, args.mode, args.source, args.model) as any;

        if (!row) return null;
        if (Date.now() - Number(row.created_at) >= args.ttlMs) return null;

        try {
            return {
                id: Number(row.id),
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
    }): number {
        const tx = this.db.transaction(() => {
            const result = this.db.prepare(`
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
            if (args.mode === 'player' && args.steamId) {
                this.invalidateCoachReport(args.steamId);
            }
            return Number(result.lastInsertRowid);
        });
        return tx();
    }

    getLatestAnalysisForMatch(matchId: number): StoredAnalysis | null {
        const row = this.db.prepare(`
            SELECT id, match_id, steam_id, mode, structured_json, fact_prompt, model, source, created_at
            FROM analyses
            WHERE match_id = ?
            ORDER BY created_at DESC
            LIMIT 1
        `).get(matchId) as any;
        if (!row) return null;
        try {
            return {
                id: Number(row.id),
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

    getAnalysisMessage(messageId: string): StoredAnalysisMessage | null {
        const row = this.db.prepare(`
            SELECT
                am.message_id,
                am.analysis_id,
                am.page_number,
                am.steam_id AS message_steam_id,
                am.mode AS message_mode,
                am.rendered_text,
                am.created_at AS message_created_at,
                a.id,
                a.match_id,
                a.steam_id,
                a.mode,
                a.structured_json,
                a.fact_prompt,
                a.model,
                a.source,
                a.created_at
            FROM analysis_messages am
            JOIN analyses a ON a.id = am.analysis_id
            WHERE am.message_id = ?
            LIMIT 1
        `).get(messageId) as any;
        if (!row) return null;

        const pageRows = this.db.prepare(`
            SELECT message_id, page_number, rendered_text
            FROM analysis_messages
            WHERE analysis_id = ?
            ORDER BY page_number ASC
        `).all(row.analysis_id) as any[];

        try {
            const analysis: StoredAnalysis = {
                id: Number(row.id),
                matchId: Number(row.match_id),
                steamId: row.steam_id ?? null,
                mode: row.mode,
                structuredJson: JSON.parse(row.structured_json),
                factPrompt: row.fact_prompt ?? null,
                model: row.model,
                source: row.source,
                createdAt: Number(row.created_at),
            };
            return {
                messageId: row.message_id,
                analysisId: Number(row.analysis_id),
                matchId: analysis.matchId,
                steamId: row.message_steam_id ?? analysis.steamId ?? null,
                mode: row.message_mode,
                pageNumber: Number(row.page_number),
                renderedText: String(row.rendered_text || ''),
                createdAt: Number(row.message_created_at),
                analysis,
                renderedPages: pageRows.map((page) => ({
                    messageId: String(page.message_id),
                    pageNumber: Number(page.page_number),
                    renderedText: String(page.rendered_text || ''),
                })),
            };
        } catch (error) {
            logger.warn('Failed to parse analysis message context:', error);
            return null;
        }
    }

    saveAnalysisMessage(args: {
        messageId: string;
        analysisId: number;
        pageNumber: number;
        steamId?: string | null;
        mode: AnalysisMode;
        renderedText: string;
    }) {
        this.db.prepare(`
            INSERT INTO analysis_messages (message_id, analysis_id, page_number, steam_id, mode, rendered_text, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(message_id) DO UPDATE SET
                analysis_id = excluded.analysis_id,
                page_number = excluded.page_number,
                steam_id = excluded.steam_id,
                mode = excluded.mode,
                rendered_text = excluded.rendered_text,
                created_at = excluded.created_at
        `).run(
            args.messageId,
            args.analysisId,
            args.pageNumber,
            args.steamId ?? null,
            args.mode,
            args.renderedText.slice(0, 6000),
            Date.now(),
        );
    }

    savePlayerNote(args: { steamId?: string | null; matchId?: number | null; text: string }) {
        const tx = this.db.transaction(() => {
            this.db.prepare(`
                INSERT INTO player_notes (steam_id, match_id, text, created_at)
                VALUES (?, ?, ?, ?)
            `).run(args.steamId ?? null, args.matchId ?? null, args.text.slice(0, 500), Date.now());
            this.invalidateCoachReport(args.steamId ?? null);
        });
        tx();
    }

    getRecentPlayerNotes(steamId: string, limit = 10): PlayerNote[] {
        const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
        const rows = this.db.prepare(`
            SELECT id, steam_id, match_id, text, created_at
            FROM player_notes
            WHERE steam_id = ?
              AND created_at >= ?
            ORDER BY created_at DESC
            LIMIT ?
        `).all(steamId, since, Math.min(limit, 10)) as any[];
        return rows.map((row) => ({
            id: Number(row.id),
            steamId: row.steam_id ?? null,
            matchId: row.match_id == null ? null : Number(row.match_id),
            text: String(row.text || ''),
            createdAt: Number(row.created_at),
        }));
    }

    invalidateCoachReport(steamId?: string | null) {
        if (steamId) {
            this.db.prepare(`DELETE FROM coach_reports WHERE steam_id = ?`).run(steamId);
            return;
        }
        this.db.prepare(`DELETE FROM coach_reports`).run();
    }

    getFreshCoachReport(steamId: string, ttlMs: number): StoredCoachReport | null {
        const row = this.db.prepare(`
            SELECT steam_id, report_json, sample_text, created_at
            FROM coach_reports
            WHERE steam_id = ?
            LIMIT 1
        `).get(steamId) as any;
        if (!row) return null;
        if (Date.now() - Number(row.created_at) >= ttlMs) return null;
        try {
            return {
                steamId: row.steam_id,
                reportJson: JSON.parse(row.report_json),
                sampleText: String(row.sample_text || ''),
                createdAt: Number(row.created_at),
            };
        } catch (error) {
            logger.warn('Failed to parse cached coach report:', error);
            return null;
        }
    }

    saveCoachReport(args: { steamId: string; reportJson: any; sampleText: string }) {
        this.db.prepare(`
            INSERT INTO coach_reports (steam_id, report_json, sample_text, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(steam_id) DO UPDATE SET
                report_json = excluded.report_json,
                sample_text = excluded.sample_text,
                created_at = excluded.created_at
        `).run(args.steamId, JSON.stringify(args.reportJson), args.sampleText.slice(0, 500), Date.now());
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
            this.invalidateCoachReport(args.steamId);
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

    getPlanGrade(planId: number, matchId: number): { planId: number; matchId: number; resultsJson: any; createdAt: number } | null {
        const row = this.db.prepare(`
            SELECT plan_id, match_id, results_json, created_at
            FROM plan_grades
            WHERE plan_id = ? AND match_id = ?
            LIMIT 1
        `).get(planId, matchId) as any;
        if (!row) return null;
        try {
            return {
                planId: Number(row.plan_id),
                matchId: Number(row.match_id),
                resultsJson: JSON.parse(row.results_json),
                createdAt: Number(row.created_at),
            };
        } catch {
            return null;
        }
    }

    countPlanGrades(planId: number): number {
        const row = this.db.prepare(`
            SELECT COUNT(*) AS count
            FROM plan_grades
            WHERE plan_id = ?
        `).get(planId) as any;
        return Number(row?.count || 0);
    }

    savePlanGrade(args: { planId: number; matchId: number; resultsJson: any; maxGrades?: number }): number | null {
        const tx = this.db.transaction(() => {
            const plan = this.db.prepare(`
                SELECT steam_id
                FROM coaching_plans
                WHERE id = ?
                LIMIT 1
            `).get(args.planId) as any;
            const result = this.db.prepare(`
                INSERT OR IGNORE INTO plan_grades (plan_id, match_id, results_json, created_at)
                VALUES (?, ?, ?, ?)
            `).run(args.planId, args.matchId, JSON.stringify(args.resultsJson), Date.now());
            const gradeCount = this.countPlanGrades(args.planId);
            if (gradeCount >= (args.maxGrades ?? 3)) {
                this.db.prepare(`
                    UPDATE coaching_plans
                    SET status = 'graded'
                    WHERE id = ?
                `).run(args.planId);
            }
            if (result.changes > 0 && plan?.steam_id) {
                this.invalidateCoachReport(plan.steam_id);
            }
            return result.changes > 0 ? gradeCount : null;
        });
        return tx();
    }

    getRecentPlayerAnalyses(steamId: string, limit = 20): StoredAnalysis[] {
        const rows = this.db.prepare(`
            SELECT id, match_id, steam_id, mode, structured_json, fact_prompt, model, source, created_at
            FROM analyses
            WHERE steam_id = ? AND mode = 'player'
            ORDER BY created_at DESC
            LIMIT ?
        `).all(steamId, limit) as any[];
        return rows.flatMap((row) => {
            try {
                return [{
                    id: Number(row.id),
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
