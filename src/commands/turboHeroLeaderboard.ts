import { EmbedBuilder, Message } from 'discord.js';
import { Commands } from '../constants';
import { UserData } from '../models/UserData';
import { dotaDataService } from '../services/dotaDataService';
import { logger } from '../services/loggerService';
import { fetchPlayerHeroPerformance, TurboHeroPerformanceMatch } from '../services/stratzClient';
import { turboRankService } from '../services/turboRankService';
import { UserDataService } from '../services/userDataService';

const MATCH_SAMPLE_PER_PLAYER = 15;
const FETCH_BATCH_SIZE = 2;
const PLAYER_FETCH_TIMEOUT_MS = 15000;
const MIN_PROVEN_GAMES = 5;
const SHRINK_K = 5;

const EXCLUDE_COMPONENTS = new Set(['perseverance', 'sange', 'yasha', 'kaya', 'skull_basher']);
const NON_BUILD_ITEMS = new Set(['ultimate_scepter_2', 'aghanims_blessing', 'aghanims_blessing_2']);

type RoleLens = 'Carry/Core' | 'Mid' | 'Offlane' | 'Support/Flex';

interface PlayerHeroRows {
  user: UserData;
  name: string;
  matches: TurboHeroPerformanceMatch[];
}

interface PlayerScore {
  steamId: string;
  name: string;
  games: number;
  wins: number;
  rawWr: number;
  shrunkWr: number;
  role: RoleLens;
  position: string;
  score: number;
  impactPercentile: number;
  impactRaw: number;
  itemPaceSeconds: number | null;
  fastHits: number;
  fastAttempts: number;
  statsLine: string;
}

