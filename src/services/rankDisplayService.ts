import { opendotaClient } from './apiClient';
import { fetchStratzMatchDetailed, SourceStatus, StratzMatchResult } from './stratzClient';
import { mmrToMedal, rankTierToMMR, rankTierToMedal } from './turboRankService';

const PROFILE_RANK_CACHE_MS = 6 * 60 * 60 * 1000;

type RankSource = 'stratz' | 'opendota' | 'stratz+opendota';

interface RankCandidate {
  rankTier: number;
  leaderboardRank?: number | null;
  source: RankSource;
}

interface CachedProfileRank {
  expiresAt: number;
  rank: RankCandidate | null;
}

export interface RankDisplayEntry {
  steamId: string;
  rankTier: number;
  leaderboardRank?: number | null;
  label: string;
  source: RankSource;
}

export interface MatchRankDisplay {
  lobbyRankLabel?: string;
  visibleRankCount: number;
  playersBySteamId: Map<string, RankDisplayEntry>;
  /** How many players the match has at all, so callers can say "6/10 ranks". */
  totalPlayers: number;
  /** Which providers actually answered, so callers can explain a thin board. */
  providers: { stratz: SourceStatus; opendota: SourceStatus };
}

const profileRankCache = new Map<string, CachedProfileRank>();

