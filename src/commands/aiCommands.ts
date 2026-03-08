import { Message, EmbedBuilder } from 'discord.js';
import { AIConstants, ProcessConstants } from '../constants';
import { logger } from '../services/loggerService';
import { opendotaClient } from '../services/apiClient';
import { dotaDataService } from '../services/dotaDataService';
import { getDetailedMatchData, requestMatchParse, waitForMatchParse } from '../services/dotaService';
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
        plugins: [{ id: 'web', max_results: 3 }],
        ...params
    };
    if (opts?.response_format) {
        body.response_format = opts.response_format;
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

const ANALYZE_SYSTEM = `You are a Dota 2 match analyst-chan. Provide data-driven analysis referencing specific heroes, players, item timings, damage breakdowns, and statistics. Draw actionable conclusions — identify power spikes, damage type mismatches, itemization counters, and pivotal decisions. When analyzing mistakes, consider whether the problem was execution (missed abilities) or strategic (wrong damage type into resistances, bad item choices). Structure your response clearly with numbered points. Be direct, spicy and concise. Roast caow or epi as a running joke, but your analysis MUST cover ALL underperforming players fairly — the caow roast is a bonus, not a replacement for real analysis.

Make sure to double check everything before replying to make sure nothing is missed / hallucinated.
CRITICAL — Ability name accuracy:
The "Dmg Sources" field uses Dota 2's INTERNAL ability names, which often differ from the display names players know. You MUST use the correct DISPLAY name when discussing abilities. Common internal→display mappings:
- dawnbreaker fire wreath = Starbreaker (Q), dawnbreaker celestial hammer = Celestial Hammer (W), dawnbreaker luminosity = Luminosity (passive)
- death prophet exorcism = Exorcism, death prophet spirit siphon = Spirit Siphon
- juggernaut blade fury = Blade Fury, juggernaut omni slash = Omnislash
- sniper assassinate = Assassinate, sniper shrapnel = Shrapnel
- dark seer wall of replica = Wall of Replica, dark seer ion shell = Ion Shell, dark seer surge = Surge
- muerta dead shot = Dead Shot, muerta the calling = The Calling, muerta pierce the veil = Pierce the Veil
- drow ranger multishot = Multishot, drow ranger frost arrows = Frost Arrows
- venomancer venomous gale = Venomous Gale, venomancer poison sting = Poison Sting, venomancer plague ward = Plague Ward, venomancer noxious plague = Noxious Plague
- lina laguna blade = Laguna Blade, lina light strike array = Light Strike Array, lina dragon slave = Dragon Slave
- "null" or "Right Click" = auto-attack / right-click damage
If you see an internal name not listed here, derive the display name from context (hero name prefix + ability descriptor). NEVER present raw internal names to the user.

CRITICAL — Damage type accuracy:
- Physical damage abilities (commonly misidentified as magical): Exorcism (Death Prophet), Omnislash (Juggernaut), Flak Cannon (Gyrocopter), Tidebringer (Kunkka), Sleight of Fist (Ember Spirit), March of the Machines (Tinker), Quill Spray (Bristleback), Blade Fury (deals magical but renders Jugg unable to attack).
- Pure damage abilities: Tinker Laser, Timber Chain, Whirling Death, Brain Sap, Purification, Laguna Blade (with Aghanim's Scepter).
- Always verify damage types before claiming an item counters a specific ability.

CRITICAL — Player coverage:
- Every player on the losing team should get at least a brief mention in the analysis — don't skip anyone.

CRITICAL - Make sure your information is based on the latest patch.`;

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
                    description: 'Match story: key turning points with timings and gold/XP shifts. Use **bold** for player and hero names. MAX 3 sentences.',
                },
                laningPhase: {
                    type: 'string',
                    description: 'Lane winners/losers with efficiency stats. Did laning decide the game? Use **bold** for hero names. MAX 2 sentences.',
                },
                draftItemsDamage: {
                    type: 'string',
                    description: 'Damage types vs defenses, key itemization failures. Use **bold** for item and hero names. MAX 3 sentences.',
                },
                biggestMistakes: {
                    type: 'string',
                    description: '2-3 errors by losing team, one sentence each. Use **bold** for player names.',
                },
                mvpLvp: {
                    type: 'string',
                    description: 'Format: **MVP: Player — Hero** stats. **LVP: Player — Hero** stats. One sentence each. Optionally mention 1-2 other standouts.',
                },
                losingTeamActions: {
                    type: 'string',
                    description: 'What losing team needed differently. 2-3 short bullet points.',
                },
            },
            required: ['gameNarrative', 'laningPhase', 'draftItemsDamage', 'biggestMistakes', 'mvpLvp', 'losingTeamActions'],
            additionalProperties: false,
        },
    },
};

