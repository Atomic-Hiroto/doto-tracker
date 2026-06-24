import { EmbedBuilder, Message } from 'discord.js';
import { UserData } from '../models/UserData';
import { dotaDataService } from '../services/dotaDataService';
import { logger } from '../services/loggerService';
import { fetchPlayerTurboDeepMatches, TurboDeepPlayerMatch } from '../services/stratzClient';
import { mmrToMedal, rankTierToMMR, turboRankService } from '../services/turboRankService';
import { UserDataService } from '../services/userDataService';

const SOLO_TAKE = 20;
const PARTY_TAKE = 8;
const FETCH_BATCH_SIZE = 2;
const PLAYER_FETCH_TIMEOUT_MS = 25000;
const MIN_SOLO_GAMES = 3;
const MIN_PARTY_GAMES = 2;
const SHRINK_K = 6;
const RECENCY_HALF_LIFE_DAYS = 60;

type RoleLens = 'Carry/Core' | 'Mid' | 'Offlane' | 'Support/Flex';

interface Target {
  steamId: string;
  discordId: string;
  name: string;
  discovered?: boolean;
  estimate: NonNullable<ReturnType<typeof turboRankService.getEstimateBySteamId>>;
}

interface ReadSummary {
  games: number;
  wins: number;
  readMMR: number | null;
  effectiveSample: number;
  avgVisibleRanks: number;
  volatility: number | null;
  newestAgeDays: number | null;
}

interface PlayerDeepRow {
  target: Target;
  solo: TurboDeepPlayerMatch[];
  party: TurboDeepPlayerMatch[];
  soloRead: ReadSummary;
  partyRead: ReadSummary;
  role: RoleLens;
  position: string;
  impactRaw: number;
  impactPercentile: number;
  statsLine: string;
  topHeroId: number | null;
  topHeroCount: number;
  uniqueHeroes: number;
}

function avg(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function fmtMmr(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${Math.round(value)} MMR`;
}

function fmtRead(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${mmrToMedal(value).medal} (~${Math.round(value)})`;
}

function pct(wins: number, games: number): string {
  return games ? `${Math.round((wins / games) * 100)}%` : 'n/a';
}

function daysSince(ts: number | null | undefined): number | null {
  if (!ts) return null;
  return Math.max(0, Math.floor((Date.now() / 1000 - ts) / 86400));
}

function fitLines(lines: string[], emptyText: string, limit = 1000): string {
  if (lines.length === 0) return emptyText;
  const selected: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const extra = selected.length ? 1 : 0;
    if (used + lines[i].length + extra > limit) {
      const tail = `...and ${lines.length - i} more.`;
      const tailExtra = selected.length ? 1 : 0;
      if (used + tail.length + tailExtra <= limit) selected.push(tail);
      break;
    }
    selected.push(lines[i]);
    used += lines[i].length + extra;
  }
  return selected.join('\n');
}

function rankValues(ranks: number[]): number[] {
  return ranks
    .map(rankTierToMMR)
    .filter((value): value is number => value != null && Number.isFinite(value));
}

function lobbyMmr(match: TurboDeepPlayerMatch): number | null {
  const mmrs = rankValues(match.otherRanks);
  if (mmrs.length < 3) return null;
  return avg(mmrs);
}

