export interface ThrowMatch {
  match_id: number;
  start_time: number;
  game_mode: number;
  player_slot: number;
  radiant_win: boolean;
  throw?: number | null;
  stomp?: number | null;
  party_size?: number | null;
}

export interface LeadGame {
  id: number;
  won: boolean;
  lead: number;
  party: 'solo' | 'party' | 'unknown';
}

export function leadGames(matches: ThrowMatch[]): LeadGame[] {
  const seen = new Set<number>();
  const games: LeadGame[] = [];
  for (const match of matches) {
    if (!Number.isSafeInteger(match.match_id) || match.match_id <= 0 || seen.has(match.match_id)) continue;
    if (typeof match.radiant_win !== 'boolean' || !Number.isInteger(match.player_slot)
      || !((match.player_slot >= 0 && match.player_slot <= 4) || (match.player_slot >= 128 && match.player_slot <= 132))) continue;
    const won = (match.player_slot < 128) === match.radiant_win;
    // OpenDota supplies throw only for losses, stomp only for wins. Null is missing, not zero.
    const lead = won ? match.stomp : match.throw;
    if (typeof lead !== 'number' || !Number.isFinite(lead)) continue;
    seen.add(match.match_id);
    games.push({ id: match.match_id, won, lead: Math.max(0, lead),
      party: match.party_size === 1 ? 'solo' : typeof match.party_size === 'number' && match.party_size > 1 ? 'party' : 'unknown' });
  }
  return games;
}

export function leadRate(games: LeadGame[], threshold: number) {
  const reached = games.filter(game => game.lead >= threshold);
  const n = reached.length;
  const lost = reached.filter(game => !game.won).length;
  if (!n) return { n, lost, rate: null, low: null, high: null };
  const rate = lost / n;
  const z = 1.95996398454;
  const denom = 1 + z * z / n;
  const center = (rate + z * z / (2 * n)) / denom;
  const margin = z * Math.sqrt(rate * (1 - rate) / n + z * z / (4 * n * n)) / denom;
  return { n, lost, rate, low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

export function withoutSharedGames(a: LeadGame[], b: LeadGame[], sharedIds?: Set<number>) {
  const bIds = new Set(b.map(game => game.id));
  const shared = sharedIds ?? new Set(a.filter(game => bIds.has(game.id)).map(game => game.id));
  return { shared: shared.size, a: a.filter(game => !shared.has(game.id)), b: b.filter(game => !shared.has(game.id)) };
}
