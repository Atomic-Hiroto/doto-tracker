import fs from 'fs';
import path from 'path';
import { AttachmentBuilder, Client, EmbedBuilder, Guild, TextBasedChannel, TextChannel } from 'discord.js';
import { ChannelConstants } from '../constants';
import {
  TI_ACTIVE_GRACE_MS, TI_FINISH_GIVEUP_MS, TI_LEAGUE_ID, TI_LEAGUE_LABEL, TI_LIVE_TICKER, TI_MAIN_STAGE_START,
  TI_POLL_ACTIVE_MS, TI_POLL_IDLE_MS, TI_REPARSE_INTERVAL_MS, TI_REPARSE_MAX_AGE_MS,
  TI_STATE_FILE, TI_SWEEP_MIN_INTERVAL_MS,
} from '../constants/ti';
import { opendotaClient } from './apiClient';
import { renderScoreboardFromMatch } from './chartService';
import { dotaDataService } from './dotaDataService';
import { logger } from './loggerService';
import { scoreFantasy, seriesTotal, topContributors } from './tiFantasy';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface TiFantasyRow {
  accountId: number;
  name: string;
  team: string;
  heroId: number;
  heroName: string;
  isRadiant: boolean;
  kills: number;
  deaths: number;
  assists: number;
  netWorth: number;
  gpm: number;
  points: number;
  drivers: string;
}

export interface TiGameRecord {
  matchId: number;
  seriesId: number | null;
  seriesType: number | null;
  startTime: number;
  duration: number;
  radiantName: string;
  direName: string;
  radiantTag: string;
  direTag: string;
  radiantScore: number;
  direScore: number;
  radiantWin: boolean;
  gameNumber: number;
  parsed: boolean;
  postedAt: number;
  messageId?: string;
  channelId?: string;
  fantasy: TiFantasyRow[];
}

interface TiState {
  enabled: boolean;
  leagueId: number;
  games: Record<string, TiGameRecord>;
  /** Series id -> the ids of the live-ticker messages already cleaned up, plus the wrap-up post. */
  seriesWrapped: Record<string, string>;
  live: Record<string, { messageId: string; channelId: string; gameTime: number; frozenSince: number }>;
  /** Match ids believed to have just ended, mapped to when we first thought so. */
  pendingFinish: Record<string, number>;
  lastSweep: number;
  lastReparse: number;
  lastActivity: number;
}

const STATE_PATH = path.resolve(process.cwd(), TI_STATE_FILE);

function emptyState(): TiState {
  return {
    enabled: true, leagueId: TI_LEAGUE_ID, games: {}, seriesWrapped: {},
    live: {}, pendingFinish: {}, lastSweep: 0, lastReparse: 0, lastActivity: 0,
  };
}

let state: TiState = emptyState();
let loaded = false;