function summarizeRead(matches: TurboDeepPlayerMatch[]): ReadSummary {
  const usable = matches
    .map((match) => ({ match, lobby: lobbyMmr(match), visible: rankValues(match.otherRanks).length }))
    .filter((row): row is { match: TurboDeepPlayerMatch; lobby: number; visible: number } => row.lobby != null);

  const wins = matches.filter((match) => match.won).length;
  if (usable.length === 0) {
    return {
      games: matches.length,
      wins,
      readMMR: null,
      effectiveSample: 0,
      avgVisibleRanks: 0,
      volatility: null,
      newestAgeDays: null,
    };
  }

  const now = Date.now() / 1000;
  const decayLambda = Math.LN2 / (RECENCY_HALF_LIFE_DAYS * 86400);
  let weightedSum = 0;
  let totalWeight = 0;
  let effectiveSample = 0;

  for (const row of usable) {
    const ageSec = Math.max(0, now - row.match.startDateTime);
    const recency = Math.exp(-decayLambda * ageSec);
    const completeness = Math.min(row.visible, 9) / 9;
    const w = recency * completeness;
    weightedSum += row.lobby * w;
    totalWeight += w;
    effectiveSample += completeness;
  }

  const readMMR = totalWeight > 0 ? weightedSum / totalWeight : null;
  const variance = readMMR == null
    ? null
    : usable.reduce((sum, row) => sum + Math.pow(row.lobby - readMMR, 2), 0) / usable.length;
  const newestTs = usable.reduce((max, row) => Math.max(max, row.match.startDateTime || 0), 0);

  return {
    games: matches.length,
    wins,
    readMMR: readMMR == null ? null : Math.round(readMMR),
    effectiveSample: Math.round(effectiveSample * 100) / 100,
    avgVisibleRanks: avg(usable.map((row) => row.visible)),
    volatility: variance == null ? null : Math.round(Math.sqrt(variance)),
    newestAgeDays: daysSince(newestTs),
  };
}

function plurality(values: Array<string | null | undefined>, fallback = 'Unknown'): string {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best = fallback;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function roleLens(position: string, avgGpm: number): RoleLens {
  if (position === 'Hard Sup' || position === 'Soft Sup') return 'Support/Flex';
  if (position === 'Mid') return 'Mid';
  if (position === 'Offlane') return 'Offlane';
  if (position === 'Safelane') return 'Carry/Core';
  return avgGpm < 620 ? 'Support/Flex' : 'Carry/Core';
}

function impactFor(role: RoleLens, stats: {
  kills: number; deaths: number; assists: number; lastHits: number; gpm: number; xpm: number;
  heroDamage: number; towerDamage: number; heroHealing: number; wardsPlaced: number; wardsDestroyed: number; stacks: number;
}): { raw: number; line: string } {
  if (role === 'Support/Flex') {
    const raw =
      stats.assists * 1.35
      + stats.heroHealing / 1200
      + stats.wardsPlaced * 1.1
      + stats.wardsDestroyed * 2.0
      + stats.stacks * 1.2
      + stats.heroDamage / 5000
      - stats.deaths * 1.5;
    return {
      raw,
      line: `${stats.assists.toFixed(1)} ast, ${stats.wardsPlaced.toFixed(1)} wards, ${stats.wardsDestroyed.toFixed(1)} dewards, ${(stats.heroHealing / 1000).toFixed(1)}k heal`,
    };
  }

  if (role === 'Offlane') {
    const raw =
      stats.heroDamage / 2400
      + stats.towerDamage / 1200
      + stats.assists * 0.95
      + stats.wardsDestroyed * 1.0
      + stats.stacks * 0.6
      + stats.kills * 1.2
      - stats.deaths * 1.7;
    return {
      raw,
      line: `${stats.kills.toFixed(1)}/${stats.deaths.toFixed(1)}/${stats.assists.toFixed(1)}, ${(stats.heroDamage / 1000).toFixed(1)}k dmg, ${(stats.towerDamage / 1000).toFixed(1)}k tower`,
    };
  }

  if (role === 'Mid') {
    const raw =
      stats.gpm / 30
      + stats.xpm / 35
      + stats.heroDamage / 2200
      + stats.kills * 2.0
      + stats.assists * 0.5
      - stats.deaths * 2.0;
    return {
      raw,
      line: `${Math.round(stats.gpm)} GPM, ${Math.round(stats.xpm)} XPM, ${(stats.heroDamage / 1000).toFixed(1)}k dmg, ${stats.kills.toFixed(1)} kills`,
    };
  }

  const raw =
    stats.gpm / 25
    + stats.lastHits / 8
    + stats.heroDamage / 2500
    + stats.towerDamage / 800
    + stats.kills * 1.8
    + stats.assists * 0.4
    - stats.deaths * 2.0;
  return {
    raw,
    line: `${Math.round(stats.gpm)} GPM, ${Math.round(stats.lastHits)} LH, ${(stats.heroDamage / 1000).toFixed(1)}k dmg, ${(stats.towerDamage / 1000).toFixed(1)}k tower`,
  };
}

function percentileByRole(rows: PlayerDeepRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const role of ['Carry/Core', 'Mid', 'Offlane', 'Support/Flex'] as RoleLens[]) {
    const group = rows.filter((row) => row.role === role).sort((a, b) => b.impactRaw - a.impactRaw);
    if (group.length === 0) continue;
    for (let i = 0; i < group.length; i++) {
      out.set(group[i].target.steamId, group.length === 1 ? 0.65 : 1 - i / (group.length - 1));
    }
  }
  return out;
}

