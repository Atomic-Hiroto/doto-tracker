import { Message, EmbedBuilder } from 'discord.js';
import { AIConstants, ProcessConstants } from '../constants';
import { logger } from '../services/loggerService';
import { opendotaClient } from '../services/apiClient';
import { dotaDataService } from '../services/dotaDataService';
import { getDetailedMatchData, requestMatchParse, waitForMatchParse } from '../services/dotaService';
import { fetchStratzMatch, waitForStratzParse } from '../services/stratzClient';
import { fetchDotabuffTurboMeta } from '../services/dotabuffScraper';
import { formatDuration } from '../utils/formatters';
import { safeTyping, safeSend } from '../utils/channelHelpers';
import axios from 'axios';

// Discord embed field values are capped at 1024 chars
const trunc = (s: string, max = 1024) => s.length > max ? s.slice(0, max - 1) + '…' : s;
const ANALYZE_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const analyzeCache = new Map<string, { createdAt: number; data: any; source: string; model: string }>();

async function callAI(
    systemPrompt: string,
    userPrompt: string,
    opts?: { model?: string; params?: Record<string, any>; response_format?: any; useWeb?: boolean }
): Promise<string> {
    const model = opts?.model ?? AIConstants.AI_MODEL;
    const params = opts?.params ?? AIConstants.AI_PARAMS;
    const useWeb = opts?.useWeb ?? true;

    const body: Record<string, any> = {
        model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        ...params
    };
    if (useWeb) {
        // Web search is useful for meta commands, but +analyze disables it so match facts stay isolated.
        body.plugins = [{ id: 'web', max_results: 3 }];
    }
    if (opts?.response_format) {
        body.response_format = opts.response_format;
        // For structured output: use response-healing to auto-fix malformed JSON.
        body.plugins = useWeb
            ? [{ id: 'web', max_results: 3 }, { id: 'response-healing' }]
            : [{ id: 'response-healing' }];
    }

    try {
        const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            body,
            {
                headers: {
                    Authorization: `Bearer ${ProcessConstants.OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://github.com/Atomic-Hiroto/doto-tracker',
                    'X-Title': 'Doto Tracker',
                },
            }
        );

        const content = response.data?.choices?.[0]?.message?.content;
        if (Array.isArray(content)) {
            return content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trimStart();
        }
        return (content || '').trimStart();
    } catch (err: any) {
        const status = err?.response?.status;
        const errBody = err?.response?.data?.error?.message || err?.response?.data?.error || err?.message;
        logger.error(`callAI failed [${model}] HTTP ${status}:`, errBody);
        throw new Error(`AI API error (HTTP ${status}): ${errBody}`);
    }
}

const COACH_SYSTEM = `You are doto-chan, a Dota 2 expert who is a spicy but genuinely helpful anime coach. You give blunt, direct advice with roasty humor but always with real insight. You know the game deeply based on the latest patch — timings, drafts, itemization, matchups. Keep responses concise and actionable.`;

// ── System prompt for fact-grounded match analysis ────────────────────────────
const ANALYZE_SYSTEM = `You are doto-chan, a Dota 2 match analyst. You receive a MATCH_FACTS JSON object produced by deterministic code. Your job is to explain those facts, not to invent new ones.

## Source Of Truth
- Use ONLY facts from MATCH_FACTS.
- Major claims must include at least one evidence id like [F12].
- Do not mention a player, hero, item, objective, timing, draft event, or stat unless it appears in MATCH_FACTS.
- If data is absent or marked unavailable, say it is unavailable instead of guessing.

## Reasoning Style
- Write like an analyst, not a stat dump: every section should explain what the facts meant for how the game played out.
- You may infer strategic conclusions such as "damage profile problem", "map collapse", "timing window", or "failed initiation", but tie each conclusion to concrete evidence.
- Exact numbers, counts, timings, structure totals, and damage splits must be copied from facts. Do not calculate new totals, approximate durations, or combine categories unless a fact already did it.
- If you use a qualitative label like "physical-heavy", "magic burst", "vision control", or "tower cascade", cite the team damage, utility, or objective-cluster fact that justifies it.
- Do not add player damage values together. Combined damage claims are allowed only when MATCH_FACTS has an explicit combined-damage fact.

## Analysis Order
1. Match arc: winner, duration, game mode, decisive economy or objective swings.
2. Composition and lanes: use DRAFT_ORDER only when present; otherwise discuss picked team compositions and lane evidence only.
3. Items and damage: use item timing/final inventory facts; never claim an item timing unless a fact states it.
4. Objectives and map control: towers, barracks, Roshan, wards, dewards, rune pressure.
5. Player accountability: explain MVP/LVP using concrete stats and timings.

## Hard Rules
- For Turbo/All Pick, never discuss bans unless MATCH_FACTS.draft.reliableDraft is true and DRAFT_ORDER facts exist.
- Do not convert raw API counters into seconds, counts, or confirmed events unless MATCH_FACTS already did that conversion.
- Do not invent structure language like "all structures" or "24 structures"; use the exact tower/barracks wording from MATCH_FACTS.
- Do not mix tower clusters with barracks or Ancient damage. Objective-cluster facts are towers only unless they explicitly say otherwise.
- Do not say "Ancient fell" or name a final building unless MATCH_FACTS explicitly contains that building event.
- Do not use web/meta knowledge for match facts. Patch context may explain broad strategic context only if MATCH_FACTS.patchContext is present.
- Every player on the losing team should receive at least a brief mention somewhere across the analysis if the output length allows.
- Keep the spicy style, but every roast needs a real stat behind it.

## Perspective
- Never print an unlabeled +/- lead. Always name the side: "Dire led by 30,383", not "-30,383".
- When a focus player is set, frame all economy / XP / lead facts from that player's team's point of view.

## Focus Mode
- Center the whole analysis on the focus player. Other heroes appear only as context for what that player faced or should have done.
- Order the report around their game: laning -> item timings -> fights they were in -> their deaths -> result.
- Lead the narrative with their individual arc, not the match's.
- If MATCH_FACTS contains benchmark facts for this player, use them explicitly as percentile context.
- If benchmark facts are absent, do not invent a benchmark.

## Data Honesty
- Use only facts in MATCH_FACTS.
- If a stat is absent, such as lane CS, state it is unavailable in one short clause and move on.
- If only some of a player's death timings are listed, report the count honestly: "1 of 8 deaths is timestamped", not language implying all deaths are explained.

## Mistake Objects
- keyMistakes must be an array of ranked objects.
- Severity must be one of: "game-losing", "costly", "minor".
- Each mistake needs: claim, evidence, severity, fix.
- The fix must chain mistake -> consequence -> specific alternative using only facts on the sheet.

## Length Budget
- Whole-match mode: write a complete but compact recap that fits one Discord embed. Use 2 sentences for narrative, draft/laning, items/damage, and map control; use exactly 2 keyMistakes unless the third is truly decisive.
- Personal coaching mode: you may be more detailed, especially in keyMistakes and whatToImprove, but stay focused on the target player. Use 2-3 keyMistakes.
- Do not list every stat that appears in MATCH_FACTS. Pick the facts that explain the result.

## Output Exemplar
For a stomp:
{
  "gameNarrative": "**Dire** won because the economy graph turned once and never came back: the net worth lead flipped by 7m and peaked at -28,000 by 18m [F6]. The tower cluster at 14:10-15:22 shows the map collapsing immediately after that swing, not a slow loss [F12].",
  "draftAndLaning": "Radiant had physical cores but their lane CS did not create a usable timing; Dire's magic-heavy damage profile punished every defensive move [F4][F8].",
  "itemizationAndDamage": "**Axe**'s 6:02 Blink timing mattered because it arrived before Radiant's BKBs, turning the next two death clusters into objectives [F20][F31].",
  "keyMistakes": [{ "claim": "Radiant kept fighting before defensive items were online.", "evidence": ["F20", "F31"], "severity": "game-losing", "fix": "After the 6:02 Blink reveal, Radiant needed to dodge the next wave and trade side lanes; taking the fight fed the tower cluster that broke the map." }],
  "mapControl": "Dire's ward and deward edge mattered because it overlapped with the tower window, so Radiant were defending blind rather than merely losing fights [F14][F29].",
  "mvpAndStandouts": "**MVP: Player - Hero** - One sentence with stats and evidence.\\n**LVP: Player - Hero** - One sentence with stats and evidence.\\n**Honorable Mention: Player - Hero** - One sentence with stats and evidence.",
  "whatToImprove": "The losing team needed to skip the doomed fight after the item timing and trade the opposite lane, because the actual consequence was a tower cluster, not just one bad death [F20][F31]."
}

Use Discord markdown. Keep each schema field concise, but prioritize correctness over jokes.`;

// ── Structured output schema for +analyze ────────────────────────────────────
const ANALYZE_RESPONSE_FORMAT = {
    type: 'json_schema' as const,
    json_schema: {
        name: 'match_analysis',
        strict: true,
        schema: {
            type: 'object',
            properties: {
                gameNarrative: {
                    type: 'string',
                    description: 'The story of this match in 2-4 concise sentences. Use concrete economy/objective/timing facts and include evidence ids like [F12]. Do not mention Ancient/final buildings unless a fact explicitly says so. Use **bold** for player and hero names.',
                },
                draftAndLaning: {
                    type: 'string',
                    description: 'Combined composition/draft + laning analysis in 2-3 sentences. If reliableDraft is false, never discuss bans; use picked heroes and lane facts only. Qualitative lineup claims must cite team damage/profile facts. Include evidence ids.',
                },
                itemizationAndDamage: {
                    type: 'string',
                    description: 'Analyze item choices, item timings, final inventories, and exact damage profile in 2-3 sentences. Only mention items/timings/damage numbers present in facts. Combined damage claims require an explicit combined-damage fact. Include evidence ids.',
                },
                keyMistakes: {
                    type: 'array',
                    description: 'The 2-3 biggest mistakes ranked by game impact.',
                    items: {
                        type: 'object',
                        properties: {
                            claim: { type: 'string', description: 'A concrete mistake claim with no unsupported numbers.' },
                            evidence: { type: 'array', items: { type: 'string' }, description: 'Evidence ids like F7, without brackets.' },
                            severity: { type: 'string', enum: ['game-losing', 'costly', 'minor'] },
                            fix: { type: 'string', description: 'Counterfactual coaching: mistake -> consequence -> specific alternative.' },
                        },
                        required: ['claim', 'evidence', 'severity', 'fix'],
                        additionalProperties: false,
                    },
                },
                mvpAndStandouts: {
                    type: 'string',
                    description: 'Format EXACTLY like this with NEWLINES and evidence ids:\\n**MVP: Player — Hero** - 1 sentence on why.\\n**LVP: Player — Hero** - 1 sentence on why.\\n**Honorable Mention: Player — Hero** - 1 sentence on why.',
                },
                mapControl: {
                    type: 'string',
                    description: 'Analyze vision, dewards, rune control, Roshan/Aegis, and exact tower/barracks/objective-cluster facts. Objective clusters are towers only unless a fact says otherwise. Do not infer barracks timings from final structure totals. 2-3 sentences max. Include evidence ids.',
                },
                whatToImprove: {
                    type: 'string',
                    description: 'One direct sentence on what the losing team should have done differently, grounded in one or more evidence ids.',
                },
            },
            required: ['gameNarrative', 'draftAndLaning', 'itemizationAndDamage', 'keyMistakes', 'mvpAndStandouts', 'mapControl', 'whatToImprove'],
            additionalProperties: false,
        },
    },
};

const ANALYZE_FOCUS_RESPONSE_FORMAT = {
    type: 'json_schema' as const,
    json_schema: {
        name: 'player_match_coaching',
        strict: true,
        schema: {
            type: 'object',
            properties: {
                focusSummary: {
                    type: 'string',
                    description: '2-3 sentences about the focused player only: their team, hero, result, role in the win/loss, and the decisive personal arc. Include evidence ids.',
                },
                laneAndFarm: {
                    type: 'string',
                    description: 'Focused-player laning/farm analysis from CS, denies, net worth, GPM/XPM, lane report, and benchmark facts when available. Do not write a whole-team recap. Include evidence ids.',
                },
                timingsAndItems: {
                    type: 'string',
                    description: 'Focused-player item timings/final inventory and how those timings changed fights or objectives. Include evidence ids.',
                },
                fightsAndDeaths: {
                    type: 'string',
                    description: 'Focused-player combat and death review. Use all-death timing facts when present, plus leverage-ranked events. Include evidence ids.',
                },
                benchmarkCheck: {
                    type: 'string',
                    description: 'Compare focused player to available OpenDota benchmark percentiles. If benchmarks are unavailable, say unavailable and use replay facts instead. Include evidence ids when available.',
                },
                keyMistakes: {
                    type: 'array',
                    description: '2-3 focused-player mistakes ranked by impact.',
                    items: {
                        type: 'object',
                        properties: {
                            claim: { type: 'string', description: 'A concrete focused-player mistake claim with no unsupported numbers.' },
                            evidence: { type: 'array', items: { type: 'string' }, description: 'Evidence ids like F7, without brackets.' },
                            severity: { type: 'string', enum: ['game-losing', 'costly', 'minor'] },
                            fix: { type: 'string', description: 'Counterfactual coaching: mistake -> consequence -> specific alternative.' },
                        },
                        required: ['claim', 'evidence', 'severity', 'fix'],
                        additionalProperties: false,
                    },
                },
                nextGamePlan: {
                    type: 'string',
                    description: 'A concrete next-game plan for the focused player: lane/farm target, item/timing target, fight rule, and one avoidable death pattern. Include evidence ids.',
                },
            },
            required: ['focusSummary', 'laneAndFarm', 'timingsAndItems', 'fightsAndDeaths', 'benchmarkCheck', 'keyMistakes', 'nextGamePlan'],
            additionalProperties: false,
        },
    },
};

function stripEvidenceMarkers(text: string): string {
    return text.replace(/\s*\[F\d+\]/g, '').replace(/\s{2,}/g, ' ').trim();
}

function maybeStripEvidence(value: any, debug: boolean): any {
    if (debug) return value;
    if (typeof value === 'string') return stripEvidenceMarkers(value);
    if (Array.isArray(value)) return value.map((item) => maybeStripEvidence(item, debug));
    if (value && typeof value === 'object') {
        const next: any = {};
        for (const [key, nested] of Object.entries(value)) {
            next[key] = key === 'evidence' ? nested : maybeStripEvidence(nested, debug);
        }
        return next;
    }
    return value;
}

function formatMistakes(mistakes: any, debug: boolean): string {
    if (!Array.isArray(mistakes)) return String(mistakes || 'No mistakes returned.');
    return mistakes.map((mistake, idx) => {
        const evidence = debug && Array.isArray(mistake.evidence) && mistake.evidence.length
            ? ` [${mistake.evidence.join('][')}]`
            : '';
        const severity = mistake.severity ? `**${mistake.severity}**` : `**#${idx + 1}**`;
        const claim = debug ? mistake.claim : stripEvidenceMarkers(String(mistake.claim || ''));
        const fix = debug ? mistake.fix : stripEvidenceMarkers(String(mistake.fix || ''));
        return `${idx + 1}. ${severity}: ${claim}${evidence}\nFix: ${fix}`;
    }).join('\n');
}

function limitText(text: any, max: number): string {
    const value = String(text || '').trim();
    if (value.length <= max) return value;
    const slice = value.slice(0, max - 1);
    const sentenceEnd = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
    if (sentenceEnd > Math.floor(max * 0.55)) {
        return slice.slice(0, sentenceEnd + 1).trim();
    }
    const wordEnd = slice.lastIndexOf(' ');
    return `${slice.slice(0, wordEnd > Math.floor(max * 0.55) ? wordEnd : max - 1).trim()}...`;
}

function formatSections(data: any, debug: boolean, focusMode: boolean): string[] {
    const display = maybeStripEvidence(data, debug);
    if (focusMode && data.focusSummary) {
        const limits = { summary: 700, lane: 620, items: 680, fights: 780, benchmarks: 520, mistakes: 1200, plan: 620 };
        return [
            `**🎯 YOUR GAME**\n${limitText(display.focusSummary, limits.summary)}`,
            `**🌱 LANE & FARM**\n${limitText(display.laneAndFarm, limits.lane)}`,
            `**⚔️ TIMINGS & ITEMS**\n${limitText(display.timingsAndItems, limits.items)}`,
            `**💀 FIGHTS & DEATHS**\n${limitText(display.fightsAndDeaths, limits.fights)}`,
            `**📊 BENCHMARK CHECK**\n${limitText(display.benchmarkCheck, limits.benchmarks)}`,
            `**🧯 KEY MISTAKES**\n${limitText(formatMistakes(data.keyMistakes, debug), limits.mistakes)}`,
            `**📝 NEXT GAME PLAN**\n${limitText(display.nextGamePlan, limits.plan)}`,
        ];
    }

    const limits = focusMode
        ? { narrative: 760, draft: 620, items: 760, mistakes: 1400, map: 620, mvp: 620, improve: 560 }
        : { narrative: 540, draft: 460, items: 560, mistakes: 860, map: 420, mvp: 520, improve: 340 };
    return [
        `**📖 GAME NARRATIVE**\n${limitText(display.gameNarrative, limits.narrative)}`,
        `**🏗️ DRAFT & LANING**\n${limitText(display.draftAndLaning, limits.draft)}`,
        `**⚔️ ITEMS & DAMAGE**\n${limitText(display.itemizationAndDamage, limits.items)}`,
        `**💀 KEY MISTAKES**\n${limitText(formatMistakes(data.keyMistakes, debug), limits.mistakes)}`,
        `**👁️ MAP CONTROL & VISION**\n${limitText(display.mapControl, limits.map)}`,
        `**🏆 MVP & STANDOUTS**\n${limitText(display.mvpAndStandouts, limits.mvp)}`,
        `**📝 WHAT TO IMPROVE**\n${limitText(display.whatToImprove, limits.improve)}`,
    ];
}

// ── Format structured analysis into a single Discord embed ────────────────────
function formatAnalysis(data: any, matchId: number, model: string, source: string, opts: { debug?: boolean; focusPlayer?: string; cached?: boolean } = {}): EmbedBuilder[] {
    const debug = !!opts.debug;
    const focusMode = !!opts.focusPlayer;
    const sections = formatSections(data, debug, focusMode);
    const title = `🔍 Match Analysis — #${matchId}${opts.focusPlayer ? ` — ${opts.focusPlayer}` : ''}`;
    const footer = `doto-chan coaching • ${source}${opts.cached ? ' • cached' : ''}${debug ? ' • debug facts' : ''} • ${model}`;

    const makeEmbed = (description: string, suffix = '') => new EmbedBuilder()
        .setColor('#ef4444')
        .setTitle(`${title}${suffix}`)
        .setDescription(trunc(description, 4096))
        .setURL(`https://www.opendota.com/matches/${matchId}`)
        .setFooter({ text: footer })
        .setTimestamp();

    if (!focusMode) {
        return [makeEmbed(sections.join('\n\n'))];
    }

    const first = sections.slice(0, 4).join('\n\n');
    const second = sections.slice(4).join('\n\n');
    return second.trim()
        ? [makeEmbed(first, ' — 1/2'), makeEmbed(second, ' — 2/2')]
        : [makeEmbed(first)];
}

async function sendAnalysisEmbeds(message: Message, embeds: EmbedBuilder[]) {
    if (!embeds.length) return null;
    const [first, ...rest] = embeds;
    const reply = await message.reply({ embeds: [first] });
    for (const embed of rest) {
        await safeSend(message.channel, { embeds: [embed] });
    }
    return reply;
}

const BOT_OWNER_ID = '78168838910246912';

export async function analyze(message: Message, args: string[]) {
    // Parse flags: -model <model_name> (owner-only), -stratz
    let modelOverride: string | null = null;
    let useStratz = false;
    let debugFacts = false;
    let forceRedo = false;
    const cleanArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '-model' && args[i + 1]) {
            if (message.author.id === BOT_OWNER_ID) {
                modelOverride = args[i + 1];
                i++; // skip the model name arg
            } else {
                return message.reply('❌ Model override is restricted to the bot owner.');
            }
        } else if (args[i] === '-od' || args[i] === '-opendota') {
            useStratz = false; // explicitly disable stratz
        } else if (args[i] === '-stratz') {
            useStratz = true;
        } else if (args[i] === '-debug' || args[i] === '--debug') {
            if (message.author.id !== BOT_OWNER_ID) {
                return message.reply('❌ Debug facts are restricted to the bot owner.');
            }
            debugFacts = true;
        } else if (args[i] === '-redo' || args[i] === '--redo') {
            forceRedo = true;
        } else {
            cleanArgs.push(args[i]);
        }
    }

    // Default to Stratz if not explicitly disabled or if -stratz is present
    // We only use OD if -od is passed or if Stratz fetch fails later
    if (!args.includes('-od') && !args.includes('-opendota')) {
        useStratz = true;
    }

    const matchId = parseInt(cleanArgs[0], 10);
    if (!cleanArgs[0] || isNaN(matchId)) {
        return message.reply('Usage: `+analyze <match_id> [player]` — give me a match ID to dissect! 🔍\nOwner-only: `+analyze <match_id> -model <openrouter_model> -debug`');
    }
    const focusPlayerQuery = cleanArgs.slice(1).join(' ').trim();
    const mode = focusPlayerQuery ? 'player' : 'match';
    const requestedSource = useStratz ? 'stratz' : 'opendota';
    const useModel = modelOverride || AIConstants.AI_ANALYZE_MODEL;
    const cacheKey = `${matchId}:${requestedSource}:${mode}:${focusPlayerQuery.toLowerCase()}:${useModel}`;
    const cached = analyzeCache.get(cacheKey);
    if (!forceRedo && cached && Date.now() - cached.createdAt < ANALYZE_CACHE_TTL_MS) {
        const embeds = formatAnalysis(cached.data, matchId, cached.model, cached.source, {
            debug: debugFacts,
            focusPlayer: focusPlayerQuery || undefined,
            cached: true,
        });
        return sendAnalysisEmbeds(message, embeds);
    }

    try {
        safeTyping(message.channel);

        // ── Determine which data source to use ───────────────────────────────
        let prompt = '';
        let resolvedFocusPlayer: string | undefined;
        if (useStratz) {
            let stratzMatch = await fetchStratzMatch(matchId);

            // ── Stratz Polling: if not parsed, poll ─────────────────────────
            if (!stratzMatch || !stratzMatch.parsedDateTime) {
                const isError = !stratzMatch;
                const waitEmbed = new EmbedBuilder()
                    .setColor(isError ? '#f59e0b' : '#0ea5e9')
                    .setTitle(isError ? '⚠️ Stratz API Issue' : '⏳ Stratz: Parsing Match...')
                    .setDescription(
                        isError 
                            ? `I'm having trouble reaching Stratz or the query is too heavy. I'll keep trying...\n` +
                              `Match **#${matchId}** status unknown.`
                            : `Match **#${matchId}** isn't parsed on Stratz yet.\n` +
                              `I'm waiting for Stratz to finish processing the replay — I'll update this automatically.\n\n` +
                              `⏳ Waiting for parse... (this usually takes 30s–2min)`
                    )
                    .setFooter({ text: 'Polling Stratz every 20s • Max 5 min' });

                const waitMsg = await message.reply({ embeds: [waitEmbed] });
                try { await message.react('⏳'); } catch { /* ignore */ }

                const parsed = await waitForStratzParse(matchId, {
                    onTick: (attempt, max) => {
                        const elapsed = attempt * 20;
                        waitEmbed.setDescription(
                            `Match **#${matchId}** isn't fully ready yet.\n` +
                            `Still waiting... (${elapsed}s elapsed, attempt ${attempt}/${max})`
                        );
                        waitMsg.edit({ embeds: [waitEmbed] }).catch(() => { });
                    }
                });

                try {
                    await message.reactions.cache.get('⏳')?.users.remove(message.client.user!);
                } catch { /* ignore */ }

                if (!parsed) {
                    try { await message.react('❌'); } catch { /* ignore */ }
                    waitEmbed
                        .setColor('#ef4444')
                        .setTitle('❌ Stratz Parse Timeout')
                        .setDescription(
                            `Stratz is taking too long to parse **#${matchId}**.\n` +
                            `Falling back to OpenDota analysis...`
                        );
                    await waitMsg.edit({ embeds: [waitEmbed] });
                    useStratz = false; // Fallback to OD logic below
                } else {
                    try { await message.react('✅'); } catch { /* ignore */ }
                    waitEmbed
                        .setColor('#22c55e')
                        .setTitle('✅ Stratz Ready!')
                        .setDescription(`Match **#${matchId}** data is now available on Stratz — analyzing...`);
                    await waitMsg.edit({ embeds: [waitEmbed] });
                    
                    safeTyping(message.channel);
                    stratzMatch = await fetchStratzMatch(matchId);
                }
            }

            if (useStratz && stratzMatch) {
                const openDotaMatch = await opendotaClient.get(`/matches/${matchId}`)
                    .then((res) => res.data)
                    .catch((error) => {
                        logger.warn(`[+analyze] OpenDota merge unavailable for ${matchId}:`, error?.message || error);
                        return null;
                    });
                const built = await buildAnalyzeFactPrompt(stratzMatch, openDotaMatch, { focusPlayerQuery });
                prompt = built.prompt;
                resolvedFocusPlayer = built.focusPlayerLabel;
            }
        }

        // ── Fallback or Explicit OpenDota Logic ─────────────────────────────
        if (!useStratz) {
            const matchData = await getDetailedMatchData(matchId);
            if (!matchData) {
                return message.reply(`❌ Could not fetch data from OpenDota for match **${matchId}**.`);
            }

            // ── Build structured prompt with clear sections ─────────────────────

            // Match summary header
            const winner = matchData.radiantWin ? 'Radiant' : 'Dire';
            const summaryParts = [
                `Match #${matchData.matchId}`,
                `Duration: ${formatDuration(matchData.duration)}`,
                `Winner: ${winner}`,
                matchData.radiantScore != null ? `Score: Radiant ${matchData.radiantScore} — Dire ${matchData.direScore}` : '',
                matchData.skillBracket ? `Bracket: ${matchData.skillBracket}` : '',
                matchData.firstBloodTime != null ? `First Blood: ${formatDuration(matchData.firstBloodTime)}` : '',
                matchData.comeback ? `Comeback: ${matchData.comeback.toLocaleString()} gold deficit overcome` : '',
                matchData.throw ? `Throw: ${matchData.throw.toLocaleString()} gold lead squandered` : '',
                `Game Mode: ${matchData.gameMode}`,
            ].filter(Boolean);

            // Draft block — only relevant for Captain's Mode (2) or Captain's Draft (16)
            const hasDraft = matchData.gameModeId === 2 || matchData.gameModeId === 16;
            const draftBlock = (hasDraft && matchData.draft?.length)
                ? `\n=== DRAFT ORDER ===\n${matchData.draft.map((d: any) =>
                    `${d.order + 1}. ${d.team} ${d.isPick ? 'PICK' : 'BAN'}: ${d.heroName}`
                ).join('\n')}`
                : '';

            // Player blocks with all new fields
            const playerBlock = matchData.players.map((p: any) => {
                const header = [
                    `[${p.team}] ${p.name} — ${p.heroName}`,
                    p.heroVariant ? `(Facet ${p.heroVariant})` : '',
                    `(${p.lane}${p.isRoaming ? ' Roam' : ''})`
                ].filter(Boolean).join(' ');

                const lines = [
                    header,
                    `  KDA: ${p.kills}/${p.deaths}/${p.assists} (${p.kda}) | Lvl: ${p.level || '?'} | NW: ${(p.netWorth ?? 0).toLocaleString()} | GPM: ${p.gpm ?? '?'} | XPM: ${p.xpm ?? '?'}`,
                    `  Dmg: ${(p.heroDamage ?? 0).toLocaleString()} | Tower: ${(p.towerDamage ?? 0).toLocaleString()} | Heal: ${(p.heroHealing ?? 0).toLocaleString()} | LH: ${p.lastHits ?? '?'} | DN: ${p.denies ?? 0}`,
                    `  Items: ${p.items?.length ? p.items.join(', ') : 'None'}`,
                ];

                // Only include if data exists
                if (p.backpack?.length) lines.push(`  Backpack: ${p.backpack.join(', ')}`);
                if (p.buybacks > 0) {
                    const buybackTimes = p.buybackLog?.length
                        ? ` (at ${p.buybackLog.map((bb: any) => formatDuration(bb.time)).join(', ')})`
                        : '';
                    lines.push(`  Buybacks: ${p.buybacks}${buybackTimes}`);
                }
                if (p.obsPlaced > 0 || p.senPlaced > 0 || p.obsKilled > 0 || p.senKilled > 0) {
                    lines.push(`  Vision: ${p.obsPlaced} obs / ${p.senPlaced} sen placed | ${p.obsKilled} obs / ${p.senKilled} sen destroyed`);
                }
                if (p.runePickups > 0) {
                    const importantRunes = p.runesLog?.filter((r: any) => r.key === 5 || r.key === 7) // 5=bounty, 7=wisdom in some maps, or wait: 5=bounty etc (rough filter). We will just show count.
                        .length;
                    lines.push(`  Runes: ${p.runePickups} total pickups`);
                }
                if (p.permanentBuffs?.length) lines.push(`  Buffs: ${p.permanentBuffs.join(', ')}`);

                // Multi-kills and streaks
                if (p.multiKills) lines.push(`  Multi-kills: ${p.multiKills}`);
                if (p.killStreaks) lines.push(`  Max Kill Streak: ${p.killStreaks}`);

                // Farming stats
                const farmStats: string[] = [];
                if (p.campsStacked > 0) farmStats.push(`Stacked: ${p.campsStacked}`);
                if (p.neutralKills > 0) farmStats.push(`Jungle: ${p.neutralKills}`);
                if (p.towerKills > 0) farmStats.push(`Tower Kills: ${p.towerKills}`);
                if (p.roshanKills > 0 || p.aegisPickups > 0) farmStats.push(`Roshan: ${p.roshanKills} kills / ${p.aegisPickups} aegis`);
                if (farmStats.length) lines.push(`  Farming: ${farmStats.join(' | ')}`);

                // Key item timings
                if (p.keyItemTimings?.length) {
                    const timings = p.keyItemTimings.map((t: any) =>
                        `${t.item.replace(/_/g, ' ')} @ ${formatDuration(t.time)}`
                    ).join(', ');
                    lines.push(`  Item Timings: ${timings}`);
                }

                // Kill timeline
                if (p.killTimeline?.length) {
                    const kills = p.killTimeline
                        .filter((k: any) => k.time >= 0)
                        .map((k: any) =>
                            `${formatDuration(k.time)} ${k.victim.replace(/_/g, ' ')}`
                        ).join(', ');
                    if (kills) lines.push(`  Kills: ${kills}`);
                }

                // Extra stats line
                const extras: string[] = [];
                if (p.laneEfficiency != null) extras.push(`Lane Eff: ${p.laneEfficiency}%`);
                if (p.apm > 0) extras.push(`APM: ${p.apm}`);
                if (p.timeSpentDead > 0) extras.push(`Dead: ${p.timeSpentDead}s`);
                if (p.teamfightParticipation != null) extras.push(`TF: ${p.teamfightParticipation}%`);
                if (p.stunDuration > 0) extras.push(`Stuns: ${p.stunDuration}s`);
                if (p.leaverStatus >= 2) extras.push(`⚠️ ABANDONED`);
                if (extras.length) lines.push(`  ${extras.join(' | ')}`);

                // Top damage abilities
                if (p.topDamageAbilities?.length) {
                    const abilities = p.topDamageAbilities.map((a: any) =>
                        `${a.ability} (${a.damage.toLocaleString()})`
                    ).join(', ');
                    lines.push(`  Dmg Sources: ${abilities}`);
                }

                // Damage received
                if (p.damageReceived?.length) {
                    const recv = p.damageReceived.map((r: any) =>
                        `${r.ability} (${r.damage.toLocaleString()})`
                    ).join(', ');
                    lines.push(`  Dmg Received: ${recv}`);
                }

                // Damage dealt to each enemy hero
                if (p.damageToHeroes?.length) {
                    const targets = p.damageToHeroes.map((t: any) =>
                        `${t.hero} (${t.damage.toLocaleString()})`
                    ).join(', ');
                    lines.push(`  Dmg Targets: ${targets}`);
                }

                // Max hero hit
                if (p.maxHeroHit) {
                    lines.push(`  Biggest Hit: ${p.maxHeroHit.value.toLocaleString()} dmg (${p.maxHeroHit.inflictor} on ${p.maxHeroHit.target})`);
                }

                // Net worth curve (sampled)
                if (p.goldCurve?.length) lines.push(`  Gold Curve: ${p.goldCurve.join(' → ')}`);

                // Benchmarks
                const benchKeys = Object.keys(p.benchmarks || {});
                if (benchKeys.length > 0) {
                    const bStr = benchKeys.map(k => `${k}: ${p.benchmarks[k]}`).join(', ');
                    lines.push(`  Benchmarks: ${bStr}`);
                }

                return lines.join('\n');
            }).join('\n\n');

            // Party groupings
            const parties = new Map<number, string[]>();
            for (const p of matchData.players) {
                if (p.partyId != null) {
                    if (!parties.has(p.partyId)) parties.set(p.partyId, []);
                    parties.get(p.partyId)!.push(p.name);
                }
            }
            const partyBlock = Array.from(parties.values())
                .filter(members => members.length > 1)
                .map(members => `Party: ${members.join(' + ')}`)
                .join('\n');

            const goldGraph = matchData.goldAdvantage?.length
                ? `\n=== GOLD ADVANTAGE (Radiant perspective) ===\n${matchData.goldAdvantage.join(' → ')}`
                : '';

            const xpGraph = matchData.xpAdvantage?.length
                ? `\n=== XP ADVANTAGE (Radiant perspective) ===\n${matchData.xpAdvantage.join(' → ')}`
                : '';

            const teamfightBlock = matchData.teamfights?.length
                ? `\n=== TEAMFIGHTS ===\n${matchData.teamfights.map((f: any) =>
                    `  ${formatDuration(f.start)}-${formatDuration(f.end)}: Radiant got ${f.radiantKills} kills, Dire got ${f.direKills} kills.\n    Radiant dead: ${f.radiantDeaths}\n    Dire dead: ${f.direDeaths}`
                ).join('\n')}`
                : '';

            const objectivesBlock = matchData.objectives?.length
                ? `\n=== OBJECTIVES ===\n${matchData.objectives.slice(0, 25).map((o: any) => {
                    const byWho = o.player !== 'Unknown' ? ` (by ${o.player})` : '';
                    return `${formatDuration(o.time)} ${o.team} ${o.type}${o.key ? ' (' + o.key + ')' : ''}${byWho}`;
                }).join(', ')}`
                : '';

            prompt = `Analyze this Dota 2 match:

=== MATCH SUMMARY ===
${summaryParts.join(' | ')}
${draftBlock}
${partyBlock ? `\n=== PARTIES ===\n${partyBlock}` : ''}

=== PLAYERS ===
${playerBlock}
${goldGraph}
${xpGraph}
${teamfightBlock}
${objectivesBlock}

Analyze this match. Fill each schema field with CONCISE, data-backed analysis. Reference specific numbers from the data above. Use Discord markdown (**bold** for names). Be direct and spicy. STRICT LIMIT: 250 words total across all fields. Each field 2-4 sentences max.`;
        }

        // Debug: log the full prompt so we can inspect what the model receives
        logger.debug(`[+analyze] System prompt:\n${ANALYZE_SYSTEM}`);
        logger.debug(`[+analyze] User prompt (${prompt.length} chars):\n${prompt}`);

        if (modelOverride) {
            logger.info(`[+analyze] Owner model override: ${modelOverride}`);
        }

        const response = await callAI(ANALYZE_SYSTEM, prompt, {
            model: useModel,
            params: modelOverride ? { ...AIConstants.AI_ANALYZE_PARAMS, max_tokens: 16000 } : AIConstants.AI_ANALYZE_PARAMS,
            response_format: resolvedFocusPlayer ? ANALYZE_FOCUS_RESPONSE_FORMAT : ANALYZE_RESPONSE_FORMAT,
            useWeb: false,
        });

        // Parse structured JSON response
        let analysisData: any;
        try {
            analysisData = JSON.parse(response);
        } catch (parseErr) {
            logger.error('[+analyze] Failed to parse structured response, falling back to raw text');
            logger.debug(`[+analyze] Raw response (${response.length} chars): ${response.slice(0, 500)}`);
            // Fallback: send raw text in embed if JSON parsing fails
            const fallbackText = response.trim() || 'AI returned an empty response. Try again later.';
            const fallbackEmbed = new EmbedBuilder()
                .setColor('#ef4444')
                .setTitle(`🔍 Match Analysis — #${matchId}`)
                .setDescription(trunc(fallbackText, 4096))
                .setURL(`https://www.opendota.com/matches/${matchId}`)
                .setFooter({ text: `doto-chan coaching • ${useModel}` })
                .setTimestamp();
            return message.reply({ embeds: [fallbackEmbed] });
        }

        const source = useStratz ? 'Stratz' : 'OpenDota';
        analyzeCache.set(cacheKey, { createdAt: Date.now(), data: analysisData, source, model: useModel });
        const embeds = formatAnalysis(analysisData, matchId, useModel, source, {
            debug: debugFacts,
            focusPlayer: resolvedFocusPlayer || focusPlayerQuery || undefined,
        });
        await sendAnalysisEmbeds(message, embeds);
    } catch (error: any) {
        logger.error('Error in analyze command:', error);
        const reason = error?.message?.includes('HTTP 402')
            ? 'Insufficient OpenRouter credits for Opus 4.6. Top up at <https://openrouter.ai/credits>'
            : error?.message || 'Unknown error';
        await message.reply(`❌ Analysis failed: ${reason}`);
    }
}


