import { TurboRoleGame } from './stratzClient';

/** Games on a hero at one position before it counts as something the player brings. */
export const MIN_HERO_GAMES = 3;
/** Hero records are pulled this many games toward 50%, so a 3–0 can't outrank a 30–20 by much. */
const HERO_PRIOR_GAMES = 10;
/** A slot with no qualifying hero is scored on the player's whole record there, pulled harder... */
const FLEX_PRIOR_GAMES = 20;
/** ...and docked this much, so a real comfort hero always beats "whatever they pick". */
const FLEX_PENALTY = 0.05;
/** Heroes per position considered when resolving clashes; deeper picks never win a slot. */
const HEROES_PER_SLOT = 6;

export interface HeroOption {
  /** null = no hero with MIN_HERO_GAMES at this position; the record is the whole position. */
  heroId: number | null;
  games: number;
  wins: number;
  /** Shrunk win rate the assignment maximises. */
  value: number;
}

/** position (1–5) → options, best first. Every position has at least the flex option. */
export type RoleTable = Map<number, HeroOption[]>;

export function buildRoleTable(games: TurboRoleGame[]): RoleTable {
  const byPos = new Map<number, { games: number; wins: number; heroes: Map<number, { games: number; wins: number }> }>();
  for (let pos = 1; pos <= 5; pos++) byPos.set(pos, { games: 0, wins: 0, heroes: new Map() });
  for (const game of games) {
    const slot = byPos.get(game.position);
    if (!slot) continue;
    slot.games++;
    if (game.won) slot.wins++;
    const hero = slot.heroes.get(game.heroId) || { games: 0, wins: 0 };
    hero.games++;
    if (game.won) hero.wins++;
    slot.heroes.set(game.heroId, hero);
  }

  const table: RoleTable = new Map();
  for (const [pos, slot] of byPos) {
    const options: HeroOption[] = [...slot.heroes]
      .filter(([, record]) => record.games >= MIN_HERO_GAMES)
      .map(([heroId, record]) => ({
        heroId,
        games: record.games,
        wins: record.wins,
        value: (record.wins + HERO_PRIOR_GAMES / 2) / (record.games + HERO_PRIOR_GAMES),
      }))
      .sort((a, b) => b.value - a.value || b.games - a.games)
      .slice(0, HEROES_PER_SLOT);
    options.push({
      heroId: null,
      games: slot.games,
      wins: slot.wins,
      value: (slot.wins + FLEX_PRIOR_GAMES / 2) / (slot.games + FLEX_PRIOR_GAMES) - FLEX_PENALTY,
    });
    table.set(pos, options);
  }
  return table;
}

export interface SlotAssignment extends HeroOption {
  playerId: string;
  position: number;
}

function permutations(items: number[]): number[][] {
  if (items.length <= 1) return [items];
  const out: number[][] = [];
  items.forEach((item, i) => {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([item, ...rest]);
  });
  return out;
}

/**
 * Gives each of five players a different position and a different hero, maximising the summed
 * hero-at-position win rate. Every one of the 120 position orders is tried and hero clashes are
 * searched exhaustively, so when two players want the same hero or lane the one whose record on
 * it is stronger keeps it only if that leaves the whole party better off. Ties go to the order the
 * players were passed in, so callers list their strongest player first.
 */
export function assignRoles(players: { id: string; table: RoleTable }[]): { slots: SlotAssignment[]; fit: number } | null {
  if (players.length !== 5) return null;
  let best: { slots: SlotAssignment[]; total: number } | null = null;

  for (const order of permutations([1, 2, 3, 4, 5])) {
    const options = players.map((player, i) => player.table.get(order[i]) || []);
    // Upper bound for pruning: every remaining player gets their top option, clashes ignored.
    const ceiling = options.map(list => list[0]?.value ?? 0);
    const picked: HeroOption[] = [];
    const used = new Set<number>();

    const search = (i: number, total: number) => {
      if (i === players.length) {
        if (!best || total > best.total + 1e-9) {
          best = {
            total,
            slots: picked.map((option, j) => ({ ...option, playerId: players[j].id, position: order[j] })),
          };
        }
        return;
      }
      let bound = total;
      for (let j = i; j < players.length; j++) bound += ceiling[j];
      if (best && bound <= best.total + 1e-9) return;
      for (const option of options[i]) {
        if (option.heroId !== null && used.has(option.heroId)) continue;
        if (option.heroId !== null) used.add(option.heroId);
        picked.push(option);
        search(i + 1, total + option.value);
        picked.pop();
        if (option.heroId !== null) used.delete(option.heroId);
      }
    };
    search(0, 0);
  }

  const result = best as { slots: SlotAssignment[]; total: number } | null;
  if (!result) return null;
  return { slots: [...result.slots].sort((a, b) => a.position - b.position), fit: result.total / players.length };
}