function fmtMinFromSec(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return 'n/a';
  const mins = Math.floor(seconds / 60);
  return `${mins}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
}

function fmtSignedPace(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return 'item pace n/a';
  if (Math.abs(seconds) < 30) return 'item pace even';
  return seconds > 0
    ? `items ${fmtMinFromSec(seconds)} faster`
    : `items ${fmtMinFromSec(Math.abs(seconds))} slower`;
}

function avg(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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

function splitHeroQuery(args: string[]): string {
  return args.join(' ').trim();
}

function playerName(user: UserData): string {
  return turboRankService.getSteamName(user.steamId) ?? `Steam ${user.steamId}`;
}

function isNonBuild(internal: string): boolean {
  return NON_BUILD_ITEMS.has(internal) || internal.includes('blessing');
}

function firstKeyItems(match: TurboHeroPerformanceMatch): Map<number, number> {
  const first = new Map<number, number>();
  for (const purchase of match.purchases) {
    const meta = dotaDataService.getItemMeta(purchase.itemId);
    if (!meta || !meta.isKey) continue;
    const time = Math.max(0, Number(purchase.time));
    const current = first.get(purchase.itemId);
    if (current == null || time < current) first.set(purchase.itemId, time);
  }

  const consumed = new Set<string>();
  for (const itemId of first.keys()) {
    for (const component of dotaDataService.getItemComponentNames(itemId)) consumed.add(component);
  }
  for (const itemId of [...first.keys()]) {
    const internal = dotaDataService.getItemInternalName(itemId);
    if (internal && (consumed.has(internal) || EXCLUDE_COMPONENTS.has(internal) || isNonBuild(internal))) {
      first.delete(itemId);
    }
  }
  return first;
}

async function fetchRows(users: UserData[], heroId: number, onProgress: (checked: number) => void): Promise<PlayerHeroRows[]> {
  const rows: PlayerHeroRows[] = [];
  for (let i = 0; i < users.length; i += FETCH_BATCH_SIZE) {
    const batch = users.slice(i, i + FETCH_BATCH_SIZE);
    const fetched = await Promise.all(batch.map(async (user) => ({
      user,
      name: playerName(user),
      matches: await fetchPlayerHeroPerformance(Number(user.steamId), heroId, MATCH_SAMPLE_PER_PLAYER, PLAYER_FETCH_TIMEOUT_MS),
    })));
    rows.push(...fetched.filter((row) => row.matches.length > 0));
    onProgress(Math.min(users.length, i + batch.length));
  }
  return rows;
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

function roleLens(position: string, avgGpm: number, heroRoles: string[]): RoleLens {
  if (position === 'Hard Sup' || position === 'Soft Sup') return 'Support/Flex';
  if (position === 'Mid') return 'Mid';
  if (position === 'Offlane') return 'Offlane';
  if (position === 'Safelane') return 'Carry/Core';
  if (avgGpm < 620 || heroRoles.includes('Support')) return 'Support/Flex';
  return 'Carry/Core';
}

function buildCrewItemMedians(rows: PlayerHeroRows[]): Map<number, number> {
  const times = new Map<number, number[]>();
  for (const row of rows) {
    for (const match of row.matches) {
      for (const [itemId, time] of firstKeyItems(match)) {
        const arr = times.get(itemId) ?? [];
        arr.push(time);
        times.set(itemId, arr);
      }
    }
  }

  const medians = new Map<number, number>();
  for (const [itemId, arr] of times) {
    if (arr.length >= 4) {
      const m = median(arr);
      if (m != null) medians.set(itemId, m);
    }
  }
  return medians;
}

function itemPace(row: PlayerHeroRows, crewMedians: Map<number, number>): { pace: number | null; fastHits: number; fastAttempts: number } {
  const deltas: number[] = [];
  let fastHits = 0;
  let fastAttempts = 0;
  for (const match of row.matches) {
    for (const [itemId, time] of firstKeyItems(match)) {
      const crewMedian = crewMedians.get(itemId);
      if (crewMedian == null) continue;
      deltas.push(crewMedian - time);
      fastAttempts++;
      if (time <= crewMedian) fastHits++;
    }
  }
  return { pace: median(deltas), fastHits, fastAttempts };
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

function percentileByRole(rows: PlayerScore[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const role of ['Carry/Core', 'Mid', 'Offlane', 'Support/Flex'] as RoleLens[]) {
    const group = rows.filter((row) => row.role === role).sort((a, b) => b.impactRaw - a.impactRaw);
    if (group.length === 0) continue;
    for (let i = 0; i < group.length; i++) {
      out.set(group[i].steamId, group.length === 1 ? 0.65 : 1 - i / (group.length - 1));
    }
  }
  return out;
}

function buildScores(rows: PlayerHeroRows[], heroRoles: string[], crewMedians: Map<number, number>): PlayerScore[] {
  const allGames = rows.reduce((sum, row) => sum + row.matches.length, 0);
  const allWins = rows.reduce((sum, row) => sum + row.matches.filter((match) => match.won).length, 0);
  const baselineWr = allGames > 0 ? allWins / allGames : 0.5;

  const prelim = rows.map((row) => {
    const matches = row.matches;
    const games = matches.length;
    const wins = matches.filter((match) => match.won).length;
    const stats = {
      kills: avg(matches.map((m) => m.kills)),
      deaths: avg(matches.map((m) => m.deaths)),
      assists: avg(matches.map((m) => m.assists)),
      lastHits: avg(matches.map((m) => m.lastHits)),
      gpm: avg(matches.map((m) => m.gpm)),
      xpm: avg(matches.map((m) => m.xpm)),
      heroDamage: avg(matches.map((m) => m.heroDamage)),
      towerDamage: avg(matches.map((m) => m.towerDamage)),
      heroHealing: avg(matches.map((m) => m.heroHealing)),
      wardsPlaced: avg(matches.map((m) => m.wardsPlaced)),
      wardsDestroyed: avg(matches.map((m) => m.wardsDestroyed)),
      stacks: avg(matches.map((m) => m.stacks)),
    };
    const position = plurality(matches.map((m) => m.position));
    const role = roleLens(position, stats.gpm, heroRoles);
    const impact = impactFor(role, stats);
    const pace = itemPace(row, crewMedians);
    return {
      steamId: row.user.steamId,
      name: row.name,
      games,
      wins,
      rawWr: games > 0 ? wins / games : 0,
      shrunkWr: (wins + SHRINK_K * baselineWr) / (games + SHRINK_K),
      role,
      position,
      score: 0,
      impactPercentile: 0,
      impactRaw: impact.raw,
      itemPaceSeconds: pace.pace,
      fastHits: pace.fastHits,
      fastAttempts: pace.fastAttempts,
      statsLine: impact.line,
    };
  });

  const impactPercentiles = percentileByRole(prelim);
  return prelim.map((row) => {
    const impactPercentile = impactPercentiles.get(row.steamId) ?? 0.5;
    const fastRate = row.fastAttempts > 0 ? row.fastHits / row.fastAttempts : 0.5;
    const itemBonus = (row.itemPaceSeconds == null ? 0 : clamp(row.itemPaceSeconds / 60, -5, 5) * 1.25)
      + (fastRate - 0.5) * 7;
    return {
      ...row,
      impactPercentile,
      score: row.shrunkWr * 68 + impactPercentile * 22 + itemBonus + Math.min(row.games, 12) * 0.15,
    };
  }).sort((a, b) => b.score - a.score);
}

function scoreLine(row: PlayerScore, index: number): string {
  const wr = Math.round(row.rawWr * 100);
  const shrunk = Math.round(row.shrunkWr * 100);
  const fast = row.fastAttempts ? `, fast items ${row.fastHits}/${row.fastAttempts}` : '';
  const small = row.games < MIN_PROVEN_GAMES ? ' · small sample' : '';
  return `**${index + 1}. ${row.name}** — ${row.role} (${row.position}) · ${row.games}G ${row.wins}-${row.games - row.wins}, ${wr}% WR (shrunk ${shrunk}%) · ${fmtSignedPace(row.itemPaceSeconds)}${fast}\n${row.statsLine}${small}`;
}

export async function turboHeroLeaderboard(message: Message, args: string[], userDataService: UserDataService) {
  try {
    const heroQuery = splitHeroQuery(args);
    if (!heroQuery) {
      return message.reply(`Usage: \`+${Commands.TURBO_HERO_LB} <hero>\` e.g. \`+${Commands.TURBO_HERO_LB} drow ranger\`.`);
    }

    await dotaDataService.getItemName(1);
    const hero = dotaDataService.findHeroByName(heroQuery);
    if (!hero) {
      return message.reply(`Couldn't find a hero matching "${heroQuery}". Try \`+${Commands.TURBO_HERO_LB} crystal maiden\`.`);
    }

    const users = userDataService.getAllUsers();
    if (users.length === 0) return message.reply('No registered users to rank yet.');

    const progress = await message.reply(`🏆 Building Turbo hero leaderboard for **${hero.localized_name}** across ${users.length} registered player(s)…`);
    const rows = await fetchRows(users, hero.id, (checked) => {
      if (checked === users.length || checked % 6 === 0) {
        progress.edit(`🏆 Building **${hero.localized_name}** leaderboard… checked ${checked}/${users.length} player(s).`).catch(() => {});
      }
    });

    const enoughRows = rows.filter((row) => row.matches.length >= 2);
    if (enoughRows.length === 0) {
      return progress.edit(`Not enough parsed Turbo **${hero.localized_name}** games yet. Need at least 2 games from at least one registered player.`);
    }

    const crewMedians = buildCrewItemMedians(enoughRows);
    const scores = buildScores(enoughRows, dotaDataService.getHeroRoles(hero.id), crewMedians);
    const proven = scores.filter((row) => row.games >= MIN_PROVEN_GAMES);
    const watch = scores.filter((row) => row.games < MIN_PROVEN_GAMES);
    const totalGames = enoughRows.reduce((sum, row) => sum + row.matches.length, 0);
    const totalWins = enoughRows.reduce((sum, row) => sum + row.matches.filter((match) => match.won).length, 0);
    const roleCounts = [...scores.reduce((map, row) => {
      map.set(row.role, (map.get(row.role) ?? 0) + 1);
      return map;
    }, new Map<RoleLens, number>()).entries()]
      .map(([role, n]) => `${role}: **${n}**`)
      .join(' · ');

    const embed = new EmbedBuilder()
      .setColor('#22c55e')
      .setTitle(`🏆 Turbo Hero Leaderboard — ${hero.localized_name}`)
      .setDescription('Role-aware crew ranking for one Turbo hero. Uses sample-shrunk winrate, role-specific impact stats, and key-item pace.')
      .addFields(
        {
          name: 'Coverage',
          value:
            `Players checked: **${users.length}** | players ranked: **${scores.length}**\n` +
            `Hero games studied: **${totalGames}** (${totalWins}-${totalGames - totalWins}, **${Math.round((totalWins / totalGames) * 100)}% WR**)\n` +
            `Role lenses: ${roleCounts || 'n/a'}`,
          inline: false,
        },
        {
          name: 'Proven Leaderboard',
          value: fitLines(proven.slice(0, 8).map(scoreLine), `Need ${MIN_PROVEN_GAMES}+ games for a proven ranking.`),
          inline: false,
        },
        ...(watch.length ? [{
          name: 'Small Sample Watch',
          value: fitLines(watch.slice(0, 5).map(scoreLine), 'No small samples.'),
          inline: false,
        }] : []),
        {
          name: 'Method',
          value:
            `Proven ranking requires ${MIN_PROVEN_GAMES}+ recent parsed Turbo games on this hero; smaller samples are shown separately. ` +
            'Score = shrunk WR first, then role-specific impact percentile, then key-item pace. ' +
            'Carry/Core emphasizes GPM, LH, damage and tower damage. Mid emphasizes GPM/XPM, kills and damage. Offlane emphasizes damage, assists and objectives. Support/Flex emphasizes assists, healing, wards, dewards and stacks. ' +
            'Stun duration is not included yet because this fast Stratz scan does not expose reliable stun seconds.',
          inline: false,
        },
      )
      .setTimestamp();

    await progress.edit({ content: null, embeds: [embed] });
  } catch (error) {
    logger.error('Error in turboherolb command:', error);
    await message.reply('An error occurred while building the Turbo hero leaderboard. Please try again later.');
  }
}