function topHero(matches: TurboDeepPlayerMatch[]): { heroId: number | null; count: number; unique: number } {
  const counts = new Map<number, number>();
  for (const match of matches) {
    if (match.heroId == null) continue;
    counts.set(match.heroId, (counts.get(match.heroId) ?? 0) + 1);
  }
  let heroId: number | null = null;
  let count = 0;
  for (const [id, n] of counts) {
    if (n > count) {
      heroId = id;
      count = n;
    }
  }
  return { heroId, count, unique: counts.size };
}

function buildDeepRow(target: Target, solo: TurboDeepPlayerMatch[], party: TurboDeepPlayerMatch[]): PlayerDeepRow {
  const statsMatches = solo.length ? solo : party;
  const stats = {
    kills: avg(statsMatches.map((m) => m.kills)),
    deaths: avg(statsMatches.map((m) => m.deaths)),
    assists: avg(statsMatches.map((m) => m.assists)),
    lastHits: avg(statsMatches.map((m) => m.lastHits)),
    gpm: avg(statsMatches.map((m) => m.gpm)),
    xpm: avg(statsMatches.map((m) => m.xpm)),
    heroDamage: avg(statsMatches.map((m) => m.heroDamage)),
    towerDamage: avg(statsMatches.map((m) => m.towerDamage)),
    heroHealing: avg(statsMatches.map((m) => m.heroHealing)),
    wardsPlaced: avg(statsMatches.map((m) => m.wardsPlaced)),
    wardsDestroyed: avg(statsMatches.map((m) => m.wardsDestroyed)),
    stacks: avg(statsMatches.map((m) => m.stacks)),
  };
  const position = plurality(statsMatches.map((m) => m.position));
  const role = roleLens(position, stats.gpm);
  const impact = impactFor(role, stats);
  const hero = topHero(statsMatches);
  return {
    target,
    solo,
    party,
    soloRead: summarizeRead(solo),
    partyRead: summarizeRead(party),
    role,
    position,
    impactRaw: impact.raw,
    impactPercentile: 0,
    statsLine: impact.line,
    topHeroId: hero.heroId,
    topHeroCount: hero.count,
    uniqueHeroes: hero.unique,
  };
}

function withImpactPercentiles(rows: PlayerDeepRow[]): PlayerDeepRow[] {
  const percentiles = percentileByRole(rows);
  return rows.map((row) => ({
    ...row,
    impactPercentile: percentiles.get(row.target.steamId) ?? 0.5,
  }));
}

async function nameFor(message: Message, entry: ReturnType<typeof turboRankService.getAllEstimates>[number]): Promise<string> {
  if (entry.steamName) return entry.steamName;
  if (entry.discordId) {
    const user = await message.client.users.fetch(entry.discordId).catch(() => null);
    if (user) return user.username;
  }
  return `Steam ${entry.steamId}`;
}

function parseMode(args: string[]) {
  const lowered = args.map((arg) => arg.toLowerCase());
  return {
    crewOnly: lowered.some((arg) => ['crew', 'friends', 'mine', 'squad'].includes(arg)),
    includeDiscovered: lowered.some((arg) => ['all', 'everyone', 'full'].includes(arg)),
    noParty: lowered.some((arg) => ['noparty', 'soloonly', 'solo-only'].includes(arg)),
  };
}