export async function suggest(message: Message, args: string[], userDataService: any) {
    let discordId = message.author.id;
    let targetUser = message.author;

    if (message.mentions.users.size > 0) {
        targetUser = message.mentions.users.first()!;
        discordId = targetUser.id;
    }

    const user = userDataService.getUserByDiscordId(discordId);
    if (!user) return message.reply('Player not registered. Use `+register <steamId>` first.');

    try {
        safeTyping(message.channel);

        const [recentRes, heroesRes] = await Promise.all([
            opendotaClient.get<any[]>(`/players/${user.steamId}/recentMatches?limit=15`),
            opendotaClient.get<any[]>(`/players/${user.steamId}/heroes?significant=0`),
        ]);

        const recent = recentRes.data;
        const heroes = heroesRes.data.filter((h: any) => h.games >= 3).sort((a: any, b: any) => b.games - a.games).slice(0, 10);

        const heroDetails = await Promise.all(
            heroes.map(async (h: any) => `${await dotaDataService.getHeroName(h.hero_id)} (${h.games}G, ${((h.win / h.games) * 100).toFixed(0)}%WR)`)
        );

        const avgKDA = (recent.reduce((s: number, m: any) => s + (m.kills + m.assists) / (m.deaths || 1), 0) / recent.length).toFixed(2);
        const recentHeroIds = [...new Set(recent.map((m: any) => m.hero_id))].slice(0, 5);
        const recentHeroNames = await Promise.all(recentHeroIds.map((id: number) => dotaDataService.getHeroName(id)));

        const prompt = `Player hero pool (most played): ${heroDetails.join(', ')}
Recent heroes (last 15 games): ${recentHeroNames.join(', ')}
Average KDA: ${avgKDA}

Based on their playstyle and hero pool, suggest 3 heroes they should try next. 
For each hero give:
- Hero name and role
- Why it suits their playstyle  
- One tip to get started
Keep it fun and spicy, under 200 words total.`;

        const response = await callAI(COACH_SYSTEM, prompt);

        const embed = new EmbedBuilder()
            .setColor('#8b5cf6')
            .setTitle(`🎯 Hero Suggestions — ${targetUser.username}`)
            .setDescription(response)
            .setFooter({ text: 'doto-chan has spoken. go practice.' })
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    } catch (error) {
        logger.error('Error in suggest command:', error);
        await message.reply('An error occurred generating suggestions. Please try again.');
    }
}