function loadState(): TiState {
  if (loaded) return state;
  loaded = true;
  try {
    if (fs.existsSync(STATE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
      state = { ...emptyState(), ...parsed };
      // A league switch (next year's TI) must not inherit last year's posted set.
      if (state.leagueId !== TI_LEAGUE_ID) state = { ...emptyState() };
    }
  } catch (error) {
    logger.error('Could not read TI state, starting fresh:', error);
    state = emptyState();
  }
  return state;
}

function saveState() {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (error) {
    logger.error('Could not persist TI state:', error);
  }
}

export function getTiState(): TiState {
  return loadState();
}

export function setTiEnabled(enabled: boolean) {
  loadState();
  state.enabled = enabled;
  saveState();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A text channel we can actually post into — PartialGroupDMChannel has no `send`. */
export type PostTarget = TextBasedChannel & { send: TextChannel['send'] };

function asPostTarget(channel: unknown): PostTarget | null {
  const candidate = channel as any;
  return candidate?.isTextBased?.() && typeof candidate.send === 'function' ? candidate as PostTarget : null;
}

const SERIES_LABEL: Record<number, string> = { 0: 'Bo1', 1: 'Bo3', 2: 'Bo5' };
const WINS_NEEDED: Record<number, number> = { 0: 1, 1: 2, 2: 3 };
/** Games inside one series follow each other closely; a rematch never does. */
const SERIES_GAP_SECONDS = 6 * 60 * 60;

export function seriesLabel(seriesType: number | null | undefined): string {
  return seriesType == null ? 'Series' : SERIES_LABEL[seriesType] || 'Series';
}

export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  return `${mins}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

const fmtPoints = (points: number) => points.toLocaleString('en-US');

/** Every main-stage game we have already recorded, oldest first. */
export function mainStageGames(): TiGameRecord[] {
  return Object.values(loadState().games).sort((a, b) => a.startTime - b.startTime);
}

export interface TiSeries {
  key: string;
  games: TiGameRecord[];
  seriesType: number | null;
  /** Stable order: whoever was Radiant in the opening game comes first. */
  teams: [string, string];
  wins: Record<string, number>;
  decided: boolean;
  winner: string | null;
}

/**
 * Groups main-stage games into series.
 *
 * OpenDota's `series_id` is the obvious key, but it is null on the opening game
 * of a series often enough that trusting it renumbers half the bracket ("Game 1"
 * twice in a row). Grouping on the team pair plus time proximity is what the
 * data actually supports: consecutive games of a series are minutes apart, while
 * a lower-bracket rematch between the same two orgs is days away and only starts
 * once the earlier series is already decided.
 */
export function buildSeriesGroups(games: TiGameRecord[] = mainStageGames()): TiSeries[] {
  const groups: TiSeries[] = [];
  for (const game of games) {
    const pair = [game.radiantName, game.direName].sort().join(' | ');
    const open = groups.find(group =>
      group.key.startsWith(pair)
      && !group.decided
      && game.startTime - group.games[group.games.length - 1].startTime <= SERIES_GAP_SECONDS);

    const group = open ?? {
      key: `${pair}#${game.startTime}`,
      games: [],
      seriesType: null,
      teams: [game.radiantName, game.direName] as [string, string],
      wins: { [game.radiantName]: 0, [game.direName]: 0 },
      decided: false,
      winner: null,
    };
    if (!open) groups.push(group);

    group.games.push(game);
    if (group.seriesType == null && game.seriesType != null) group.seriesType = game.seriesType;
    group.wins[game.radiantWin ? game.radiantName : game.direName]++;

    // `series_type` is frequently null on the opening game of a series, and
    // Number(null) is 0 — i.e. "Bo1" — which would close every series after one
    // map. An unknown format is assumed to be a Bo3.
    const needed = group.seriesType == null ? 2 : WINS_NEEDED[group.seriesType] ?? 2;
    const [teamA, teamB] = group.teams;
    if (group.wins[teamA] >= needed || group.wins[teamB] >= needed) {
      group.decided = true;
      group.winner = group.wins[teamA] > group.wins[teamB] ? teamA : teamB;
    }
  }
  return groups;
}

/** The series a given game belongs to, with that game already counted. */
export function seriesForGame(game: TiGameRecord): TiSeries | null {
  return buildSeriesGroups().find(group => group.games.some(entry => entry.matchId === game.matchId)) ?? null;
}

