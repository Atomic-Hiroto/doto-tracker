import { coachingDbService } from './coachingDbService';
import { dotaDataService } from './dotaDataService';
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
const PLAN_GRADE_MATCH_TARGET = 3;

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

function teamNumber(team: 'Radiant' | 'Dire'): number {
    return team === 'Radiant' ? 2 : 3;
}

function fightPlayers(fight: any): any[] {
    return Array.isArray(fight?.players) ? fight.players : [];
}

function matchPlayerAtFightIndex(match: any, index: number): any | null {
    return Array.isArray(match?.players) ? match.players[index] || null : null;
}

function teamfightKills(match: any, players: any[], team: 'Radiant' | 'Dire'): number {
    return players
        .filter((_p: any, index: number) => {
            const matchPlayer = matchPlayerAtFightIndex(match, index);
            return matchPlayer && playerTeam(matchPlayer) === team;
        })
        .reduce((sum: number, p: any) => {
            const killed = p?.killed || {};
            return sum + Object.values(killed).reduce((inner: number, value: any) => inner + Number(value || 0), 0);
        }, 0);
}

function firstRelevantTeamfight(match: any, player: any, afterSeconds = 10 * 60): any | null {
    const slot = Number(player.player_slot);
    return (Array.isArray(match?.teamfights) ? match.teamfights : [])
        .filter((fight: any) => Number(fight?.start) >= afterSeconds)
        .find((fight: any) => fightPlayers(fight).some((_p: any, index: number) => Number(matchPlayerAtFightIndex(match, index)?.player_slot) === slot)) || null;
}

function objectiveTeam(objective: any): 'Radiant' | 'Dire' | null {
    const objectiveTeamNumber = Number(objective?.team);
    if (objectiveTeamNumber === teamNumber('Radiant')) return 'Radiant';
    if (objectiveTeamNumber === teamNumber('Dire')) return 'Dire';
    const slot = Number(objective?.player_slot ?? objective?.slot);
    if (Number.isFinite(slot)) return slot < 128 ? 'Radiant' : 'Dire';
    return null;
}

function isTowerObjectiveForTeam(objective: any, team: 'Radiant' | 'Dire'): boolean {
    if (objective?.type !== 'building_kill' || !objective?.key) return false;
    const key = String(objective.key);
    if (!/tower/i.test(key)) return false;
    return team === 'Radiant' ? key.includes('badguys') : key.includes('goodguys');
}

function isRoshanObjectiveForTeam(objective: any, team: 'Radiant' | 'Dire'): boolean {
    if (!/roshan/i.test(`${objective?.type || ''} ${objective?.key || ''}`)) return false;
    const explicitTeam = objectiveTeam(objective);
    return explicitTeam == null || explicitTeam === team;
}

function objectiveLabel(objective: any): string {
    if (/roshan/i.test(`${objective?.type || ''} ${objective?.key || ''}`)) return 'Roshan';
    if (objective?.type === 'building_kill') return 'tower';
    return String(objective?.type || 'objective');
}

function objectiveByTeamNear(match: any, team: 'Radiant' | 'Dire', start: number, end: number): any | null {
    return (Array.isArray(match?.objectives) ? match.objectives : [])
        .find((objective: any) => {
            const time = Number(objective?.time);
            if (!Number.isFinite(time) || time < start || time > end) return false;
            return isTowerObjectiveForTeam(objective, team) || isRoshanObjectiveForTeam(objective, team);
        }) || null;
}