export async function draft(message: Message, args: string[]) {
    if (args.length === 0) {
        return message.reply('Usage: `+draft Pudge, Invoker, Anti-Mage` — list enemy heroes separated by commas');
    }

    const enemyInput = args.join(' ').split(',').map(s => s.trim()).filter(Boolean);

    if (enemyInput.length === 0) {
        return message.reply('Please provide at least one enemy hero name.');
    }

    try {
        safeTyping(message.channel);

        // Try to resolve hero IDs for context enrichment
        const resolvedEnemies = enemyInput.map(name => {
            const hero = dotaDataService.findHeroByName(name);
            return hero ? hero.localized_name : name;
        });

        const prompt = `Enemy team has: ${resolvedEnemies.join(', ')}

As a Dota 2 expert, suggest 3 counter-pick heroes with brief explanations:
For each suggest: hero name, why it counters this lineup, key item(s) to rush.
Also mention one strategy tip against this lineup.
Keep it punchy, under 200 words.`;

        const response = await callAI(COACH_SYSTEM, prompt);

        const embed = new EmbedBuilder()
            .setColor('#dc2626')
            .setTitle('⚔️ Counter-Pick Suggestions')
            .setDescription(`**Enemy lineup:** ${resolvedEnemies.join(', ')}\n\n${response}`)
            .setFooter({ text: 'doto-chan counter-pick guide' })
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    } catch (error) {
        logger.error('Error in draft command:', error);
        await message.reply('An error occurred generating counter-picks. Please try again.');
    }
}