function resolveChannel(client: Client): PostTarget | null {
  const override = process.env.TI_CHANNEL_ID;
  if (override) {
    const channel = asPostTarget(client.channels.cache.get(override));
    if (channel) return channel;
  }
  for (const guild of client.guilds.cache.values() as Iterable<Guild>) {
    const found = guild.channels.cache.find(ch => ch.name === ChannelConstants.DOTO_TRACKER_CHANNEL);
    const channel = asPostTarget(found);
    if (channel) return channel;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Building a game record from an OpenDota match payload
// ---------------------------------------------------------------------------

async function buildRecord(match: any, gameNumber: number): Promise<TiGameRecord> {
  // `od_data` only exists once OpenDota has chewed the replay. Without it the
  // fantasy-heavy fields (teamfight, stuns, wards, stacks) are all absent, so we
  // post the box score now and come back to fill the rest in.
  const parsed = !!match.od_data && match.players?.some((p: any) => p.teamfight_participation != null);
  const radiantName = match.radiant_team?.name || match.radiant_name || 'Radiant';
  const direName = match.dire_team?.name || match.dire_name || 'Dire';

  const fantasy: TiFantasyRow[] = await Promise.all((match.players || []).map(async (player: any) => {
    const score = scoreFantasy(player, parsed);
    const isRadiant = player.player_slot < 128;
    return {
      accountId: Number(player.account_id || 0),
      name: player.name || player.personaname || 'Unknown',
      team: isRadiant ? radiantName : direName,
      heroId: Number(player.hero_id || 0),
      heroName: await dotaDataService.getHeroName(player.hero_id),
      isRadiant,
      kills: Number(player.kills || 0),
      deaths: Number(player.deaths || 0),
      assists: Number(player.assists || 0),
      netWorth: Number(player.net_worth || player.total_gold || 0),
      gpm: Number(player.gold_per_min || 0),
      points: score.total,
      drivers: topContributors(score, 2).map(entry => entry.stat).join(', '),
    };
  }));

  return {
    matchId: Number(match.match_id),
    seriesId: match.series_id ?? null,
    seriesType: match.series_type ?? null,
    startTime: Number(match.start_time),
    duration: Number(match.duration || 0),
    radiantName,
    direName,
    radiantTag: match.radiant_team?.tag || radiantName.slice(0, 4).toUpperCase(),
    direTag: match.dire_team?.tag || direName.slice(0, 4).toUpperCase(),
    radiantScore: Number(match.radiant_score || 0),
    direScore: Number(match.dire_score || 0),
    radiantWin: !!match.radiant_win,
    gameNumber,
    parsed,
    postedAt: Date.now(),
    fantasy,
  };
}

// ---------------------------------------------------------------------------
// Embeds
// ---------------------------------------------------------------------------

/**
 * Column widths are measured across the whole game, not per team, so the two
 * blocks line up with each other when they sit in the same embed.
 */
function fantasyBlock(rows: TiFantasyRow[], all: TiFantasyRow[]): string {
  const nameWidth = Math.max(...all.map(row => row.name.length), 6);
  const heroWidth = Math.max(...all.map(row => row.heroName.length), 4);
  const lines = [...rows].sort((a, b) => b.points - a.points).map(row =>
    `${fmtPoints(row.points).padStart(7)}  ${row.name.padEnd(nameWidth)}  `
    + `${row.heroName.padEnd(heroWidth)}  ${`${row.kills}/${row.deaths}/${row.assists}`.padStart(8)}`
    + `  ${(row.netWorth / 1000).toFixed(1).padStart(5)}k`);
  const header = `${'PTS'.padStart(7)}  ${'PLAYER'.padEnd(nameWidth)}  ${'HERO'.padEnd(heroWidth)}  ${'K/D/A'.padStart(8)}  ${'NET'.padStart(6)}`;
  return '```\n' + header + '\n' + lines.join('\n') + '\n```';
}

export function buildGameEmbed(game: TiGameRecord, hasImage: boolean): EmbedBuilder {
  const winner = game.radiantWin ? game.radiantName : game.direName;
  const loser = game.radiantWin ? game.direName : game.radiantName;
  const side = game.radiantWin ? 'Radiant' : 'Dire';

  // The series is rebuilt from the ledger rather than read off the record, so
  // this game's own result is always part of the scoreline it prints.
  const series = seriesForGame(game);
  const gameNumber = series
    ? series.games.findIndex(entry => entry.matchId === game.matchId) + 1
    : game.gameNumber;
  const seriesLine = series
    ? `${seriesLabel(series.seriesType)} · **${series.teams[0]} ${series.wins[series.teams[0]]}`
      + ` – ${series.wins[series.teams[1]]} ${series.teams[1]}**`
      + (series.decided ? '  🏁 **series over**' : '')
    : null;

  const mvp = [...game.fantasy].sort((a, b) => b.points - a.points)[0];

  const embed = new EmbedBuilder()
    .setColor(0xffb020)
    .setTitle(`🏆 ${winner} def. ${loser} — Game ${gameNumber}`)
    .setURL(`https://www.opendota.com/matches/${game.matchId}`)
    .setDescription(
      `⏱ **${formatDuration(game.duration)}**  ·  kills **${game.radiantName} ${game.radiantScore}`
      + ` – ${game.direScore} ${game.direName}**  ·  won from **${side}**`
      + (seriesLine ? `\n${seriesLine}` : ''),
    )
    .setFooter({ text: `${TI_LEAGUE_LABEL} · Main Stage · match ${game.matchId}` })
    .setTimestamp(new Date((game.startTime + game.duration) * 1000));

  if (hasImage) embed.setImage('attachment://ti-scoreboard.png');

  if (mvp) {
    embed.addFields({
      name: '⭐ Fantasy MVP',
      value: `**${mvp.name}** (${mvp.team}) on **${mvp.heroName}** — **${fmtPoints(mvp.points)}** pts`
        + (mvp.drivers ? `\ncarried by ${mvp.drivers}` : ''),
    });
  }

  const winners = game.fantasy.filter(row => row.isRadiant === game.radiantWin);
  const losers = game.fantasy.filter(row => row.isRadiant !== game.radiantWin);
  embed.addFields(
    { name: `🟢 ${winner} — fantasy`, value: fantasyBlock(winners, game.fantasy) },
    { name: `🔴 ${loser} — fantasy`, value: fantasyBlock(losers, game.fantasy) },
  );

  if (!game.parsed) {
    embed.addFields({
      name: '⏳ Replay still parsing',
      value: 'Fantasy points here only count the box score. Wards, stacks, stuns and teamfight participation land when OpenDota finishes the replay — this post updates itself.',
    });
  }

  return embed;
}

function buildSeriesEmbed(series: TiSeries): EmbedBuilder {
  const games = series.games;
  const [teamA, teamB] = series.teams;
  const winner = series.winner ?? (series.wins[teamA] >= series.wins[teamB] ? teamA : teamB);
  const loser = winner === teamA ? teamB : teamA;

  // A TI fantasy card scores a series as the sum of the player's two best games,
  // so a sweep is worth no more than the minimum needed to win it.
  const byPlayer = new Map<string, { row: TiFantasyRow; scores: number[] }>();
  for (const game of games) {
    for (const row of game.fantasy) {
      const key = row.accountId ? String(row.accountId) : `${row.name}|${row.team}`;
      const entry = byPlayer.get(key);
      if (entry) { entry.scores.push(row.points); entry.row = row; }
      else byPlayer.set(key, { row, scores: [row.points] });
    }
  }
  const totals = [...byPlayer.values()]
    .map(entry => ({ ...entry.row, points: seriesTotal(entry.scores), games: entry.scores.length }))
    .sort((a, b) => b.points - a.points);

  const nameWidth = Math.max(...totals.map(row => row.name.length), 4);
  const board = totals.slice(0, 10).map((row, index) =>
    `${String(index + 1).padStart(2)}. ${fmtPoints(row.points).padStart(7)}  ${row.name.padEnd(nameWidth)}  ${row.team}`);

  return new EmbedBuilder()
    .setColor(0x4ecdc4)
    .setTitle(`🏁 ${winner} take the series ${series.wins[winner]}–${series.wins[loser]} over ${loser}`)
    .setDescription(
      games.map((game, index) => {
        const gWinner = game.radiantWin ? game.radiantName : game.direName;
        const gLoser = game.radiantWin ? game.direName : game.radiantName;
        const gWinnerKills = game.radiantWin ? game.radiantScore : game.direScore;
        const gLoserKills = game.radiantWin ? game.direScore : game.radiantScore;
        return `**Game ${index + 1}** · ${gWinner} def. ${gLoser}`
          + ` · ${gWinnerKills}–${gLoserKills} kills · ${formatDuration(game.duration)}`;
      }).join('\n'),
    )
    .addFields({
      name: '⭐ Series fantasy (best 2 games, TI scoring)',
      value: '```\n' + board.join('\n') + '\n```',
    })
    .setFooter({ text: `${TI_LEAGUE_LABEL} · Main Stage` })
    .setTimestamp();
}

function progressBar(fraction: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function buildLiveEmbed(live: any, gameNumber: number, standingLine: string | null): EmbedBuilder {
  const radiant = live.team_name_radiant || 'Radiant';
  const dire = live.team_name_dire || 'Dire';
  const lead = Number(live.radiant_lead || 0);
  const leader = lead >= 0 ? radiant : dire;
  // Cap the bar at a 25k swing; past that the game is over anyway.
  const fraction = 0.5 + Math.max(-0.5, Math.min(0.5, lead / 50000));

  return new EmbedBuilder()
    .setColor(0xef4444)
    .setTitle(`🔴 LIVE — ${radiant} vs ${dire} · Game ${gameNumber}`)
    .setURL(`https://www.opendota.com/matches/${live.match_id}`)
    .setDescription(
      `⚔️ **${live.radiant_score ?? 0}** – **${live.dire_score ?? 0}**  ·  ⏱ **${formatDuration(Number(live.game_time || 0))}**\n`
      + (standingLine ? `${standingLine}\n` : '')
      + `\n\`${progressBar(fraction)}\`\n`
      + `Net worth: **${leader} +${Math.abs(Math.round(lead / 100) / 10)}k**`,
    )
    .setFooter({ text: `${TI_LEAGUE_LABEL} · Main Stage · updates every ~90s` })
    .setTimestamp();
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

async function renderBoard(match: any, game: TiGameRecord): Promise<AttachmentBuilder | null> {
  try {
    // `null` skips the rank lookup: pro lobbies expose no rank tiers, so resolving
    // them is a guaranteed-empty round trip.
    const buffer = await renderScoreboardFromMatch(match, [], null, {
      detailed: true, radiantName: game.radiantName, direName: game.direName,
    });
    return new AttachmentBuilder(buffer, { name: 'ti-scoreboard.png' });
  } catch (error) {
    logger.warn(`Could not render TI scoreboard for ${game.matchId}:`, error);
    return null;
  }
}

/**
 * Fetches a main-stage match, records it and posts the result embed. Returns the
 * record on success so callers can chain a series wrap-up.
 */
export async function postGame(
  channel: PostTarget,
  matchId: number,
  opts: { repost?: boolean } = {},
): Promise<TiGameRecord | null> {
  loadState();
  const existing = state.games[String(matchId)];
  if (existing && !opts.repost) return existing;

  let match: any;
  try {
    // `refresh` skips the 10-minute match cache. Both callers are polling for a
    // state change — the match appearing at all, or its replay parse landing —
    // so a cached copy is exactly the wrong answer.
    match = (await opendotaClient.get(`/matches/${matchId}`, { refresh: true } as any)).data;
  } catch (error: any) {
    // A 404 just means OpenDota has not ingested the match yet; the chase loop
    // will ask again next tick.
    if (error?.response?.status === 404) logger.debug(`TI: match ${matchId} not on OpenDota yet`);
    else logger.error(`TI: could not fetch match ${matchId}:`, error);
    return null;
  }
  if (!match || Number(match.leagueid) !== TI_LEAGUE_ID) {
    logger.warn(`TI: match ${matchId} is not in league ${TI_LEAGUE_ID}, skipping`);
    return null;
  }
  // The hot path asks for a match the moment its live entry freezes, which can be
  // a minute or two before OpenDota has ingested the result. A half-written match
  // has no duration and no winner; posting one would put a bogus scoreboard in
  // chat that never gets corrected.
  if (!Number(match.duration) || typeof match.radiant_win !== 'boolean' || !match.players?.length) {
    logger.debug(`TI: match ${matchId} is not complete on OpenDota yet`);
    return null;
  }

  const game = await buildRecord(match, 1);
  // The series scoreline is derived from the ledger, so the game has to be in it
  // before the embed is built — otherwise every post is one game behind.
  state.games[String(matchId)] = game;
  const series = seriesForGame(game);
  game.gameNumber = series
    ? series.games.findIndex(entry => entry.matchId === matchId) + 1
    : 1;

  const attachment = await renderBoard(match, game);
  const embed = buildGameEmbed(game, !!attachment);

  try {
    const sent = await channel.send({ embeds: [embed], files: attachment ? [attachment] : [] });
    game.messageId = sent.id;
    game.channelId = sent.channelId;
  } catch (error) {
    logger.error(`TI: could not post match ${matchId}:`, error);
    if (!existing) delete state.games[String(matchId)];
    return null;
  }

  state.lastActivity = Date.now();
  saveState();
  const lateBySec = Math.round(Date.now() / 1000) - (game.startTime + game.duration);
  logger.info(
    `TI: posted game ${matchId} (${game.radiantName} vs ${game.direName}) `
    + `${lateBySec}s after the game ended`,
  );
  return game;
}

/** Re-renders an already-posted game in place — used once the replay parse lands. */
async function refreshGame(client: Client, game: TiGameRecord): Promise<boolean> {
  let match: any;
  try {
    match = (await opendotaClient.get(`/matches/${game.matchId}`, { refresh: true } as any)).data;
  } catch (error) {
    logger.warn(`TI: reparse fetch failed for ${game.matchId}:`, error);
    return false;
  }
  const refreshed = await buildRecord(match, game.gameNumber);
  refreshed.gameNumber = game.gameNumber;
  if (!refreshed.parsed) return false;

  refreshed.messageId = game.messageId;
  refreshed.channelId = game.channelId;
  refreshed.postedAt = game.postedAt;
  state.games[String(game.matchId)] = refreshed;
  saveState();

  if (!game.messageId || !game.channelId) return true;
  try {
    const channel = asPostTarget(await client.channels.fetch(game.channelId));
    if (!channel) return true;
    const message = await channel.messages.fetch(game.messageId);
    const attachment = await renderBoard(match, refreshed);
    await message.edit({
      embeds: [buildGameEmbed(refreshed, !!attachment)],
      files: attachment ? [attachment] : [],
    });
    logger.info(`TI: filled in parsed fantasy for game ${game.matchId}`);
  } catch (error) {
    logger.warn(`TI: could not edit posted game ${game.matchId}:`, error);
  }
  return true;
}

async function wrapSeriesIfDone(channel: PostTarget, game: TiGameRecord) {
  const series = seriesForGame(game);
  // A Bo1 is fully described by its own game embed; only multi-game series earn
  // a wrap-up with the best-two-games fantasy card.
  if (!series || !series.decided || series.games.length < 2) return;
  if (state.seriesWrapped[series.key]) return;

  try {
    const sent = await channel.send({ embeds: [buildSeriesEmbed(series)] });
    state.seriesWrapped[series.key] = sent.id;
    saveState();
    logger.info(`TI: posted series wrap-up for ${series.key}`);
  } catch (error) {
    logger.warn(`TI: could not post series wrap-up for ${series.key}:`, error);
  }
}

// ---------------------------------------------------------------------------
// Live ticker
// ---------------------------------------------------------------------------

async function updateLiveTicker(channel: PostTarget, liveGames: any[]) {
  const seen = new Set<string>();
  for (const live of liveGames) {
    const matchId = String(live.match_id);
    seen.add(matchId);
    // A finished game lingers in `/live` for a couple of minutes; once the result
    // is posted the ticker is redundant.
    if (state.games[matchId]) continue;

    // The live payload carries team names but no history, so the running series
    // score comes from the games we have already posted for this same pairing.
    const pair = [live.team_name_radiant, live.team_name_dire].filter(Boolean).sort().join(' | ');
    const series = buildSeriesGroups().find(group => group.key.startsWith(pair) && !group.decided);
    const standingLine = series
      ? `${seriesLabel(series.seriesType)} · ${series.teams[0]} **${series.wins[series.teams[0]]}**`
        + ` – **${series.wins[series.teams[1]]}** ${series.teams[1]}`
      : null;
    const embed = buildLiveEmbed(live, (series?.games.length ?? 0) + 1, standingLine);

    const tracked = state.live[matchId];
    try {
      if (tracked) {
        const target = asPostTarget(await channel.client.channels.fetch(tracked.channelId));
        if (target) {
          const message = await target.messages.fetch(tracked.messageId);
          await message.edit({ embeds: [embed] });
          continue;
        }
      }
      const sent = await channel.send({ embeds: [embed] });
      state.live[matchId] = {
        messageId: sent.id, channelId: sent.channelId,
        gameTime: Number(live.game_time || 0), frozenSince: 0,
      };
      saveState();
    } catch (error) {
      logger.warn(`TI: live ticker update failed for ${matchId}:`, error);
      delete state.live[matchId];
    }
  }
}

/** Drops the in-progress embed for a game that is no longer live. */
async function clearLiveTicker(client: Client, matchId: string) {
  const tracked = state.live[matchId];
  if (!tracked) return;
  delete state.live[matchId];
  saveState();
  try {
    const channel = asPostTarget(await client.channels.fetch(tracked.channelId));
    if (!channel) return;
    const message = await channel.messages.fetch(tracked.messageId);
    await message.delete();
  } catch (error) {
    logger.debug(`TI: could not remove live ticker for ${matchId}: ${error}`);
  }
}

// ---------------------------------------------------------------------------
// Sweep + poll loop
// ---------------------------------------------------------------------------

/**
 * Reads the league's match list and posts anything from the main stage we have
 * not covered yet. Returns how many games it posted.
 */
export async function sweepLeague(channel: PostTarget, limit = 25): Promise<number> {
  loadState();
  let listed: any[];
  try {
    listed = (await opendotaClient.get<any[]>(`/leagues/${TI_LEAGUE_ID}/matches`)).data || [];
  } catch (error) {
    logger.error('TI: league match sweep failed:', error);
    return 0;
  }
  state.lastSweep = Date.now();

  const pending = listed
    .filter(match => Number(match.start_time) >= TI_MAIN_STAGE_START)
    .filter(match => !state.games[String(match.match_id)])
    .sort((a, b) => a.start_time - b.start_time)
    .slice(0, limit);

  let posted = 0;
  for (const match of pending) {
    const game = await postGame(channel, Number(match.match_id));
    if (!game) continue;
    posted++;
    await clearLiveTicker(channel.client, String(match.match_id));
    await wrapSeriesIfDone(channel, game);
  }
  saveState();
  return posted;
}

async function reparsePass(client: Client) {
  const now = Date.now();
  if (now - state.lastReparse < TI_REPARSE_INTERVAL_MS) return;
  state.lastReparse = now;
  const stale = mainStageGames()
    .filter(game => !game.parsed && now - game.postedAt < TI_REPARSE_MAX_AGE_MS)
    .slice(0, 4);
  for (const game of stale) await refreshGame(client, game);
  saveState();
}

let pollTimer: NodeJS.Timeout | null = null;

async function tick(client: Client) {
  loadState();
  if (!state.enabled) return schedule(client, TI_POLL_IDLE_MS);

  const channel = resolveChannel(client);
  if (!channel) {
    logger.warn(`TI: no #${ChannelConstants.DOTO_TRACKER_CHANNEL} channel found; retrying later`);
    return schedule(client, TI_POLL_IDLE_MS);
  }

  // On a cold start `/live` still lists games that finished hours ago, so
  // reconcile against the league first — otherwise the very first tick posts a
  // "LIVE" ticker for a game that is already over.
  if (state.lastSweep === 0) await sweepLeague(channel);

  let liveGames: any[] = [];
  try {
    // Must bypass the shared 60s cache: a cached repeat would carry an identical
    // game_time and read as a frozen — i.e. finished — game.
    const live = (await opendotaClient.get<any[]>('/live', { refresh: true } as any)).data || [];
    liveGames = live.filter(entry => Number(entry.league_id) === TI_LEAGUE_ID);
  } catch (error) {
    logger.warn('TI: /live poll failed:', error);
  }

  // OpenDota does not remove a game from `/live` when it ends — the entry simply
  // stops advancing, sometimes for hours. Waiting for it to disappear meant the
  // result only landed on the next periodic sweep, up to 15 minutes late. A
  // frozen `game_time` is the actual end-of-game signal, and it costs nothing.
  const liveIds = new Set(liveGames.map(entry => String(entry.match_id)));
  const moving: any[] = [];
  for (const live of liveGames) {
    const matchId = String(live.match_id);
    if (state.games[matchId]) continue;
    const gameTime = Number(live.game_time || 0);
    const tracked = state.live[matchId];
    if (tracked && gameTime > 0 && tracked.gameTime === gameTime) {
      if (!state.pendingFinish[matchId]) {
        state.pendingFinish[matchId] = Date.now();
        logger.info(`TI: live entry for ${matchId} froze at ${gameTime}s — looking for the result`);
      }
      continue;
    }
    // A tech pause also freezes the clock; when it resumes the game leaves the
    // pending set again and the ticker picks straight back up.
    if (tracked) { tracked.gameTime = gameTime; tracked.frozenSince = 0; }
    delete state.pendingFinish[matchId];
    moving.push(live);
  }

  // Belt and braces: an entry that does vanish is finished too.
  for (const matchId of Object.keys(state.live)) {
    if (!liveIds.has(matchId) && !state.games[matchId] && !state.pendingFinish[matchId]) {
      state.pendingFinish[matchId] = Date.now();
    }
  }

  if (moving.length) state.lastActivity = Date.now();
  if (TI_LIVE_TICKER && moving.length) await updateLiveTicker(channel, moving);

  // Hot path: ask for the finished match by id rather than re-listing the whole
  // league. Same one call, but it lands as soon as OpenDota has ingested the
  // match instead of waiting for the league index to catch up.
  for (const [matchId, since] of Object.entries({ ...state.pendingFinish })) {
    if (state.games[matchId]) {
      delete state.pendingFinish[matchId];
      await clearLiveTicker(client, matchId);
      continue;
    }
    const game = await postGame(channel, Number(matchId));
    if (game) {
      delete state.pendingFinish[matchId];
      state.lastActivity = Date.now();
      await clearLiveTicker(client, matchId);
      await wrapSeriesIfDone(channel, game);
    } else if (Date.now() - since > TI_FINISH_GIVEUP_MS) {
      logger.warn(`TI: gave up waiting for ${matchId} to appear; the periodic sweep will retry`);
      delete state.pendingFinish[matchId];
      await clearLiveTicker(client, matchId);
    }
  }

  // The league listing is now only a backstop for anything `/live` never showed
  // us at all — a game that started and finished between two polls, say.
  if (Date.now() - state.lastSweep >= TI_SWEEP_MIN_INTERVAL_MS) await sweepLeague(channel);

  await reparsePass(client);
  saveState();

  const chasing = Object.keys(state.pendingFinish).length > 0;
  const active = moving.length > 0 || chasing || Date.now() - state.lastActivity < TI_ACTIVE_GRACE_MS;
  schedule(client, active ? TI_POLL_ACTIVE_MS : TI_POLL_IDLE_MS);
}

function schedule(client: Client, delayMs: number) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    tick(client).catch(error => {
      logger.error('TI poll tick failed:', error);
      schedule(client, TI_POLL_IDLE_MS);
    });
  }, delayMs);
}

export function startTiPoller(client: Client) {
  loadState();
  logger.info(
    `TI poller armed for league ${TI_LEAGUE_ID} (${TI_LEAGUE_LABEL}), `
    + `${Object.keys(state.games).length} main-stage games already posted`,
  );
  schedule(client, 15000);
}

export function stopTiPoller() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}
