/**
 * CLI test for +analyze — runs the full pipeline without Discord.
 * Mirrors the exact same prompt construction as aiCommands.ts analyze().
 *
 * Usage:  pnpm test:analyze 8723829704
 *         pnpm test:analyze 8723829704 --no-ai   (just show the prompt, skip API call)
 *         pnpm test:analyze 8723829704 --dump     (dump raw matchData JSON to stdout)
 */
import 'dotenv/config';
import axios from 'axios';
import { getDetailedMatchData } from '../src/services/dotaService';
import { dotaDataService } from '../src/services/dotaDataService';
import { formatDuration } from '../src/utils/formatters';
import { AI_ANALYZE_MODEL, AI_ANALYZE_PARAMS } from '../src/constants/aiService';

// ── System prompt (must match aiCommands.ts ANALYZE_SYSTEM) ──────────────────
const ANALYZE_SYSTEM = `You are a Dota 2 match analyst-chan. You receive rich structured match data and produce data-driven analysis.

## Your Analytical Framework
Follow this reasoning order to ensure comprehensive analysis:
1. **Draft context** — Evaluate pick/ban synergies, lane matchups, team compositions, and hero facet choices
2. **Laning phase** — Use lane efficiency %, CS curves, first blood timing, and gold curves to determine lane outcomes
3. **Economy & itemization** — Cross-reference item timings with gold curves, evaluate choices against enemy damage types and compositions
4. **Teamfights & objectives** — Identify key fights from the teamfight log, correlate with objective kills and gold swings
5. **Decisive plays** — Pin down the specific moment(s) that decided the game using kill timelines, buyback logs, and comeback/throw values

## Data Field Guide
- **heroVariant** = hero facet (1-indexed), the Dota 2 facet system. Mention if a facet choice was suboptimal.
- **rankTier** = player rank medal. Use to contextualize play quality.
- **partyId** = party grouping. Players sharing a partyId queued together — note coordinated plays.
- **multiKills / killStreaks** = highlight spectacular multi-kill and streak performances.
- **campsStacked / neutralKills** = jungle efficiency and support contribution.
- **maxHeroHit** = biggest single damage instance — highlight if notable.
- **damageReceived** = incoming damage sources — identify who got focused and by what.
- **goldCurve / lhCurve** = net worth and CS over time — use to identify farming patterns and power spikes.
- **buybackLog** = buyback timings — critical for late-game analysis.
- **comeback / throw** = max gold swing values — quantifies how dramatic the game was.

## CRITICAL RULES

Ability name accuracy:
Dmg Sources use Dota 2 INTERNAL ability names. Always translate to display names:
- dawnbreaker fire wreath = Starbreaker (Q), dawnbreaker celestial hammer = Celestial Hammer (W), dawnbreaker luminosity = Luminosity (passive)
- death prophet exorcism = Exorcism, death prophet spirit siphon = Spirit Siphon
- juggernaut blade fury = Blade Fury, juggernaut omni slash = Omnislash
- sniper assassinate = Assassinate, sniper shrapnel = Shrapnel
- dark seer wall of replica = Wall of Replica, dark seer ion shell = Ion Shell
- muerta dead shot = Dead Shot, muerta the calling = The Calling, muerta pierce the veil = Pierce the Veil
- drow ranger multishot = Multishot, drow ranger frost arrows = Frost Arrows
- venomancer venomous gale = Venomous Gale, venomancer poison sting = Poison Sting, venomancer plague ward = Plague Ward
- lina laguna blade = Laguna Blade, lina light strike array = Light Strike Array, lina dragon slave = Dragon Slave
- "null" or "Right Click" = auto-attack damage
If you see an internal name not listed, derive the display name from context. NEVER show raw internal names.

Damage type accuracy:
- Physical: Exorcism, Omnislash, Flak Cannon, Tidebringer, Sleight of Fist, Quill Spray
- Pure: Tinker Laser, Timber Chain, Whirling Death, Brain Sap, Purification, Laguna Blade (w/ Aghs)
- Verify damage types before claiming item counters.

Player coverage:
- Every player on the LOSING team must get at least a brief mention — don't skip anyone.
- Roast caow or epi if present (running joke), but never replace real analysis with just roasts.

Be direct, spicy, and concise. Use Discord markdown (**bold** for names). Base everything on the provided data, not assumptions.`;

// ── Structured output schema (must match aiCommands.ts) ──────────────────────
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
                    description: 'Combined draft + laning analysis in 2-3 sentences. Comment on draft synergies/weaknesses, facet choices (if notable), and lane outcomes using lane efficiency and CS data. Name lane winners/losers. Use **bold** for hero names.',
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
                    description: 'Format: **MVP: Player — Hero** with 1 sentence on why (cite stats). **LVP: Player — Hero** with 1 sentence. Optionally 1-2 other standouts.',
                },
                whatToImprove: {
                    type: 'string',
                    description: 'What the losing team should do differently. 2-3 bullet points, each actionable and specific.',
                },
            },
            required: ['gameNarrative', 'draftAndLaning', 'itemizationAndDamage', 'keyMistakes', 'mvpAndStandouts', 'whatToImprove'],
            additionalProperties: false,
        },
    },
};