// ── Format structured analysis into a single Discord embed ────────────────────
function formatAnalysis(data: any, matchId: number, model: string): EmbedBuilder {
    const sections = [
        `**GAME NARRATIVE**\n${data.gameNarrative}`,
        `**LANING PHASE**\n${data.laningPhase}`,
        `**DRAFT, ITEMS & DAMAGE ANALYSIS**\n${data.draftItemsDamage}`,
        `**BIGGEST MISTAKES**\n${data.biggestMistakes}`,
        `**MVP & LVP**\n${data.mvpLvp}`,
        `**WHAT THE LOSING TEAM NEEDED TO DO**\n${data.losingTeamActions}`,
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
    // Parse flags: -model <model_name> (owner-only)
    let modelOverride: string | null = null;
    const cleanArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '-model' && args[i + 1]) {
            if (message.author.id === BOT_OWNER_ID) {
                modelOverride = args[i + 1];
                i++; // skip the model name arg
            } else {
                return message.reply('❌ Model override is restricted to the bot owner.');
            }
        } else {
            cleanArgs.push(args[i]);
        }
    }

    const matchId = parseInt(cleanArgs[0], 10);
    if (!cleanArgs[0] || isNaN(matchId)) {
        return message.reply('Usage: `+analyze <match_id>` — give me a match ID to dissect! 🔍\nOwner-only: `+analyze <match_id> -model <openrouter_model>`');
    }

    try {
        safeTyping(message.channel);
        let matchData = await getDetailedMatchData(matchId);

        // ── Auto-parse wait: if not parsed, request parse and poll ────────
        if (!matchData) {
            await requestMatchParse(matchId);

            const waitEmbed = new EmbedBuilder()
                .setColor('#f59e0b')
                .setTitle('⏳ Parsing Match...')
                .setDescription(
                    `Match **#${matchId}** isn't parsed yet.\n` +
                    `I've requested OpenDota to parse it — hang tight, I'll update this message automatically when it's ready.\n\n` +
                    `⏳ Waiting for parse... (this usually takes 30s–2min)`
                )
                .setFooter({ text: 'Polling every 20s • Timeout: 5 min' });

            const waitMsg = await message.reply({ embeds: [waitEmbed] });

            // Add a hourglass reaction to the user's original message
            try { await message.react('⏳'); } catch { /* ignore missing perms */ }

            const parsed = await waitForMatchParse(matchId, {
                onTick: (attempt, max) => {
                    const elapsed = attempt * 20;
                    const mins = Math.floor(elapsed / 60);
                    const secs = elapsed % 60;
                    const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
                    waitEmbed.setDescription(
                        `Match **#${matchId}** isn't parsed yet.\n` +
                        `I've requested OpenDota to parse it — hang tight, I'll update this message automatically when it's ready.\n\n` +
                        `⏳ Still waiting... (${timeStr} elapsed, attempt ${attempt}/${max})`
                    );
                    waitMsg.edit({ embeds: [waitEmbed] }).catch(() => { });
                },
            });

            // Swap reaction
            try {
                await message.reactions.cache.get('⏳')?.users.remove(message.client.user!);
            } catch { /* ignore */ }

            if (!parsed) {
                try { await message.react('❌'); } catch { /* ignore */ }
                waitEmbed
                    .setColor('#ef4444')
                    .setTitle('❌ Parse Timeout')
                    .setDescription(
                        `Match **#${matchId}** still isn't parsed after 5 minutes.\n` +
                        `OpenDota might be slow or the replay isn't available.\n` +
                        `Try \`+analyze ${matchId}\` again later.`
                    )
                    .setFooter(null);
                return waitMsg.edit({ embeds: [waitEmbed] });
            }

            // Parsed! Update the wait message and fetch full data
            try { await message.react('✅'); } catch { /* ignore */ }
            waitEmbed
                .setColor('#22c55e')
                .setTitle('✅ Match Parsed!')
                .setDescription(`Match **#${matchId}** is ready — generating analysis now...`)
                .setFooter(null);
            await waitMsg.edit({ embeds: [waitEmbed] });

            safeTyping(message.channel);
            matchData = await getDetailedMatchData(matchId);

            if (!matchData) {
                waitEmbed
                    .setColor('#ef4444')
                    .setTitle('❌ Data Error')
                    .setDescription(`Match parsed but couldn't load detailed data. Try \`+analyze ${matchId}\` again.`);
                return waitMsg.edit({ embeds: [waitEmbed] });
            }
        }

        // ── Player block with enriched data (null-safe) ──────────────────────
        const playerBlock = matchData.players.map((p: any) => {
            const lines = [
                `[${p.team}] ${p.name} — ${p.heroName} (${p.lane}${p.isRoaming ? ' Roam' : ''})`,
                `  KDA: ${p.kills}/${p.deaths}/${p.assists} (${p.kda}) | Lvl: ${p.level || '?'} | NW: ${(p.netWorth ?? 0).toLocaleString()} | GPM: ${p.gpm ?? '?'} | XPM: ${p.xpm ?? '?'}`,
                `  Dmg: ${(p.heroDamage ?? 0).toLocaleString()} | Tower: ${(p.towerDamage ?? 0).toLocaleString()} | Heal: ${(p.heroHealing ?? 0).toLocaleString()} | LH: ${p.lastHits ?? '?'}`,
                `  Items: ${p.items?.length ? p.items.join(', ') : 'None'}`,
            ];

            // Only include if data exists
            if (p.backpack?.length) lines.push(`  Backpack: ${p.backpack.join(', ')}`);
            if (p.buybacks > 0) lines.push(`  Buybacks: ${p.buybacks}`);
            if (p.obsPlaced > 0 || p.senPlaced > 0) lines.push(`  Wards: ${p.obsPlaced} obs / ${p.senPlaced} sentries`);
            if (p.runePickups > 0) lines.push(`  Runes: ${p.runePickups}`);
            if (p.permanentBuffs?.length) lines.push(`  Buffs: ${p.permanentBuffs.join(', ')}`);

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
            if (extras.length) lines.push(`  ${extras.join(' | ')}`);

            // Top damage abilities
            if (p.topDamageAbilities?.length) {
                const abilities = p.topDamageAbilities.map((a: any) =>
                    `${a.ability} (${a.damage.toLocaleString()})`
                ).join(', ');
                lines.push(`  Dmg Sources: ${abilities}`);
            }

            // Damage dealt to each enemy hero
            if (p.damageToHeroes?.length) {
                const targets = p.damageToHeroes.map((t: any) =>
                    `${t.hero} (${t.damage.toLocaleString()})`
                ).join(', ');
                lines.push(`  Dmg Targets: ${targets}`);
            }

            // Benchmarks
            const benchKeys = Object.keys(p.benchmarks || {});
            if (benchKeys.length > 0) {
                const bStr = benchKeys.map(k => `${k}: ${p.benchmarks[k]}`).join(', ');
                lines.push(`  Benchmarks: ${bStr}`);
            }

            return lines.join('\n');
        }).join('\n\n');

        const goldGraph = matchData.goldAdvantage?.length
            ? `\n=== GOLD ADVANTAGE (Radiant perspective) ===\n${matchData.goldAdvantage.join(' → ')}`
            : '';

        const xpGraph = matchData.xpAdvantage?.length
            ? `\n=== XP ADVANTAGE (Radiant perspective) ===\n${matchData.xpAdvantage.join(' → ')}`
            : '';

        const teamfightBlock = matchData.teamfights?.length
            ? `\n=== TEAMFIGHTS ===\n${matchData.teamfights.map((f: any) =>
                `  ${formatDuration(f.start)}-${formatDuration(f.end)}: Radiant ${f.radiantKills}k / Dire ${f.direKills}k (${f.totalDeaths} deaths)`
            ).join('\n')}`
            : '';

        const objectivesBlock = matchData.objectives?.length
            ? `\n=== OBJECTIVES ===\n${matchData.objectives.slice(0, 20).map((o: any) =>
                `${formatDuration(o.time)} ${o.team} ${o.type}${o.key ? ' (' + o.key + ')' : ''}`
            ).join(', ')}`
            : '';

        const prompt = `Analyze this Dota 2 match #${matchData.matchId}:
Duration: ${formatDuration(matchData.duration)} | Winner: ${matchData.radiantWin ? 'Radiant' : 'Dire'} | Game Mode: ${matchData.gameMode}

=== PLAYERS ===
${playerBlock}
${goldGraph}
${xpGraph}
${teamfightBlock}
${objectivesBlock}

Analyze this match. Fill each schema field with CONCISE, data-backed analysis. Use Discord markdown (**bold** for player names, hero names, key items). Be direct and spicy. STRICT LIMIT: 200 words total across all fields. Each field 1-3 sentences max.`;

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
            logger.debug(`[+analyze] Raw response: ${response.slice(0, 500)}`);
            // Fallback: send raw text in embed if JSON parsing fails
            const fallbackEmbed = new EmbedBuilder()
                .setColor('#ef4444')
                .setTitle(`🔍 Match Analysis — #${matchId}`)
                .setDescription(trunc(response, 4096))
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
