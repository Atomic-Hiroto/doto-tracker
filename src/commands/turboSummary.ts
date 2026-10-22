import { TurboRankEstimate } from '../models/TurboRank';
import { TurboStatsService } from '../services/turboStatsService';
import { turboRankService, mmrToMedal, mmrToEmoji } from '../services/turboRankService';

const LB_MIN_SOLO = 10;
const LB_MIN_CONF = 40;

/** Solid enough for the `+turborank all` board: solo-based, with 10+ solo games behind it. */
export function isLeaderboardQuality(estimate: Pick<TurboRankEstimate, 'confidence' | 'soloSampleSize' | 'partyFallback'>): boolean {
  return !estimate.partyFallback && estimate.confidence >= LB_MIN_CONF && estimate.soloSampleSize >= LB_MIN_SOLO;
}

/** "🟠 Hidden **Ancient 3** · ~4300 ±150 · 42 solo games", or why there is no rank yet. */
export function hiddenRankLine(estimate: TurboRankEstimate | null): string {
  if (!estimate) return '🔮 Hidden rank not calibrated yet · `+turborank calibrate`';
  const error = estimate.precisionSD ? ` ±${estimate.precisionSD}` : '';
  const basis = estimate.partyFallback
    ? 'party games only, rough guess'
    : `${estimate.soloSampleSize} solo game${estimate.soloSampleSize === 1 ? '' : 's'}${isLeaderboardQuality(estimate) ? '' : ', rough guess'}`;
  return `${mmrToEmoji(estimate.estimatedMMR)} Hidden **${estimate.medal}** · ~${estimate.estimatedMMR}${error} · ${basis}`;
}

/**
 * The Turbo block `+profile` and `+compare` share: hidden rank (own level, from solo lobbies), pull
 * (what their parties draw, `+turbopull`), and the bot-tracked record. Win rate is shown as a fact,
 * never as a ranking: in Turbo it sits near 50% for everyone.
 */
export function turboSummary(stats: TurboStatsService, discordId: string, steamId: string, pullById?: Map<string, { rating: number; games: number }>) {
  const estimate = turboRankService.getEstimateBySteamId(steamId) ?? turboRankService.getEstimate(discordId);
  const pull = pullById?.get(discordId);
  const record = stats.getPlayerStats(discordId);
  const games = record ? record.wins + record.losses : 0;
  return {
    estimate,
    pull,
    lines: [
      hiddenRankLine(estimate),
      pull ? `🧲 Parties draw **${mmrToMedal(pull.rating).medal}** enemies (~${Math.round(pull.rating)})` : null,
      games ? `📒 ${record!.wins}W–${record!.losses}L tracked (${Math.round((record!.wins / games) * 100)}%)` : null,
    ].filter((line): line is string => Boolean(line)),
  };
}

/** Pull ratings keyed by Discord id, from the same enemy source `+turbopull` uses. */
export function pullRatingsById(stats: TurboStatsService) {
  const enemyByMatch = turboRankService.getEnemyStrengthByMatch({ registeredOnly: true, minVisibleEnemies: 2 });
  return new Map(stats.getPullRatings(enemyByMatch, 20).players.map(player => [player.discordId, player]));
}