async function targetsFor(message: Message, args: string[], userDataService: UserDataService): Promise<Target[]> {
  const mode = parseMode(args);
  const registeredSteamIds = new Set(userDataService.getAllUsers().map((user: UserData) => user.steamId));
  const estimates = turboRankService.getAllEstimates()
    .filter((entry) => mode.includeDiscovered || !entry.discovered)
    .filter((entry) => !mode.crewOnly || registeredSteamIds.has(entry.steamId));

  const named = await Promise.all(estimates.map(async (entry) => ({
    steamId: entry.steamId,
    discordId: entry.discordId,
    discovered: entry.discovered,
    name: await nameFor(message, entry),
    estimate: entry.estimate,
  })));

  return named;
}

async function fetchRows(
  targets: Target[],
  includeParty: boolean,
  onProgress: (checked: number) => void,
): Promise<PlayerDeepRow[]> {
  const rows: PlayerDeepRow[] = [];

  for (let i = 0; i < targets.length; i += FETCH_BATCH_SIZE) {
    const batch = targets.slice(i, i + FETCH_BATCH_SIZE);
    const fetched = await Promise.all(batch.map(async (target) => {
      const soloPromise = fetchPlayerTurboDeepMatches(Number(target.steamId), SOLO_TAKE, false, PLAYER_FETCH_TIMEOUT_MS);
      const partyPromise = includeParty
        ? fetchPlayerTurboDeepMatches(Number(target.steamId), PARTY_TAKE, true, PLAYER_FETCH_TIMEOUT_MS)
        : Promise.resolve([]);
      const [solo, party] = await Promise.all([soloPromise, partyPromise]);
      return buildDeepRow(target, solo, party);
    }));
    rows.push(...fetched.filter((row) => row.solo.length > 0 || row.party.length > 0));
    onProgress(Math.min(targets.length, i + batch.length));
  }

  return withImpactPercentiles(rows);
}

function rowFlags(row: PlayerDeepRow): string[] {
  const flags: string[] = [];
  const delta = row.soloRead.readMMR == null ? null : row.soloRead.readMMR - row.target.estimate.estimatedMMR;
  if (row.soloRead.games < 5) flags.push('thin solo');
  if (row.soloRead.effectiveSample < 3) flags.push('low visible sample');
  if ((row.soloRead.volatility ?? 0) >= 500) flags.push('volatile lobbies');
  if ((row.soloRead.newestAgeDays ?? 0) > 30) flags.push('not current');
  if (Date.now() - row.target.estimate.lastUpdated > 21 * 86400000) flags.push('stale calibration');
  if (delta != null && Math.abs(delta) >= 300) flags.push('large drift');
  if (row.target.estimate.partyFallback) flags.push('official party fallback');
  return flags;
}

function recalibrationLine(row: PlayerDeepRow): string {
  const delta = row.soloRead.readMMR == null ? null : row.soloRead.readMMR - row.target.estimate.estimatedMMR;
  const flags = rowFlags(row);
  return `**${row.target.name}** — recent solo **${fmtRead(row.soloRead.readMMR)}** vs official **${row.target.estimate.medal}** (~${row.target.estimate.estimatedMMR}) ` +
    `(${fmtMmr(delta)}) · ${row.soloRead.games} solo, eff ${row.soloRead.effectiveSample}` +
    (flags.length ? ` · ${flags.join(', ')}` : '');
}

async function formLine(row: PlayerDeepRow, index: number): Promise<string> {
  const games = row.soloRead.games || row.partyRead.games;
  const wins = row.soloRead.games ? row.soloRead.wins : row.partyRead.wins;
  const baseline = 0.5;
  const shrunkWr = (wins + SHRINK_K * baseline) / (games + SHRINK_K);
  const heroName = row.topHeroId == null ? 'mixed heroes' : await dotaDataService.getHeroName(row.topHeroId);
  return `**${index + 1}. ${row.target.name}** — ${row.role} (${row.position}) · ${games}G ${wins}-${games - wins}, ${pct(wins, games)} WR (shrunk ${Math.round(shrunkWr * 100)}%) · impact p${Math.round(row.impactPercentile * 100)}\n` +
    `${row.statsLine} · top hero ${heroName} ${row.topHeroCount}/${games}`;
}