function normalizeRankTier(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function normalizeLeaderboardRank(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function rankPower(rank: RankCandidate): number {
  const tier = Math.floor(rank.rankTier / 10);
  const stars = rank.rankTier % 10;
  if (tier === 8) {
    const leaderboardBoost = rank.leaderboardRank
      ? 1_000_000 - Math.min(rank.leaderboardRank, 999_999)
      : 0;
    return 8_000_000 + leaderboardBoost;
  }
  return tier * 10_000 + stars * 100;
}

function mergeSource(a: RankCandidate | null, b: RankCandidate | null): RankSource {
  if (a && b) return 'stratz+opendota';
  return a?.source ?? b?.source ?? 'opendota';
}

function chooseHigherRank(a: RankCandidate | null, b: RankCandidate | null): RankCandidate | null {
  if (!a) return b;
  if (!b) return a;
  const winner = rankPower(b) > rankPower(a) ? b : a;
  return { ...winner, source: mergeSource(a, b) };
}

export function formatRankLabel(rankTier: number | null | undefined, leaderboardRank?: number | null): string | null {
  if (!rankTier || rankTier <= 0) return null;
  const tier = Math.floor(rankTier / 10);
  if (tier === 8 && leaderboardRank && leaderboardRank > 0) {
    return `Immortal #${leaderboardRank.toLocaleString('en-US')}`;
  }
  return rankTierToMedal(rankTier);
}

function averageRankLabel(ranks: RankDisplayEntry[]): string | undefined {
  const mmrs = ranks
    .map((rank) => rankTierToMMR(rank.rankTier))
    .filter((mmr): mmr is number => mmr != null);
  if (mmrs.length === 0) return undefined;
  const avg = mmrs.reduce((sum, mmr) => sum + mmr, 0) / mmrs.length;
  return mmrToMedal(avg).medal;
}

/**
 * @returns `reachable: false` only when the request itself failed. A player who
 *          simply has no medal on OpenDota is a reachable null, and must not be
 *          reported to the user as an outage.
 */
async function fetchOpenDotaProfileRank(
  steamId: string,
): Promise<{ rank: RankCandidate | null; reachable: boolean }> {
  const cached = profileRankCache.get(steamId);
  if (cached && cached.expiresAt > Date.now()) return { rank: cached.rank, reachable: true };

  try {
    const response = await opendotaClient.get<{ rank_tier?: number; leaderboard_rank?: number | null }>(
      `/players/${steamId}`,
      // Ten of these fire per scoreboard. Retrying each one three times turns a
      // provider outage into a two-minute stall, and a missing medal is a far
      // cheaper failure than a command that never answers.
      { timeout: 12000, 'axios-retry': { retries: 0 } } as any,
    );
    const rankTier = normalizeRankTier(response.data?.rank_tier);
    const rank = rankTier
      ? {
        rankTier,
        leaderboardRank: normalizeLeaderboardRank(response.data?.leaderboard_rank),
        source: 'opendota' as const,
      }
      : null;
    profileRankCache.set(steamId, { expiresAt: Date.now() + PROFILE_RANK_CACHE_MS, rank });
    return { rank, reachable: true };
  } catch {
    profileRankCache.set(steamId, { expiresAt: Date.now() + 10 * 60 * 1000, rank: null });
    return { rank: null, reachable: false };
  }
}

/**
 * Merges medals from both providers, taking the highest each one is willing to
 * show. Neither is authoritative: OpenDota only knows a rank if the player has
 * ever opened their profile there, STRATZ only if it has ingested the match. A
 * player visible to one and not the other is the normal case, not an error, so
 * this never fails on a provider being absent — it records which one was and
 * lets the caller say so.
 *
 * @param stratzResult  A STRATZ fetch the caller already made. Pass it to avoid
 *                      a second round trip; omit it to have one made here.
 */
export async function resolveMatchRankDisplay(
  match: any,
  stratzResult?: StratzMatchResult,
): Promise<MatchRankDisplay | null> {
  const matchId = Number(match?.match_id);
  const players: any[] = Array.isArray(match?.players) ? match.players : [];
  if (!matchId || players.length === 0) return null;

  const stratz = stratzResult
    ?? await fetchStratzMatchDetailed(matchId).catch((): StratzMatchResult => ({ match: null, status: 'error' }));
  const stratzMatch = stratz.match;
  const stratzPlayers = new Map<string, RankCandidate>();
  for (const player of stratzMatch?.players ?? []) {
    const steamId = player.steamAccountId != null ? String(player.steamAccountId) : null;
    const rankTier = normalizeRankTier(player.steamAccount?.seasonRank);
    if (!steamId || !rankTier) continue;
    stratzPlayers.set(steamId, {
      rankTier,
      leaderboardRank: normalizeLeaderboardRank(player.steamAccount?.seasonLeaderboardRank),
      source: 'stratz',
    });
  }

  const steamIds = players
    .map((player) => normalizeRankTier(player.account_id))
    .filter((id): id is number => id != null)
    .map(String);
  const uniqueSteamIds = [...new Set(steamIds)];
  const openDotaRanks = new Map<string, RankCandidate>();
  let openDotaReachable = false;

  await Promise.all(uniqueSteamIds.map(async (steamId) => {
    const matchPlayer = players.find((player) => String(player.account_id || '') === steamId);
    const matchRankTier = normalizeRankTier(matchPlayer?.rank_tier);
    const matchRank: RankCandidate | null = matchRankTier
      ? {
        rankTier: matchRankTier,
        leaderboardRank: normalizeLeaderboardRank(matchPlayer?.leaderboard_rank),
        source: 'opendota',
      }
      : null;
    const profile = await fetchOpenDotaProfileRank(steamId);
    if (profile.reachable) openDotaReachable = true;
    const best = chooseHigherRank(matchRank, profile.rank);
    if (best) openDotaRanks.set(steamId, best);
  }));

  const playersBySteamId = new Map<string, RankDisplayEntry>();
  for (const steamId of uniqueSteamIds) {
    const best = chooseHigherRank(stratzPlayers.get(steamId) ?? null, openDotaRanks.get(steamId) ?? null);
    const label = best ? formatRankLabel(best.rankTier, best.leaderboardRank) : null;
    if (!best || !label) continue;
    playersBySteamId.set(steamId, {
      steamId,
      rankTier: best.rankTier,
      leaderboardRank: best.leaderboardRank ?? null,
      label,
      source: best.source,
    });
  }

  const entries = [...playersBySteamId.values()];
  const stratzAverageRank = normalizeRankTier(
    (stratzMatch as any)?.averageRank ?? (stratzMatch as any)?.actualRank ?? (stratzMatch as any)?.rank,
  );
  const lobbyRankLabel = formatRankLabel(stratzAverageRank) ?? averageRankLabel(entries);

  const openDotaStatus: SourceStatus = openDotaReachable || uniqueSteamIds.length === 0 ? 'ok' : 'error';

  return {
    lobbyRankLabel: lobbyRankLabel ?? undefined,
    visibleRankCount: entries.length,
    playersBySteamId,
    totalPlayers: players.length,
    providers: { stratz: stratz.status, opendota: openDotaStatus },
  };
}
