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
import { fetchStratzMatch } from '../src/services/stratzClient';
import { dotaDataService } from '../src/services/dotaDataService';
import { formatDuration } from '../src/utils/formatters';
import { AI_ANALYZE_MODEL, AI_ANALYZE_PARAMS } from '../src/constants/aiService';

// ── System prompt (must match aiCommands.ts ANALYZE_SYSTEM) ──────────────────
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

async function main() {
    const args = process.argv.slice(2);
    const skipAI = args.includes('--no-ai');
    const dumpRaw = args.includes('--dump');
    
    let useStratz = false;
    let matchIdArg = '';
    
    for (const arg of args) {
        if (arg === '--no-ai' || arg === '--dump') continue;
        if (arg === '-stratz') {
            useStratz = true;
            continue;
        }
        matchIdArg = arg;
    }
    
    const matchId = parseInt(matchIdArg, 10);

    if (!matchIdArg || isNaN(matchId)) {
        console.error('Usage: pnpm test:analyze <match_id> [--no-ai] [--dump] [-stratz]');
        process.exit(1);
    }

    console.log(`\n🔍 Fetching match ${matchId} from OpenDota...\n`);

    await dotaDataService.initialize();

    let prompt: string;

    if (useStratz) {
        console.log(`\n🔍 Fetching match ${matchId} from Stratz...\n`);
        const stratzMatch = await fetchStratzMatch(matchId);
        if (!stratzMatch) {
            console.error('❌ Match not found on Stratz or error occurred.');
            process.exit(1);
        }

        if (dumpRaw) {
            console.log(JSON.stringify(stratzMatch, null, 2));
            return;
        }

        const winner = stratzMatch.didRadiantWin ? 'Radiant' : 'Dire';
        const stratzSummaryParts = [
            `Match #${stratzMatch.id || stratzMatch.match_id}`,
            `Duration: ${formatDuration(stratzMatch.durationSeconds || stratzMatch.duration)}`,
            `Winner: ${winner}`,
            stratzMatch.firstBloodTime != null ? `First Blood: ${formatDuration(stratzMatch.firstBloodTime)}` : '',
            `Game Mode: Mode ${stratzMatch.gameMode || stratzMatch.game_mode}`,
            `Average Rank: ${stratzMatch.averageRank || 'Unknown'}`,
            `Lane Outcomes (0=Draw, 1=Rad, 2=Dire): Top ${stratzMatch.topLaneOutcome}, Mid ${stratzMatch.midLaneOutcome}, Bot ${stratzMatch.bottomLaneOutcome}`
        ].filter(Boolean);

        const hasDraftStratz = (stratzMatch.pickBans?.length ?? 0) > 0;
        const draftBlockStratz = hasDraftStratz
            ? `\n=== DRAFT ORDER ===\n${await Promise.all(stratzMatch.pickBans!.map(async (d: any) => {
                const heroName = await dotaDataService.getHeroName(d.heroId);
                return `${d.order + 1}. ${d.isRadiant ? 'Radiant' : 'Dire'} ${d.isPick ? 'PICK' : 'BAN'}: ${heroName}`;
            })).then(lines => lines.join('\n'))}`
            : '';

        const goldGraphStratz = `\n=== GOLD ADVANTAGE (Radiant perspective, per minute) ===\n${stratzMatch.radiantNetworthLeads?.join(' → ') || 'N/A'}`;
        const xpGraphStratz = `\n=== XP ADVANTAGE (Radiant perspective, per minute) ===\n${stratzMatch.radiantExperienceLeads?.join(' → ') || 'N/A'}`;

        const playerBlockStratz = await Promise.all(stratzMatch.players.map(async (p: any) => {
            const header = [
                `[${p.isRadiant ? 'Radiant' : 'Dire'}] ${p.steamAccount?.name || 'Anonymous'} — ${p.hero?.displayName || `Hero ${p.heroId}`}`,
                p.variant ? `(Facet ${p.variant})` : '',
                p.isRandom ? `[RANDOMED]` : '',
                p.leaverStatus ? `[LEAVER_STATUS: ${p.leaverStatus}]` : ''
            ].filter(Boolean).join(' ');

            const lines = [
                header,
                `  KDA: ${p.kills}/${p.deaths}/${p.assists} | Lvl: ${p.level} | NW: ${p.networth} (Spent: ${p.goldSpent})`,
                `  GPM: ${p.goldPerMinute} | XPM: ${p.experiencePerMinute} | IMP: ${p.imp ?? 'N/A'} (Streak Pred: ${p.streakPrediction})`,
                `  Dmg Dealt: ${p.heroDamage} | Tower: ${p.towerDamage} | Heal: ${p.heroHealing} | LH: ${p.numLastHits} | DN: ${p.numDenies}`,
                `  Pos: ${p.position?.toString().replace('POSITION_', '') ?? 'Unknown'} | Award: ${p.award === 1 ? 'MVP' : (p.award ? 'Standout' : 'None')}`,
                p.intentionalFeeding ? `  ⚠️ INTENTIONAL FEEDING DETECTED` : '',
                p.invisibleSeconds > 60 ? `  Sneakiness: ${p.invisibleSeconds}s invisible` : ''
            ].filter(Boolean);

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
                if (p.stats.wards?.length || p.stats.wardDestruction?.length || p.stats.runes?.length || p.stats.campStack?.length) {
                    const stackCount = Array.isArray(p.stats.campStack) ? p.stats.campStack.reduce((a: number, b: number) => a + b, 0) : 0;
                    const utils = [
                        p.stats.wards?.length ? `Wards: ${p.stats.wards.length}` : '',
                        p.stats.wardDestruction?.length ? `De-ward: ${p.stats.wardDestruction.length}` : '',
                        p.stats.runes?.length ? `Runes: ${p.stats.runes.length}` : '',
                        stackCount ? `Stacks: ${stackCount}` : ''
                    ].filter(Boolean).join(' | ');
                    if (utils) lines.push(`  Utility: ${utils}`);
                }

                // Benchmarking vs Hero Averages
                if (p.heroAverage) {
                    const avg = p.heroAverage;
                    const compare = (val: number, ref: number) => {
                        if (!ref) return 'N/A';
                        const diff = ((val - ref) / ref) * 100;
                        return `${diff > 0 ? '+' : ''}${diff.toFixed(1)}%`;
                    };
                    lines.push(`  Benchmarks (vs Bracket Avg): GPM: ${compare(p.goldPerMinute, avg.goldPerMinute)}, XPM: ${compare(p.experiencePerMinute, avg.goldPerMinute)}, LH: ${compare(p.numLastHits, avg.cs)}, DN: ${compare(p.numDenies, avg.dn)}, Dmg: ${compare(p.heroDamage, avg.heroDamage)}`);
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
        for (const p of stratzMatch.players) {
            if (p.partyId != null) {
                if (!parties.has(p.partyId)) parties.set(p.partyId, []);
                parties.get(p.partyId)!.push(p.steamAccount?.name || 'Anonymous');
            }
        }
        const partyBlockStratz = Array.from(parties.values())
            .filter(members => members.length > 1)
            .map(members => `Party: ${members.join(' + ')}`)
            .join('\n');

        const objectivePartsStratz: string[] = [];
        if (stratzMatch.playbackData?.roshanEvents?.length) {
            const kills = stratzMatch.playbackData.roshanEvents.filter((r: any) => r.hp === 0);
            if (kills.length) {
                objectivePartsStratz.push(`Roshan Kills: ${kills.map((r: any) => formatDuration(r.time)).join(', ')}`);
            }
        }
        if (stratzMatch.playbackData?.buildingEvents?.length) {
            const structuralEvents = stratzMatch.playbackData.buildingEvents
                .filter((b: any) => b.hp === 0)
                .map((b: any) => `${formatDuration(b.time)} ${b.type || 'Building'} (${b.isRadiant ? 'Radiant' : 'Dire'})`);
            if (structuralEvents.length) {
                objectivePartsStratz.push(`Key Building Destructions: ${structuralEvents.join(', ')}`);
            }
        }
        if (stratzMatch.towerDeaths?.length) {
            const radTowers = stratzMatch.towerDeaths.filter((t: any) => t.isRadiant).length;
            const direTowers = stratzMatch.towerDeaths.filter((t: any) => !t.isRadiant).length;
            objectivePartsStratz.push(`Tower Deaths: Radiant lost ${radTowers}, Dire lost ${direTowers} (Details: ${stratzMatch.towerDeaths.map((t: any) => `${formatDuration(t.time)} ${t.isRadiant ? 'Rad' : 'Dire'}`).join(', ')})`);
        }
        if (stratzMatch.chatEvents?.length) {
            const chat = stratzMatch.chatEvents.slice(0, 10).map((c: any) => `${formatDuration(c.time)} ${c.isRadiant ? '[Rad]' : '[Dire]'} Hero ${c.fromHeroId}: ${c.value}`);
            if (chat.length) objectivePartsStratz.push(`Chat Log (Sample): ${chat.join(' | ')}`);
        }
        objectivePartsStratz.push(`Final Structure Status - Rad Towers: ${stratzMatch.towerStatusRadiant}, Dire Towers: ${stratzMatch.towerStatusDire} | Rad Barracks: ${stratzMatch.barracksStatusRadiant}, Dire Barracks: ${stratzMatch.barracksStatusDire}`);


        prompt = `Analyze this Dota 2 match (from Stratz high-detail API):

=== MATCH SUMMARY ===
${stratzSummaryParts.join(' | ')}
${draftBlockStratz}
${objectivePartsStratz.length ? `\n=== OBJECTIVES ===\n${objectivePartsStratz.join('\n')}` : ''}
${partyBlockStratz ? `\n=== PARTIES ===\n${partyBlockStratz}` : ''}

=== PLAYERS ===
${playerBlockStratz.join('\n\n')}
${goldGraphStratz}
${xpGraphStratz}

Analyze this match. Fill each schema field with CONCISE, data-backed analysis. Reference specific numbers like IMP scores, Lane Outcomes, and specific minute marks from the advantage graph. Use Discord markdown (**bold** for names). Be direct and spicy. STRICT LIMIT: 250 words total across all fields. Each field 2-4 sentences max.`;

    } else {
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

        // ── Validate new fields are present (omitted for brevity in this replace) ...

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

        const hasDraft = matchData.gameModeId === 2 || matchData.gameModeId === 16;
        const draftBlock = (hasDraft && matchData.draft?.length)
            ? `\n=== DRAFT ORDER ===\n${matchData.draft.map((d: any) =>
                `${d.order + 1}. ${d.team} ${d.isPick ? 'PICK' : 'BAN'}: ${d.heroName}`
            ).join('\n')}`
            : '';

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
                lines.push(`  Runes: ${p.runePickups} total pickups`);
            }
            if (p.permanentBuffs?.length) lines.push(`  Buffs: ${p.permanentBuffs.join(', ')}`);

            if (p.multiKills) lines.push(`  Multi-kills: ${p.multiKills}`);
            if (p.killStreaks) lines.push(`  Max Kill Streak: ${p.killStreaks}`);

            const farmStats: string[] = [];
            if (p.campsStacked > 0) farmStats.push(`Stacked: ${p.campsStacked}`);
            if (p.neutralKills > 0) farmStats.push(`Jungle: ${p.neutralKills}`);
            if (p.towerKills > 0) farmStats.push(`Tower Kills: ${p.towerKills}`);
            if (p.roshanKills > 0 || p.aegisPickups > 0) farmStats.push(`Roshan: ${p.roshanKills} kills / ${p.aegisPickups} aegis`);
            if (farmStats.length) lines.push(`  Farming: ${farmStats.join(' | ')}`);

            if (p.keyItemTimings?.length) {
                const timings = p.keyItemTimings.map((t: any) =>
                    `${t.item.replace(/_/g, ' ')} @ ${formatDuration(t.time)}`
                ).join(', ');
                lines.push(`  Item Timings: ${timings}`);
            }

            if (p.killTimeline?.length) {
                const kills = p.killTimeline
                    .filter((k: any) => k.time >= 0)
                    .map((k: any) =>
                        `${formatDuration(k.time)} ${k.victim.replace(/_/g, ' ')}`
                    ).join(', ');
                if (kills) lines.push(`  Kills: ${kills}`);
            }

            const extras: string[] = [];
            if (p.laneEfficiency != null) extras.push(`Lane Eff: ${p.laneEfficiency}%`);
            if (p.apm > 0) extras.push(`APM: ${p.apm}`);
            if (p.timeSpentDead > 0) extras.push(`Dead: ${p.timeSpentDead}s`);
            if (p.teamfightParticipation != null) extras.push(`TF: ${p.teamfightParticipation}%`);
            if (p.stunDuration > 0) extras.push(`Stuns: ${p.stunDuration}s`);
            if (p.leaverStatus >= 2) extras.push(`⚠️ ABANDONED`);
            if (extras.length) lines.push(`  ${extras.join(' | ')}`);

            if (p.topDamageAbilities?.length) {
                const abilities = p.topDamageAbilities.map((a: any) =>
                    `${a.ability} (${a.damage.toLocaleString()})`
                ).join(', ');
                lines.push(`  Dmg Sources: ${abilities}`);
            }

            if (p.damageReceived?.length) {
                const recv = p.damageReceived.map((r: any) =>
                    `${r.ability} (${r.damage.toLocaleString()})`
                ).join(', ');
                lines.push(`  Dmg Received: ${recv}`);
            }

            if (p.damageToHeroes?.length) {
                const targets = p.damageToHeroes.map((t: any) =>
                    `${t.hero} (${t.damage.toLocaleString()})`
                ).join(', ');
                lines.push(`  Dmg Targets: ${targets}`);
            }

            if (p.maxHeroHit) {
                lines.push(`  Biggest Hit: ${p.maxHeroHit.value.toLocaleString()} dmg (${p.maxHeroHit.inflictor} on ${p.maxHeroHit.target})`);
            }

            if (p.goldCurve?.length) lines.push(`  Gold Curve: ${p.goldCurve.join(' → ')}`);

            const benchKeys = Object.keys(p.benchmarks || {});
            if (benchKeys.length > 0) {
                const bStr = benchKeys.map((k: string) => `${k}: ${p.benchmarks[k]}`).join(', ');
                lines.push(`  Benchmarks: ${bStr}`);
            }

            return lines.join('\n');
        }).join('\n\n');

        const parties = new Map<number, string[]>();
        for (const p of matchData.players as any[]) {
            if (p.partyId != null) {
                if (!parties.has(p.partyId)) parties.set(p.partyId, []);
                parties.get(p.partyId)!.push(p.name);
            }
        }
        const partyBlock = Array.from(parties.values())
            .filter((members: string[]) => members.length > 1)
            .map((members: string[]) => `Party: ${members.join(' + ')}`)
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
