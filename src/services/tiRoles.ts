import { opendotaClient } from './apiClient';
import { logger } from './loggerService';

/**
 * Valve's own card-slot role for each pro, straight off OpenDota's `/proPlayers`.
 *
 * This matters because the fantasy score this bot computes is systematically
 * short for supports — watchers taken and lotuses grabbed are support work and
 * neither is exposed by any public API. Comparing a support's number against a
 * core's is therefore not a fair fight, so every surface that ranks players tags
 * the role and ranks within it.
 */
export type TiRole = 'Core' | 'Mid' | 'Sup' | 'Off' | '';

const ROLE_BY_ID: Record<number, TiRole> = { 1: 'Core', 2: 'Sup', 3: 'Off', 4: 'Mid' };

/** `/proPlayers` is a 4.5MB payload, so it is pulled rarely and kept compact. */
const REFRESH_MS = 12 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;

let roles = new Map<number, TiRole>();
let fetchedAt = 0;
let inFlight: Promise<void> | null = null;

async function refresh(): Promise<void> {
  const response = await opendotaClient.get<any[]>('/proPlayers');
  const next = new Map<number, TiRole>();
  for (const player of response.data || []) {
    const role = ROLE_BY_ID[Number(player?.fantasy_role)];
    if (role && player.account_id) next.set(Number(player.account_id), role);
  }
  if (next.size) {
    roles = next;
    fetchedAt = Date.now();
    logger.info(`TI: loaded card-slot roles for ${roles.size} pro players`);
  }
}

/**
 * Loads the role table if it is stale. Never throws — a missing table only means
 * rows render without a role tag, which is a cosmetic loss, not a broken post.
 */
export async function ensureRoles(): Promise<void> {
  const age = Date.now() - fetchedAt;
  if (roles.size && age < REFRESH_MS) return;
  if (!roles.size && fetchedAt && age < RETRY_MS) return;
  if (inFlight) return inFlight;
  inFlight = refresh()
    .catch(error => {
      // Stamp the attempt so a persistent failure backs off instead of retrying
      // on every single poll.
      if (!roles.size) fetchedAt = Date.now();
      logger.warn('TI: could not load pro player roles:', error);
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

export function roleFor(accountId: number | undefined | null): TiRole {
  return (accountId && roles.get(Number(accountId))) || '';
}

/** Card slots in the order a fantasy team is built, so displays stay consistent. */
export const ROLE_ORDER: TiRole[] = ['Core', 'Mid', 'Off', 'Sup'];

export function sortRoles(a: TiRole, b: TiRole): number {
  const rank = (role: TiRole) => {
    const index = ROLE_ORDER.indexOf(role);
    return index === -1 ? ROLE_ORDER.length : index;
  };
  return rank(a) - rank(b);
}
