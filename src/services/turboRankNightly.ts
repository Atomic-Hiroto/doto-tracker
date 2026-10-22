import { logger } from './loggerService';
import { turboRankService } from './turboRankService';

/** 22:00 UTC is 03:30 IST, when the crew is least likely to be mid-session. */
const RUN_HOUR_UTC = 22;
const PLAYER_TIMEOUT_MS = 120_000;
const PLAYER_GAP_MS = 1500;

let timer: NodeJS.Timeout | undefined;
let running = false;

/**
 * Nightly `+turborank` refresh for everyone who played since their last calibration.
 *
 * Live games arrive before OpenDota has parsed them, so their party size is unknown and the solo
 * estimate skips them; only a Stratz calibration relabels the solo ones. This re-runs it for just
 * those players (a couple of Stratz calls each, from the VPS that holds the key's IP binding), with
 * the OpenDota fallback off so a Stratz outage can't spend ~100 OpenDota calls per player.
 */
async function runNightlyCalibration() {
  if (running) return;
  running = true;
  try {
    const targets = turboRankService.playersNeedingCalibration();
    if (!targets.length) {
      logger.info('Nightly turbo rank refresh: nobody played since their last calibration');
      return;
    }
    logger.info(`Nightly turbo rank refresh: ${targets.length} players`);
    let updated = 0;
    for (const [i, target] of targets.entries()) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        const estimate = await Promise.race([
          turboRankService.calibratePlayer(target.discordId, target.steamId, 100, undefined, { openDotaFallback: false }),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('timed out')), PLAYER_TIMEOUT_MS); }),
        ]);
        if (estimate) updated++;
      } catch (error) {
        logger.error(`Nightly turbo rank refresh failed for ${target.name} (${target.steamId}):`, error);
      } finally {
        clearTimeout(timeout);
      }
      if (i < targets.length - 1) await new Promise(resolve => setTimeout(resolve, PLAYER_GAP_MS));
    }
    logger.info(`Nightly turbo rank refresh done: ${updated}/${targets.length} updated`);
  } finally {
    running = false;
  }
}

function msUntilNextRun(now = new Date()) {
  const next = new Date(now);
  next.setUTCHours(RUN_HOUR_UTC, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function schedule() {
  timer = setTimeout(async () => {
    await runNightlyCalibration().catch(error => logger.error('Nightly turbo rank refresh crashed:', error));
    schedule();
  }, msUntilNextRun());
}

export function startTurboRankNightly() {
  if (timer) return;
  schedule();
  logger.info(`Nightly turbo rank refresh armed for ${RUN_HOUR_UTC}:00 UTC`);
}

export function stopTurboRankNightly() {
  clearTimeout(timer);
  timer = undefined;
}
