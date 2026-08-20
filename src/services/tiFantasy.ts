import { TI_FANTASY_POINTS as PTS } from '../constants/ti';

export interface FantasyBreakdown {
  kills: number;
  deaths: number;
  creeps: number;
  gpm: number;
  towers: number;
  wards: number;
  camps: number;
  runes: number;
  lotuses: number;
  smokes: number;
  teamfight: number;
  stuns: number;
  firstBlood: number;
  tormentors: number;
  roshans: number;
  couriers: number;
}

export interface FantasyScore {
  /** Total fantasy points for this game under the TI 2026 table. */
  total: number;
  /** Raw stat counts, so the embed can show what actually drove the number. */
  raw: FantasyBreakdown;
  /** Points contributed by each stat, keyed the same way as `raw`. */
  points: FantasyBreakdown;
  /** False when the replay was not parsed, i.e. only the box-score half is real. */
  parsed: boolean;
}

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Tormentors are not a first-class OpenDota field; the parser only records them
 * as a unit kill under the internal npc name.
 */
function tormentorKills(player: any): number {
  return num((player?.killed || {})['npc_dota_miniboss']);
}

/**
 * Lotuses are not counted directly either. Each lotus taken becomes a Famango in
 * the player's inventory, so the purchase log is the closest available proxy —
 * it undercounts, but at 176 points a piece the error is a rounding artefact
 * against a five-figure total.
 */
function lotusesTaken(player: any): number {
  return (player?.purchase_log || []).filter((entry: any) =>
    entry?.key === 'famango' || entry?.key === 'great_famango').length;
}

/**
 * Scores one player's game under the TI 2026 fantasy table.
 *
 * Two of the official stats — watchers taken and madstones collected — have no
 * OpenDota equivalent at all, so a real card would sit slightly above what this
 * returns. Both are small (147 and 13 points), and every consumer of this
 * function labels the number as an estimate.
 */
export function scoreFantasy(player: any, matchIsParsed: boolean): FantasyScore {
  const raw: FantasyBreakdown = {
    kills: num(player.kills),
    deaths: num(player.deaths),
    creeps: num(player.last_hits) + num(player.denies),
    gpm: num(player.gold_per_min),
    towers: num(player.towers_killed ?? player.tower_kills),
    wards: num(player.obs_placed ?? player.observers_placed),
    camps: num(player.camps_stacked ?? player.creeps_stacked),
    runes: num(player.rune_pickups),
    lotuses: lotusesTaken(player),
    smokes: num((player.item_uses || {}).smoke_of_deceit),
    teamfight: num(player.teamfight_participation),
    stuns: num(player.stuns),
    firstBlood: num(player.firstblood_claimed) > 0 ? 1 : 0,
    tormentors: tormentorKills(player),
    roshans: num(player.roshans_killed ?? player.roshan_kills),
    couriers: num(player.courier_kills),
  };

  const points: FantasyBreakdown = {
    kills: raw.kills * PTS.kill,
    deaths: PTS.deathBase - raw.deaths * PTS.deathPenalty,
    creeps: raw.creeps * PTS.creep,
    gpm: raw.gpm * PTS.gpm,
    towers: raw.towers * PTS.tower,
    wards: raw.wards * PTS.wardPlaced,
    camps: raw.camps * PTS.campStacked,
    runes: raw.runes * PTS.rune,
    lotuses: raw.lotuses * PTS.lotus,
    smokes: raw.smokes * PTS.smoke,
    teamfight: raw.teamfight * PTS.teamfight,
    stuns: raw.stuns * PTS.stunSecond,
    firstBlood: raw.firstBlood * PTS.firstBlood,
    tormentors: raw.tormentors * PTS.tormentor,
    roshans: raw.roshans * PTS.roshan,
    couriers: raw.couriers * PTS.courier,
  };

  const total = Object.values(points).reduce((sum, value) => sum + value, 0);
  return { total: Math.round(total), raw, points, parsed: matchIsParsed };
}

/** The two or three stats that put the most points on this player's board. */
export function topContributors(score: FantasyScore, count = 3): Array<{ stat: string; points: number }> {
  const labels: Record<keyof FantasyBreakdown, string> = {
    kills: 'kills', deaths: 'staying alive', creeps: 'creeps', gpm: 'GPM', towers: 'towers',
    wards: 'wards', camps: 'stacks', runes: 'runes', lotuses: 'lotuses', smokes: 'smokes',
    teamfight: 'teamfight', stuns: 'stuns', firstBlood: 'first blood', tormentors: 'tormentor',
    roshans: 'roshan', couriers: 'courier',
  };
  return (Object.keys(score.points) as Array<keyof FantasyBreakdown>)
    .map(stat => ({ stat: labels[stat], points: Math.round(score.points[stat]) }))
    .filter(entry => entry.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, count);
}

/**
 * A TI series card scores the sum of the player's two best games, not every game
 * they played, so a 3-0 sweep is worth the same as a 2-0.
 */
export function seriesTotal(gameScores: number[]): number {
  return [...gameScores].sort((a, b) => b - a).slice(0, 2).reduce((sum, value) => sum + value, 0);
}
