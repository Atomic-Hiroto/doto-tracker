import axios from 'axios';
import { Message, EmbedBuilder } from 'discord.js';
import { AIConstants, ProcessConstants, Replies } from '../constants';
import { opendotaClient } from '../services/apiClient';
import { coachingDbService } from '../services/coachingDbService';
import { dotaDataService } from '../services/dotaDataService';
import { logger } from '../services/loggerService';
import { UserDataService } from '../services/userDataService';
import { safeTyping } from '../utils/channelHelpers';
import { formatDuration } from '../utils/formatters';
import { parseArgs } from '../utils/argParser';
import { getOpenDotaDeathTimes } from '../services/coachingPlanService';

const COACH_REPORT_TTL_MS = 6 * 60 * 60 * 1000;
const COACH_COOLDOWN_MS = 60 * 1000;
const coachCooldowns = new Map<string, number>();

const COACH_SYSTEM = `You are doto-chan, a persistent Dota 2 coach. You receive COACH_FACTS computed by deterministic code. Do not aggregate raw matches yourself.

Rules:
- Use only COACH_FACTS.
- Every substantive claim must cite evidence ids like [C1].
- Be neutral and coaching-focused; mild flavor is okay only in the opening line.
- Output compact Discord markdown with these headings: Recurring Problems, Biggest Win, Trend Verdict, Focus For Next Week.
- Do not invent benchmarks, roles, or causes that are not in COACH_FACTS.`;

const COACH_RESPONSE_FORMAT = {
    type: 'json_schema' as const,
    json_schema: {
        name: 'coach_trend_report',
        strict: true,
        schema: {
            type: 'object',
            properties: {
                recurringProblems: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            claim: { type: 'string' },
                            evidence: { type: 'array', items: { type: 'string' } },
                            fix: { type: 'string' },
                        },
                        required: ['claim', 'evidence', 'fix'],
                        additionalProperties: false,
                    },
                },
                biggestWin: { type: 'string' },
                trendVerdict: { type: 'string' },
                focusForNextWeek: { type: 'string' },
            },
            required: ['recurringProblems', 'biggestWin', 'trendVerdict', 'focusForNextWeek'],
            additionalProperties: false,
        },
    },
};

function didPlayerWin(match: any, player: any): boolean {
    const isRadiant = Number(player.player_slot) < 128;
    return (isRadiant && match.radiant_win) || (!isRadiant && !match.radiant_win);
}

function bucketDuration(seconds: number): string {
    if (seconds < 25 * 60) return '<25m';
    if (seconds < 35 * 60) return '25-35m';
    return '35m+';
}

function deathPhase(time: number): string {
    if (time < 10 * 60) return '0-10m';
    if (time < 20 * 60) return '10-20m';
    if (time < 30 * 60) return '20-30m';
    return '30m+';
}

function categoryFromMistake(claim: string): string {
    const lower = claim.toLowerCase();
    if (/death|died|dying|caught|overextend/.test(lower)) return 'deaths/positioning';
    if (/bkb|blink|pipe|item|timing|purchase/.test(lower)) return 'item timing';
    if (/tower|objective|roshan|siege|map/.test(lower)) return 'objective conversion';
    if (/ward|vision|deward/.test(lower)) return 'vision';
    if (/farm|lane|cs|last hit|gpm|xpm/.test(lower)) return 'farm/lane';
    return 'general decision-making';
}

