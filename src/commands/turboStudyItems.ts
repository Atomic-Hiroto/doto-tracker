import { EmbedBuilder, Message } from 'discord.js';
import { Commands } from '../constants';
import { UserData } from '../models/UserData';
import { dotaDataService } from '../services/dotaDataService';
import { logger } from '../services/loggerService';
import { fetchHeroItemBenchmarks, fetchPlayerHeroItemTimings, TurboHeroMatchItems } from '../services/stratzClient';
import { turboRankService } from '../services/turboRankService';
import { UserDataService } from '../services/userDataService';

const MATCH_SAMPLE_PER_PLAYER = 15;
const FETCH_BATCH_SIZE = 2;
const PLAYER_FETCH_TIMEOUT_MS = 15000;
const MIN_TRUSTED_PLAYER_GAMES = 5;
// Turbo completes items ~55-65% of the ranked time (2× gold, but also boosted XP and a
// compressed lane phase), so divide the ranked benchmark by 1.8 — not 2 — for the turbo "par".
const TURBO_PACE_FACTOR = 1.8;
const EXCLUDE_COMPONENTS = new Set(['perseverance', 'sange', 'yasha', 'kaya', 'skull_basher']);
const NON_BUILD_ITEMS = new Set(['ultimate_scepter_2', 'aghanims_blessing', 'aghanims_blessing_2']);
const PROGRESSION_CONTEXT_ITEMS = new Set(['crystalys', 'maelstrom']);

interface StudyMatch {
  matchId: number;
  steamId: string;
  playerName: string;
  durationSeconds: number;
  won: boolean;
  firstByItem: Map<number, number>;
}

interface Bucket {
  wins: number;
  games: number;
}

interface ItemSignal {
  itemId: number;
  name: string;
  count: number;
  wins: number;
  medianAll: number;
  medianWin: number | null;
  medianLoss: number | null;
  parMin: number | null;
  cutoff: number;
  fast: Bucket;
  slow: Bucket;
  timingEdge: number | null;
  fastEdge: number | null;
}

interface PlayerHeroScore {
  steamId: string;
  playerName: string;
  games: number;
  wins: number;
  shrunkWr: number;
  paceSeconds: number | null;
  paceSamples: number;
  fastHits: number;
  fastAttempts: number;
  score: number;
}

function isNonBuild(internal: string): boolean {
  return NON_BUILD_ITEMS.has(internal) || internal.includes('blessing');
}

function fmtMinFromSec(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return 'n/a';
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
}

function pct(bucket: Bucket): string {
  return bucket.games > 0 ? `${Math.round((bucket.wins / bucket.games) * 100)}%` : 'n/a';
}