function checkConversionRule(player: any, match: any, planText: string): { label: string; passed: boolean; evidence: string } {
    if (!/(convert|tower|objective|roshan|siege|push)/i.test(planText)) {
        return { label: 'conversion rule', passed: true, evidence: 'no explicit conversion target' };
    }
    if (!Array.isArray(match?.teamfights) || !match.teamfights.length) {
        return { label: 'conversion rule', passed: true, evidence: 'teamfight data unavailable' };
    }
    const team = playerTeam(player);
    const enemy = team === 'Radiant' ? 'Dire' : 'Radiant';
    const wonFights = (Array.isArray(match?.teamfights) ? match.teamfights : [])
        .filter((fight: any) => Number(fight?.start) >= 8 * 60)
        .filter((fight: any) => {
            const players = fightPlayers(fight);
            const alliedKills = teamfightKills(match, players, team);
            const enemyKills = teamfightKills(match, players, enemy);
            return alliedKills > enemyKills;
        })
        .sort((a: any, b: any) => Number(a?.start || 0) - Number(b?.start || 0))
        .slice(0, 3);
    if (!wonFights.length) {
        return { label: 'conversion rule', passed: false, evidence: 'no won teamfight found after 8m' };
    }
    for (const fight of wonFights) {
        const fightEnd = Number(fight.end || fight.start);
        const objective = objectiveByTeamNear(match, team, fightEnd, fightEnd + 90);
        if (objective) {
            return {
                label: 'conversion rule',
                passed: true,
                evidence: `${objectiveLabel(objective)} at ${formatDuration(Number(objective.time))} after won fight ${formatDuration(Number(fight.start))}`,
            };
        }
    }
    return {
        label: 'conversion rule',
        passed: false,
        evidence: `no tower/Roshan within 90s after first ${wonFights.length} won fight(s): ${wonFights.map((fight: any) => formatDuration(Number(fight.start))).join(', ')}`,
    };
}