export async function meta(message: Message) {
    const loadingMsg = await safeSend(message.channel, '⏳ Scraping Dotabuff turbo meta… (this takes ~30s)');
    try {
        safeTyping(message.channel);

        // ─── Try Dotabuff lane-specific data first ───────────────────────────────────────
        let usesDotabuff = false;
        let laneFields: { name: string; value: string; inline: boolean }[] = [];
        let turboSummary = '';

        try {
            const lanes = await fetchDotabuffTurboMeta();
            usesDotabuff = lanes.some(l => l.heroes.length > 0);

            if (usesDotabuff) {
                for (const lane of lanes) {
                    if (lane.heroes.length === 0) continue;
                    // Top 4 by win rate, min pick rate filter to avoid tiny samples
                    const top = lane.heroes
                        .filter(h => h.pickRate >= 3)
                        .sort((a, b) => b.winRate - a.winRate)
                        .slice(0, 4);
                    if (top.length === 0) continue;
                    const lines = top.map(h =>
                        `**${h.heroName}** [${h.tier}] — ${h.winRate.toFixed(1)}% WR (${h.pickRate.toFixed(1)}% pick)`
                    );
                    laneFields.push({
                        name: `📘 ${lane.positionLabel}`,
                        value: trunc(lines.join('\n')),
                        inline: true,
                    });
                }

                // Build a flat turbo summary for AI
                turboSummary = lanes.map(l => {
                    const top3 = l.heroes
                        .filter(h => h.pickRate >= 3)
                        .sort((a, b) => b.winRate - a.winRate)
                        .slice(0, 3)
                        .map(h => `${h.heroName} ${h.winRate.toFixed(1)}%`)
                        .join(', ');
                    return `${l.positionLabel}: ${top3}`;
                }).join('\n');
            }
        } catch (scrapeErr: any) {
            logger.warn('Dotabuff scrape failed, falling back to OpenDota:', scrapeErr);
            // Temporary: tell the user why we're falling back
            await safeSend(message.channel, `⚠️ Dotabuff scrape failed (falling back to OpenDota): \`${scrapeErr?.message ?? scrapeErr}\``);
        }

        // ─── Fallback: OpenDota pub + turbo totals ─────────────────────────────────────────
        const odResponse = await opendotaClient.get<any[]>('/heroStats');
        const heroStats = odResponse.data;

        const pubHeroes = heroStats
            .filter((h: any) => (h.pub_pick || 0) >= 1000)
            .sort((a: any, b: any) => (b.pub_win / (b.pub_pick || 1)) - (a.pub_win / (a.pub_pick || 1)))
            .slice(0, 8);
        const turboHeroes = heroStats
            .filter((h: any) => (h.turbo_picks || 0) >= 1000)
            .sort((a: any, b: any) => (b.turbo_wins / (b.turbo_picks || 1)) - (a.turbo_wins / (a.turbo_picks || 1)))
            .slice(0, 8);

        const [pubLines, turboLines] = await Promise.all([
            Promise.all(pubHeroes.map(async (h: any) => {
                const name = await dotaDataService.getHeroName(h.id);
                const wr = ((h.pub_win / (h.pub_pick || 1)) * 100).toFixed(1);
                return `**${name}** — ${wr}% WR (${(h.pub_pick as number).toLocaleString()} picks)`;
            })),
            Promise.all(turboHeroes.map(async (h: any) => {
                const name = await dotaDataService.getHeroName(h.id);
                const wr = ((h.turbo_wins / (h.turbo_picks || 1)) * 100).toFixed(1);
                return `**${name}** — ${wr}% WR (${(h.turbo_picks as number).toLocaleString()} picks)`;
            })),
        ]);

        // ─── AI commentary ────────────────────────────────────────────────────────
        const aiPrompt = usesDotabuff
            ? `Current Dota 2 Turbo meta by lane (Dotabuff, last 7 days):
${turboSummary}

Pub win rates (OpenDota, all modes):
${pubLines.join('\n')}

Give a punchy meta snapshot (under 220 words):
- Which lane/hero is dominating turbo right now and why
- One hero that's great in turbo specifically (fast game = good)
- One underrated turbo pick worth spamming
- One key macro tip for turbo this patch
Be specific, spicy, and opinionated.`
            : `Current Dota 2 pub meta (OpenDota):
${pubLines.join('\n')}

Turbo top heroes:
${turboLines.join('\n')}

Give a brief meta snapshot (under 200 words):
- 2-3 strongest picks and why
- Why 1-2 turbo heroes dominate
- One underrated pick
- One general strategy tip
Keep it spicy and punchy.`;

        const aiTake = await callAI(COACH_SYSTEM, aiPrompt);

        // ─── Build embed ────────────────────────────────────────────────────────────────────
        const embed = new EmbedBuilder()
            .setColor('#0ea5e9')
            .setTitle('📊 Current Meta Snapshot')
            .setURL('https://www.dotabuff.com/heroes?view=meta&mode=turbo&date=7d')
            .setTimestamp();

        if (usesDotabuff && laneFields.length > 0) {
            embed.addFields(
                ...laneFields,
                { name: '🏆 Pub Win Rates (all modes)', value: trunc(pubLines.join('\n') || 'No data'), inline: false },
                { name: '🎙️ doto-chan\'s take', value: trunc(aiTake || 'No commentary available.'), inline: false }
            );
            embed.setFooter({ text: 'Turbo data: Dotabuff (7d) • Pub data: OpenDota • doto-chan meta digest' });
        } else {
            embed.addFields(
                { name: '🏆 Pub Win Rates', value: trunc(pubLines.join('\n') || 'No data'), inline: false },
                { name: '⚡ Turbo Win Rates', value: trunc(turboLines.join('\n') || 'No data'), inline: false },
                { name: '🎙️ doto-chan\'s take', value: trunc(aiTake || 'No commentary available.'), inline: false }
            );
            embed.setFooter({ text: 'Data: OpenDota • doto-chan meta digest' });
        }

        // Delete the loading message
        if (loadingMsg) await loadingMsg.delete().catch(() => null);
        await message.reply({ embeds: [embed] });
    } catch (error) {
        logger.error('Error in meta command:', error);
        if (loadingMsg) await loadingMsg.delete().catch(() => null);
        await safeSend(message.channel, 'An error occurred fetching meta data. Please try again.');
    }
}

function formatStratzGameMode(mode: any): string {
    if (typeof mode === 'number') {
        const modes: Record<number, string> = {
            1: 'All Pick',
            2: "Captain's Mode",
            3: 'Random Draft',
            4: 'Single Draft',
            16: "Captain's Draft",
            22: 'Ranked All Pick',
            23: 'Turbo',
        };
        return modes[mode] || `Mode ${mode}`;
    }

    if (typeof mode === 'string' && mode.trim()) {
        return mode
            .replace(/_/g, ' ')
            .toLowerCase()
            .replace(/\b[a-z]/g, (char) => char.toUpperCase());
    }

    return 'Unknown';
}

function isReliableDraftMode(mode: any): boolean {
    if (typeof mode === 'number') return mode === 2 || mode === 16;
    if (typeof mode !== 'string') return false;
    const normalized = mode.replace(/[_\s-]/g, '').toUpperCase();
    return normalized.includes('CAPTAINSMODE') || normalized.includes('CAPTAINSDRAFT');
}

function countStatusBits(value: any): number | null {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return null;
    return numeric.toString(2).split('').filter((bit) => bit === '1').length;
}

type AnalyzeFact = {
    id: string;
    topic: string;
    text: string;
    data?: Record<string, any>;
};

type DamageTotals = {
    physical: number;
    magical: number;
    pure: number;
    total: number;
    playersWithBreakdown: number;
};

type TowerDeathEvent = {
    teamLost: 'Radiant' | 'Dire';
    time: number;
};

type AnalyzePromptOptions = {
    focusPlayerQuery?: string;
};

type BuiltAnalyzePrompt = {
    prompt: string;
    focusPlayerLabel?: string;
};