function pp(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${Math.round(value * 100)}pp`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function fmtSignedPace(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return 'pace n/a';
  if (Math.abs(seconds) < 30) return 'on crew pace';
  return seconds > 0
    ? `${fmtMinFromSec(seconds)} faster`
    : `${fmtMinFromSec(Math.abs(seconds))} slower`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
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
  return args
    .filter((arg) => !['crew', 'friends', 'mine', 'squad'].includes(arg.toLowerCase()))
    .join(' ')
    .trim();
}

function playerName(user: UserData): string {
  return turboRankService.getSteamName(user.steamId) ?? `Steam ${user.steamId}`;
}

function collapseFinishedItems(match: TurboHeroMatchItems): Map<number, number> {
  const firstByItem = new Map<number, number>();
  for (const purchase of match.purchases) {
    const meta = dotaDataService.getItemMeta(purchase.itemId);
    if (!meta || !meta.isKey) continue;
    const sec = Math.max(0, Number(purchase.time));
    const current = firstByItem.get(purchase.itemId);
    if (current == null || sec < current) firstByItem.set(purchase.itemId, sec);
  }

  const consumed = new Set<string>();
  for (const itemId of firstByItem.keys()) {
    for (const component of dotaDataService.getItemComponentNames(itemId)) consumed.add(component);
  }

  for (const itemId of [...firstByItem.keys()]) {
    const internal = dotaDataService.getItemInternalName(itemId);
    if (internal && (consumed.has(internal) || EXCLUDE_COMPONENTS.has(internal) || isNonBuild(internal))) {
      firstByItem.delete(itemId);
    }
  }

  return firstByItem;
}

async function fetchPlayerRows(user: UserData, heroId: number): Promise<StudyMatch[]> {
  const matches = await fetchPlayerHeroItemTimings(
    Number(user.steamId),
    heroId,
    MATCH_SAMPLE_PER_PLAYER,
    PLAYER_FETCH_TIMEOUT_MS,
  );
  return matches
    .filter((match) => typeof match.won === 'boolean')
    .map((match) => ({
      matchId: match.matchId,
      steamId: user.steamId,
      playerName: playerName(user),
      durationSeconds: match.durationSeconds,
      won: match.won!,
      firstByItem: collapseFinishedItems(match),
    }))
    .filter((match) => match.firstByItem.size > 0);
}

async function fetchCrewRows(
  users: UserData[],
  heroId: number,
  onProgress: (checked: number) => void,
): Promise<{ rows: StudyMatch[]; playersWithRows: number }> {
  const rows: StudyMatch[] = [];
  let playersWithRows = 0;

  for (let i = 0; i < users.length; i += FETCH_BATCH_SIZE) {
    const batch = users.slice(i, i + FETCH_BATCH_SIZE);
    const batchRows = await Promise.all(batch.map((user) => fetchPlayerRows(user, heroId)));
    for (const playerRows of batchRows) {
      if (playerRows.length > 0) playersWithRows++;
      rows.push(...playerRows);
    }
    onProgress(Math.min(users.length, i + batch.length));
  }

  const seen = new Set<number>();
  return {
    rows: rows.filter((row) => {
      if (seen.has(row.matchId)) return false;
      seen.add(row.matchId);
      return true;
    }),
    playersWithRows,
  };
}

function buildSignals(matches: StudyMatch[], benchmarks: Map<number, number>): ItemSignal[] {
  const itemIds = new Set<number>();
  for (const match of matches) {
    for (const itemId of match.firstByItem.keys()) itemIds.add(itemId);
  }

  const minBuys = Math.max(4, Math.ceil(matches.length * 0.12));
  const signals: ItemSignal[] = [];

  for (const itemId of itemIds) {
    const meta = dotaDataService.getItemMeta(itemId);
    if (!meta) continue;

    const bought = matches
      .map((match) => ({ match, time: match.firstByItem.get(itemId) }))
      .filter((row): row is { match: StudyMatch; time: number } => row.time != null);
    if (bought.length < minBuys) continue;

    const winTimes = bought.filter((row) => row.match.won).map((row) => row.time);
    const lossTimes = bought.filter((row) => !row.match.won).map((row) => row.time);
    const allTimes = bought.map((row) => row.time);
    const medianAll = median(allTimes);
    if (medianAll == null) continue;

    const medianWin = median(winTimes);
    const medianLoss = median(lossTimes);
    const cutoff = medianWin ?? medianAll;
    const fast: Bucket = { wins: 0, games: 0 };
    const slow: Bucket = { wins: 0, games: 0 };

    for (const match of matches) {
      const time = match.firstByItem.get(itemId);
      const bucket = time != null && time <= cutoff ? fast : slow;
      bucket.games++;
      if (match.won) bucket.wins++;
    }

    const fastRate = fast.games > 0 ? fast.wins / fast.games : null;
    const slowRate = slow.games > 0 ? slow.wins / slow.games : null;
    signals.push({
      itemId,
      name: meta.name,
      count: bought.length,
      wins: bought.filter((row) => row.match.won).length,
      medianAll,
      medianWin,
      medianLoss,
      parMin: benchmarks.has(itemId) ? (benchmarks.get(itemId)! / TURBO_PACE_FACTOR) : null,
      cutoff,
      fast,
      slow,
      timingEdge: medianWin != null && medianLoss != null ? medianLoss - medianWin : null,
      fastEdge: fastRate != null && slowRate != null ? fastRate - slowRate : null,
    });
  }

  return signals;
}

function timingSignalLine(signal: ItemSignal): string {
  const par = signal.parMin != null ? ` · par ${fmtMinFromSec(signal.parMin * 60)}` : '';
  return `**${signal.name}** — ${signal.count} buys; W@ **${fmtMinFromSec(signal.medianWin)}** vs L@ **${fmtMinFromSec(signal.medianLoss)}**${par}; <=${fmtMinFromSec(signal.cutoff)}: **${pct(signal.fast)}** vs late/miss **${pct(signal.slow)}** (${pp(signal.fastEdge)})`;
}

function commonItemLine(signal: ItemSignal): string {
  const buyWr = signal.count > 0 ? `${Math.round((signal.wins / signal.count) * 100)}%` : 'n/a';
  return `**${signal.name}** — ${signal.count} buys, ${buyWr} WR, median ${fmtMinFromSec(signal.medianAll)}`;
}

function isProgressionContextItem(itemId: number): boolean {
  const internal = dotaDataService.getItemInternalName(itemId);
  return !!internal && PROGRESSION_CONTEXT_ITEMS.has(internal);
}

function choosePlayerScoreItems(signals: ItemSignal[]): ItemSignal[] {
  const chosen = new Map<number, ItemSignal>();
  for (const signal of signals
    .filter((s) => (s.fastEdge ?? 0) > 0 && s.count >= 4)
    .sort((a, b) => (b.fastEdge ?? 0) - (a.fastEdge ?? 0))) {
    chosen.set(signal.itemId, signal);
    if (chosen.size >= 4) break;
  }
  for (const signal of [...signals].sort((a, b) => b.count - a.count)) {
    if (chosen.size >= 4) break;
    chosen.set(signal.itemId, signal);
  }
  return [...chosen.values()];
}

function buildPlayerScores(matches: StudyMatch[], signals: ItemSignal[], baselineWr: number): PlayerHeroScore[] {
  const scoreItems = choosePlayerScoreItems(signals);
  if (scoreItems.length === 0) return [];

  const byPlayer = new Map<string, StudyMatch[]>();
  for (const match of matches) {
    byPlayer.set(match.steamId, [...(byPlayer.get(match.steamId) ?? []), match]);
  }

  const shrinkK = 5;
  return [...byPlayer.entries()]
    .map(([steamId, playerMatches]) => {
      const games = playerMatches.length;
      const wins = playerMatches.filter((match) => match.won).length;
      const shrunkWr = (wins + shrinkK * baselineWr) / (games + shrinkK);
      const playerName = playerMatches[0]?.playerName ?? `Steam ${steamId}`;

      const paceDeltas: number[] = [];
      let fastHits = 0;
      let fastAttempts = 0;
      for (const signal of scoreItems) {
        const times = playerMatches
          .map((match) => match.firstByItem.get(signal.itemId))
          .filter((time): time is number => time != null);
        const playerMedian = median(times);
        if (playerMedian != null) paceDeltas.push(signal.medianAll - playerMedian);
        for (const time of times) {
          fastAttempts++;
          if (time <= signal.cutoff) fastHits++;
        }
      }

      const paceSeconds = median(paceDeltas);
      const fastRate = fastAttempts > 0 ? fastHits / fastAttempts : baselineWr;
      const paceBonus = paceSeconds == null ? 0 : clamp(paceSeconds / 60, -5, 5) * 1.25;
      const fastBonus = (fastRate - 0.5) * 8;
      const score = shrunkWr * 100 + paceBonus + fastBonus + Math.min(games, 12) * 0.15;

      return {
        steamId,
        playerName,
        games,
        wins,
        shrunkWr,
        paceSeconds,
        paceSamples: paceDeltas.length,
        fastHits,
        fastAttempts,
        score,
      };
    })
    .filter((row) => row.games >= 2)
    .sort((a, b) => b.score - a.score);
}

function playerScoreLine(row: PlayerHeroScore, index: number): string {
  const wr = Math.round((row.wins / row.games) * 100);
  const shrunk = Math.round(row.shrunkWr * 100);
  const sample = row.games < MIN_TRUSTED_PLAYER_GAMES ? ' · small sample' : '';
  const fast = row.fastAttempts > 0 ? ` · fast hits ${row.fastHits}/${row.fastAttempts}` : '';
  return `**${index + 1}. ${row.playerName}** — ${row.games}G ${row.wins}-${row.games - row.wins}, ${wr}% WR (shrunk ${shrunk}%) · ${fmtSignedPace(row.paceSeconds)}${fast}${sample}`;
}

export async function turboStudyItems(message: Message, args: string[], userDataService: UserDataService) {
  try {
    const heroQuery = splitHeroQuery(args);
    if (!heroQuery) {
      return message.reply(`Usage: \`+${Commands.TURBO_STUDY_ITEMS} <hero>\` e.g. \`+${Commands.TURBO_STUDY_ITEMS} phantom assassin\`.`);
    }

    await dotaDataService.getItemName(1); // ensure constants are initialized for sync lookups
    const hero = dotaDataService.findHeroByName(heroQuery);
    if (!hero) {
      return message.reply(`Couldn't find a hero matching "${heroQuery}". Try the full name, e.g. \`+${Commands.TURBO_STUDY_ITEMS} phantom assassin\`.`);
    }

    const users = userDataService.getAllUsers();
    if (users.length === 0) return message.reply('No registered users to study yet.');

    const progress = await message.reply(`📊 Studying Turbo item timings for **${hero.localized_name}** across ${users.length} registered player(s)…`);
    const [{ rows: matches, playersWithRows }, benchmarks] = await Promise.all([
      fetchCrewRows(users, hero.id, (checked) => {
        if (checked === users.length || checked % 6 === 0) {
          progress.edit(`📊 Studying **${hero.localized_name}** item timings… checked ${checked}/${users.length} player(s).`).catch(() => {});
        }
      }),
      fetchHeroItemBenchmarks(hero.id),
    ]);

    if (matches.length < 8) {
      return progress.edit(`Not enough parsed Turbo **${hero.localized_name}** games with item data yet. Found ${matches.length}; need at least 8.`);
    }

    const wins = matches.filter((match) => match.won).length;
    const baselineWr = wins / matches.length;
    const signals = buildSignals(matches, benchmarks);
    if (signals.length === 0) {
      return progress.edit(`Found ${matches.length} Turbo **${hero.localized_name}** games, but no key item cleared the sample gate.`);
    }

    const timingSignals = signals
      .filter((signal) =>
        signal.medianWin != null
        && signal.medianLoss != null
        && signal.fast.games >= 3
        && signal.slow.games >= 3
        && signal.fastEdge != null,
      )
      .sort((a, b) => {
        const edge = (b.fastEdge ?? 0) - (a.fastEdge ?? 0);
        if (Math.abs(edge) > 0.01) return edge;
        return (b.timingEdge ?? 0) - (a.timingEdge ?? 0);
      });

    const fasterInWins = [...signals]
      .filter((signal) => signal.timingEdge != null && signal.timingEdge > 0)
      .sort((a, b) => (b.timingEdge ?? 0) - (a.timingEdge ?? 0))
      .slice(0, 5)
      .map((signal) => `**${signal.name}** — wins are **${fmtMinFromSec(signal.timingEdge)}** earlier (${fmtMinFromSec(signal.medianWin)} vs ${fmtMinFromSec(signal.medianLoss)})`);

    const commonItems = [...signals]
      .sort((a, b) => b.count - a.count)
      .slice(0, 6)
      .map(commonItemLine);

    const playerScores = buildPlayerScores(matches, signals, baselineWr);
    const trustedPlayerScores = playerScores.filter((row) => row.games >= MIN_TRUSTED_PLAYER_GAMES);
    const smallSamplePlayers = playerScores.filter((row) => row.games < MIN_TRUSTED_PLAYER_GAMES);
    const scoreItems = choosePlayerScoreItems(signals);
    const scoreItemNames = scoreItems.map((signal) => signal.name).join(', ');

    const baitOrLate = [...signals]
      .filter((signal) =>
        !isProgressionContextItem(signal.itemId)
        && ((signal.fastEdge ?? 0) <= -0.05 || (signal.timingEdge ?? 0) < -90)
      )
      .sort((a, b) => (a.fastEdge ?? 0) - (b.fastEdge ?? 0))
      .slice(0, 3)
      .map((signal) => `**${signal.name}** — fast bucket ${pct(signal.fast)} vs late/miss ${pct(signal.slow)} (${pp(signal.fastEdge)}); inspect before treating as core.`);

    const embed = new EmbedBuilder()
      .setColor('#f97316')
      .setTitle(`🧪 Turbo Item Study — ${hero.localized_name}`)
      .setDescription(
        'Crew-level timing study from recent parsed Stratz Turbo games. This is correlation, not proof that an item causes the win.',
      )
      .addFields(
        {
          name: 'Coverage',
          value:
            `Players checked: **${users.length}** | players with games: **${playersWithRows}**\n` +
            `Hero games studied: **${matches.length}** (${wins}-${matches.length - wins}, **${Math.round(baselineWr * 100)}% WR**)\n` +
            `Per-player sample cap: **${MATCH_SAMPLE_PER_PLAYER}** recent Turbo ${hero.localized_name} games`,
          inline: false,
        },
        {
          name: 'Best Crew Players',
          value: fitLines(
            trustedPlayerScores.slice(0, 7).map(playerScoreLine),
            `Need at least ${MIN_TRUSTED_PLAYER_GAMES} parsed games from a player before ranking them as proven.`,
          ),
          inline: false,
        },
        ...(smallSamplePlayers.length > 0 ? [{
          name: 'Small Sample Watch',
          value: fitLines(smallSamplePlayers.slice(0, 5).map(playerScoreLine), 'No small-sample players.'),
          inline: false,
        }] : []),
        {
          name: 'Best Timing Signals',
          value: fitLines(timingSignals.slice(0, 5).map(timingSignalLine), 'No item has enough win/loss timing split yet.'),
          inline: false,
        },
        {
          name: 'Earlier In Wins',
          value: fitLines(fasterInWins, 'No clear earlier-in-wins item timing yet.'),
          inline: false,
        },
        {
          name: 'Most Common Key Items',
          value: fitLines(commonItems, 'No common key items found.'),
          inline: false,
        },
        {
          name: 'Possible Bait / Context Items',
          value: fitLines(baitOrLate, 'No obvious bait/context warning from this sample.'),
          inline: false,
        },
        {
          name: 'How To Read This',
          value:
            '`Best Crew Players` uses shrunk WR first, then key-item pace and fast-hit count, so item timing matters but a faster 1-4 sample does not beat proven winning. Pace is measured against crew medians for: ' +
            `${scoreItemNames || 'the common key items'}.\n` +
            '`W@` and `L@` are median completion timings in wins/losses. `<=time` compares games where the item arrived by the winning median against late or missed games. Expensive item WR is biased by already-winning games, so timing split matters more than raw WR.',
          inline: false,
        },
      )
      .setTimestamp();

    await progress.edit({ content: null, embeds: [embed] });
  } catch (error) {
    logger.error('Error in turbostudyitems command:', error);
    await message.reply('An error occurred while building the Turbo item study. Please try again later.');
  }
}
