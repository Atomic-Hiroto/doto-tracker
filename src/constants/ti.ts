/**
 * The International 2026 auto-poster.
 *
 * OpenDota's free tier is 2000 calls/day and the registered-player match poll
 * already eats a large slice of it, so the TI poller is deliberately two-speed:
 * it idles cheaply and only tightens its loop while a main-stage game is
 * actually on the wire. Every interval here is env-overridable so the cadence
 * can be tuned from the VPS without a redeploy.
 */

export const TI_LEAGUE_ID = parseInt(process.env.TI_LEAGUE_ID || '19719', 10);
export const TI_LEAGUE_LABEL = process.env.TI_LEAGUE_LABEL || 'The International 2026';

/**
 * Group stage ran 15–16 Aug and the main stage opened 20 Aug 02:36 UTC. OpenDota
 * exposes no bracket field, so "main stage" is a timestamp cut — the four-day gap
 * between the two phases means any cutoff inside it gives the same answer.
 */
export const TI_MAIN_STAGE_START = parseInt(process.env.TI_MAIN_STAGE_START || '1787184000', 10);

/** Poll cadence while a main-stage game is live (or just ended). */
export const TI_POLL_ACTIVE_MS = parseInt(process.env.TI_POLL_ACTIVE_MS || '90000', 10);
/** Poll cadence when nothing is live. */
export const TI_POLL_IDLE_MS = parseInt(process.env.TI_POLL_IDLE_MS || '600000', 10);
/** How long after the last sign of life we keep polling fast (games run back-to-back). */
export const TI_ACTIVE_GRACE_MS = parseInt(process.env.TI_ACTIVE_GRACE_MS || '2400000', 10);
/** Floor between full `/leagues/{id}/matches` sweeps — the safety net for anything `/live` missed. */
export const TI_SWEEP_MIN_INTERVAL_MS = parseInt(process.env.TI_SWEEP_MIN_INTERVAL_MS || '600000', 10);
/**
 * How long to keep asking OpenDota for a match whose live entry has frozen.
 * Covers ingest lag and long tech pauses; past this the periodic sweep takes over.
 */
export const TI_FINISH_GIVEUP_MS = parseInt(process.env.TI_FINISH_GIVEUP_MS || '1800000', 10);
/** A game posted before OpenDota parsed the replay gets edited later; this is how often we retry. */
export const TI_REPARSE_INTERVAL_MS = parseInt(process.env.TI_REPARSE_INTERVAL_MS || '420000', 10);
/** Give up waiting for a parse after this long — some replays never land. */
export const TI_REPARSE_MAX_AGE_MS = parseInt(process.env.TI_REPARSE_MAX_AGE_MS || String(6 * 60 * 60 * 1000), 10);
/** Set TI_LIVE_TICKER=0 to drop the in-progress embed and halve the poll cost. */
export const TI_LIVE_TICKER = (process.env.TI_LIVE_TICKER || '1') !== '0';

export const TI_STATE_FILE = process.env.TI_STATE_FILE || 'tiState.json';

/**
 * TI 2026 fantasy point values, per game. Valve rescaled these from the old
 * fractional DPC table into whole points, so a strong game lands in the tens of
 * thousands rather than in the twenties.
 *
 * Sources agreeing on every value: ti2026calculator.com and the Sportskeeda /
 * egamersworld compendium guides.
 */
export const TI_FANTASY_POINTS = {
  kill: 107,
  deathBase: 1950,
  deathPenalty: 195,
  creep: 3,            // last hits + denies
  gpm: 2,              // per point of GPM
  tower: 352,
  wardPlaced: 117,     // observer wards
  campStacked: 234,
  rune: 141,
  watcher: 147,        // not exposed by OpenDota
  lotus: 176,
  smoke: 293,
  madstone: 13,        // not exposed by OpenDota
  teamfight: 2124,     // multiplied by the participation fraction
  stunSecond: 10,
  firstBlood: 1934,
  tormentor: 879,
  roshan: 1172,
  courier: 703,
} as const;

/** Stats the official scoring counts that OpenDota's match payload simply does not carry. */
export const TI_FANTASY_MISSING = ['watchers', 'madstones'] as const;