function partyLine(row: PlayerDeepRow): string {
  const delta = row.partyRead.readMMR != null && row.soloRead.readMMR != null
    ? row.partyRead.readMMR - row.soloRead.readMMR
    : null;
  return `**${row.target.name}** — solo **${fmtRead(row.soloRead.readMMR)}** -> party **${fmtRead(row.partyRead.readMMR)}** (${fmtMmr(delta)}) · ${row.soloRead.games} solo / ${row.partyRead.games} party`;
}

async function heroPoolLine(row: PlayerDeepRow): Promise<string> {
  const games = row.solo.length || row.party.length;
  const top = row.topHeroId == null ? 'unknown' : await dotaDataService.getHeroName(row.topHeroId);
  const share = games ? Math.round((row.topHeroCount / games) * 100) : 0;
  const label = share >= 45 ? 'specialist' : row.uniqueHeroes >= 8 ? 'wide pool' : 'mixed pool';
  return `**${row.target.name}** — ${top} ${row.topHeroCount}/${games} (${share}%) · ${row.uniqueHeroes} unique · ${label}`;
}

export async function turboStudyDeep(message: Message, args: string[], userDataService: UserDataService) {
  try {
    const mode = parseMode(args);
    const targets = await targetsFor(message, args, userDataService);
    if (targets.length < 3) {
      return message.reply('Need at least 3 calibrated TurboRank players for a deep Stratz study.');
    }

    const includeParty = !mode.noParty;
    const progress = await message.reply(
      `🧬 Running deep Stratz Turbo study for **${targets.length}** calibrated player(s)… ` +
      `solo ${SOLO_TAKE}/player${includeParty ? `, party ${PARTY_TAKE}/player` : ''}.`,
    );

    const rows = await fetchRows(targets, includeParty, (checked) => {
      if (checked === targets.length || checked % 6 === 0) {
        progress.edit(`🧬 Deep Stratz study… checked ${checked}/${targets.length} player(s).`).catch(() => {});
      }
    });

    const usable = rows.filter((row) => row.soloRead.games >= MIN_SOLO_GAMES && row.soloRead.readMMR != null);
    if (usable.length < 3) {
      return progress.edit(`Deep Stratz scan finished, but only **${usable.length}** player(s) had ${MIN_SOLO_GAMES}+ recent solo Turbo games with visible-rank lobbies.`);
    }

    const totalSolo = rows.reduce((sum, row) => sum + row.solo.length, 0);
    const totalParty = rows.reduce((sum, row) => sum + row.party.length, 0);
    const avgVisible = avg(usable.map((row) => row.soloRead.avgVisibleRanks));
    const deltas = usable
      .map((row) => row.soloRead.readMMR == null ? null : row.soloRead.readMMR - row.target.estimate.estimatedMMR)
      .filter((value): value is number => value != null);
    const avgDrift = avg(deltas);
    const driftUp = deltas.filter((delta) => delta >= 250).length;
    const driftDown = deltas.filter((delta) => delta <= -250).length;

    const roleCounts = [...usable.reduce((map, row) => {
      map.set(row.role, (map.get(row.role) ?? 0) + 1);
      return map;
    }, new Map<RoleLens, number>()).entries()]
      .map(([role, n]) => `${role}: **${n}**`)
      .join(' · ');

    const recalibration = usable
      .slice()
      .sort((a, b) => {
        const ad = Math.abs((a.soloRead.readMMR ?? a.target.estimate.estimatedMMR) - a.target.estimate.estimatedMMR);
        const bd = Math.abs((b.soloRead.readMMR ?? b.target.estimate.estimatedMMR) - b.target.estimate.estimatedMMR);
        return bd - ad;
      })
      .slice(0, 8)
      .map(recalibrationLine);

    const formRows = usable
      .slice()
      .sort((a, b) => {
        const aForm = ((a.soloRead.wins + SHRINK_K * 0.5) / (a.soloRead.games + SHRINK_K)) * 55 + a.impactPercentile * 35 + clamp((a.soloRead.readMMR ?? 0) / 1000, 0, 6);
        const bForm = ((b.soloRead.wins + SHRINK_K * 0.5) / (b.soloRead.games + SHRINK_K)) * 55 + b.impactPercentile * 35 + clamp((b.soloRead.readMMR ?? 0) / 1000, 0, 6);
        return bForm - aForm;
      })
      .slice(0, 6);
    const formLines = await Promise.all(formRows.map(formLine));

    const partyRows = usable
      .filter((row) => row.partyRead.games >= MIN_PARTY_GAMES && row.partyRead.readMMR != null)
      .sort((a, b) => {
        const ad = Math.abs((a.partyRead.readMMR ?? 0) - (a.soloRead.readMMR ?? 0));
        const bd = Math.abs((b.partyRead.readMMR ?? 0) - (b.soloRead.readMMR ?? 0));
        return bd - ad;
      })
      .slice(0, 6)
      .map(partyLine);

    const poolRows = usable
      .filter((row) => row.topHeroId != null)
      .sort((a, b) => (b.topHeroCount / Math.max(1, b.solo.length)) - (a.topHeroCount / Math.max(1, a.solo.length)))
      .slice(0, 6);
    const poolLines = await Promise.all(poolRows.map(heroPoolLine));

    const embed = new EmbedBuilder()
      .setColor('#06b6d4')
      .setTitle(mode.crewOnly ? '🧬 Turbo Study Deep — Crew Stratz Scan' : '🧬 Turbo Study Deep — Stratz Scan')
      .setDescription('Heavy diagnostic scan over recent Stratz Turbo data. This derives audit signals only; it does not change official ranks or leaderboards.')
      .addFields(
        {
          name: 'Coverage',
          value:
            `Players checked: **${targets.length}** | players with usable solo read: **${usable.length}**\n` +
            `Matches scanned: **${totalSolo}** solo${includeParty ? `, **${totalParty}** party` : ''}\n` +
            `Average visible ranks in usable solo lobbies: **${avgVisible.toFixed(1)}/9**\n` +
            `Average recent drift vs official: **${fmtMmr(avgDrift)}** · drift up/down >=250: **${driftUp}/${driftDown}**\n` +
            `Role lenses: ${roleCounts || 'n/a'}`,
          inline: false,
        },
        {
          name: 'Recalibration / Audit Queue',
          value: fitLines(recalibration, 'No large drift detected.'),
          inline: false,
        },
        {
          name: 'Recent Role/Form Signals',
          value: fitLines(formLines, 'No role/form rows.'),
          inline: false,
        },
        {
          name: 'Party Contamination Read',
          value: includeParty ? fitLines(partyRows, 'Not enough party data to compare against solo.') : 'Party scan disabled.',
          inline: false,
        },
        {
          name: 'Hero Pool Shape',
          value: fitLines(poolLines, 'No hero-pool rows.'),
          inline: false,
        },
        {
          name: 'Method',
          value:
            `For each player, Stratz recent Turbo solo games are re-read using other-player visible medals, 60d recency decay and visible-rank completeness. ` +
            `Official TurboRank is untouched. Role/form uses role-specific stats normalized inside the scanned pool. Party rows are diagnostic only because party matchmaking follows stack average, not individual MMR.\n` +
            `Flags: \`crew\` scans registered players only, \`all\` includes discovered players, \`noparty\` skips the party scan.`,
          inline: false,
        },
      )
      .setTimestamp();

    await progress.edit({ content: null, embeds: [embed] });
  } catch (error) {
    logger.error('Error in deep turbo study command:', error);
    await message.reply('An error occurred while running the deep Stratz Turbo study. Please try again later.');
  }
}
