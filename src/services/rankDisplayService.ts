import { opendotaClient } from './apiClient';
import { fetchStratzMatch } from './stratzClient';
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

async function fetchOpenDotaProfileRank(steamId: string): Promise<RankCandidate | null> {
  const cached = profileRankCache.get(steamId);
  if (cached && cached.expiresAt > Date.now()) return cached.rank;

  try {
    const response = await opendotaClient.get<{ rank_tier?: number; leaderboard_rank?: number | null }>(
      `/players/${steamId}`,
      { timeout: 12000 },
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
    return rank;
  } catch {
    profileRankCache.set(steamId, { expiresAt: Date.now() + 10 * 60 * 1000, rank: null });
    return null;
  }
}

export async function resolveMatchRankDisplay(match: any): Promise<MatchRankDisplay | null> {
  const matchId = Number(match?.match_id);
  const players: any[] = Array.isArray(match?.players) ? match.players : [];
  if (!matchId || players.length === 0) return null;

  const stratzMatch = await fetchStratzMatch(matchId).catch(() => null);
  const stratzPlayers = new Map<string, RankCandidate>();
  for (const player of stratzMatch?.players ?? []) {
    const steamId = player.steamAccountId != null ? String(player.steamAccountId) : null;
    const rankTier = normalizeRankTier(player.steamAccount?.seasonRank);
    if (!steamId || !rankTier) continue;
    stratzPlayers.set(steamId, { rankTier, source: 'stratz' });
  }

  const steamIds = players
    .map((player) => normalizeRankTier(player.account_id))
    .filter((id): id is number => id != null)
    .map(String);
  const uniqueSteamIds = [...new Set(steamIds)];
  const openDotaRanks = new Map<string, RankCandidate>();

  await Promise.all(uniqueSteamIds.map(async (steamId) => {
    const matchPlayer = players.find((player) => String(player.account_id || '') === steamId);
    const matchRankTier = normalizeRankTier(matchPlayer?.rank_tier);
    const matchRank: RankCandidate | null = matchRankTier
      ? { rankTier: matchRankTier, source: 'opendota' }
      : null;
    const profileRank = await fetchOpenDotaProfileRank(steamId);
    const best = chooseHigherRank(matchRank, profileRank);
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

  if (!lobbyRankLabel && entries.length === 0) return null;
  return {
    lobbyRankLabel: lobbyRankLabel ?? undefined,
    visibleRankCount: entries.length,
    playersBySteamId,
  };
}