async function main() {
    const args = process.argv.slice(2);
    const matchId = parseInt(args[0], 10);
    const skipAI = args.includes('--no-ai');
    const dumpRaw = args.includes('--dump');

    if (!matchId || isNaN(matchId)) {
        console.error('Usage: pnpm test:analyze <match_id> [--no-ai] [--dump]');
        process.exit(1);
    }

    console.log(`\n🔍 Fetching match ${matchId} from OpenDota...\n`);

    await dotaDataService.initialize();

    const matchData = await getDetailedMatchData(matchId);
    if (!matchData) {
        console.error('❌ Match not found or not parsed yet.');
        process.exit(1);
    }

    // ── Optionally dump raw match data ───────────────────────────────────────
    if (dumpRaw) {
        console.log(JSON.stringify(matchData, null, 2));
        return;
    }

    // ── Validate new fields are present ──────────────────────────────────────
    console.log('📋 FIELD VALIDATION:');
    console.log('-'.repeat(60));
    const checks = [
        ['draft', matchData.draft?.length ?? 0, 'Draft picks/bans'],
        ['firstBloodTime', matchData.firstBloodTime, 'First blood time'],
        ['radiantScore', matchData.radiantScore, 'Radiant score'],
        ['direScore', matchData.direScore, 'Dire score'],
        ['skillBracket', matchData.skillBracket, 'Skill bracket'],
        ['comeback', matchData.comeback, 'Comeback value'],
        ['throw', matchData.throw, 'Throw value'],
    ];
    for (const [field, val, label] of checks) {
        const status = val != null && val !== 0 ? '✅' : '⚠️  (null/0)';
        console.log(`  ${status} ${label}: ${JSON.stringify(val)}`);
    }

    // Per-player new fields (check first player)
    const p0 = (matchData as any).players[0];
    const playerChecks = [
        ['heroVariant', p0.heroVariant, 'Hero facet'],
        ['rankTier', p0.rankTier, 'Rank tier'],
        ['partyId', p0.partyId, 'Party ID'],
        ['denies', p0.denies, 'Denies'],
        ['multiKills', p0.multiKills, 'Multi-kills'],
        ['killStreaks', p0.killStreaks, 'Kill streaks'],
        ['campsStacked', p0.campsStacked, 'Camps stacked'],
        ['neutralKills', p0.neutralKills, 'Neutral kills'],
        ['towerKills', p0.towerKills, 'Tower kills'],
        ['roshanKills', p0.roshanKills, 'Roshan kills'],
        ['maxHeroHit', p0.maxHeroHit?.value, 'Max hero hit'],
        ['damageReceived', p0.damageReceived?.length, 'Dmg received entries'],
        ['goldCurve', p0.goldCurve?.length, 'Gold curve samples'],
        ['lhCurve', p0.lhCurve?.length, 'LH curve samples'],
        ['buybackLog', p0.buybackLog?.length, 'Buyback log entries'],
        ['leaverStatus', p0.leaverStatus, 'Leaver status'],
        ['abilityBuild', p0.abilityBuild?.length, 'Ability build length'],
    ];
    console.log(`\n  Player 0: ${p0.name} — ${p0.heroName}`);
    for (const [field, val, label] of playerChecks) {
        const status = val != null && val !== 0 ? '✅' : '⚠️  (null/0)';
        console.log(`    ${status} ${label}: ${JSON.stringify(val)}`);
    }
    console.log('');

    // ── Build the EXACT same prompt as aiCommands.ts analyze() ───────────────

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

    // Draft block
    const draftBlock = matchData.draft?.length
        ? `\n=== DRAFT ORDER ===\n${matchData.draft.map((d: any) =>
            `${d.order + 1}. ${d.team} ${d.isPick ? 'PICK' : 'BAN'}: ${d.heroName}`
        ).join('\n')}`
        : '';

    // Player blocks with all new fields
    const playerBlock = matchData.players.map((p: any) => {
        const header = [
            `[${p.team}] ${p.name} — ${p.heroName}`,
            p.heroVariant ? `(Facet ${p.heroVariant})` : '',
            `(${p.lane}${p.isRoaming ? ' Roam' : ''})`,
            p.rankTier ? `[${p.rankTier}]` : '',
        ].filter(Boolean).join(' ');

        const lines = [
            header,
            `  KDA: ${p.kills}/${p.deaths}/${p.assists} (${p.kda}) | Lvl: ${p.level || '?'} | NW: ${(p.netWorth ?? 0).toLocaleString()} | GPM: ${p.gpm ?? '?'} | XPM: ${p.xpm ?? '?'}`,
            `  Dmg: ${(p.heroDamage ?? 0).toLocaleString()} | Tower: ${(p.towerDamage ?? 0).toLocaleString()} | Heal: ${(p.heroHealing ?? 0).toLocaleString()} | LH: ${p.lastHits ?? '?'} | DN: ${p.denies ?? 0}`,
            `  Items: ${p.items?.length ? p.items.join(', ') : 'None'}`,
        ];

        if (p.backpack?.length) lines.push(`  Backpack: ${p.backpack.join(', ')}`);
        if (p.buybacks > 0) {
            const buybackTimes = p.buybackLog?.length
                ? ` (at ${p.buybackLog.map((bb: any) => formatDuration(bb.time)).join(', ')})`
                : '';
            lines.push(`  Buybacks: ${p.buybacks}${buybackTimes}`);
        }
        if (p.obsPlaced > 0 || p.senPlaced > 0) lines.push(`  Wards: ${p.obsPlaced} obs / ${p.senPlaced} sentries`);
        if (p.runePickups > 0) lines.push(`  Runes: ${p.runePickups}`);
        if (p.permanentBuffs?.length) lines.push(`  Buffs: ${p.permanentBuffs.join(', ')}`);

        // Multi-kills and streaks
        if (p.multiKills) lines.push(`  Multi-kills: ${p.multiKills}`);
        if (p.killStreaks) lines.push(`  Max Kill Streak: ${p.killStreaks}`);

        // Farming stats
        const farmStats: string[] = [];
        if (p.campsStacked > 0) farmStats.push(`Stacked: ${p.campsStacked}`);
        if (p.neutralKills > 0) farmStats.push(`Jungle: ${p.neutralKills}`);
        if (p.towerKills > 0) farmStats.push(`Tower Kills: ${p.towerKills}`);
        if (p.roshanKills > 0) farmStats.push(`Rosh Kills: ${p.roshanKills}`);
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
            const bStr = benchKeys.map((k: string) => `${k}: ${p.benchmarks[k]}`).join(', ');
            lines.push(`  Benchmarks: ${bStr}`);
        }

        return lines.join('\n');
    }).join('\n\n');

    // Party groupings
    const parties = new Map<number, string[]>();
    for (const p of matchData.players as any[]) {
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
            `  ${formatDuration(f.start)}-${formatDuration(f.end)}: Radiant ${f.radiantKills}k / Dire ${f.direKills}k (${f.totalDeaths} deaths)`
        ).join('\n')}`
        : '';

    const objectivesBlock = matchData.objectives?.length
        ? `\n=== OBJECTIVES ===\n${matchData.objectives.slice(0, 25).map((o: any) =>
            `${formatDuration(o.time)} ${o.team} ${o.type}${o.key ? ' (' + o.key + ')' : ''}`
        ).join(', ')}`
        : '';

    const prompt = `Analyze this Dota 2 match:

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

    // ── Print everything ─────────────────────────────────────────────────────
    console.log('='.repeat(80));
    console.log('SYSTEM PROMPT:');
    console.log('-'.repeat(80));
    console.log(ANALYZE_SYSTEM);
    console.log('='.repeat(80));
    console.log(`USER PROMPT (${prompt.length} chars):`);
    console.log('-'.repeat(80));
    console.log(prompt);
    console.log('='.repeat(80));

    if (skipAI) {
        console.log('\n--no-ai flag set, skipping AI call. Done.');
        return;
    }

    // ── Call AI ──────────────────────────────────────────────────────────────
    console.log(`\n🤖 Calling ${AI_ANALYZE_MODEL}...\n`);
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        console.error('❌ OPENROUTER_API_KEY not set in .env');
        process.exit(1);
    }

    try {
        const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                model: AI_ANALYZE_MODEL,
                messages: [
                    { role: 'system', content: ANALYZE_SYSTEM },
                    { role: 'user', content: prompt },
                ],
                plugins: [{ id: 'web', max_results: 3 }, { id: 'json-healing' }],
                response_format: ANALYZE_RESPONSE_FORMAT,
                ...AI_ANALYZE_PARAMS,
            },
            {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://github.com/Atomic-Hiroto/doto-tracker',
                    'X-Title': 'Doto Tracker',
                },
            }
        );

        const content = response.data?.choices?.[0]?.message?.content;
        let text: string;
        if (Array.isArray(content)) {
            text = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trimStart();
        } else {
            text = (content || '').trimStart();
        }

        console.log('='.repeat(80));
        console.log('RAW AI RESPONSE:');
        console.log('-'.repeat(80));
        console.log(text);
        console.log('='.repeat(80));

        // Parse structured response
        try {
            const parsed = JSON.parse(text);
            console.log('\n✅ JSON PARSE SUCCESSFUL');
            console.log('-'.repeat(60));
            for (const [key, value] of Object.entries(parsed)) {
                console.log(`\n📌 ${key}:`);
                console.log(value);
            }
        } catch (parseErr) {
            console.error('\n❌ JSON PARSE FAILED — raw text above');
        }

        const usage = response.data?.usage;
        if (usage) {
            console.log(`\n📊 Tokens — prompt: ${usage.prompt_tokens}, completion: ${usage.completion_tokens}, total: ${usage.total_tokens}`);
        }
    } catch (err: any) {
        const errBody = err?.response?.data?.error?.message || err?.response?.data?.error || err?.message;
        console.error(`\n❌ AI API error (HTTP ${err?.response?.status}): ${errBody}`);
        process.exit(1);
    }
}

main();