function finiteNumber(value: any): number | null {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function formatNumber(value: any): string {
    const numeric = finiteNumber(value);
    return numeric == null ? 'N/A' : Math.round(numeric).toLocaleString();
}

function formatFactTime(seconds: any): string {
    const value = Number(seconds);
    if (!Number.isFinite(value)) return 'unknown time';
    if (value < 0) return `pre-game ${formatDuration(Math.abs(value))}`;
    return formatDuration(value);
}

function formatTeamLead(value: number, positiveTeam: string, negativeTeam: string): string {
    const rounded = Math.abs(Math.round(value)).toLocaleString();
    if (value > 0) return `${positiveTeam} led by ${rounded}`;
    if (value < 0) return `${negativeTeam} led by ${rounded}`;
    return 'the teams were even';
}

function formatTeamSwing(value: number, positiveTeam: string, negativeTeam: string): string {
    const rounded = Math.abs(Math.round(value)).toLocaleString();
    if (value > 0) return `${rounded} toward ${positiveTeam}`;
    if (value < 0) return `${rounded} toward ${negativeTeam}`;
    return '0';
}

function formatPercent(part: number, total: number): string {
    if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return '0%';
    return `${Math.round((part / total) * 100)}%`;
}

function ordinal(n: number): string {
    const suffixes = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return `${n}${suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]}`;
}

function sampleNumberSeries(values: any[], maxPoints = 8): Array<{ minute: number; value: number }> {
    const nums = (values || [])
        .map((value, minute) => ({ minute, value: Number(value) }))
        .filter((point) => Number.isFinite(point.value));
    if (nums.length <= maxPoints) return nums;

    const selected = new Map<number, { minute: number; value: number }>();
    const step = Math.max(1, Math.floor((nums.length - 1) / (maxPoints - 1)));
    for (let i = 0; i < nums.length; i += step) {
        selected.set(nums[i].minute, nums[i]);
    }
    selected.set(nums[nums.length - 1].minute, nums[nums.length - 1]);
    return [...selected.values()].sort((a, b) => a.minute - b.minute);
}

function summarizeAdvantageSeries(
    label: string,
    values: any[],
    positiveTeam = 'Radiant',
    negativeTeam = 'Dire',
    perspectiveLabel = 'Radiant perspective'
): { text: string; data: Record<string, any> } | null {
    const nums = (values || [])
        .map((value, minute) => ({ minute, value: Number(value) }))
        .filter((point) => Number.isFinite(point.value));
    if (nums.length === 0) return null;

    const final = nums[nums.length - 1];
    const maxRadiant = nums.reduce((best, point) => point.value > best.value ? point : best, nums[0]);
    const maxDire = nums.reduce((best, point) => point.value < best.value ? point : best, nums[0]);
    const largestSwing = nums.slice(1).reduce((best, point, idx) => {
        const prev = nums[idx];
        const delta = point.value - prev.value;
        return Math.abs(delta) > Math.abs(best.delta) ? { from: prev.minute, to: point.minute, delta } : best;
    }, { from: 0, to: 0, delta: 0 });
    const radiantPositive = nums.filter((point) => point.value > 0);
    const direPositive = nums.filter((point) => point.value < 0);
    const lastRadiantPositive = radiantPositive[radiantPositive.length - 1] || null;
    const firstDirePositive = direPositive[0] || null;
    const samples = sampleNumberSeries(values).map((point) => `${point.minute}m ${formatTeamLead(point.value, positiveTeam, negativeTeam)}`);
    const leadSignText = [
        radiantPositive.length ? `${positiveTeam}-lead samples ${radiantPositive.length}, last at ${lastRadiantPositive?.minute}m` : `no ${positiveTeam}-lead samples`,
        direPositive.length ? `${negativeTeam}-lead samples ${direPositive.length}, first at ${firstDirePositive?.minute}m` : `no ${negativeTeam}-lead samples`,
    ].join('; ');

    return {
        text: `${label} (${perspectiveLabel}): final ${formatTeamLead(final.value, positiveTeam, negativeTeam)} at ${final.minute}m; max ${positiveTeam} lead ${Math.abs(Math.round(maxRadiant.value)).toLocaleString()} at ${maxRadiant.minute}m; max ${negativeTeam} lead ${Math.abs(Math.round(maxDire.value)).toLocaleString()} at ${maxDire.minute}m; largest 1-min swing ${formatTeamSwing(largestSwing.delta, positiveTeam, negativeTeam)} from ${largestSwing.from}m-${largestSwing.to}m; lead signs: ${leadSignText}.`,
        data: {
            final,
            maxRadiant,
            maxDire,
            largestSwing,
            leadSigns: {
                radiantPositiveSamples: radiantPositive.length,
                direPositiveSamples: direPositive.length,
                lastRadiantPositive,
                firstDirePositive,
            },
            samples,
        },
    };
}

function summarizeAdvantageForTeam(label: string, values: any[], team: 'Radiant' | 'Dire'): { text: string; data: Record<string, any> } | null {
    const multiplier = team === 'Radiant' ? 1 : -1;
    const adjusted = (values || []).map((value) => Number(value) * multiplier);
    const otherTeam = team === 'Radiant' ? 'Dire' : 'Radiant';
    const summary = summarizeAdvantageSeries(label, adjusted, team, otherTeam, `${team} perspective`);
    if (!summary) return null;
    return { text: summary.text, data: { ...summary.data, perspectiveTeam: team } };
}

function isImportantItemName(name: string): boolean {
    return /Divine Rapier|Black King Bar|Aghanim|Refresher|Butterfly|Daedalus|Satanic|Eye of Skadi|Heart of Tarrasque|Assault Cuirass|Mjollnir|Manta Style|Radiance|Bloodthorn|Nullifier|Silver Edge|Monkey King Bar|Abyssal Blade|Hurricane Pike|Shiva|Pipe of Insight|Crimson Guard|Lotus Orb|Aeon Disk|Gleipnir|Orchid|Scythe of Vyse|Ethereal Blade|Blink Dagger|Overwhelming Blink|Swift Blink|Arcane Blink|Boots of Travel|Desolator|Diffusal Blade|Mage Slayer|Sange|Yasha|Kaya|Hand of Midas|Helm of the Overlord|Solar Crest/i.test(name);
}

function emptyDamageTotals(): DamageTotals {
    return { physical: 0, magical: 0, pure: 0, total: 0, playersWithBreakdown: 0 };
}

function getPlayerDamageTotals(player: any): DamageTotals | null {
    const dealt = player.stats?.heroDamageReport?.dealtTotal;
    if (!dealt) return null;

    const physical = Math.max(0, finiteNumber(dealt.physicalDamage) ?? 0);
    const magical = Math.max(0, finiteNumber(dealt.magicalDamage) ?? 0);
    const pure = Math.max(0, finiteNumber(dealt.pureDamage) ?? 0);
    const total = physical + magical + pure;
    if (total <= 0) return null;

    return { physical, magical, pure, total, playersWithBreakdown: 1 };
}

function addDamageTotals(target: DamageTotals, source: DamageTotals | null): void {
    if (!source) return;
    target.physical += source.physical;
    target.magical += source.magical;
    target.pure += source.pure;
    target.total += source.total;
    target.playersWithBreakdown += source.playersWithBreakdown;
}

function formatDamageTotals(totals: DamageTotals): string {
    return [
        `physical ${formatNumber(totals.physical)} (${formatPercent(totals.physical, totals.total)})`,
        `magical ${formatNumber(totals.magical)} (${formatPercent(totals.magical, totals.total)})`,
        `pure ${formatNumber(totals.pure)} (${formatPercent(totals.pure, totals.total)})`,
        `total ${formatNumber(totals.total)}`,
    ].join(', ');
}

function collectTowerDeathEvents(matchData: any): TowerDeathEvent[] {
    const typedTowerDeaths = Array.isArray(matchData.playbackData?.buildingEvents)
        ? matchData.playbackData.buildingEvents
            .filter((event: any) => event?.type === 'TOWER' && Number(event.hp) === 0 && Number(event.time) >= 0)
            .map((tower: any) => {
                const time = finiteNumber(tower.time);
                if (time == null) return null;
                return {
                    key: `${tower.isRadiant ? 'Radiant' : 'Dire'}:${tower.indexId ?? tower.npcId ?? time}`,
                    event: {
                        teamLost: tower.isRadiant ? 'Radiant' as const : 'Dire' as const,
                        time,
                    },
                };
            })
            .filter((row: { key: string; event: TowerDeathEvent } | null): row is { key: string; event: TowerDeathEvent } => !!row)
        : [];
    if (typedTowerDeaths.length > 0) {
        const deduped = new Map<string, TowerDeathEvent>();
        for (const row of typedTowerDeaths) {
            if (!deduped.has(row.key) || row.event.time < deduped.get(row.key)!.time) {
                deduped.set(row.key, row.event);
            }
        }
        return [...deduped.values()].sort((a, b) => a.time - b.time);
    }

    if (!Array.isArray(matchData.towerDeaths)) return [];
    return matchData.towerDeaths
        .map((tower: any) => {
            const time = finiteNumber(tower.time);
            if (time == null) return null;
            return {
                teamLost: tower.isRadiant ? 'Radiant' as const : 'Dire' as const,
                time,
            };
        })
        .filter((event: TowerDeathEvent | null): event is TowerDeathEvent => !!event)
        .sort((a: TowerDeathEvent, b: TowerDeathEvent) => a.time - b.time);
}

function laneTotals(teamReport: any, laneName: 'safeLane' | 'midLane' | 'offLane') {
    const rows = Array.isArray(teamReport) ? teamReport : [teamReport].filter(Boolean);
    return rows.reduce((total, row) => {
        const lane = row?.[laneName] || {};
        total.cs += Number(lane.meleeCount || 0) + Number(lane.rangeCount || 0) + Number(lane.siegeCount || 0);
        total.denies += Number(lane.denyCount || 0);
        return total;
    }, { cs: 0, denies: 0 });
}

function summarizeLaneReport(matchData: any): string | null {
    if (!matchData.laneReport) return null;
    const laneSummary = (team: any) => {
        const lane = (label: string, name: 'safeLane' | 'midLane' | 'offLane') => {
            const totals = laneTotals(team, name);
            return `${label}: ${totals.cs} CS/${totals.denies} denies`;
        };
        return `${lane('safe', 'safeLane')}, ${lane('mid', 'midLane')}, ${lane('off', 'offLane')}`;
    };
    return `Lane creep report - Radiant ${laneSummary(matchData.laneReport.radiant)}; Dire ${laneSummary(matchData.laneReport.dire)}.`;
}

function summarizeTowerClusters(events: TowerDeathEvent[], minCount = 3, maxGapSeconds = 90): Array<Record<string, any>> {
    const clusters: Array<Record<string, any>> = [];
    for (const teamLost of ['Radiant', 'Dire'] as const) {
        const teamEvents = events.filter((event) => event.teamLost === teamLost);
        let current: TowerDeathEvent[] = [];
        const flush = () => {
            if (current.length >= minCount) {
                const start = current[0].time;
                const end = current[current.length - 1].time;
                clusters.push({
                    teamLost,
                    count: current.length,
                    start,
                    end,
                    durationSeconds: end - start,
                    times: current.map((event) => event.time),
                });
            }
            current = [];
        };

        for (const event of teamEvents) {
            const last = current[current.length - 1];
            if (!last || event.time - last.time <= maxGapSeconds) {
                current.push(event);
            } else {
                flush();
                current.push(event);
            }
        }
        flush();
    }

    return clusters.sort((a, b) => Number(a.start) - Number(b.start));
}

async function resolveFinalInventory(player: any): Promise<string[]> {
    const finalReport = Array.isArray(player.stats?.inventoryReport)
        ? player.stats.inventoryReport.slice(-1)[0]
        : player.stats?.inventoryReport;

    const ids: Array<number | null | undefined> = finalReport
        ? [
            finalReport.item0?.itemId, finalReport.item1?.itemId, finalReport.item2?.itemId,
            finalReport.item3?.itemId, finalReport.item4?.itemId, finalReport.item5?.itemId,
            finalReport.neutral0?.itemId,
        ]
        : [
            player.item0Id, player.item1Id, player.item2Id,
            player.item3Id, player.item4Id, player.item5Id,
            player.neutral0Id,
        ];

    const names = await Promise.all(ids.map((id) => id ? dotaDataService.getItemName(id) : null));
    return names.filter((name): name is string => !!name && name !== 'Unknown Item' && name !== 'Empty Slot');
}

async function resolveImportantPurchases(player: any): Promise<Array<{ time: number; item: string }>> {
    const purchases = Array.isArray(player.stats?.itemPurchases) ? player.stats.itemPurchases : [];
    const resolved = await Promise.all(
        purchases
            .filter((purchase: any) => Number.isFinite(Number(purchase.time)) && Number(purchase.time) >= 0 && purchase.itemId)
            .map(async (purchase: any) => ({
                time: Number(purchase.time),
                item: await dotaDataService.getItemName(purchase.itemId),
            }))
    );

    return resolved
        .filter((purchase) => purchase.item && purchase.item !== 'Unknown Item' && isImportantItemName(purchase.item))
        .sort((a, b) => a.time - b.time)
        .slice(0, 12);
}

function findOpenDotaPlayer(odMatch: any, stratzPlayer: any): any | null {
    const players = odMatch?.players;
    if (!Array.isArray(players)) return null;

    const steamAccountId = Number(stratzPlayer.steamAccountId);
    if (Number.isFinite(steamAccountId)) {
        const bySteam = players.find((p: any) => Number(p.account_id) === steamAccountId);
        if (bySteam) return bySteam;
    }

    if (stratzPlayer.playerSlot != null) {
        const bySlot = players.find((p: any) => p.player_slot === stratzPlayer.playerSlot);
        if (bySlot) return bySlot;
    }

    return players.find((p: any) =>
        p.hero_id === stratzPlayer.heroId &&
        (p.player_slot < 128) === !!stratzPlayer.isRadiant
    ) || null;
}

function formatOpenDotaBenchmarks(odPlayer: any): string[] {
    const labels: Record<string, string> = {
        gold_per_min: 'GPM',
        xp_per_min: 'XPM',
        kills_per_min: 'kills/min',
        last_hits_per_min: 'LH/min',
        hero_damage_per_min: 'hero damage/min',
        hero_healing_per_min: 'healing/min',
        tower_damage: 'tower damage',
    };
    const benchmarks = odPlayer?.benchmarks;
    if (!benchmarks || typeof benchmarks !== 'object') return [];

    return Object.entries(labels)
        .map(([key, label]) => {
            const pct = Number((benchmarks as any)[key]?.pct);
            return Number.isFinite(pct) ? `${label} ${ordinal(Math.round(pct * 100))} percentile` : '';
        })
        .filter(Boolean);
}

async function findFocusPlayer(players: any[], query?: string): Promise<any | null> {
    const needle = query?.trim().toLowerCase();
    if (!needle) return null;
    for (const p of players) {
        const heroName = (p.hero?.displayName || await dotaDataService.getHeroName(p.heroId)).toLowerCase();
        const playerName = String(p.steamAccount?.name || 'Anonymous').toLowerCase();
        if (playerName.includes(needle) || heroName.includes(needle)) return p;
    }
    return null;
}

function eventLeverageScore(time: number, player: any, economyPoints: Array<{ minute: number; value: number }>, towerEvents: TowerDeathEvent[]): number {
    let score = 0;
    const minute = Math.max(0, Math.round(time / 60));
    const nearbyEconomy = economyPoints.find((point) => Math.abs(point.minute - minute) <= 1);
    if (nearbyEconomy) score += Math.min(8, Math.abs(nearbyEconomy.value) / 5000);
    if (towerEvents.some((tower) => Math.abs(tower.time - time) <= 75)) score += 5;
    if (time > 10 * 60) score += 2;
    if (time > 20 * 60) score += 2;
    if (Number(player?.deaths || 0) > 8) score += 1;
    return score;
}

function selectLeverageEvents(player: any, economyValues: any[], towerEvents: TowerDeathEvent[], limit = 8): { killTimes: string[]; deathTimes: string[] } {
    const economyPoints = (economyValues || [])
        .map((value, minute) => ({ minute, value: Number(value) }))
        .filter((point) => Number.isFinite(point.value));
    const kills = (Array.isArray(player.stats?.killEvents) ? player.stats.killEvents : [])
        .map((event: any) => ({ type: 'kill' as const, time: finiteNumber(event.time), score: 0 }))
        .filter((event: any) => event.time != null);
    const deaths = (Array.isArray(player.stats?.deathEvents) ? player.stats.deathEvents : [])
        .map((event: any) => ({ type: 'death' as const, time: finiteNumber(event.time), score: 0 }))
        .filter((event: any) => event.time != null);
    const selected = [...kills, ...deaths]
        .map((event) => ({ ...event, score: eventLeverageScore(event.time as number, player, economyPoints, towerEvents) }))
        .sort((a, b) => b.score - a.score || Number(a.time) - Number(b.time))
        .slice(0, limit)
        .sort((a, b) => Number(a.time) - Number(b.time));

    return {
        killTimes: selected.filter((event) => event.type === 'kill').map((event) => formatFactTime(event.time)),
        deathTimes: selected.filter((event) => event.type === 'death').map((event) => formatFactTime(event.time)),
    };
}

async function buildAnalyzeFactPrompt(matchData: any, odMatch?: any, options: AnalyzePromptOptions = {}): Promise<BuiltAnalyzePrompt> {
    const facts: AnalyzeFact[] = [];
    const warnings: string[] = [];
    const addFact = (topic: string, text: string, data?: Record<string, any>) => {
        const fact = { id: `F${facts.length + 1}`, topic, text, data };
        facts.push(fact);
        return fact;
    };

    const gameModeValue = matchData.gameMode ?? matchData.game_mode;
    const gameModeLabel = formatStratzGameMode(gameModeValue);
    const reliableDraft = isReliableDraftMode(gameModeValue);
    const durationSeconds = Number(matchData.durationSeconds || matchData.duration || 0);
    const winner = matchData.didRadiantWin ? 'Radiant' : 'Dire';
    const matchId = matchData.id || matchData.match_id;
    const players = Array.isArray(matchData.players) ? matchData.players : [];
    const focusPlayer = await findFocusPlayer(players, options.focusPlayerQuery);
    const focusPlayerLabel = focusPlayer
        ? `${focusPlayer.steamAccount?.name || 'Anonymous'} - ${focusPlayer.hero?.displayName || await dotaDataService.getHeroName(focusPlayer.heroId)}`
        : undefined;
    if (options.focusPlayerQuery && !focusPlayer) {
        warnings.push(`Requested focus player "${options.focusPlayerQuery}" was not found; produced whole-match analysis instead.`);
    }

    addFact('match', `Match #${matchId}: ${gameModeLabel}, duration ${formatDuration(durationSeconds)}, winner ${winner}.`, {
        matchId,
        gameMode: gameModeLabel,
        durationSeconds,
        winner,
    });
    addFact('match', `Context: gameVersionId ${matchData.gameVersionId ?? 'unknown'}, region ${matchData.regionId ?? 'unknown'}, averageRank ${matchData.averageRank ?? 'unknown'}, bracket ${matchData.bracket ?? 'unknown'}.`);
    if (Number.isFinite(Number(matchData.firstBloodTime))) {
        addFact('match', `First blood occurred at ${formatFactTime(matchData.firstBloodTime)}.`);
    }
    if (focusPlayerLabel) {
        addFact('focus', `Personal coaching mode target: ${focusPlayerLabel}. Prioritize this player's choices, deaths, item timings, damage, objectives, and counterfactual improvements.`);
    }

    const teamLine = async (isRadiant: boolean) => (await Promise.all(
        players
            .filter((p: any) => p.isRadiant === isRadiant)
            .map(async (p: any) => {
                const heroName = p.hero?.displayName || await dotaDataService.getHeroName(p.heroId);
                return `${p.steamAccount?.name || 'Anonymous'} (${heroName}${p.variant ? ` facet ${p.variant}` : ''})`;
            })
    )).join(', ');
    addFact('composition', `Radiant picked: ${await teamLine(true)}.`);
    addFact('composition', `Dire picked: ${await teamLine(false)}.`);

    const orderedDraftEvents = Array.isArray(matchData.pickBans)
        ? matchData.pickBans
            .filter((d: any) => d.order != null)
            .sort((a: any, b: any) => Number(a.order) - Number(b.order))
        : [];
    if (reliableDraft && orderedDraftEvents.length > 0) {
        const draftLines = await Promise.all(orderedDraftEvents.map(async (event: any) => {
            const heroName = await dotaDataService.getHeroName(event.heroId);
            return `${Number(event.order) + 1}. ${event.isRadiant ? 'Radiant' : 'Dire'} ${event.isPick ? 'pick' : 'ban'} ${heroName}`;
        }));
        addFact('draft', `Reliable draft order: ${draftLines.join('; ')}.`, { reliableDraft: true });
    } else {
        addFact('draft', `${gameModeLabel} has no reliable ordered pick/ban draft in this fact sheet. Non-pick Stratz rows were intentionally omitted because they are not confirmed bans.`, { reliableDraft: false });
        warnings.push('Do not analyze bans for this match unless a reliable draft fact exists.');
    }

    const laneReportSummary = summarizeLaneReport(matchData);
    if (laneReportSummary) {
        addFact('lanes', laneReportSummary);
    } else {
        addFact('lanes', 'Lane creep report is unavailable for this match.');
    }

    const focusTeam = focusPlayer ? (focusPlayer.isRadiant ? 'Radiant' as const : 'Dire' as const) : null;
    const goldSummary = focusTeam
        ? summarizeAdvantageForTeam('Net worth lead', matchData.radiantNetworthLeads || [], focusTeam)
        : summarizeAdvantageSeries('Net worth lead', matchData.radiantNetworthLeads || []);
    if (goldSummary) addFact('economy', goldSummary.text, goldSummary.data);
    const xpSummary = focusTeam
        ? summarizeAdvantageForTeam('XP lead', matchData.radiantExperienceLeads || [], focusTeam)
        : summarizeAdvantageSeries('XP lead', matchData.radiantExperienceLeads || []);
    if (xpSummary) addFact('economy', xpSummary.text, xpSummary.data);
    if (!matchData.radiantExperienceLeads?.length) {
        addFact('economy', 'XP lead data is unavailable for this match.');
    }

    const radiantDamage = emptyDamageTotals();
    const direDamage = emptyDamageTotals();
    for (const p of players) {
        addDamageTotals(p.isRadiant ? radiantDamage : direDamage, getPlayerDamageTotals(p));
    }
    if (radiantDamage.playersWithBreakdown || direDamage.playersWithBreakdown) {
        addFact('damage', `Team hero damage by type from Stratz damage report: Radiant ${formatDamageTotals(radiantDamage)}; Dire ${formatDamageTotals(direDamage)}. Use this fact for damage-mix labels such as physical-heavy or magic burst.`, {
            radiant: radiantDamage,
            dire: direDamage,
        });
    }

    const topHeroDamage = (await Promise.all(players.map(async (p: any) => {
        const heroName = p.hero?.displayName || await dotaDataService.getHeroName(p.heroId);
        const total = finiteNumber(p.heroDamage);
        return {
            team: p.isRadiant ? 'Radiant' : 'Dire',
            playerName: p.steamAccount?.name || 'Anonymous',
            heroName,
            total: total ?? 0,
        };
    })))
        .filter((row) => row.total > 0)
        .sort((a, b) => b.total - a.total)
        .slice(0, 5);
    if (topHeroDamage.length) {
        addFact('damage', `Top hero damage totals: ${topHeroDamage.map((row) => `${row.playerName} - ${row.heroName} (${row.team}) ${formatNumber(row.total)}`).join('; ')}.`, {
            topHeroDamage,
        });
        if (topHeroDamage.length >= 2) {
            const topPair = topHeroDamage.slice(0, 2);
            const combinedTotal = topPair.reduce((sum, row) => sum + row.total, 0);
            addFact('damage', `Top two hero damage dealers combined for exactly ${formatNumber(combinedTotal)} hero damage: ${topPair.map((row) => `${row.playerName} - ${row.heroName} ${formatNumber(row.total)}`).join(' + ')}. Use this fact for combined damage claims.`, {
                players: topPair,
                combinedTotal,
            });
        }
    }

    if (Array.isArray(matchData.playbackData?.roshanEvents)) {
        const roshKills = matchData.playbackData.roshanEvents
            .filter((event: any) => event.hp === 0)
            .map((event: any) => formatFactTime(event.time));
        if (roshKills.length > 0) addFact('objectives', `Roshan kills at ${roshKills.join(', ')}.`);
    }
    const towerEvents = collectTowerDeathEvents(matchData);
    if (towerEvents.length > 0) {
        const radiantLost = towerEvents.filter((tower) => tower.teamLost === 'Radiant');
        const direLost = towerEvents.filter((tower) => tower.teamLost === 'Dire');
        addFact('objectives', `Tower death totals only: Radiant lost ${radiantLost.length} towers; Dire lost ${direLost.length} towers. Use objectiveCluster facts for tower timing windows; do not create timing windows from this totals fact.`, {
            radiantTowerDeaths: radiantLost.length,
            direTowerDeaths: direLost.length,
        });
        const towerClusters = summarizeTowerClusters(towerEvents);
        for (const cluster of towerClusters) {
            addFact('objectiveCluster', `Tower cluster only, no barracks or Ancient: ${cluster.teamLost} lost ${cluster.count} towers from ${formatFactTime(cluster.start)} to ${formatFactTime(cluster.end)} (${formatDuration(cluster.durationSeconds)} window): exact tower death times ${cluster.times.map((time: number) => formatFactTime(time)).join(', ')}.`, {
                ...cluster,
                structureType: 'tower',
            });
        }
    }
    const radiantTowersStanding = countStatusBits(matchData.towerStatusRadiant);
    const direTowersStanding = countStatusBits(matchData.towerStatusDire);
    const radiantBarracksStanding = countStatusBits(matchData.barracksStatusRadiant);
    const direBarracksStanding = countStatusBits(matchData.barracksStatusDire);
    if (radiantTowersStanding != null && direTowersStanding != null) {
        const radiantTowersDestroyed = 11 - radiantTowersStanding;
        const direTowersDestroyed = 11 - direTowersStanding;
        const radiantBarracksDestroyed = radiantBarracksStanding == null ? null : 6 - radiantBarracksStanding;
        const direBarracksDestroyed = direBarracksStanding == null ? null : 6 - direBarracksStanding;
        addFact('objectives', `Final tracked structure totals, not a timing window (towers/barracks only): Radiant had ${radiantTowersStanding}/11 towers standing (${radiantTowersDestroyed} destroyed) and ${radiantBarracksStanding ?? 'unknown'}/6 barracks standing${radiantBarracksDestroyed == null ? '' : ` (${radiantBarracksDestroyed} destroyed)`}; Dire had ${direTowersStanding}/11 towers standing (${direTowersDestroyed} destroyed) and ${direBarracksStanding ?? 'unknown'}/6 barracks standing${direBarracksDestroyed == null ? '' : ` (${direBarracksDestroyed} destroyed)`}. Do not describe this as "all structures" and do not infer when barracks fell from this fact.`, {
            radiant: { towersStanding: radiantTowersStanding, towersDestroyed: radiantTowersDestroyed, barracksStanding: radiantBarracksStanding, barracksDestroyed: radiantBarracksDestroyed },
            dire: { towersStanding: direTowersStanding, towersDestroyed: direTowersDestroyed, barracksStanding: direBarracksStanding, barracksDestroyed: direBarracksDestroyed },
        });
    }

    for (const p of players) {
        const heroName = p.hero?.displayName || await dotaDataService.getHeroName(p.heroId);
        const playerName = p.steamAccount?.name || 'Anonymous';
        const team = p.isRadiant ? 'Radiant' : 'Dire';
        const odPlayer = findOpenDotaPlayer(odMatch, p);
        const playerLabel = `${playerName} - ${heroName}`;
        const isFocus = focusPlayer ? p === focusPlayer : false;
        addFact('player', `${team} ${playerLabel}: ${p.kills}/${p.deaths}/${p.assists}, level ${p.level}, net worth ${Number(p.networth || 0).toLocaleString()}, GPM/XPM ${p.goldPerMinute}/${p.experiencePerMinute}, LH/DN ${p.numLastHits}/${p.numDenies}, hero/tower/healing damage ${Number(p.heroDamage || 0).toLocaleString()}/${Number(p.towerDamage || 0).toLocaleString()}/${Number(p.heroHealing || 0).toLocaleString()}.`, {
            team,
            playerName,
            heroName,
            slot: p.playerSlot,
        });

        if (focusPlayer && !isFocus) continue;

        if (isFocus) {
            const benchmarkFacts = formatOpenDotaBenchmarks(odPlayer);
            if (benchmarkFacts.length) {
                addFact('benchmarks', `${playerLabel} OpenDota hero benchmark percentiles: ${benchmarkFacts.join('; ')}. Treat these as available benchmark facts for the focused player only.`);
            }
        }

        const inventory = await resolveFinalInventory(p);
        if (inventory.length) addFact('items', `${playerLabel} final inventory: ${inventory.join(', ')}.`);
        const importantPurchases = await resolveImportantPurchases(p);
        if (importantPurchases.length) {
            addFact('items', `${playerLabel} important item timings: ${importantPurchases.map((item) => `${item.item} at ${formatFactTime(item.time)}`).join('; ')}.`, {
                playerName,
                heroName,
                purchases: importantPurchases,
            });
        }

        const buybacks = Number(odPlayer?.buyback_count || 0);
        if (buybacks > 0) {
            const buybackTimes = Array.isArray(odPlayer?.buyback_log)
                ? odPlayer.buyback_log.map((entry: any) => formatFactTime(entry.time)).join(', ')
                : '';
            addFact('player', `${playerLabel} used ${buybacks} buyback${buybacks === 1 ? '' : 's'}${buybackTimes ? ` at ${buybackTimes}` : ''}.`);
        }

        const utilityParts = [
            Array.isArray(p.stats?.wards) && p.stats.wards.length ? `${p.stats.wards.length} wards placed` : '',
            Array.isArray(p.stats?.wardDestruction) && p.stats.wardDestruction.length ? `${p.stats.wardDestruction.length} wards destroyed` : '',
            Array.isArray(p.stats?.runes) && p.stats.runes.length ? `${p.stats.runes.length} rune events` : '',
            Array.isArray(p.stats?.courierKills) && p.stats.courierKills.length ? `${p.stats.courierKills.length} courier kills` : '',
            odPlayer?.stuns ? `${Number(odPlayer.stuns).toFixed(1)}s stun duration` : '',
            odPlayer?.obs_placed ? `${odPlayer.obs_placed} OpenDota obs placed` : '',
            odPlayer?.sen_placed ? `${odPlayer.sen_placed} OpenDota sentries placed` : '',
        ].filter(Boolean);
        if (utilityParts.length) addFact('utility', `${playerLabel} utility: ${utilityParts.join(', ')}.`);

        if (p.stats?.heroDamageReport?.dealtTotal || p.stats?.heroDamageReport?.receivedTotal) {
            const dealt = p.stats.heroDamageReport.dealtTotal;
            const received = p.stats.heroDamageReport.receivedTotal;
            addFact('damage', `${playerLabel} damage profile: dealt physical/magical/pure ${formatNumber(dealt?.physicalDamage)}/${formatNumber(dealt?.magicalDamage)}/${formatNumber(dealt?.pureDamage)}; received physical/magical/pure ${formatNumber(received?.physicalDamage)}/${formatNumber(received?.magicalDamage)}/${formatNumber(received?.pureDamage)}.`);
        }

        if (focusPlayer && Array.isArray(p.stats?.abilityCastReport) && p.stats.abilityCastReport.length) {
            const topCasts = await Promise.all(
                [...p.stats.abilityCastReport]
                    .sort((a: any, b: any) => Number(b.count || 0) - Number(a.count || 0))
                    .slice(0, 5)
                    .map(async (cast: any) => `${await dotaDataService.getAbilityName(cast.abilityId)} x${cast.count}`)
            );
            addFact('mechanics', `${playerLabel} top ability casts: ${topCasts.join(', ')}.`);
        }

        const kills = Array.isArray(p.stats?.killEvents) ? p.stats.killEvents : [];
        const deaths = Array.isArray(p.stats?.deathEvents) ? p.stats.deathEvents : [];
        if (kills.length || deaths.length || (isFocus && Number(p.deaths || 0) > 0)) {
            const leverage = selectLeverageEvents(p, matchData.radiantNetworthLeads || [], towerEvents);
            if (isFocus) {
                const allDeathTimes = deaths.map((event: any) => formatFactTime(event.time));
                const coverageText = allDeathTimes.length === Number(p.deaths || 0)
                    ? `all ${Number(p.deaths || 0)} deaths are timestamped${allDeathTimes.length ? ` from ${allDeathTimes[0]} through ${allDeathTimes[allDeathTimes.length - 1]} (${allDeathTimes.join(', ')})` : ''}`
                    : `${allDeathTimes.length} of ${Number(p.deaths || 0)} deaths are timestamped${allDeathTimes.length ? ` (${allDeathTimes.join(', ')})` : ''}`;
                addFact('combatTimeline', `${playerLabel} death timing coverage: ${coverageText}. If the final timestamp is included, describe it as "through" or "last at" that time, not "before" that time. If this count is lower than total deaths, describe it as partial timing coverage.`);
            }
            addFact('combatTimeline', `${playerLabel} leverage-ranked combat events: ${kills.length} kill events${leverage.killTimes.length ? ` (selected ${leverage.killTimes.join(', ')})` : ''}; ${deaths.length} death events${leverage.deathTimes.length ? ` (selected ${leverage.deathTimes.join(', ')})` : ''}. Selected events are ranked by proximity to economy swings and tower deaths, not by earliest timestamp.`);
        }
    }

    const factSheet = {
        source: 'Stratz + OpenDota merge',
        generatedAt: new Date().toISOString(),
        match: {
            matchId,
            gameMode: gameModeLabel,
            durationSeconds,
            winner,
            gameVersionId: matchData.gameVersionId ?? null,
            regionId: matchData.regionId ?? null,
        },
        draft: {
            reliableDraft,
            note: reliableDraft
                ? 'Draft facts may be analyzed.'
                : 'No reliable draft order. Do not discuss bans or self-bans.',
        },
        mode: focusPlayerLabel ? 'player' : 'match',
        focusPlayer: focusPlayerLabel ?? null,
        warnings,
        facts,
    };

    const focusRules = focusPlayerLabel
        ? `\nPersonal coaching mode:\n- Focus on ${focusPlayerLabel}; use other players only as context for what this player faced or should have done.\n- Structure the analysis around this player's game: laning -> item timings -> fights they were in -> their deaths -> result.\n- Lead with this player's individual arc, not the match's overall arc.\n- Use benchmark facts explicitly only if MATCH_FACTS contains a benchmarks topic for this player; otherwise do not invent benchmark comparisons.\n- whatToImprove / nextGamePlan must be a counterfactual coaching chain for this player: mistake -> consequence -> specific alternative.\n- keyMistakes should prioritize this player's errors unless another teammate fact is necessary context.\n`
        : '';
    const lengthRules = focusPlayerLabel
        ? `\nLength target:\n- Personal coaching mode can be richer than the default recap, but stay under two Discord embeds.\n- Use 2-3 keyMistakes. Keep each claim and fix to one compact sentence.\n`
        : `\nLength target:\n- Whole-match recap must fit one Discord embed.\n- Use exactly 2 keyMistakes unless a third is essential to explain the result.\n- Keep every section concise: usually 2 sentences, with no stat listing unless it explains the game.\n`;

    return {
        prompt: `Analyze this Dota 2 match using only MATCH_FACTS.

Rules for this response:
- Major claims need evidence ids like [F12].
- If a fact is not present, do not mention it.
- Do not discuss bans unless MATCH_FACTS.draft.reliableDraft is true.
- Do not use web/meta knowledge for match facts.
- You may reason about why the game played out that way, but exact numbers/timings/counts must be copied from facts.
- Do not calculate new structure totals, damage totals, or approximate objective windows. Use the provided damage and objective-cluster facts.
- Prefer concrete player, item, timing, objective, and economy facts over generic advice.
${focusRules}
${lengthRules}

MATCH_FACTS:
${JSON.stringify(factSheet, null, 2)}`,
        focusPlayerLabel,
    };
}

// ── Helper to generate Rich Stratz prompt ────────────────────────────────────
async function generateRichStratzPrompt(matchData: any, odMatch?: any): Promise<string> {
    const gameModeValue = matchData.gameMode ?? matchData.game_mode;
    const gameModeLabel = formatStratzGameMode(gameModeValue);
    const hasReliableDraft = isReliableDraftMode(gameModeValue);
    const matchDurationSeconds = Number(matchData.durationSeconds || matchData.duration || 0);
    const winner = matchData.didRadiantWin ? 'Radiant' : 'Dire';
    const summaryParts = [
        `Match #${matchData.id || matchData.match_id}`,
        `Duration: ${formatDuration(matchDurationSeconds)}`,
        `Winner: ${winner}`,
        matchData.firstBloodTime != null ? `First Blood: ${formatDuration(matchData.firstBloodTime)}` : '',
        `Game Mode: ${gameModeLabel}`,
        `Average Rank: ${matchData.averageRank || 'Unknown'} (Bracket ${matchData.bracket})`
    ].filter(Boolean);

    let laneDetailBlock = '';
    if (matchData.laneReport) {
        const formatLane = (f: any) => `Mid: ${f.midLane?.meleeCount + f.midLane?.rangeCount} CS / ${f.midLane?.denyCount} DN | Safe: ${f.safeLane?.meleeCount + f.safeLane?.rangeCount} CS / ${f.safeLane?.denyCount} DN | Off: ${f.offLane?.meleeCount + f.offLane?.rangeCount} CS / ${f.offLane?.denyCount} DN`;
        laneDetailBlock = `\n=== LANE CREEP CONTROL (CS/DN) ===\nRadiant: ${formatLane(matchData.laneReport.radiant)}\nDire: ${formatLane(matchData.laneReport.dire)}`;
    }

    const pickedHeroLine = async (isRadiant: boolean) => (await Promise.all(
        (matchData.players || [])
            .filter((p: any) => p.isRadiant === isRadiant)
            .map(async (p: any) => {
                const heroName = p.hero?.displayName || await dotaDataService.getHeroName(p.heroId);
                return `${p.steamAccount?.name || 'Anonymous'} on ${heroName}`;
            })
    )).join(', ') || 'N/A';

    const teamCompositionBlock =
        `\n=== TEAM COMPOSITIONS (picked heroes) ===\n` +
        `Radiant: ${await pickedHeroLine(true)}\n` +
        `Dire: ${await pickedHeroLine(false)}`;

    const orderedDraftEvents = Array.isArray(matchData.pickBans)
        ? matchData.pickBans
            .filter((d: any) => d.order != null)
            .sort((a: any, b: any) => Number(a.order) - Number(b.order))
        : [];
    const draftBlock = hasReliableDraft && orderedDraftEvents.length > 0
        ? `\n=== DRAFT ORDER ===\n${await Promise.all(orderedDraftEvents.map(async (d: any) => {
            const heroName = await dotaDataService.getHeroName(d.heroId);
            return `${d.order + 1}. ${d.isRadiant ? 'Radiant' : 'Dire'} ${d.isPick ? 'PICK' : 'BAN'}: ${heroName}`;
        })).then(lines => lines.join('\n'))}`
        : `\n=== DRAFT NOTE ===\n${gameModeLabel}: no reliable ordered pick/ban draft is available. Ignore Stratz non-pick rows for this mode; they are not confirmed bans. Analyze team composition from picked heroes only.`;

    const goldGraph = `\n=== GOLD ADVANTAGE (Radiant perspective, per minute) ===\n${matchData.radiantNetworthLeads?.join(' → ') || 'N/A'}`;
    const xpGraph = `\n=== XP ADVANTAGE (Radiant perspective, per minute) ===\n${matchData.radiantExperienceLeads?.join(' → ') || 'N/A'}`;
    
    const objectiveParts: string[] = [];
    if (matchData.playbackData?.roshanEvents?.length) {
        const kills = matchData.playbackData.roshanEvents.filter((r: any) => r.hp === 0);
        if (kills.length) {
            objectiveParts.push(`Roshan Kills: ${kills.map((r: any) => formatDuration(r.time)).join(', ')}`);
        }
    }
    if (matchData.playbackData?.buildingEvents?.length) {
        const structuralEvents = matchData.playbackData.buildingEvents
            .filter((b: any) => b.hp === 0)
            .map((b: any) => `${formatDuration(b.time)} ${b.type || 'Building'} (${b.isRadiant ? 'Radiant' : 'Dire'})`);
        if (structuralEvents.length) {
            objectiveParts.push(`Key Building Destructions: ${structuralEvents.join(', ')}`);
        }
    }
    if (matchData.towerDeaths?.length) {
        const radTowers = matchData.towerDeaths.filter((t: any) => t.isRadiant).length;
        const direTowers = matchData.towerDeaths.filter((t: any) => !t.isRadiant).length;
        objectiveParts.push(`Tower Deaths: Radiant lost ${radTowers}, Dire lost ${direTowers} (Details: ${matchData.towerDeaths.map((t: any) => `${formatDuration(t.time)} ${t.isRadiant ? 'Rad' : 'Dire'}`).join(', ')})`);
    }
    if (matchData.chatEvents?.length) {
        const chat = matchData.chatEvents.slice(0, 10).map((c: any) => `${formatDuration(c.time)} ${c.isRadiant ? '[Rad]' : '[Dire]'} Hero ${c.fromHeroId}: ${c.value}`);
        if (chat.length) objectiveParts.push(`Chat Log (Sample): ${chat.join(' | ')}`);
    }
    const radiantTowersStanding = countStatusBits(matchData.towerStatusRadiant);
    const direTowersStanding = countStatusBits(matchData.towerStatusDire);
    const radiantBarracksStanding = countStatusBits(matchData.barracksStatusRadiant);
    const direBarracksStanding = countStatusBits(matchData.barracksStatusDire);
    const structureParts = [
        radiantTowersStanding != null && direTowersStanding != null
            ? `Towers standing: Radiant ${radiantTowersStanding}/11, Dire ${direTowersStanding}/11`
            : '',
        radiantBarracksStanding != null && direBarracksStanding != null
            ? `Barracks standing: Radiant ${radiantBarracksStanding}/6, Dire ${direBarracksStanding}/6`
            : '',
    ].filter(Boolean);
    if (structureParts.length) {
        objectiveParts.push(`Final Structure Status - ${structureParts.join(' | ')}`);
    }


    const playerBlock = await Promise.all(matchData.players.map(async (p: any) => {
        const header = [
            `[${p.isRadiant ? 'Radiant' : 'Dire'}] ${p.steamAccount?.name || 'Anonymous'} — ${p.hero?.displayName || `Hero ${p.heroId}`}`,
            p.variant ? `(Facet ${p.variant})` : '',
            p.isRandom ? `[RANDOMED]` : '',
            p.leaverStatus ? `[LEAVER_STATUS: ${p.leaverStatus}]` : ''
        ].filter(Boolean).join(' ');

        const lines = [
            header,
            `  KDA: ${p.kills}/${p.deaths}/${p.assists} | Lvl: ${p.level} | NW: ${p.networth} (Spent: ${p.goldSpent})`,
            `  GPM: ${p.goldPerMinute} | XPM: ${p.experiencePerMinute}`,
            `  Dmg Dealt: ${p.heroDamage} | Tower: ${p.towerDamage} | Heal: ${p.heroHealing} | LH: ${p.numLastHits} | DN: ${p.numDenies}`,
            `  Pos: ${p.position?.toString().replace('POSITION_', '') ?? 'Unknown'}`,
            Number(p.invisibleSeconds) > 60 && (!matchDurationSeconds || Number(p.invisibleSeconds) <= matchDurationSeconds)
                ? `  Sneakiness: ${Math.round(Number(p.invisibleSeconds))}s invisible`
                : ''
        ].filter(Boolean);

        // Support Totality: Stun duration from OpenDota + Ability Counts from Stratz
        const odPlayer = odMatch?.players?.find((op: any) => op.player_slot === p.playerSlot);
        const abilityCount = Array.isArray(p.stats?.abilityCastReport)
            ? p.stats.abilityCastReport.reduce((acc: number, curr: any) => acc + (curr.count || 0), 0)
            : 0;

        if (odPlayer || abilityCount > 0) {
            const supportStats = [
                abilityCount > 0 ? `Abilities Used: ${abilityCount}` : '',
                odPlayer?.stuns > 0 ? `Stun Duration: ${odPlayer.stuns.toFixed(1)}s` : '',
                odPlayer?.obs_placed > 0 ? `Obs Placed: ${odPlayer.obs_placed}` : '',
                odPlayer?.sen_placed > 0 ? `Sen Placed: ${odPlayer.sen_placed}` : '',
                odPlayer?.pings > 0 ? `Pings: ${odPlayer.pings}` : '',
            ].filter(Boolean).join(' | ');
            if (supportStats) lines.push(`  Support Value: ${supportStats}`);
        }

        if (p.stats) {
            // Final Inventory Report (Last item in log is final state)
            const ir = Array.isArray(p.stats.inventoryReport) ? p.stats.inventoryReport.slice(-1)[0] : p.stats.inventoryReport;
            if (ir) {
                const resolveInv = async (item: any) => item?.itemId ? await dotaDataService.getItemName(item.itemId) : null;
                
                const mainItems = (await Promise.all([
                    resolveInv(ir.item0), resolveInv(ir.item1), resolveInv(ir.item2),
                    resolveInv(ir.item3), resolveInv(ir.item4), resolveInv(ir.item5)
                ])).filter(Boolean);
                
                const backpack = (await Promise.all([
                    resolveInv(ir.backPack0), resolveInv(ir.backPack1), resolveInv(ir.backPack2)
                ])).filter(Boolean);
                
                const neutral = await resolveInv(ir.neutral0);

                if (mainItems.length) lines.push(`  Inventory: ${mainItems.join(', ')}`);
                if (backpack.length) lines.push(`  Backpack: ${backpack.join(', ')}`);
                if (neutral) lines.push(`  Neutral: ${neutral}`);
            }

            // Permanent Buffs (Aghs, Shard, Moonshard, etc.)
            if (p.stats.matchPlayerBuffEvent?.length) {
                const buffs = await Promise.all(p.stats.matchPlayerBuffEvent.map(async (b: any) => {
                    const name = b.itemId ? await dotaDataService.getItemName(b.itemId) : (b.abilityId ? `Ability ${b.abilityId}` : null);
                    return name;
                }));
                const uniqueBuffs = [...new Set(buffs.filter(Boolean))];
                if (uniqueBuffs.length) lines.push(`  Perm Buffs: ${uniqueBuffs.join(', ')}`);
            }

            // Spirit Bear Inventory (for Lone Druid)
            const sbi = Array.isArray(p.stats.spiritBearInventoryReport) ? p.stats.spiritBearInventoryReport.slice(-1)[0] : p.stats.spiritBearInventoryReport;
            if (sbi) {
                const resolveId = async (id: number | null) => id ? await dotaDataService.getItemName(id) : null;
                
                const bearItems = (await Promise.all([
                    resolveId(sbi.item0Id), resolveId(sbi.item1Id), resolveId(sbi.item2Id),
                    resolveId(sbi.item3Id), resolveId(sbi.item4Id), resolveId(sbi.item5Id)
                ])).filter(Boolean);

                const bearBackpack = (await Promise.all([
                    resolveId(sbi.backPack0Id), resolveId(sbi.backPack1Id), resolveId(sbi.backPack2Id)
                ])).filter(Boolean);

                const bearNeutral = await resolveId(sbi.neutral0Id);

                if (bearItems.length || bearBackpack.length || bearNeutral) {
                    lines.push(`  --- Spirit Bear ---`);
                    if (bearItems.length) lines.push(`  Bear Inventory: ${bearItems.join(', ')}`);
                    if (bearBackpack.length) lines.push(`  Bear Backpack: ${bearBackpack.join(', ')}`);
                    if (bearNeutral) lines.push(`  Bear Neutral: ${bearNeutral}`);
                }
            }

            // Action Report (APM)
            if (p.stats.actionReport) {
                const ar = p.stats.actionReport;
                lines.push(`  Actions: Casts(${ar.castPosition + ar.castTarget + ar.castNoTarget}), Attacks(${ar.attackPosition + ar.attackTarget}), Move(${ar.moveToPosition + ar.moveToTarget}), Pings(${ar.pingUsed}), Scan(${ar.scanUsed})`);
            }

            // Farm Distribution
            if (p.stats.farmDistributionReport) {
                const fd = p.stats.farmDistributionReport;
                const creepGold = fd.creepType?.reduce((sum: number, c: any) => sum + (c.gold || 0), 0) || 0;
                const bldgGold = (Array.isArray(fd.buildings) ? fd.buildings.reduce((sum: number, b: any) => sum + (b.gold || 0), 0) : fd.buildings?.gold) || 0;
                const farm = [
                    creepGold ? `Creeps: ${creepGold}g` : '',
                    bldgGold ? `Buildings: ${bldgGold}g` : ''
                ].filter(Boolean).join(', ');
                if (farm) lines.push(`  Farm Distribution: ${farm}`);
            }

            // Damage Breakdown
            if (p.stats.heroDamageReport) {
                const hdr = p.stats.heroDamageReport;
                if (hdr.dealtTotal) lines.push(`  Damage Dealt: Phys(${hdr.dealtTotal.physicalDamage}), Mag(${hdr.dealtTotal.magicalDamage}), Pure(${hdr.dealtTotal.pureDamage})`);
                if (hdr.receivedTotal) lines.push(`  Damage Taken: Phys(${hdr.receivedTotal.physicalDamage}), Mag(${hdr.receivedTotal.magicalDamage}), Pure(${hdr.receivedTotal.pureDamage})`);
            }

            // Full Item Timeline (Significant Items)
            if (p.stats.itemPurchases?.length) {
                const purchaseHistory = await Promise.all(p.stats.itemPurchases.map(async (i: any) => {
                    const name = await dotaDataService.getItemName(i.itemId);
                    return `${name} (${formatDuration(i.time)})`;
                }));
                lines.push(`  Item Timeline: ${purchaseHistory.join(' → ')}`);
            }

            // Vision & Utility
            if (p.stats.wards?.length || p.stats.wardDestruction?.length || p.stats.runes?.length || p.stats.campStack?.length || p.stats.courierKills?.length) {
                const stackCount = Array.isArray(p.stats.campStack) ? p.stats.campStack.reduce((a: number, b: number) => a + b, 0) : 0;
                const fountainTrips = Array.isArray(p.stats.tripsFountainPerMinute) ? p.stats.tripsFountainPerMinute.reduce((a: number, b: number) => a + b, 0) : 0;
                const utils = [
                    p.stats.wards?.length ? `Wards: ${p.stats.wards.length}` : '',
                    p.stats.wardDestruction?.length ? `De-ward: ${p.stats.wardDestruction.length}` : '',
                    p.stats.runes?.length ? `Runes: ${p.stats.runes.length}` : '',
                    stackCount ? `Stacks: ${stackCount}` : '',
                    fountainTrips ? `Fountain Trips: ${fountainTrips}` : '',
                    p.stats.courierKills?.length ? `Courier Kills: ${p.stats.courierKills.length}` : ''
                ].filter(Boolean).join(' | ');
                if (utils) lines.push(`  Utility: ${utils}`);
            }

            // Chat & Wheels
            if (p.stats.chatWheels?.length || p.stats.allTalks?.length) {
                const lines2 = [
                    p.stats.chatWheels?.length ? `ChatWheels: ${p.stats.chatWheels.length}` : '',
                    p.stats.allTalks?.length ? `AllTalk: ${p.stats.allTalks.map((t: any) => t.message).join(' | ')}` : ''
                ].filter(Boolean).join(' | ');
                if (lines2) lines.push(`  Persona: ${lines2}`);
            }

            // Item Usage (Actives)
            if (p.stats.itemUsed?.length) {
                const activeUses = await Promise.all(p.stats.itemUsed.map(async (iu: any) => {
                    const name = await dotaDataService.getItemName(iu.itemId);
                    return `${name}(x${iu.count})`;
                }));
                if (activeUses.length) lines.push(`  Actives Used: ${activeUses.join(', ')}`);
            }

            // Ability Build (First 12 levels)
            if (p.abilities?.length) {
                const build = await Promise.all(p.abilities.slice(0, 12).map(async (a: any) => {
                    const name = await dotaDataService.getAbilityName(a.abilityId);
                    return name;
                }));
                lines.push(`  Ability Build (Lvl 1-12): ${build.join(' → ')}`);
            }

            // Ability Cast Report (Top 5)
            if (p.stats.abilityCastReport?.length) {
                const topCasts = await Promise.all(p.stats.abilityCastReport
                    .sort((a: any, b: any) => b.count - a.count)
                    .slice(0, 5)
                    .map(async (c: any) => {
                        const name = await dotaDataService.getAbilityName(c.abilityId);
                        return `${name}(${c.count})`;
                    }));
                lines.push(`  Top Casts: ${topCasts.join(', ')}`);
            }

            // Kill/Death Matrix
            if (p.stats.killEvents?.length || p.stats.deathEvents?.length) {
                const killCounts: Record<number, number> = {};
                p.stats.killEvents?.forEach((k: any) => { if (k.target) killCounts[k.target] = (killCounts[k.target] || 0) + 1; });
                
                // Note: Stratz deathEvents don't always include the killer in the simple array, 
                // but we can infer from the match's other players' killEvents if needed.
                // For now, let's just show who they killed most.
                const mostKilled = await Promise.all(Object.entries(killCounts)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 2)
                    .map(async ([id, count]) => {
                        const name = await dotaDataService.getHeroName(parseInt(id));
                        return `${name}(x${count})`;
                    }));
                if (mostKilled.length) lines.push(`  Nemesis Targets: ${mostKilled.join(', ')}`);
            }
        }

        return lines.join('\n');
    }));

    const parties = new Map<number, string[]>();
    for (const p of matchData.players) {
        if (p.partyId != null) {
            if (!parties.has(p.partyId)) parties.set(p.partyId, []);
            parties.get(p.partyId)!.push(p.steamAccount?.name || 'Anonymous');
        }
    }
    const partyBlock = Array.from(parties.values())
        .filter(members => members.length > 1)
        .map(members => `Party: ${members.join(' + ')}`)
        .join('\n');

    return `Analyze this Dota 2 match (from Stratz high-detail API):

=== MATCH SUMMARY ===
${summaryParts.join(' | ')}
${laneDetailBlock}
${draftBlock}
${teamCompositionBlock}
${objectiveParts.length ? `\n=== OBJECTIVES ===\n${objectiveParts.join('\n')}` : ''}
${partyBlock ? `\n=== PARTIES ===\n${partyBlock}` : ''}

=== PLAYERS ===
${playerBlock.join('\n\n')}
${goldGraph}
${xpGraph}

Analyze this match. Fill each schema field with CONCISE, data-backed analysis. Reference specific numbers, item timings, objective timings, and specific minute marks from the advantage graph. Use Discord markdown (**bold** for names). Be direct and spicy. STRICT LIMIT: 250 words total across all fields. Each field 2-4 sentences max.`;
}