async function callCoachAI(prompt: string): Promise<any> {
    const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
            model: AIConstants.AI_COACH_MODEL,
            messages: [
                { role: 'system', content: COACH_SYSTEM },
                { role: 'user', content: prompt },
            ],
            max_tokens: 2500,
            stream: false,
            response_format: COACH_RESPONSE_FORMAT,
            plugins: [{ id: 'response-healing' }],
        },
        {
            headers: {
                Authorization: `Bearer ${ProcessConstants.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://github.com/Atomic-Hiroto/doto-tracker',
                'X-Title': 'Doto Tracker',
            },
        },
    );

    const content = response.data?.choices?.[0]?.message?.content;
    const text = Array.isArray(content)
        ? content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('')
        : String(content || '');
    return JSON.parse(text);
}

async function mapInBatches<T, R>(items: T[], batchSize: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        results.push(...await Promise.all(batch.map(mapper)));
    }
    return results;
}

function buildCoachEmbed(ai: any, targetUser: { username: string }, sampleText: string, cached = false): EmbedBuilder {
    const problems = Array.isArray(ai.recurringProblems)
        ? ai.recurringProblems.slice(0, 3).map((p: any) => `⚠️ **${p.claim}** — ${p.fix}`).join('\n')
        : 'No recurring problems returned.';

    return new EmbedBuilder()
        .setColor('#8b5cf6')
        .setTitle(`🎓 Coach Report — ${targetUser.username}`)
        .setDescription(`**Recurring Problems**\n${problems}`)
        .addFields(
            { name: 'Biggest Win', value: String(ai.biggestWin || 'N/A').slice(0, 1024), inline: false },
            { name: 'Trend Verdict', value: String(ai.trendVerdict || 'N/A').slice(0, 1024), inline: false },
            { name: 'Focus For Next Week', value: String(ai.focusForNextWeek || 'N/A').slice(0, 1024), inline: false },
            { name: 'Sample', value: sampleText.slice(0, 1024), inline: true },
        )
        .setFooter({ text: cached ? 'doto-chan coaching • cached trend synthesis' : 'doto-chan coaching • trend synthesis' })
        .setTimestamp();
}

export async function coach(message: Message, args: string[], userDataService: UserDataService) {
    const parsed = parseArgs(args, message);
    let discordId = message.author.id;
    let targetUser = message.author;
    if (parsed.mentions.length > 0) {
        discordId = parsed.mentions[0];
        targetUser = message.mentions.users.first()!;
    }

    const user = userDataService.getUserByDiscordId(discordId);
    if (!user) return message.reply(Replies.NEED_REGISTRATION);

    try {
        const cooldownKey = `${message.author.id}:${user.steamId}`;
        const now = Date.now();
        const cooldownUntil = coachCooldowns.get(cooldownKey) || 0;
        if (cooldownUntil > now) {
            return message.reply(`Coach report is cooling down. Try again in ${Math.ceil((cooldownUntil - now) / 1000)}s.`);
        }
        coachCooldowns.set(cooldownKey, now + COACH_COOLDOWN_MS);

        const forceRedo = parsed.flags.redo === true || parsed.flags.refresh === true;
        const cachedReport = forceRedo ? null : coachingDbService.getFreshCoachReport(user.steamId, COACH_REPORT_TTL_MS);
        if (cachedReport) {
            return message.reply({ embeds: [buildCoachEmbed(cachedReport.reportJson, targetUser, cachedReport.sampleText, true)] });
        }

        safeTyping(message.channel);
        const recent = await opendotaClient.get<any[]>(`/players/${user.steamId}/recentMatches?limit=20`);
        const recentMatches = recent.data || [];
        if (recentMatches.length < 3) {
            return message.reply('Need at least 3 recent matches before I can coach trends.');
        }

        const detailed = await mapInBatches(
            recentMatches.slice(0, 20),
            4,
            async (match) => opendotaClient.get(`/matches/${match.match_id}`).then((res) => res.data).catch(() => null)
        );
        const fetchedMatches = detailed.filter(Boolean);
        const parsedMatches = fetchedMatches.filter((match: any) => !!match.version);
        const rows = await Promise.all(parsedMatches.map(async (match: any) => {
            const player = (match.players || []).find((p: any) => String(p.account_id) === String(user.steamId));
            if (!player) return null;
            const hero = await dotaDataService.getHeroName(player.hero_id);
            const deaths = getOpenDotaDeathTimes(match, player);
            const alliedKills = (match.players || [])
                .filter((p: any) => p !== player && (p.player_slot < 128) === (player.player_slot < 128))
                .flatMap((p: any) => Array.isArray(p.kills_log) ? p.kills_log : [])
                .map((k: any) => Number(k.time))
                .filter(Number.isFinite);
            const isolatedDeaths = deaths.filter((deathTime: number) => !alliedKills.some((killTime: number) => killTime > deathTime && killTime <= deathTime + 60)).length;
            return {
                matchId: match.match_id,
                hero,
                won: didPlayerWin(match, player),
                duration: Number(match.duration || 0),
                durationBucket: bucketDuration(Number(match.duration || 0)),
                kda: `${player.kills}/${player.deaths}/${player.assists}`,
                deaths: Number(player.deaths || 0),
                deathPhases: deaths.map(deathPhase),
                isolatedDeaths,
                gpm: Number(player.gold_per_min || 0),
                xpm: Number(player.xp_per_min || 0),
                laneEfficiency: Number(player.lane_efficiency || 0),
                obsPlaced: Number(player.obs_placed || 0),
                senPlaced: Number(player.sen_placed || 0),
                obsKilled: Number(player.obs_killed || 0),
                senKilled: Number(player.sen_killed || 0),
                timeDead: Number(player.life_state_dead || 0),
                teamfightParticipation: player.teamfight_participation == null ? null : Math.round(Number(player.teamfight_participation) * 100),
            };
        }));
        const matches = rows.filter((row): row is NonNullable<typeof row> => !!row);

        const facts: Array<{ id: string; topic: string; text: string; data?: any }> = [];
        const addFact = (topic: string, text: string, data?: any) => facts.push({ id: `C${facts.length + 1}`, topic, text, data });
        const wins = matches.filter((m) => m.won).length;
        addFact('sample', `${targetUser.username}: ${matches.length} parsed matches used for trend facts, ${fetchedMatches.length - parsedMatches.length} unparsed matches skipped, ${wins}-${matches.length - wins} record.`, {
            parsedMatches: matches.length,
            skippedUnparsedMatches: fetchedMatches.length - parsedMatches.length,
            wins,
        });
        if (matches.length < 3) {
            return message.reply(`Need at least 3 parsed matches for a useful coach report. Found ${matches.length} parsed and skipped ${fetchedMatches.length - parsedMatches.length} unparsed.`);
        }

        const deathBuckets = matches.flatMap((m) => m.deathPhases).reduce((acc: Record<string, number>, phase) => {
            acc[phase] = (acc[phase] || 0) + 1;
            return acc;
        }, {});
        const isolatedDeaths = matches.reduce((sum, m) => sum + m.isolatedDeaths, 0);
        const totalDeaths = matches.reduce((sum, m) => sum + m.deaths, 0);
        addFact('deaths', `Death timing histogram: ${Object.entries(deathBuckets).map(([k, v]) => `${k}: ${v}`).join(', ') || 'no timed deaths'}; isolated deaths ${isolatedDeaths}/${totalDeaths}.`, { deathBuckets, isolatedDeaths, totalDeaths });
        const avgTimeDead = Math.round(matches.reduce((sum, m) => sum + m.timeDead, 0) / matches.length);
        const tfpValues = matches.map((m) => m.teamfightParticipation).filter((value): value is number => value != null);
        const avgTfp = tfpValues.length ? Math.round(tfpValues.reduce((sum, value) => sum + value, 0) / tfpValues.length) : null;
        addFact('fightImpact', `Fight impact trend: average time dead ${formatDuration(avgTimeDead)} per match; average teamfight participation ${avgTfp == null ? 'unavailable' : `${avgTfp}%`} across ${tfpValues.length} parsed matches with the stat.`, { avgTimeDead, avgTfp, teamfightParticipationSamples: tfpValues.length });

        const byHero = new Map<string, typeof matches>();
        for (const match of matches) byHero.set(match.hero, [...(byHero.get(match.hero) || []), match]);
        const heroSummaries = [...byHero.entries()].map(([hero, heroMatches]) => {
            const avg = (key: 'gpm' | 'xpm' | 'laneEfficiency') => Math.round(heroMatches.reduce((s, m) => s + m[key], 0) / heroMatches.length);
            const heroWins = heroMatches.filter((m) => m.won).length;
            return `${hero}: ${heroMatches.length}G ${heroWins}-${heroMatches.length - heroWins}, avg GPM/XPM ${avg('gpm')}/${avg('xpm')}, lane eff ${avg('laneEfficiency')}`;
        }).slice(0, 6);
        addFact('farm', `Hero farm/lane summary: ${heroSummaries.join('; ')}.`, { heroSummaries });

        const wardAvg = (key: 'obsPlaced' | 'senPlaced' | 'obsKilled' | 'senKilled') => matches.reduce((s, m) => s + m[key], 0) / matches.length;
        addFact('vision', `Ward averages per match: obs placed ${wardAvg('obsPlaced').toFixed(1)}, sentries placed ${wardAvg('senPlaced').toFixed(1)}, obs killed ${wardAvg('obsKilled').toFixed(1)}, sentries killed ${wardAvg('senKilled').toFixed(1)}.`);

        const durationBuckets = ['<25m', '25-35m', '35m+'].map((bucket) => {
            const bucketMatches = matches.filter((m) => m.durationBucket === bucket);
            const bucketWins = bucketMatches.filter((m) => m.won).length;
            return `${bucket}: ${bucketWins}-${bucketMatches.length - bucketWins}`;
        });
        addFact('winrate', `Winrate by duration bucket: ${durationBuckets.join(', ')}.`);

        const storedAnalyses = coachingDbService.getRecentPlayerAnalyses(user.steamId, 20);
        const mistakeCounts: Record<string, number> = {};
        for (const analysis of storedAnalyses) {
            const mistakes = Array.isArray(analysis.structuredJson?.keyMistakes) ? analysis.structuredJson.keyMistakes : [];
            for (const mistake of mistakes) {
                const category = categoryFromMistake(String(mistake.claim || ''));
                mistakeCounts[category] = (mistakeCounts[category] || 0) + 1;
            }
        }
        addFact('mistakes', `Recurring keyMistake categories from stored focus analyses: ${Object.entries(mistakeCounts).map(([k, v]) => `${k}: ${v}`).join(', ') || 'no stored focus analyses yet'}.`, { mistakeCounts });

        const planGrades = coachingDbService.getRecentPlanGrades(user.steamId, 20);
        const totalPlanChecks = planGrades.length;
        const itemPasses = planGrades.filter((grade) => grade.resultsJson?.itemRule?.passed).length;
        const fightGrades = planGrades.filter((grade) => grade.resultsJson?.fightRule?.passed !== null && grade.resultsJson?.fightRule?.passed !== undefined);
        const fightPasses = fightGrades.filter((grade) => grade.resultsJson?.fightRule?.passed).length;
        const conversionGrades = planGrades.filter((grade) =>
            grade.resultsJson?.conversionRule?.evidence
            && !['no explicit conversion target', 'teamfight data unavailable'].includes(grade.resultsJson.conversionRule.evidence)
        );
        const conversionPasses = conversionGrades.filter((grade) => grade.resultsJson?.conversionRule?.passed).length;
        addFact('plans', `Plan compliance checks: ${totalPlanChecks} graded plans; item-rule pass ${itemPasses}/${totalPlanChecks}; fight-rule pass ${fightPasses}/${fightGrades.length}; conversion-rule pass ${conversionPasses}/${conversionGrades.length}.`, { totalPlanChecks, itemPasses, fightPasses, fightChecks: fightGrades.length, conversionPasses, conversionChecks: conversionGrades.length });

        const notes = coachingDbService.getRecentPlayerNotes(user.steamId, 10);
        if (notes.length) {
            addFact('playerNotes', `Recent user-provided context notes from the last 30 days: ${notes.map((note) => `user-provided claim${note.matchId ? ` for match #${note.matchId}` : ''}: "${note.text}"`).join(' | ')}. Treat these as player claims, not API facts.`);
        }

        const coachFacts = {
            source: 'OpenDota recent matches + stored focus analyses + deterministic plan grades',
            generatedAt: new Date().toISOString(),
            steamId: user.steamId,
            facts,
        };
        const ai = await callCoachAI(`Synthesize this coaching trend report using only COACH_FACTS.\n\nCOACH_FACTS:\n${JSON.stringify(coachFacts, null, 2)}`);
        const sampleText = `${matches.length} matches • avg duration ${formatDuration(Math.round(matches.reduce((s, m) => s + m.duration, 0) / matches.length))}`;
        coachingDbService.saveCoachReport({ steamId: user.steamId, reportJson: ai, sampleText });
        await message.reply({ embeds: [buildCoachEmbed(ai, targetUser, sampleText)] });
    } catch (error: any) {
        logger.error('Error in coach command:', error?.response?.data || error);
        await message.reply(`Coach report failed: ${error?.message || 'unknown error'}`);
    }
}