export function getOpenDotaDeathTimes(match: any, player: any): number[] {
    const heroKey = player?.hero_id != null ? dotaDataService.getHeroById(Number(player.hero_id))?.name : null;
    if (!heroKey) return [];
    return (Array.isArray(match?.players) ? match.players : [])
        .filter((p: any) => p !== player && playerTeam(p) !== playerTeam(player))
        .flatMap((p: any) => Array.isArray(p.kills_log) ? p.kills_log : [])
        .filter((event: any) => event?.key === heroKey)
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

function teamWonFight(match: any, fight: any, team: 'Radiant' | 'Dire'): boolean {
    const enemy = team === 'Radiant' ? 'Dire' : 'Radiant';
    const players = fightPlayers(fight);
    return teamfightKills(match, players, team) > teamfightKills(match, players, enemy);
}

function deathInsideWonTeamfight(match: any, deathTime: number, team: 'Radiant' | 'Dire'): boolean {
    return (Array.isArray(match?.teamfights) ? match.teamfights : [])
        .some((fight: any) => {
            const start = Number(fight?.start);
            const end = Number(fight?.end ?? fight?.start);
            if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
            return deathTime >= start && deathTime <= end && teamWonFight(match, fight, team);
        });
}

function countIsolatedDeaths(player: any, match: any): { isolated: number; totalTimed: number; ignoredWonFight: number; samples: string[] } {
    const deaths = getOpenDotaDeathTimes(match, player);
    const alliedKills = alliedKillTimes(match, player);
    const team = playerTeam(player);
    const assessedDeaths = deaths.filter((deathTime) => !deathInsideWonTeamfight(match, deathTime, team));
    const isolatedTimes = assessedDeaths.filter((deathTime) =>
        !alliedKills.some((killTime) => killTime > deathTime && killTime <= deathTime + 60)
    );
    return {
        isolated: isolatedTimes.length,
        totalTimed: assessedDeaths.length,
        ignoredWonFight: deaths.length - assessedDeaths.length,
        samples: isolatedTimes.slice(0, 3).map(formatDuration),
    };
}

function countDeathsWithBuybackDown(player: any, match: any): number {
    const deaths = getOpenDotaDeathTimes(match, player);
    const buybacks = (Array.isArray(player.buyback_log) ? player.buyback_log : [])
        .map((event: any) => Number(event.time))
        .filter((time: number) => Number.isFinite(time) && time >= 0);
    if (!deaths.length || !buybacks.length) return 0;
    return deaths.filter((deathTime: number) =>
        buybacks.some((buybackTime: number) => deathTime > buybackTime && deathTime <= buybackTime + 480)
    ).length;
}

async function checkItemRule(player: any, match: any, planText: string): Promise<{ label: string; passed: boolean; evidence: string }> {
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

    if (!hit) return { label: `${target} timing`, passed: false, evidence: 'not found in purchase log' };

    const timingMatters = /\b(before|prior|until|wait|finish|complete|online)\b/i.test(planText) && /\b(fight|teamfight|engage|commit|brawl)\b/i.test(planText);
    if (timingMatters) {
        const fight = firstRelevantTeamfight(match, player);
        if (fight && Number(hit.time) > Number(fight.start)) {
            return { label: `${target} timing`, passed: false, evidence: `bought at ${formatDuration(hit.time)} after teamfight ${formatDuration(Number(fight.start))}` };
        }
        if (fight) {
            return { label: `${target} timing`, passed: true, evidence: `bought at ${formatDuration(hit.time)} before teamfight ${formatDuration(Number(fight.start))}` };
        }
    }

    return { label: `${target} timing`, passed: true, evidence: `bought at ${formatDuration(hit.time)}` };
}

export async function gradeActivePlanForMatch(steamId: string, matchId: number, detailedMatch: any): Promise<string | null> {
    const activePlan = coachingDbService.getActivePlan(steamId);
    if (!activePlan || activePlan.matchId === matchId) return null;
    if (!detailedMatch?.version) return null;
    if (coachingDbService.getPlanGrade(activePlan.id, matchId)) return null;

    const player = (Array.isArray(detailedMatch.players) ? detailedMatch.players : [])
        .find((p: any) => String(p.account_id) === String(steamId));
    if (!player) return null;

    try {
        const planText = String(activePlan.planJson?.nextGamePlan || '');
        const itemRule = await checkItemRule(player, detailedMatch, planText);
        const conversionRule = checkConversionRule(player, detailedMatch, planText);
        const isolated = countIsolatedDeaths(player, detailedMatch);
        const buybackDownDeaths = countDeathsWithBuybackDown(player, detailedMatch);
        const fightPassed = isolated.totalTimed === 0
            ? (isolated.ignoredWonFight > 0 ? true : null)
            : isolated.isolated <= Math.max(1, Math.floor(isolated.totalTimed / 3));
        const deathEvidence = isolated.totalTimed
            ? `${isolated.isolated}/${isolated.totalTimed} assessed timed deaths had no allied kill within 60s${isolated.samples.length ? ` (${isolated.samples.join(', ')})` : ''}${isolated.ignoredWonFight ? `; ${isolated.ignoredWonFight} death(s) inside won teamfights ignored` : ''}`
            : isolated.ignoredWonFight
                ? `0 assessed isolated deaths; ${isolated.ignoredWonFight} timed death(s) were inside teamfights won by ${playerTeam(player)}`
            : `${Number(player.deaths || 0)} deaths; death timing data unavailable`;
        const buybackText = buybackDownDeaths > 0 ? ` • buyback-risk deaths ${buybackDownDeaths}` : '';

        const resultsJson = {
            itemRule,
            fightRule: {
                label: 'fight rule',
                passed: fightPassed,
                evidence: deathEvidence,
            },
            conversionRule,
            buybackDownDeaths,
            player: {
                deaths: Number(player.deaths || 0),
                kills: Number(player.kills || 0),
                assists: Number(player.assists || 0),
                heroId: player.hero_id,
            },
        };
        const gradeNumber = coachingDbService.savePlanGrade({ planId: activePlan.id, matchId, resultsJson, maxGrades: PLAN_GRADE_MATCH_TARGET });
        if (!gradeNumber) return null;

        const conversionText = conversionRule.evidence === 'no explicit conversion target'
            || conversionRule.evidence === 'teamfight data unavailable'
            ? ''
            : ` • ${conversionRule.label} ${conversionRule.passed ? '✅' : '❌'} (${conversionRule.evidence})`;
        const heroName = await dotaDataService.getHeroName(Number(player.hero_id));
        const playerLabel = `${player.personaname || steamId}${heroName && heroName !== 'Unknown Hero' ? ` (${heroName})` : ''}`;
        const fightIcon = fightPassed == null ? '⚪' : fightPassed ? '✅' : '❌';
        return `📋 Last plan for ${playerLabel} — Match ${Math.min(gradeNumber, PLAN_GRADE_MATCH_TARGET)}/${PLAN_GRADE_MATCH_TARGET}: ${itemRule.label} ${itemRule.passed ? '✅' : '❌'} (${itemRule.evidence}) • fight rule ${fightIcon} (${deathEvidence})${conversionText}${buybackText}`;
    } catch (error) {
        logger.warn(`Failed to grade active coaching plan for ${steamId} on ${matchId}:`, error);
        return null;
    }
}
