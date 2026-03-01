/**
 * CLI test for +analyze — runs the full pipeline without Discord.
 *
 * Usage:  pnpm test:analyze 8707284028
 *         pnpm test:analyze 8707284028 --no-ai   (just show the prompt, skip API call)
 */
import 'dotenv/config';
import axios from 'axios';
import { getDetailedMatchData } from '../src/services/dotaService';
import { dotaDataService } from '../src/services/dotaDataService';
import { formatDuration } from '../src/utils/formatters';
import { AI_ANALYZE_MODEL, AI_ANALYZE_PARAMS } from '../src/constants/aiService';

const ANALYZE_SYSTEM = `You are a Dota 2 match analyst. Provide precise, data-driven analysis referencing specific heroes, players, item timings, and statistics. Draw actionable conclusions from the data — identify patterns, power spikes, and pivotal decisions. Structure your response clearly with numbered points. Be direct and concise.`;

async function main() {
    const args = process.argv.slice(2);
    const matchId = parseInt(args[0], 10);
    const skipAI = args.includes('--no-ai');

    if (!matchId || isNaN(matchId)) {
        console.error('Usage: pnpm test:analyze <match_id> [--no-ai]');
        process.exit(1);
    }

    console.log(`\n Fetching match ${matchId} from OpenDota...\n`);

    await dotaDataService.initialize();

    const matchData = await getDetailedMatchData(matchId);
    if (!matchData) {
        console.error('Match not found or not parsed yet.');
        process.exit(1);
    }

    // ── Build the same prompt as aiCommands.ts ──────────────────────────────
    const playerBlock = matchData.players.map((p: any) => {
        const lines = [
            `[${p.team}] ${p.name} — ${p.heroName} (${p.lane}${p.isRoaming ? ' Roam' : ''})`,
            `  KDA: ${p.kills}/${p.deaths}/${p.assists} (${p.kda}) | Lvl: ${p.level || '?'} | NW: ${(p.netWorth ?? 0).toLocaleString()} | GPM: ${p.gpm ?? '?'} | XPM: ${p.xpm ?? '?'}`,
            `  Dmg: ${(p.heroDamage ?? 0).toLocaleString()} | Tower: ${(p.towerDamage ?? 0).toLocaleString()} | Heal: ${(p.heroHealing ?? 0).toLocaleString()} | LH: ${p.lastHits ?? '?'}`,
            `  Items: ${p.items?.length ? p.items.join(', ') : 'None'}`,
        ];
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
            const kills = p.killTimeline.map((k: any) =>
                `${formatDuration(k.time)} ${k.victim.replace(/_/g, ' ')}`
            ).join(', ');
            lines.push(`  Kills: ${kills}`);
        }

        // Extra stats
        const extras: string[] = [];
        if (p.laneEfficiency != null) extras.push(`Lane Eff: ${p.laneEfficiency}%`);
        if (p.apm > 0) extras.push(`APM: ${p.apm}`);
        if (p.timeSpentDead > 0) extras.push(`Dead: ${p.timeSpentDead}s`);
        if (extras.length) lines.push(`  ${extras.join(' | ')}`);

        // Benchmarks
        const benchKeys = Object.keys(p.benchmarks || {});
        if (benchKeys.length > 0) {
            lines.push(`  Benchmarks: ${benchKeys.map(k => `${k}: ${p.benchmarks[k]}`).join(', ')}`);
        }
        return lines.join('\n');
    }).join('\n\n');

    const goldGraph = matchData.goldAdvantage?.length
        ? `\n=== GOLD ADVANTAGE (Radiant perspective) ===\n${matchData.goldAdvantage.join(' → ')}`
        : '';

    const xpGraph = (matchData as any).xpAdvantage?.length
        ? `\n=== XP ADVANTAGE (Radiant perspective) ===\n${(matchData as any).xpAdvantage.join(' → ')}`
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

Give me:
1. What decided this game (2-3 key turning points with specific timings and item power spikes)
2. The biggest mistakes by the losing team (itemization errors, missed timings, poor objective play, buyback misuse)
3. What the winning team executed well (draft synergy, tempo, rotations, itemization)
4. Performance standouts — who over/underperformed relative to their role and benchmarks
5. One concrete change (item, playstyle, or timing) that could have flipped the outcome
Keep it specific, reference real data, and stay under 600 words.`;

    // ── Print the full prompt ───────────────────────────────────────────────
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
    console.log(`\nCalling ${AI_ANALYZE_MODEL}...\n`);
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        console.error('OPENROUTER_API_KEY not set in .env');
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
        console.log('AI RESPONSE:');
        console.log('-'.repeat(80));
        console.log(text);
        console.log('='.repeat(80));

        const usage = response.data?.usage;
        if (usage) {
            console.log(`\nTokens — prompt: ${usage.prompt_tokens}, completion: ${usage.completion_tokens}, total: ${usage.total_tokens}`);
        }
    } catch (err: any) {
        const errBody = err?.response?.data?.error?.message || err?.response?.data?.error || err?.message;
        console.error(`\nAI API error (HTTP ${err?.response?.status}): ${errBody}`);
        process.exit(1);
    }
}

main();
