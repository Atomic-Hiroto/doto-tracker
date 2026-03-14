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

async function callAI(
    systemPrompt: string,
    userPrompt: string,
    opts?: { model?: string; params?: Record<string, any>; response_format?: any }
): Promise<string> {
    const model = opts?.model ?? AIConstants.AI_MODEL;
    const params = opts?.params ?? AIConstants.AI_PARAMS;

    const body: Record<string, any> = {
        model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        // Web search gives the LLM access to latest patch notes, item changes, meta info
        plugins: [{ id: 'web', max_results: 3 }],
        ...params
    };
    if (opts?.response_format) {
        body.response_format = opts.response_format;
        // For structured output: use response-healing to auto-fix malformed JSON + web for latest info
        body.plugins = [{ id: 'web', max_results: 3 }, { id: 'response-healing' }];
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

// ── System prompt for deep match analysis ─────────────────────────────────
const ANALYZE_SYSTEM = `You are a Dota 2 match analyst-chan. You receive rich structured match data and produce data-driven analysis.

## Your Analytical Framework
Follow this reasoning order to ensure comprehensive analysis:
1. **Draft context** — Evaluate pick/ban synergies and hero facet choices (skip if Turbo/All Pick where draft matters less)
2. **Laning phase** — Use lane efficiency %, CS curves, first blood timing, and gold curves to determine lane outcomes
3. **Economy & itemization** — Cross-reference item timings with gold curves, evaluate choices against enemy damage types
4. **Teamfights & objectives** — Identify key fights from the teamfight log, correlate with objective kills and gold swings
5. **Decisive plays** — Pin down the specific moment(s) that decided the game using kill timelines, buyback logs, and gold swings

## Data Field Guide
- **heroVariant** = hero facet (1-indexed), the Dota 2 facet system. Mention if a facet choice was suboptimal.
- **partyId** = party grouping. Players sharing a partyId queued together — note coordinated plays.
- **multiKills / killStreaks** = highlight spectacular multi-kill and streak performances.
- **campsStacked / neutralKills** = jungle efficiency and support contribution.
- **maxHeroHit** = biggest single damage instance — highlight if notable.
- **damageReceived** = incoming damage sources — identify who got focused and by what.
- **goldCurve / lhCurve** = net worth and CS over time — use to identify farming patterns and power spikes.
- **buybackLog** = buyback timings — critical for late-game analysis.
- **comeback / throw** = max gold swing values — quantifies how dramatic the game was.

## CRITICAL RULES

Zero Hallucination Policy:
- ONLY mention heroes, players, and items that actually exist in the provided MATCH DATA block.
- NEVER accidentally reference heroes from previous matches or standard Dota lore that didn't play in this specific game. If you see a Pipe of Insight, verify WHICH player in THIS match bought it before writing about it.

Game Mode Context:
- If the Game Mode says "Turbo", remember that gold/XP is massively accelerated, towers are weaker, and games end faster. Analyze timings accordingly (a 15 min item in Turbo is like a 30 min item in regular Dota).

Ability name accuracy:
Dmg Sources use Dota 2 INTERNAL ability names. Always translate to display names (e.g. dawnbreaker fire wreath = Starbreaker, death prophet exorcism = Exorcism). "null" or "Right Click" = auto-attack damage.

Damage type accuracy:
- Physical: Exorcism, Omnislash, Flak Cannon, Tidebringer, Sleight of Fist, Quill Spray
- Pure: Tinker Laser, Timber Chain, Whirling Death, Brain Sap, Purification, Laguna Blade (w/ Aghs)

Player coverage:
- Every player on the LOSING team must get at least a brief mention — don't skip anyone.
- Roast caow or epi if present (running joke), but never replace real analysis with just roasts.

Be direct, spicy, and concise. Use Discord markdown (**bold** for names). Base everything on the provided data, not assumptions.`;

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
                    description: 'The story of this match in 2-4 sentences. Reference specific timings, gold leads from the advantage graph, and the decisive moment that ended the game. Include comeback/throw values if dramatic. Use **bold** for player and hero names.',
                },
                draftAndLaning: {
                    type: 'string',
                    description: 'Combined draft + laning analysis in 2-3 sentences. Comment on draft synergies/weaknesses, facet choices, and lane outcomes using lane efficiency and CS data. Name lane winners/losers. Use **bold** for hero names.',
                },
                itemizationAndDamage: {
                    type: 'string',
                    description: 'Analyze item choices and timings against enemy damage types. Reference specific item timing data. Note damage type mismatches. 2-3 sentences. Use **bold** for items and heroes.',
                },
                keyMistakes: {
                    type: 'string',
                    description: 'The 2-3 biggest mistakes by the losing team. Each mistake should reference specific data: buyback timings, kill timeline events, fights lost, or objectives conceded. One sentence each. Use **bold** for player names.',
                },
                mvpAndStandouts: {
                    type: 'string',
                    description: 'Format EXACTLY like this with NEWLINES:\\n**MVP: Player — Hero** - 1 sentence on why.\\n**LVP: Player — Hero** - 1 sentence on why.\\n**Honorable Mention: Player — Hero** - 1 sentence on why.',
                },
                mapControl: {
                    type: 'string',
                    description: 'Analyze vision (wards placed/destroyed), rune control, and Roshan/Aegis secures. 2-3 sentences max. Use **bold** for items and heroes.',
                },
                whatToImprove: {
                    type: 'string',
                    description: 'One single, direct, concise sentence on what the losing team should have done differently to win.',
                },
            },
            required: ['gameNarrative', 'draftAndLaning', 'itemizationAndDamage', 'keyMistakes', 'mvpAndStandouts', 'mapControl', 'whatToImprove'],
            additionalProperties: false,
        },
    },
};

