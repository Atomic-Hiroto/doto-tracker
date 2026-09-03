import { opendotaClient } from './apiClient';
import { logger } from './loggerService';
import { MatchRankDisplay, resolveMatchRankDisplay } from './rankDisplayService';
import {
  SourceStatus,
  STRATZ_GAME_MODE_IDS,
  StratzMatchResult,
  fetchStratzMatchDetailed,
  stratzPlayerSlot,
} from './stratzClient';

/**
 * OpenDota and STRATZ each go down, each lag behind a freshly finished game, and
 * each know medals the other doesn't. Asking one of them and giving up is why a
 * command can look dead. This asks both at once, renders from whichever came
 * back, and hands the caller a sentence explaining what the missing one cost.
 */

export type MatchProvider = 'opendota' | 'stratz';

export interface CombinedMatch {
  /** Always OpenDota-shaped, whichever provider it actually came from. */
  match: any;
  /** The provider the scoreboard body was built from. */
  primary: MatchProvider;
  sources: Record<MatchProvider, SourceStatus>;
  rankDisplay: MatchRankDisplay | null;
  stratz: StratzMatchResult;
}

const PROVIDER_LABEL: Record<MatchProvider, string> = {
  opendota: 'OpenDota',
  stratz: 'STRATZ',
};

/**
 * A hard ceiling on the OpenDota leg. The default client retries a 5xx three
 * times on a 60s timeout, which during a real outage means four minutes of
 * silence — and silence is exactly the failure being fixed here. STRATZ is
 * already running alongside this and answers in well under a second, so a
 * doomed OpenDota call has nothing to buy by waiting.
 */
const OPENDOTA_MATCH_BUDGET_MS = 12_000;

async function fetchOpenDotaMatch(matchId: number): Promise<{ match: any; status: SourceStatus }> {
  try {
    const { data } = await opendotaClient.get<any>(`/matches/${matchId}`, {
      timeout: OPENDOTA_MATCH_BUDGET_MS,
      'axios-retry': { retries: 0 },
    } as any);
    if (!data?.players?.length) return { match: null, status: 'missing' };
    return { match: data, status: 'ok' };
  } catch (error: any) {
    const status = error?.response?.status;
    // A 404 means "not ingested yet", which resolves itself in minutes. Anything
    // else is the provider being unwell, and the two deserve different wording.
    if (status === 404) return { match: null, status: 'missing' };
    logger.warn(`OpenDota match ${matchId} unavailable (${status ?? error?.code ?? 'no response'})`);
    return { match: null, status: 'error' };
  }
}

/** Reshapes a STRATZ match into the OpenDota match payload the renderers expect. */
export function stratzMatchToOpenDotaShape(stratzMatch: any): any {
  const players = (stratzMatch?.players ?? []).map((player: any) => ({
    account_id: player.steamAccountId ?? null,
    player_slot: stratzPlayerSlot(player),
    hero_id: player.hero?.id ?? player.heroId ?? 0,
    personaname: player.steamAccount?.name ?? null,
    level: player.level ?? 0,
    kills: player.kills ?? 0,
    deaths: player.deaths ?? 0,
    assists: player.assists ?? 0,
    gold_per_min: player.goldPerMinute ?? 0,
    xp_per_min: player.experiencePerMinute ?? 0,
    last_hits: player.numLastHits ?? 0,
    denies: player.numDenies ?? 0,
    net_worth: player.networth ?? 0,
    hero_damage: player.heroDamage ?? 0,
    tower_damage: player.towerDamage ?? 0,
    hero_healing: player.heroHealing ?? 0,
    // STRATZ exposes stun *events*, not the summed duration OpenDota's parser
    // gives us, so the detailed scorecard's stun column is simply blank here.
    stuns: 0,
    item_0: player.item0Id ?? 0,
    item_1: player.item1Id ?? 0,
    item_2: player.item2Id ?? 0,
    item_3: player.item3Id ?? 0,
    item_4: player.item4Id ?? 0,
    item_5: player.item5Id ?? 0,
    rank_tier: player.steamAccount?.seasonRank ?? null,
    leaderboard_rank: player.steamAccount?.seasonLeaderboardRank ?? null,
  }));

  const radiantScore = players
    .filter((p: any) => p.player_slot < 128)
    .reduce((sum: number, p: any) => sum + p.kills, 0);
  const direScore = players
    .filter((p: any) => p.player_slot >= 128)
    .reduce((sum: number, p: any) => sum + p.kills, 0);

  return {
    match_id: stratzMatch?.id ?? stratzMatch?.match_id,
    duration: stratzMatch?.durationSeconds ?? 0,
    start_time: stratzMatch?.startDateTime ?? 0,
    radiant_win: !!stratzMatch?.didRadiantWin,
    game_mode: STRATZ_GAME_MODE_IDS[String(stratzMatch?.gameMode)] ?? 0,
    // radiantKills/direKills are per-minute series on some responses; the summed
    // player kills are always right, so prefer them and fall back to the scalar.
    radiant_score: radiantScore || Number(stratzMatch?.radiantKills ?? 0),
    dire_score: direScore || Number(stratzMatch?.direKills ?? 0),
    players,
  };
}

