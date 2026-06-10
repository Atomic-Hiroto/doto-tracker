import { coachingDbService } from './coachingDbService';
import { logger } from './loggerService';
import { formatDuration } from '../utils/formatters';

const ITEM_RULE_NAMES = [
    'Black King Bar',
    'BKB',
    'Blink Dagger',
    'Pipe of Insight',
    'Force Staff',
    'Glimmer Cape',
    'Lotus Orb',
    'Aeon Disk',
    'Aghanim',
    'Satanic',
    'Desolator',
    'Nullifier',
    'Assault Cuirass',
    'Crimson Guard',
];

function normalizeItemName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function extractItemTarget(planText: string): string | null {
    const normalizedPlan = planText.toLowerCase();
    return ITEM_RULE_NAMES.find((name) => normalizedPlan.includes(name.toLowerCase())) || null;
}

function playerTeam(player: any): 'Radiant' | 'Dire' {
    return Number(player.player_slot) < 128 ? 'Radiant' : 'Dire';
}

function deathTimes(player: any): number[] {
    return (Array.isArray(player.death_log) ? player.death_log : [])
        .map((event: any) => Number(event.time))
        .filter((time: number) => Number.isFinite(time) && time >= 0)
        .sort((a: number, b: number) => a - b);
}

function alliedKillTimes(match: any, player: any): number[] {
    const team = playerTeam(player);
    return (Array.isArray(match.players) ? match.players : [])
        .filter((p: any) => p !== player && playerTeam(p) === team)
        .flatMap((p: any) => Array.isArray(p.kills_log) ? p.kills_log : [])
        .map((event: any) => Number(event.time))
        .filter((time: number) => Number.isFinite(time) && time >= 0)
        .sort((a: number, b: number) => a - b);
}

function countIsolatedDeaths(player: any, match: any): { isolated: number; totalTimed: number; samples: string[] } {
    const deaths = deathTimes(player);
    const alliedKills = alliedKillTimes(match, player);
    const isolatedTimes = deaths.filter((deathTime) =>
        !alliedKills.some((killTime) => killTime > deathTime && killTime <= deathTime + 60)
    );
    return {
        isolated: isolatedTimes.length,
        totalTimed: deaths.length,
        samples: isolatedTimes.slice(0, 3).map(formatDuration),
    };
}

function countDeathsWithBuybackDown(player: any): number {
    const deaths = deathTimes(player);
    const buybacks = (Array.isArray(player.buyback_log) ? player.buyback_log : [])
        .map((event: any) => Number(event.time))
        .filter((time: number) => Number.isFinite(time) && time >= 0);
    if (!deaths.length || !buybacks.length) return 0;
    return deaths.filter((deathTime: number) =>
        buybacks.some((buybackTime: number) => deathTime > buybackTime && deathTime <= buybackTime + 480)
    ).length;
}

async function checkItemRule(player: any, planText: string): Promise<{ label: string; passed: boolean; evidence: string }> {
    const target = extractItemTarget(planText);
    if (!target) {
        return { label: 'item rule', passed: true, evidence: 'no explicit item target' };
    }

    const purchases = Array.isArray(player.purchase_log) ? player.purchase_log : [];
    const resolved = purchases.map((purchase: any) => {
        const time = Number(purchase.time);
        const rawKey = String(purchase.key || '');
        const itemName = rawKey.replace(/^item_/, '').replace(/_/g, ' ') || 'Unknown Item';
        return {
            time,
            rawKey,
            itemName,
        };
    });
    const targetNorm = normalizeItemName(target === 'BKB' ? 'Black King Bar' : target);
    const hit = resolved
        .filter((purchase: { time: number; rawKey: string; itemName: string }) => Number.isFinite(purchase.time))
        .find((purchase: { time: number; rawKey: string; itemName: string }) =>
            normalizeItemName(purchase.itemName).includes(targetNorm)
            || normalizeItemName(purchase.rawKey).includes(targetNorm)
        );

    return hit
        ? { label: `${target} timing`, passed: true, evidence: `bought at ${formatDuration(hit.time)}` }
        : { label: `${target} timing`, passed: false, evidence: 'not found in purchase log' };
}

export async function gradeActivePlanForMatch(steamId: string, matchId: number, detailedMatch: any): Promise<string | null> {
    const activePlan = coachingDbService.getActivePlan(steamId);
    if (!activePlan || activePlan.matchId === matchId) return null;

    const player = (Array.isArray(detailedMatch.players) ? detailedMatch.players : [])
        .find((p: any) => String(p.account_id) === String(steamId));
    if (!player) return null;

    try {
        const planText = String(activePlan.planJson?.nextGamePlan || '');
        const itemRule = await checkItemRule(player, planText);
        const isolated = countIsolatedDeaths(player, detailedMatch);
        const buybackDownDeaths = countDeathsWithBuybackDown(player);
        const fightPassed = isolated.totalTimed === 0
            ? Number(player.deaths || 0) <= 2
            : isolated.isolated <= Math.max(1, Math.floor(isolated.totalTimed / 3));
        const deathEvidence = isolated.totalTimed
            ? `${isolated.isolated}/${isolated.totalTimed} timed deaths had no allied kill within 60s${isolated.samples.length ? ` (${isolated.samples.join(', ')})` : ''}`
            : `${Number(player.deaths || 0)} deaths; no death_log timings`;
        const buybackText = buybackDownDeaths > 0 ? ` • buyback-risk deaths ${buybackDownDeaths}` : '';

        const resultsJson = {
            itemRule,
            fightRule: {
                label: 'fight rule',
                passed: fightPassed,
                evidence: deathEvidence,
            },
            buybackDownDeaths,
            player: {
                deaths: Number(player.deaths || 0),
                kills: Number(player.kills || 0),
                assists: Number(player.assists || 0),
                heroId: player.hero_id,
            },
        };
        coachingDbService.savePlanGrade({ planId: activePlan.id, matchId, resultsJson });

        return `📋 Last plan: ${itemRule.label} ${itemRule.passed ? '✅' : '❌'} (${itemRule.evidence}) • fight rule ${fightPassed ? '✅' : '❌'} (${deathEvidence})${buybackText}`;
    } catch (error) {
        logger.warn(`Failed to grade active coaching plan for ${steamId} on ${matchId}:`, error);
        return null;
    }
}