// ── Format structured analysis into a single Discord embed ────────────────────
function formatAnalysis(data: any, matchId: number, model: string): EmbedBuilder {
    const sections = [
        `**📖 GAME NARRATIVE**\n${data.gameNarrative}`,
        `**🏗️ DRAFT & LANING**\n${data.draftAndLaning}`,
        `**⚔️ ITEMS & DAMAGE**\n${data.itemizationAndDamage}`,
        `**💀 KEY MISTAKES**\n${data.keyMistakes}`,
        `**👁️ MAP CONTROL & VISION**\n${data.mapControl}`,
        `**🏆 MVP & STANDOUTS**\n${data.mvpAndStandouts}`,
        `**📝 WHAT TO IMPROVE**\n${data.whatToImprove}`,
    ];

    return new EmbedBuilder()
        .setColor('#ef4444')
        .setTitle(`🔍 Match Analysis — #${matchId}`)
        .setDescription(trunc(sections.join('\n\n'), 4096))
        .setURL(`https://www.opendota.com/matches/${matchId}`)
        .setFooter({ text: `doto-chan coaching • ${model}` })
        .setTimestamp();
}

const BOT_OWNER_ID = '78168838910246912';

export async function analyze(message: Message, args: string[]) {
    // Parse flags: -model <model_name> (owner-only), -stratz
    let modelOverride: string | null = null;
    let useStratz = false;
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
        return message.reply('Usage: `+analyze <match_id>` — give me a match ID to dissect! 🔍\nOwner-only: `+analyze <match_id> -model <openrouter_model>`');
    }

    try {
        safeTyping(message.channel);

        // ── Determine which data source to use ───────────────────────────────
        let prompt = '';
        if (useStratz) {
            let stratzMatch = await fetchStratzMatch(matchId);

            // ── Stratz Polling: if not parsed, poll ─────────────────────────
            if (!stratzMatch || !stratzMatch.parsedDateTime) {
                const waitEmbed = new EmbedBuilder()
                    .setColor('#0ea5e9')
                    .setTitle('⏳ Stratz: Parsing Match...')
                    .setDescription(
                        `Match **#${matchId}** isn't parsed on Stratz yet.\n` +
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
                            `Match **#${matchId}** isn't parsed on Stratz yet.\n` +
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
                        .setTitle('✅ Stratz Parsed!')
                        .setDescription(`Match **#${matchId}** is ready on Stratz — analyzing...`);
                    await waitMsg.edit({ embeds: [waitEmbed] });
                    
                    safeTyping(message.channel);
                    stratzMatch = await fetchStratzMatch(matchId);
                }
            }

            if (useStratz && stratzMatch) {
                prompt = generateStratzPrompt(stratzMatch);
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

        const useModel = modelOverride || AIConstants.AI_ANALYZE_MODEL;
        if (modelOverride) {
            logger.info(`[+analyze] Owner model override: ${modelOverride}`);
        }

        const response = await callAI(ANALYZE_SYSTEM, prompt, {
            model: useModel,
            params: modelOverride ? { max_tokens: 16000 } : AIConstants.AI_ANALYZE_PARAMS,
            response_format: ANALYZE_RESPONSE_FORMAT,
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

        const embed = formatAnalysis(analysisData, matchId, useModel);
        await message.reply({ embeds: [embed] });
    } catch (error: any) {
        logger.error('Error in analyze command:', error);
        const reason = error?.message?.includes('HTTP 402')
            ? 'Insufficient OpenRouter credits for Sonnet 4.6. Top up at <https://openrouter.ai/credits>'
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

// ── Helper to generate Stratz prompt ─────────────────────────────────────────
function generateStratzPrompt(matchData: any): string {
    const winner = matchData.didRadiantWin ? 'Radiant' : 'Dire';
    const summaryParts = [
        `Match #${matchData.id || matchData.match_id}`,
        `Duration: ${formatDuration(matchData.durationSeconds || matchData.duration)}`,
        `Winner: ${winner}`,
        matchData.firstBloodTime != null ? `First Blood: ${formatDuration(matchData.firstBloodTime)}` : '',
        `Game Mode: Mode ${matchData.gameMode || matchData.game_mode}`,
        `Average Rank: ${matchData.averageRank || 'Unknown'}`,
        `Lane Outcomes (0=Draw, 1=Rad, 2=Dire): Top ${matchData.topLaneOutcome}, Mid ${matchData.midLaneOutcome}, Bot ${matchData.bottomLaneOutcome}`
    ].filter(Boolean);

    const hasDraft = matchData.pickBans?.length > 0;
    const draftBlock = hasDraft
        ? `\n=== DRAFT ORDER ===\n${matchData.pickBans.map((d: any) =>
            `${d.order + 1}. ${d.isRadiant ? 'Radiant' : 'Dire'} ${d.isPick ? 'PICK' : 'BAN'}: HeroId ${d.heroId}`
        ).join('\n')}`
        : '';

    const goldGraph = `\n=== GOLD ADVANTAGE (Radiant perspective, per minute) ===\n${matchData.radiantNetworthLeads?.join(' → ') || 'N/A'}`;
    const xpGraph = `\n=== XP ADVANTAGE (Radiant perspective, per minute) ===\n${matchData.radiantExperienceLeads?.join(' → ') || 'N/A'}`;

    const objectiveParts: string[] = [];
    if (matchData.roshanEvents?.length) {
        objectiveParts.push(`Roshan Events: ${matchData.roshanEvents.map((r: any) => `${formatDuration(r.time)} ${r.type} (${r.isRadiant ? 'Radiant' : 'Dire'})`).join(', ')}`);
    }
    if (matchData.buildingEvents?.length) {
        // Just top level building destructions
        objectiveParts.push(`Building Destructions: ${matchData.buildingEvents.slice(0, 15).map((b: any) => `${formatDuration(b.time)} ${b.type} (${b.isRadiant ? 'Radiant' : 'Dire'})`).join(', ')}`);
    }

    const playerBlock = matchData.players.map((p: any) => {
        const header = [
            `[${p.isRadiant ? 'Radiant' : 'Dire'}] ${p.steamAccount?.name || 'Anonymous'} — ${p.hero?.displayName || `Hero ${p.heroId}`}`,
            p.variant ? `(Facet ${p.variant})` : ''
        ].filter(Boolean).join(' ');

        const lines = [
            header,
            `  KDA: ${p.kills}/${p.deaths}/${p.assists} | Lvl: ${p.level} | NW: ${p.networth} | GPM: ${p.goldPerMinute} | XPM: ${p.experiencePerMinute}`,
            `  Dmg: ${p.heroDamage} | Tower: ${p.towerDamage} | Heal: ${p.heroHealing} | LH: ${p.numLastHits} | DN: ${p.numDenies}`,
            `  Pos: ${p.position?.toString().replace('POSITION_', '') ?? 'Unknown'} | IMP: ${p.imp ?? 'N/A'} | Award: ${p.award === 1 ? 'MVP' : (p.award ? 'Standout' : 'None')}`,
            p.intentionalFeeding ? `  ⚠️ INTENTIONAL FEEDING DETECTED` : ''
        ].filter(Boolean);

        // Purchase timings from stats.itemEvents
        if (p.stats?.itemEvents?.length) {
            const majorItems = p.stats.itemEvents
                .filter((i: any) => i.purchaseTime > 0)
                .map((i: any) => `ID ${i.itemId} @ ${formatDuration(i.purchaseTime)}`)
                .slice(-10); // last 10 items for brevity or just major ones
            if (majorItems.length) lines.push(`  Purchase Timings: ${majorItems.join(', ')}`);
        }

        // Extra stats if available
        if (p.stats) {
            lines.push(`  APM (max per min): ${Math.max(...(p.stats.actionsPerMinute || [0]))}`);
            if (p.stats.wardDestruction?.length || p.stats.wards?.length) {
                lines.push(`  Vision: ${p.stats.wards?.length || 0} wards placed | ${p.stats.wardDestruction?.length || 0} destroyed`);
            }
            if (p.stats.runes?.length) {
                lines.push(`  Runes: ${p.stats.runes.length} pickups`);
            }
            if (p.stats.campStack?.length) {
                lines.push(`  Camps Stacked: ${p.stats.campStack.length}`);
            }
            if (p.stats.killEvents?.length) {
                const kills = p.stats.killEvents.map((k: any) => `${formatDuration(k.time)}`).join(', ');
                lines.push(`  Kill Times: ${kills}`);
            }
            if (p.stats.deathEvents?.length) {
                const deaths = p.stats.deathEvents.map((d: any) => `${formatDuration(d.time)}`).join(', ');
                lines.push(`  Death Times: ${deaths}`);
            }
            if (p.stats.heroDamageReport?.dealtTotal) {
                const dt = p.stats.heroDamageReport.dealtTotal;
                lines.push(`  Damage Output - Phys: ${dt.physicalDamage}, Mag: ${dt.magicalDamage}, Pure: ${dt.pureDamage}`);
            }
        }

        return lines.join('\n');
    }).join('\n\n');

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
${draftBlock}
${objectiveParts.length ? `\n=== OBJECTIVES ===\n${objectiveParts.join('\n')}` : ''}
${partyBlock ? `\n=== PARTIES ===\n${partyBlock}` : ''}

=== PLAYERS ===
${playerBlock}
${goldGraph}
${xpGraph}

Analyze this match. Fill each schema field with CONCISE, data-backed analysis. Reference specific numbers like IMP scores, Lane Outcomes, and specific minute marks from the advantage graph. Use Discord markdown (**bold** for names). Be direct and spicy. STRICT LIMIT: 250 words total across all fields. Each field 2-4 sentences max.`;
}