/**
 * Fetches one match from both providers at once and merges what came back.
 *
 * Returns null only when *neither* provider has the match — a single provider
 * being down is a degraded answer, never a failed one.
 */
export async function fetchCombinedMatch(matchId: number): Promise<CombinedMatch | null> {
  const [openDota, stratz] = await Promise.all([
    fetchOpenDotaMatch(matchId),
    fetchStratzMatchDetailed(matchId).catch((): StratzMatchResult => ({ match: null, status: 'error' })),
  ]);

  let match: any = null;
  let primary: MatchProvider = 'opendota';
  if (openDota.match) {
    match = openDota.match;
  } else if (stratz.match?.players?.length) {
    match = stratzMatchToOpenDotaShape(stratz.match);
    primary = 'stratz';
  }
  if (!match) return null;

  // The STRATZ payload is already in hand, so the rank merge reuses it rather
  // than paying for the same query twice. If OpenDota just failed to answer for
  // the match, its ten per-player profile lookups will fail the same way, so
  // don't spend the wait proving it.
  const rankDisplay = await resolveMatchRankDisplay(match, stratz, {
    skipOpenDota: openDota.status === 'error',
  }).catch(() => null);

  return {
    match,
    primary,
    sources: { opendota: openDota.status, stratz: stratz.status },
    rankDisplay,
    stratz,
  };
}

/**
 * A one-line, user-facing explanation of what a degraded fetch is missing, or
 * null when both providers answered and there is nothing to apologise for.
 */
export function sourceNotice(combined: CombinedMatch): string | null {
  const parts: string[] = [];
  for (const provider of ['opendota', 'stratz'] as MatchProvider[]) {
    const status = combined.sources[provider];
    if (status === 'ok') continue;
    const name = PROVIDER_LABEL[provider];
    if (status === 'missing') parts.push(`${name} hasn't ingested this match yet`);
    else if (status === 'error') parts.push(`${name} didn't respond`);
    else if (status === 'disabled') parts.push(`${name} isn't configured`);
  }
  if (parts.length === 0) return null;

  // Say what was actually lost. A provider being down usually costs nothing —
  // the other one covered every medal — and claiming otherwise trains people to
  // ignore the warning.
  const ranks = combined.rankDisplay;
  const missing = ranks ? ranks.totalPlayers - ranks.visibleRankCount : 0;
  const cost = !ranks
    ? 'ranks unavailable.'
    : missing > 0
      ? `${missing} of ${ranks.totalPlayers} medals are missing as a result.`
      : `all ${ranks.totalPlayers} medals still resolved.`;
  return `⚠️ ${parts.join(' and ')} — built from ${PROVIDER_LABEL[combined.primary]}; ${cost}`;
}

/** Describes where the numbers came from, for a footer. */
export function sourceCredit(combined: CombinedMatch): string {
  const both = combined.sources.opendota === 'ok' && combined.sources.stratz === 'ok';
  if (both) return 'Ranks merged from OpenDota + STRATZ';
  return `Ranks from ${PROVIDER_LABEL[combined.primary]} only`;
}
