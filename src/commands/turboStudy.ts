import fs from 'fs';
import { AttachmentBuilder, EmbedBuilder, Message } from 'discord.js';
import { turboRankService, rankTierToMMR, rankTierToMedal, pointEstimateFrom } from '../services/turboRankService';
import { TurboRankEstimate, TurboRankObservation } from '../models/TurboRank';
import { TurboStatsService } from '../services/turboStatsService';
import { UserDataService } from '../services/userDataService';
import { opendotaClient } from '../services/apiClient';
import { renderTurboStudyScatter, renderTurboStudyResidual } from '../services/chartService';
import { turboScorecard } from './turboFun';
import { turboStudyDeep } from './turboStudyDeep';
import { logger } from '../services/loggerService';
import {
  Correlation,
  Disattenuated,
  ErrorStats,
  Fit,
  MechanicalNull,
  PredictiveValue,
  ResolutionCI,
  SplitHalf,
  VarianceDecomposition,
  calibrationCheck,
  combineReliability,
  disattenuate,
  errorStats,
  fmtCorr,
  linearFit,
  mechanicalNullSlope,
  median,
  outlierCut,
  pairedMAEComparison,
  pearson,
  predictiveValue,
  resolutionWithCI,
  sd,
  spearman,
  splitHalfReliability,
  thorndikeCase2,
  varianceDecomposition,
  weightedPearson,
} from '../services/turboStudyStats';

interface StudyCandidate {
  discordId: string;
  steamId: string;
  name: string;
  estimate: TurboRankEstimate;
  /** Raw match history, needed to re-estimate from halves for the reliability split. */
  observations: readonly TurboRankObservation[];
  turboScore?: number;
  turboGames?: number;
  turboWinRate?: number;
  visibleRankTier?: number;
  visibleMMR?: number;
  /** True when visibleMMR came from the unvalidated Immortal leaderboard curve. */
  visibleFromCurve?: boolean;
}

interface StudyRow extends StudyCandidate {
  visibleRankTier: number;
  visibleMMR: number;
}

function asRows(candidates: StudyCandidate[]): StudyRow[] {
  return candidates.filter((c): c is StudyRow => c.visibleRankTier != null && c.visibleMMR != null);
}

const gapOf = (r: StudyRow) => r.estimate.estimatedMMR - r.visibleMMR;
const pointsOf = (rows: StudyRow[]) => rows.map((r) => ({ x: r.visibleMMR, y: r.estimate.estimatedMMR }));

function fmtMmr(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${Math.round(value)} MMR`;
}

/** MMR span of one medal tier — the unit a reader actually thinks in. */
const MEDAL_SPAN_MMR = 770;

/**
 * Minimum rows before the study will grade anything. The old floor was 3, which let
 * `+turbostudy` print "strong correlation" and a slope off three players. Twelve is
 * still thin; it is the point at which a Fisher interval stops spanning most of the
 * possible range.
 */
const MIN_STUDY_ROWS = 12;

/**
 * A quality row has enough *decayed* evidence to carry weight.
 *
 * The old gate was `soloSampleSize >= 15` — a raw lifetime count — inside an estimator
 * that decays observations with a 60-day half-life. On the live cohort that admitted
 * players with 96 solo games and zero in the last two months, then reported their
 * correlation as a robustness check. effectiveSample is the quantity the estimator
 * actually uses, so gate on that.
 */
function isHighQuality(row: StudyRow): boolean {
  return !row.estimate.partyFallback && row.estimate.effectiveSample >= 8;
}

/**
 * Immortal-ranked players sit above the turbo estimator's resolution ceiling (turbo
 * lobby averages top out ~4–4.5k), so their gaps are structural, not estimator error.
 *
 * They are excluded from every headline number, not just from the "measurable" split.
 * Their x-coordinate comes from `immortalMMRFromLeaderboard`, a two-parameter curve
 * fitted to three anchor players and never validated; on the live cohort, moving those
 * seven rows between plausible placements swung the headline slope from 0.76 to 0.47
 * and MAE from 563 to 1008. A number that sensitive to an unvalidated sub-model does
 * not belong in the headline.
 */
function isCeiling(row: StudyRow): boolean {
  return Math.floor(row.visibleRankTier / 10) === 8;
}

function daysSince(ms: number): number {
  return Math.floor((Date.now() - ms) / 86400000);
}

/**
 * Assumed reliability of the visible ranked medal as a measure of ranked skill.
 *
 * Unlike the turbo estimate, this one cannot be measured here — a player has exactly one
 * medal, so there is no second reading to correlate against. 0.90 allows for staleness
 * (medals lag current form and decay when someone stops queueing ranked) on top of the
 * negligible loss from 153-MMR star discretisation. Everything derived from it is
 * reported with a sensitivity range so the assumption is visible rather than buried.
 */
const RANKED_MEDAL_RELIABILITY = Number(process.env.TURBO_RANKED_RELIABILITY || '0.90');

/**
 * Assumed SD of the structural gap between "average medal of my lobbies" and "my turbo
 * skill" — the error term split-half is blind to, because it is constant within a
 * player and cancels out of both halves.
 *
 * Matches the estimator's own TURBO_BIAS_SD_MMR. It is almost certainly an
 * *over*-estimate: it was originally measured as the residual SD about the ranked
 * regression, which contains the very turbo-lean the study is trying to size. Charging
 * all of it against the instrument therefore gives a deliberately conservative floor on
 * how much lean is real, and the report shows the optimistic end alongside it.
 */
const STRUCTURAL_SD_MMR = Number(process.env.TURBO_BIAS_SD_MMR || '630');

/**
 * SD of ranked MMR across the actual Dota population, for the range-restriction
 * correction. An assumption, not a measurement: it is the one number in the study that
 * comes from outside the cohort, and the corrected figure moves roughly linearly with it.
 */
const POPULATION_RANKED_SD_MMR = Number(process.env.TURBO_POPULATION_RANKED_SD || '1400');

/** Turbo lobby averages top out around here; the ceiling drives the mechanical slope. */
const TURBO_LOBBY_CEILING_MMR = 4500;

/** Minimum Kish sample each half needs before a player can join the reliability split. */
const MIN_HALF_KISH = 2;

/**
 * Estimate every player twice, from disjoint halves of their own match history.
 *
 * Interleaved by time (even-indexed matches vs odd-indexed) rather than cut into an
 * older and a newer block: a chronological split would confound estimator noise with
 * real skill drift, and would hand nearly all the recency weight to one side.
 */
function splitHalfRows(rows: StudyRow[]): Array<{ a: number; b: number; full: number }> {
  const out: Array<{ a: number; b: number; full: number }> = [];
  for (const row of rows) {
    const ordered = [...row.observations].sort((x, y) => x.timestamp - y.timestamp);
    if (ordered.length < 4) continue;
    const a = pointEstimateFrom(ordered.filter((_, i) => i % 2 === 0));
    const b = pointEstimateFrom(ordered.filter((_, i) => i % 2 === 1));
    if (!a || !b || a.kishN < MIN_HALF_KISH || b.kishN < MIN_HALF_KISH) continue;
    out.push({ a: a.mmr, b: b.mmr, full: row.estimate.estimatedMMR });
  }
  return out;
}

/**
 * Immortal (tier 80) has no medal stars, so rankTierToMMR pins every Immortal — a
 * top-1000 ladder player and a just-qualified one — to the same floor, which badly
 * understates the strong ones. We spread them out using the OpenDota leaderboard rank.
 *
 * Curve fit to known anchors (leaderboard rank → MMR): #4903≈7.0k, #3205≈7.2k,
 * #959≈8.0k → `mmr ≈ 12200 − 613·ln(rank)`. That is two free parameters fitted to
 * three points, with no held-out check, so anything derived from it is flagged
 * (`visibleFromCurve`) and kept out of the headline stats — it is good enough to place
 * Immortals on a scatter plot and no better.
 *
 * Note the floor here is the study's own, and it deliberately matches
 * MEDAL_MMR_FLOORS[8] so an Immortal's `lean` and their study x-coordinate agree.
 * They used to differ by 200 MMR (5620 vs 5420).
 */
const IMMORTAL_FLOOR_MMR = 5420;
function immortalMMRFromLeaderboard(leaderboardRank: number | null | undefined): number {
  if (!leaderboardRank || leaderboardRank <= 0) return IMMORTAL_FLOOR_MMR;
  const est = 12200 - 613 * Math.log(leaderboardRank);
  return Math.max(IMMORTAL_FLOOR_MMR, Math.round(est));
}

/**
 * Resolve a player's visible *ranked* MMR for the study's x-axis.
 *
 * Prefers the Stratz `seasonRank` captured at calibration time (`estimate.rankedTier`):
 * it's the same source the turbo estimate used, it's generally fresher than OpenDota's
 * `rank_tier`, and it needs no extra call. OpenDota is hit only when we need a
 * leaderboard rank to de-compress an Immortal, or as a fallback when Stratz never
 * captured a medal.
 */
async function fetchVisibleRankMMR(
  steamId: string,
  stratzTier: number | null | undefined,
): Promise<{ rankTier: number; mmr: number; fromCurve: boolean } | null> {
  let rankTier = stratzTier && stratzTier > 0 ? stratzTier : null;
  let leaderboardRank: number | null = null;

  const needsOpenDota = rankTier == null || Math.floor(rankTier / 10) === 8;
  if (needsOpenDota) {
    try {
      const response = await opendotaClient.get<{ rank_tier?: number; leaderboard_rank?: number }>(`/players/${steamId}`);
      if (rankTier == null && response.data?.rank_tier) rankTier = response.data.rank_tier;
      leaderboardRank = response.data?.leaderboard_rank ?? null;
    } catch (error) {
      logger.warn(`Turbo study profile fetch failed for ${steamId}:`, error);
    }
  }

  if (!rankTier) return null;
  const isImmortal = Math.floor(rankTier / 10) === 8;
  const mmr = isImmortal ? immortalMMRFromLeaderboard(leaderboardRank) : rankTierToMMR(rankTier);
  if (mmr == null) return null;
  return { rankTier, mmr, fromCurve: isImmortal && !!leaderboardRank && leaderboardRank > 0 };
}

function toCsv(candidates: StudyCandidate[]): Buffer {
  const header = [
    'name', 'discordId', 'steamId', 'rankedMedal', 'rankedApproxMMR', 'rankedFromImmortalCurve',
    'turboMedal', 'turboMMR', 'gapMMR', 'experimentalMedal', 'experimentalMMR',
    'experimentalGapMMR', 'experimentalDeltaMMR', 'experimentalVersion', 'robustLobbyMMR',
    'balanceInvertedMMR', 'balanceWeight', 'balanceAdjustmentMMR', 'resultAdjustmentMMR',
    'resultSampleSize', 'resultPosteriorSD', 'sampleCoverage', 'precisionSD', 'kishSample', 'sampleSize',
    'soloSampleSize', 'effectiveSample', 'partyFallback', 'lastUpdated',
    'turboScore', 'turboGames', 'turboWinRate',
  ];
  const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = candidates.map((r) => {
    const gap = r.visibleMMR == null ? '' : r.estimate.estimatedMMR - r.visibleMMR;
    const exp = r.estimate.experimental;
    const expGap = exp && r.visibleMMR != null ? exp.experimentalMMR - r.visibleMMR : '';
    return [
      r.name,
      r.discordId,
      r.steamId,
      r.visibleRankTier ? rankTierToMedal(r.visibleRankTier) : '',
      r.visibleMMR ?? '',
      r.visibleFromCurve ? 'true' : 'false',
      r.estimate.medal,
      r.estimate.estimatedMMR,
      gap,
      exp?.medal ?? '',
      exp?.experimentalMMR ?? '',
      expGap,
      exp?.deltaFromCurrent ?? '',
      exp?.version ?? '',
      exp?.robustLobbyMMR ?? '',
      exp?.balanceInvertedMMR ?? '',
      exp?.balanceWeight ?? '',
      exp?.balanceAdjustment ?? '',
      exp?.resultAdjustment ?? '',
      exp?.resultSampleSize ?? '',
      exp?.resultPosteriorSD ?? '',
      r.estimate.confidence,
      r.estimate.precisionSD ?? '',
      r.estimate.kishSample ?? '',
      r.estimate.sampleSize,
      r.estimate.soloSampleSize,
      r.estimate.effectiveSample,
      r.estimate.partyFallback,
      new Date(r.estimate.lastUpdated).toISOString(),
      r.turboScore ?? '',
      r.turboGames ?? '',
      r.turboWinRate == null ? '' : r.turboWinRate.toFixed(1),
    ].map(escape).join(',');
  });

  return Buffer.from([header.join(','), ...rows].join('\n'), 'utf8');
}

// ── Trend history ────────────────────────────────────────────────────────────

const STUDY_HISTORY_FILE = 'turboStudyHistory.json';
type StudyScope = 'all' | 'crew';

interface StudySnapshot {
  ts: number;
  /**
   * Which cohort this run covered. Absent on entries written before scoping existed;
   * those are ignored for trend purposes rather than silently compared against.
   */
  scope?: StudyScope;
  n: number;
  mae: number;
  maeSE: number;
  rmse: number;
  avgGap: number;
  slope: number | null;
  intercept: number | null;
}

function loadStudyHistory(): StudySnapshot[] {
  try { return JSON.parse(fs.readFileSync(STUDY_HISTORY_FILE, 'utf8')); } catch { return []; }
}

function saveStudySnapshot(snap: StudySnapshot) {
  const hist = loadStudyHistory();
  hist.push(snap);
  try { fs.writeFileSync(STUDY_HISTORY_FILE, JSON.stringify(hist.slice(-100), null, 2)); } catch { /* ignore */ }
}

/**
 * Most recent run of the *same* cohort.
 *
 * `+turbostudy crew` used to write into the same history as the full study, so the
 * stored file holds runs of n = 14, 19, 27, 30, 31, 36, 53, 54 and 55 in one sequence
 * and "Trend vs Last Run" happily compared a 31-player cohort against a 55-player one.
 */
function previousSnapshot(scope: StudyScope): StudySnapshot | undefined {
  return loadStudyHistory().filter((s) => s.scope === scope).slice(-1)[0];
}

/**
 * Arrow only when the move clears the metric's own standard error.
 *
 * The old threshold was 1 MMR against an MAE whose SE is ~64 MMR, so essentially every
 * run reported a direction. Fifteen of the sixteen stored same-cohort deltas are inside
 * one SE — i.e. noise that was being rendered as ✅ / ⚠️.
 */
function trendArrow(curr: number, prev: number | undefined, se: number, lowerIsBetter = true): string {
  if (prev == null) return ' _(no comparable previous run)_';
  const delta = curr - prev;
  const threshold = Math.max(se, 1);
  if (Math.abs(delta) < threshold) return ` (=${delta >= 0 ? '+' : ''}${Math.round(delta)}, within noise ±${Math.round(threshold)})`;
  const better = lowerIsBetter ? delta < 0 : delta > 0;
  return ` (${delta < 0 ? '▼' : '▲'}${Math.abs(Math.round(delta))} ${better ? '✅' : '⚠️'})`;
}

const STUDY_BRACKETS = [
  { name: 'Herald–Crusader (<2310)', lo: 0, hi: 2310 },
  { name: 'Archon–Legend (2310–3850)', lo: 2310, hi: 3850 },
  { name: 'Ancient–Divine (3850+)', lo: 3850, hi: Infinity },
];

// ── Narrative ────────────────────────────────────────────────────────────────

/**
 * Plain-language read of the headline finding.
 *
 * Rewritten twice. The first version reported the full-cohort r as the answer to "does
 * ranked skill carry into Turbo?" and turned R² into "about 81% of your Turbo skill is
 * just your ranked medal" — a variance share read as a causal one, across a cohort
 * spanning Herald to Immortal, where almost any signal correlates.
 *
 * The second version fixed the statistics but kept describing the study as an accuracy
 * audit of the estimator: it called the turbo-minus-ranked gap "error". That gap is the
 * *finding*, not a mistake — it is turbo-lean. Once that is the estimand, the questions
 * change: how correlated are the two latent skills, how much of turbo is its own thing,
 * and how much does either number survive being measured with a noisy instrument.
 */
function plainEnglish(input: {
  band: Correlation | null;
  trueCorr: Disattenuated | null;
  populationCorr: number | null;
  decomposition: VarianceDecomposition | null;
  decompositionBest: VarianceDecomposition | null;
  split: SplitHalf | null;
  res: ResolutionCI;
  predictive: PredictiveValue | null;
  mechanical: MechanicalNull | null;
  ceilingCount: number;
}): string {
  const { band, trueCorr, populationCorr, decomposition, decompositionBest, res, predictive, mechanical } = input;
  const lines: string[] = [];
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  if (band && trueCorr) {
    lines.push(
      `**How correlated are Turbo skill and ranked skill?** Among players in the same broad band the raw link is ` +
      `**${band.r.toFixed(2)}** (${band.lo.toFixed(2)}–${band.hi.toFixed(2)}, n=${band.n}). Both sides are measured with ` +
      `error, which drags any correlation downward, so the *underlying* skills correlate about ` +
      `**${trueCorr.corrected.toFixed(2)}** (${trueCorr.sensitivityLo.toFixed(2)}–${trueCorr.sensitivityHi.toFixed(2)} over ` +
      'plausible medal reliability).' +
      (populationCorr != null
        ? ` Widened from this band to the whole player base it would be ~**${populationCorr.toFixed(2)}**.`
        : ''),
    );
  } else if (band) {
    lines.push(
      `**How correlated are Turbo skill and ranked skill?** Raw link **${band.r.toFixed(2)}** ` +
      `(${band.lo.toFixed(2)}–${band.hi.toFixed(2)}, n=${band.n}). Not enough split-half data to correct it for ` +
      'measurement error yet, so treat it as a floor.',
    );
  }

  if (decomposition && decompositionBest) {
    lines.push(
      `**Is Turbo its own skill?** Somewhere between **${pct(decomposition.specificPct)}** and ` +
      `**${pct(decompositionBest.specificPct)}** of the spread in Turbo estimates is Turbo-specific rather than shared ` +
      `with ranked — worth **±${Math.round(decomposition.specificSD)}–${Math.round(decompositionBest.specificSD)} MMR**. ` +
      'The range is wide because no split of a player\'s own matches can reveal how far their lobby average sits from their ' +
      'true skill. Even the pessimistic end says Turbo-lean is real.',
    );
  }

  // The slope, pair-ordering and predictive numbers each have their own field below.
  // Repeating them in full here is what used to push this field past Discord's 1024
  // cap and silently drop the last paragraphs, so this is a one-line pointer instead.
  const caveats: string[] = [];
  if (mechanical?.explained) caveats.push('the flat slope is an instrument artefact, not Turbo compressing skill');
  if (res.nearPairs > 0 && res.nearLo <= 0.5) caveats.push('close-call ordering is not settled — its interval reaches the coin flip');
  if (predictive) caveats.push(`one player's number carries ±${Math.round(predictive.interval95)} MMR at 95%, so read the cohort and not the individual`);
  if (caveats.length > 0) {
    lines.push(`**The catch:** ${caveats.join('; ')}. Detail in the fields below.`);
  }

  if (lines.length === 0) return 'Not enough data yet for a plain-language read.';
  return fitLines(lines, 'Not enough data yet for a plain-language read.', 1000, '\n\n');
}

function fitLines(lines: string[], emptyText: string, limit = 1000, sep = '\n'): string {
  if (lines.length === 0) return emptyText;
  const selected: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const nextLen = lines[i].length + (selected.length > 0 ? sep.length : 0);
    if (used + nextLen > limit) {
      selected.push(`...and ${lines.length - i} more.`);
      break;
    }
    selected.push(lines[i]);
    used += nextLen;
  }
  return selected.join(sep);
}

/** Discord rejects an embed whose title + description + all field names/values exceed this. */
const EMBED_TEXT_LIMIT = 6000;
/** Discord rejects an embed containing any field value longer than this. */
const EMBED_FIELD_LIMIT = 1024;

/**
 * Last line of defence on Discord's embed size caps.
 *
 * A single oversized field — or a total that creeps past 6000 characters — makes the API
 * reject the *entire* embed, so a report that grows one line too long fails as "an error
 * occurred" with nothing rendered. Every field goes through here, and the total budget is
 * spent from the bottom of the report upward, so a formatting change can only ever cost a
 * truncated trailing paragraph, never the headline numbers and never the whole study.
 *
 * @param reserve characters already spent on the title and description.
 */
function safeFields(fields: Array<{ name: string; value: string; inline?: boolean }>, reserve = 0) {
  const out = fields.map((f) => ({
    name: f.name.slice(0, 256),
    value: f.value && f.value.length > 0
      ? (f.value.length > EMBED_FIELD_LIMIT ? `${f.value.slice(0, EMBED_FIELD_LIMIT - 9)}\n…(cut)` : f.value)
      : '—',
    inline: f.inline ?? false,
  }));

  const budget = EMBED_TEXT_LIMIT - 100 - reserve; // 100 = margin for future chrome
  let total = out.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
  for (let i = out.length - 1; i >= 0 && total > budget; i--) {
    const field = out[i];
    const keep = field.value.length - (total - budget) - 8;
    const next = keep > 0 ? `${field.value.slice(0, keep)}\n…(cut)` : '—';
    total -= field.value.length - next.length;
    field.value = next;
  }
  return out;
}

// ── Command ──────────────────────────────────────────────────────────────────

export async function turboStudy(message: Message, args: string[], userDataService: UserDataService, turboStatsService: TurboStatsService) {
  try {
    const deepIndex = args.findIndex((arg) => ['deep', 'deeper', 'derive', 'derived', 'stratz'].includes(arg.toLowerCase()));
    if (deepIndex >= 0) {
      return turboStudyDeep(message, args.filter((_, index) => index !== deepIndex), userDataService);
    }

    // +turbostudy scorecard → estimator-accuracy validation (formerly +turboscorecard)
    if (['scorecard', 'score', 'accuracy', 'validate'].includes((args[0] ?? '').toLowerCase())) {
      return turboScorecard(message);
    }
    const crewOnly = ['friends', 'crew', 'mine', 'squad'].includes((args[0] ?? '').toLowerCase());
    const scope: StudyScope = crewOnly ? 'crew' : 'all';
    const estimates = turboRankService.getAllEstimates()
      .filter(e => !crewOnly || !e.discovered);
    const registeredUsers = userDataService.getAllUsers();

    if (estimates.length < MIN_STUDY_ROWS) {
      return message.reply(
        `Need at least ${MIN_STUDY_ROWS} calibrated players to run a study — below that the correlations and slope are ` +
        `dominated by noise and would be misleading to report. Currently ${estimates.length}` +
        (crewOnly ? ' non-discovered player(s). Try `+turbostudy` for everyone.' : '. Run `+turborank calibrate` for more players.'),
      );
    }

    const progress = await message.reply('📊 Building Turbo study... fetching visible ranked medals for calibrated players.');
    const candidates: StudyCandidate[] = [];

    for (let i = 0; i < estimates.length; i++) {
      const entry = estimates[i];
      if (i > 0 && i % 10 === 0) {
        progress.edit(`📊 Building Turbo study... checked ${i}/${estimates.length} calibrated players.`).catch(() => {});
      }

      const visible = await fetchVisibleRankMMR(entry.steamId, entry.estimate.rankedTier);
      const user = entry.discordId ? await message.client.users.fetch(entry.discordId).catch(() => null) : null;
      const stats = entry.discordId ? turboStatsService.getPlayerStats(entry.discordId) : undefined;
      const turboGames = stats ? stats.wins + stats.losses : undefined;
      candidates.push({
        discordId: entry.discordId,
        steamId: entry.steamId,
        name: user?.username ?? entry.steamName ?? entry.steamId,
        estimate: entry.estimate,
        observations: entry.observations,
        turboScore: stats?.rating,
        turboGames,
        turboWinRate: stats && turboGames ? (stats.wins / turboGames) * 100 : undefined,
        visibleRankTier: visible?.rankTier,
        visibleMMR: visible?.mmr,
        visibleFromCurve: visible?.fromCurve,
      });
    }

    const allRows = asRows(candidates);

    // ── Headline cohort ──────────────────────────────────────────────────────
    // Everything graded below runs on the *measurable* range (Herald–Divine).
    // Immortals are plotted and reported, never averaged into a headline: their
    // x-coordinate comes from an unvalidated 3-anchor curve that on the live cohort
    // moved the slope by 0.29 and MAE by 445 depending on where it placed them.
    const rows = allRows.filter((r) => !isCeiling(r));
    const ceilingRows = allRows.filter(isCeiling);

    if (rows.length < MIN_STUDY_ROWS) {
      return progress.edit(
        `Only ${rows.length} calibrated player(s) have a visible Herald–Divine medal (${ceilingRows.length} Immortal excluded — ` +
        `they sit above Turbo's resolution ceiling). Need ${MIN_STUDY_ROWS} to report statistics.`,
      );
    }

    const gaps = rows.map(gapOf);
    const stats = errorStats(gaps)!;
    const fit = linearFit(pointsOf(rows));

    // Robustness: the same headline with cohort-relative outliers removed. The old
    // code flagged |gap| >= 900 as an outlier — 20% of the live cohort, a cut below
    // one RMSE — and then included every one of them in MAE, RMSE, r and the slope.
    const cut = outlierCut(gaps.map(Math.abs));
    const outliers = rows.filter((r) => Math.abs(gapOf(r)) >= cut);
    const trimmedRows = rows.filter((r) => Math.abs(gapOf(r)) < cut);
    const trimmedStats = errorStats(trimmedRows.map(gapOf));
    const trimmedFit = linearFit(pointsOf(trimmedRows));

    // ── Correlations, all with n and a 95% interval ──────────────────────────
    const headlineCorr = pearson(pointsOf(rows));
    const rankOrderCorr = spearman(pointsOf(rows));
    const highQualityRows = rows.filter(isHighQuality);
    const highQualityCorr = pearson(pointsOf(highQualityRows));
    // Inverse-variance weights. precisionSD is recomputed on read, so it is present
    // even for estimates stored before the field existed; the fallback keeps a row
    // from vanishing if it somehow is not.
    const weightedCorr = weightedPearson(rows.map((r) => ({
      x: r.visibleMMR,
      y: r.estimate.estimatedMMR,
      w: 1 / Math.pow(r.estimate.precisionSD || 700, 2),
    })));
    const scoreCorr = pearson(
      rows.filter((r) => Number.isFinite(r.turboScore)).map((r) => ({ x: r.turboScore!, y: r.estimate.estimatedMMR })),
    );

    // Range-restricted companion: the correlation among players who are actually
    // close together, which is what a reader means by "does it work?".
    const midRows = rows.filter((r) => r.visibleRankTier >= 40 && r.visibleRankTier < 80);
    const restrictedCorr = pearson(pointsOf(midRows));

    // Player-level bootstrap, not a binomial on pair count: 317 pairs from 48 players
    // are heavily clustered, and the naive interval is about half the honest width.
    const res = resolutionWithCI(pointsOf(rows), MEDAL_SPAN_MMR);

    // ── Reliability ──────────────────────────────────────────────────────────
    // Split-half measures sampling noise and is blind to the structural term, so the
    // decomposition is bracketed rather than pinned: the optimistic end assumes the
    // lobby average is an unbiased readout of turbo skill, the conservative end charges
    // the whole assumed structural SD against it. The truth is in between and this
    // design cannot say where — so both ends get reported.
    const split = splitHalfReliability(splitHalfRows(rows));
    const relOptimistic = split ? combineReliability(split.totalSD, split.samplingNoiseSD, 0) : null;
    const relConservative = split
      ? combineReliability(split.totalSD, split.samplingNoiseSD, STRUCTURAL_SD_MMR)
      : null;

    // Observed correlations are attenuated by noise on *both* axes, so the raw numbers
    // understate the finding. Correct the range-restricted one — it is the estimand the
    // study actually cares about — using the conservative reliability so the headline
    // never leans on the most flattering assumption.
    const bandCorr = restrictedCorr ?? headlineCorr;
    const trueCorr = relConservative && bandCorr
      ? disattenuate(bandCorr.r, relConservative.reliability, RANKED_MEDAL_RELIABILITY)
      : null;

    // How wide is the band we measured in, versus the population we want to speak about?
    const bandSD = sd(midRows.length >= 8 ? midRows.map((r) => r.visibleMMR) : rows.map((r) => r.visibleMMR));
    const populationCorr = trueCorr && bandSD
      ? thorndikeCase2(trueCorr.corrected, bandSD, POPULATION_RANKED_SD_MMR)
      : null;

    const decomposition: VarianceDecomposition | null =
      relConservative && trueCorr ? varianceDecomposition(relConservative, trueCorr.corrected) : null;
    const decompositionBest: VarianceDecomposition | null =
      relOptimistic && trueCorr ? varianceDecomposition(relOptimistic, trueCorr.corrected) : null;

    // The causal-free framing: how much does knowing turbo narrow a guess at ranked?
    const predictive = predictiveValue(pointsOf(rows));
    const predictiveBand = midRows.length >= 8 ? predictiveValue(pointsOf(midRows)) : null;

    // ── Is the sub-1 slope a fact about Dota, or about averaging nine neighbours? ──
    const medianKish = median(rows.map((r) => r.estimate.kishSample ?? r.estimate.effectiveSample)) ?? 8;
    const withinPlayerSD = median(
      rows
        .map((r) => sd(r.observations.filter((o) => o.partySize === 1).map((o) => o.lobbyMMR)))
        .filter((v): v is number => v != null),
    ) ?? 349;
    const mechanical = fit
      ? mechanicalNullSlope(rows.map((r) => r.visibleMMR), {
        lobbiesPerPlayer: medianKish,
        // lobbyMMR is a mean of 9, so an individual opponent's spread is ~3× the
        // spread of the lobby means we can observe directly.
        opponentSD: withinPlayerSD * 3,
        ceiling: TURBO_LOBBY_CEILING_MMR,
        floor: 0,
        observedSlope: fit.slope,
        observedSlopeLo: fit.slopeLo,
        observedSlopeHi: fit.slopeHi,
      })
      : null;

    // ── Should the estimator apply the bias correction it keeps measuring? ────
    const calibration = calibrationCheck(pointsOf(rows));

    // ── Experimental V2, as a paired comparison on identical rows ────────────
    const experimentalPairs = rows.filter((r) => r.estimate.experimental);
    let experimentalStudyLine = 'No Experimental V2 estimates are available for this cohort.';
    let experimentalMoversLine = 'No Experimental V2 estimates are available.';
    if (experimentalPairs.length >= 8) {
      const v1 = experimentalPairs.map(gapOf);
      const v2 = experimentalPairs.map((r) => r.estimate.experimental!.experimentalMMR - r.visibleMMR);
      const cmp = pairedMAEComparison(v1, v2);
      const thin = experimentalPairs.filter((r) => {
        const e = r.estimate.experimental!;
        return e.resultSampleSize > 0 && e.resultSampleSize < 8;
      }).length;
      if (cmp) {
        const verdict = !cmp.significant
          ? `⚪ No detectable difference. MAE ${Math.round(cmp.baselineMAE)} → ${Math.round(cmp.challengerMAE)}, paired change ` +
            `**${cmp.delta >= 0 ? '+' : ''}${Math.round(cmp.delta)} ±${Math.round(cmp.deltaSE)} MMR** ` +
            `(95% ${Math.round(cmp.lo)}…${Math.round(cmp.hi)}) spans zero — do not promote.`
          : cmp.delta < 0
            ? `✅ V2 is better by **${Math.abs(Math.round(cmp.delta))} ±${Math.round(cmp.deltaSE)} MMR** MAE ` +
              `(95% ${Math.round(cmp.lo)}…${Math.round(cmp.hi)}). This cohort helped select V2, so confirm on new players first.`
            : `⚠️ V2 is worse by **${Math.round(cmp.delta)} ±${Math.round(cmp.deltaSE)} MMR** MAE. Keep it experimental.`;
        experimentalStudyLine =
          `${verdict}\n` +
          `Paired on the same **${cmp.n}** rows. Min detectable change: **~${Math.round(2.8 * cmp.deltaSE)} MMR** MAE.\n` +
          (thin > 0 ? `${thin} row(s) have <8 results feeding V2's likelihood — movement is provisional.\n` : '') +
          '_Experimental only; not used for rank._';
      }
      experimentalMoversLine = fitLines(
        experimentalPairs
          .slice()
          .sort((a, b) => Math.abs(b.estimate.experimental!.deltaFromCurrent) - Math.abs(a.estimate.experimental!.deltaFromCurrent))
          .slice(0, 6)
          .map((r) => `**${r.name}**: ${r.estimate.medal} -> ${r.estimate.experimental!.medal} (${fmtMmr(r.estimate.experimental!.deltaFromCurrent)})`),
        'No movement vs current.',
      );
    }

    // ── Health / actions ─────────────────────────────────────────────────────
    const missingVisible = candidates.filter((r) => r.visibleMMR == null);
    const thinCoverage = rows.filter((r) => r.estimate.effectiveSample < 4);
    const partyFallback = rows.filter((r) => r.estimate.partyFallback);
    const stale = rows.filter((r) => daysSince(r.estimate.lastUpdated) > 30);
    const calibratedSteamIds = new Set(candidates.map((r) => r.steamId));
    const uncalibratedRegistered = registeredUsers.filter((u) => !calibratedSteamIds.has(u.steamId));

    const largestGaps = [...rows]
      .sort((a, b) => Math.abs(gapOf(b)) - Math.abs(gapOf(a)))
      .slice(0, 6)
      .map((r) => {
        const flags = [
          r.estimate.partyFallback ? 'party fallback' : null,
          r.estimate.effectiveSample < 4 ? 'thin coverage' : null,
          daysSince(r.estimate.lastUpdated) > 30 ? 'stale' : null,
        ].filter(Boolean).join(', ');
        return `**${r.name}**: ${r.estimate.medal} turbo vs ${rankTierToMedal(r.visibleRankTier)} ranked (${fmtMmr(gapOf(r))})${flags ? ` - ${flags}` : ''}`;
      });

    const healthLines = [
      `Quality rows (solo, effective sample ≥8): **${highQualityRows.length}/${rows.length}**`,
      `Thin coverage (effective sample <4): **${thinCoverage.length}**`,
      `Party fallback: **${partyFallback.length}**`,
      `Stale >30d: **${stale.length}**`,
      `Cohort-relative outliers (|gap| ≥ ${Math.round(cut)} MMR, median+3·MAD): **${outliers.length}**`,
      `Immortals held out of all statistics: **${ceilingRows.length}**`,
    ];

    const actionLines = [
      uncalibratedRegistered.length > 0 ? `Run \`+turborank calibrate\` for ${uncalibratedRegistered.length} registered player(s) with no estimate.` : null,
      missingVisible.length > 0 ? `${missingVisible.length} calibrated player(s) have no visible ranked medal; they stay in the CSV but out of every statistic.` : null,
      stale.length > 0 ? `Recalibrate stale estimate(s): ${stale.slice(0, 4).map((r) => r.name).join(', ')}.` : null,
      partyFallback.length > 0 ? `Audit party-fallback estimate(s): ${partyFallback.slice(0, 4).map((r) => r.name).join(', ')}.` : null,
      outliers.length > 0 ? `Manually inspect: ${outliers.slice(0, 4).map((r) => r.name).join(', ')}.` : null,
      rows.length < 30 ? `n=${rows.length} — intervals above are wide. Add players before acting on any single coefficient.` : null,
      'Use the CSV to check whether a formula change moves MAE by more than its standard error.',
    ].filter((line): line is string => !!line);

    // Lean by ranked bracket. This is the slope re-expressed in three buckets, so if the
    // slope is mechanical then so is the pattern here — say so rather than letting a
    // reader treat it as independent corroboration.
    const bracketLines = STUDY_BRACKETS.map((b) => {
      const inB = rows.filter((r) => r.visibleMMR >= b.lo && r.visibleMMR < b.hi);
      const s = errorStats(inB.map(gapOf));
      if (!s) return `${b.name}: _no players_`;
      const straddles = s.meanGapLo <= 0 && s.meanGapHi >= 0;
      return `${b.name}: **${fmtMmr(s.meanGap)}** _(n=${s.n}, 95% ${Math.round(s.meanGapLo)}…${Math.round(s.meanGapHi)}${straddles ? ' — includes 0' : ''})_`;
    });
    if (mechanical?.explained) {
      bracketLines.push('⚠️ _This is the slope in three buckets, and the slope is an artefact — not independent evidence._');
    }

    const byGap = [...rows].sort((a, z) => Math.abs(gapOf(a)) - Math.abs(gapOf(z)));
    const best = byGap[0];
    const worst = byGap[byGap.length - 1];
    const extremesLine =
      `Tightest: **${best.name}** (${fmtMmr(gapOf(best))})\n` +
      `Loosest: **${worst.name}** (${fmtMmr(gapOf(worst))})`;

    let fitNote = 'n/a';
    if (fit) {
      fitNote =
        `Slope **${fit.slope.toFixed(2)}** (95% ${fit.slopeLo.toFixed(2)}–${fit.slopeHi.toFixed(2)}), intercept ${fmtMmr(fit.intercept)}, ` +
        `residual SD **${Math.round(fit.residualSD)} MMR**.\n` +
        (mechanical
          ? mechanical.explained
            ? `↳ ⚠️ Do not read this as "Turbo compresses skill". Averaging nine neighbours on a bounded ladder produces ` +
              `**${mechanical.slope.toFixed(2)}** (${mechanical.lo.toFixed(2)}–${mechanical.hi.toFixed(2)}) with zero compression, and ` +
              `${fit.slope.toFixed(2)} is inside that. The slope is an instrument artefact.`
            : `↳ Beyond the artefact: the mechanical null predicts ${mechanical.slope.toFixed(2)} ` +
              `(${mechanical.lo.toFixed(2)}–${mechanical.hi.toFixed(2)}) and the observed ${fit.slope.toFixed(2)} falls outside it.`
          : fit.slopeHi < 1
            ? '↳ Below 1, but no mechanical null was run this time, so the cause is not established.'
            : '↳ The interval includes 1.');
      if (trimmedFit && outliers.length > 0) {
        fitNote += `\n↳ Without the ${outliers.length} outlier(s): slope **${trimmedFit.slope.toFixed(2)}**.`;
      }
    }

    const rangeLines: string[] = [
      `✅ **Measurable (Herald–Divine, n=${stats.n}):** mean |lean| **${Math.round(stats.mae)} ±${Math.round(stats.maeSE)} MMR**, ` +
      `median **${Math.round(stats.medianAbsGap)}** _(≈${(stats.medianAbsGap / MEDAL_SPAN_MMR).toFixed(1)} medal tiers)_.`,
    ];
    if (split) {
      rangeLines.push(
        `↳ Sampling noise accounts for only ~**${Math.round(split.samplingNoiseSD)} MMR** of that; the structural term is ` +
        `assumed at ±${STRUCTURAL_SD_MMR} MMR and the remainder is real lean.`,
      );
    }
    if (ceilingRows.length > 0) {
      const c = errorStats(ceilingRows.map(gapOf))!;
      rangeLines.push(
        `🧢 **Immortal (n=${c.n}) — held out of everything:** mean lean ${fmtMmr(c.meanGap)}. Turbo lobbies top out ~4–4.5k, ` +
        'so the estimator cannot measure this group at all. Not a finding about them.',
      );
    }

    const topTurbo = [...allRows]
      .sort((a, b) => b.estimate.estimatedMMR - a.estimate.estimatedMMR)
      .slice(0, 6)
      .map((r, i) => `${i + 1}. **${r.name}** — ${r.estimate.medal} _(~${r.estimate.estimatedMMR})_`);
    const topRanked = [...allRows]
      .sort((a, b) => b.visibleMMR - a.visibleMMR)
      .slice(0, 6)
      .map((r, i) => `${i + 1}. **${r.name}** — ${rankTierToMedal(r.visibleRankTier)} _(~${Math.round(r.visibleMMR)})_`);

    const prevSnap = previousSnapshot(scope);
    const trendLine =
      `MAE: **${Math.round(stats.mae)}**${trendArrow(stats.mae, prevSnap?.mae, stats.maeSE)}\n` +
      `RMSE: **${Math.round(stats.rmse)}**${trendArrow(stats.rmse, prevSnap?.rmse, stats.maeSE)}\n` +
      `|Avg gap|: **${Math.round(Math.abs(stats.meanGap))}**${trendArrow(Math.abs(stats.meanGap), prevSnap ? Math.abs(prevSnap.avgGap) : undefined, stats.maeSE)}` +
      (prevSnap && Math.abs(prevSnap.n - stats.n) > Math.max(2, stats.n * 0.15)
        ? `\n⚠️ Cohort changed size (${prevSnap.n} → ${stats.n}); the comparison is not like-for-like.`
        : '');
    saveStudySnapshot({
      ts: Date.now(), scope, n: stats.n, mae: stats.mae, maeSE: stats.maeSE,
      rmse: stats.rmse, avgGap: stats.meanGap, slope: fit?.slope ?? null, intercept: fit?.intercept ?? null,
    });

    const calibrationLine = calibration
      ? `${calibration.verdict}\n` +
        `Fit: Turbo ≈ ${calibration.slope.toFixed(2)} × Ranked ${calibration.intercept >= 0 ? '+' : '−'} ${Math.abs(Math.round(calibration.intercept))}\n` +
        `Raw MAE/RMSE **${Math.round(calibration.rawMAE)} / ${Math.round(calibration.rawRMSE)}** → ` +
        `leave-one-out corrected **${Math.round(calibration.looMAE)} / ${Math.round(calibration.looRMSE)}**\n` +
        '_Out-of-sample: the line is refitted without each player before predicting them._'
      : 'Not enough rows to test the correction out-of-sample.';

    // Immortals are drawn but never fitted; the line shown is the measurable-range fit.
    const scatter = renderTurboStudyScatter(
      allRows.map((r) => ({
        label: r.name,
        x: r.visibleMMR,
        y: r.estimate.estimatedMMR,
        confidence: r.estimate.confidence,
        sampleSize: r.estimate.soloSampleSize,
        partyFallback: r.estimate.partyFallback,
        stale: daysSince(r.estimate.lastUpdated) > 30,
        outlier: !isCeiling(r) && Math.abs(gapOf(r)) >= cut,
      })),
      {
        title: 'Hidden Turbo Rank vs Visible Ranked Medal',
        xLabel: 'Visible ranked medal estimate (MMR)',
        yLabel: 'Hidden Turbo estimate (MMR)',
        fit: fit ? { slope: fit.slope, intercept: fit.intercept } : undefined,
      },
    );
    const residual = renderTurboStudyResidual(
      allRows.map((r) => ({
        label: r.name,
        rankedMMR: r.visibleMMR,
        gap: gapOf(r),
        confidence: r.estimate.confidence,
        partyFallback: r.estimate.partyFallback,
        stale: daysSince(r.estimate.lastUpdated) > 30,
      })),
      fit ? { slope: fit.slope, intercept: fit.intercept } : null,
    );
    const scatterAttachment = new AttachmentBuilder(scatter, { name: 'turbo-study.png' });
    const residualAttachment = new AttachmentBuilder(residual, { name: 'turbo-bias.png' });
    const csvAttachment = new AttachmentBuilder(toCsv(candidates), { name: 'turbo-study.csv' });

    // ── Message 1: the finding ───────────────────────────────────────────────
    const title = crewOnly ? '📊 Turbo vs Ranked — Crew' : '📊 Turbo vs Ranked Skill';
    const description =
      (crewOnly ? 'Crew-only (discovered randoms excluded). ' : '') +
      `How much does ranked skill carry into Turbo? Measured on **${rows.length}** Herald–Divine players; ` +
      `${ceilingRows.length} Immortal(s) plotted but held out.`;

    const reliabilityLine = split
      ? `Sampling noise: **±${Math.round(split.samplingNoiseSD)} MMR** of a **±${Math.round(split.totalSD)} MMR** spread ` +
        `_(split-half ${split.samplingReliability.toFixed(3)}, n=${split.n} players)_\n` +
        'Each player is estimated twice from alternating halves of their own matches. Sampling error is negligible, ' +
        '**so more games will not improve any estimate.**\n' +
        '⚠️ _What this cannot see:_ the estimator reads your lobby average, and how far that sits from your real skill ' +
        'is constant within a player, so it cancels out of both halves. That term is assumed at ' +
        `±${STRUCTURAL_SD_MMR} MMR and is the widest source of doubt in this report.`
      : 'Not enough players with ≥4 matches on both sides of the split, so estimator noise and real Turbo-lean cannot be ' +
        'separated and every lean figure below is an upper bound.';

    const decompositionLine = decomposition && decompositionBest
      ? `Shared with ranked skill: **${Math.round(decomposition.sharedPct * 100)}–${Math.round(decompositionBest.sharedPct * 100)}%**\n` +
        `Turbo-specific: **${Math.round(decomposition.specificPct * 100)}–${Math.round(decompositionBest.specificPct * 100)}%** ` +
        `_(±${Math.round(decomposition.specificSD)}–${Math.round(decompositionBest.specificSD)} MMR)_\n` +
        `Instrument noise: **${Math.round(decompositionBest.noisePct * 100)}–${Math.round(decomposition.noisePct * 100)}%**\n` +
        `_Two ends of one assumption: the low-noise end trusts the lobby average as an unbiased readout of skill, the ` +
        `high-noise end charges the full ±${STRUCTURAL_SD_MMR} MMR structural term against it. Uses disattenuated ` +
        `r=${decomposition.rTrue.toFixed(2)}._`
      : 'Needs the reliability split above.';

    const findings = new EmbedBuilder()
      .setColor('#2563eb')
      .setTitle(title)
      .setDescription(description)
      .addFields(safeFields([
        {
          name: '🟢 In Plain English',
          value: plainEnglish({
            band: restrictedCorr ?? headlineCorr,
            trueCorr,
            populationCorr,
            decomposition,
            decompositionBest,
            split,
            res,
            predictive: predictiveBand ?? predictive,
            mechanical,
            ceilingCount: ceilingRows.length,
          }),
          inline: false,
        },
        {
          name: '🔬 Instrument reliability',
          value: reliabilityLine,
          inline: false,
        },
        {
          name: '🧬 What is Turbo skill made of?',
          value: decompositionLine,
          inline: false,
        },
        {
          name: 'Correlations _(r [95% interval] n)_',
          value:
            `Whole ladder: **${fmtCorr(headlineCorr)}**\n` +
            `Archon–Divine only: **${fmtCorr(restrictedCorr)}**\n` +
            (trueCorr
              ? `↳ corrected for measurement error: **${trueCorr.corrected.toFixed(2)}** ` +
                `_(${trueCorr.sensitivityLo.toFixed(2)}–${trueCorr.sensitivityHi.toFixed(2)} over plausible medal reliability)_\n`
              : '') +
            (populationCorr != null
              ? `↳ extrapolated to the player population: **~${populationCorr.toFixed(2)}** _(assumes SD ${POPULATION_RANKED_SD_MMR})_\n`
              : '') +
            `Rank-order/Spearman: **${fmtCorr(rankOrderCorr)}**\n` +
            `Quality rows only: **${fmtCorr(highQualityCorr)}**`,
          inline: false,
        },
        {
          name: '🎯 Can it separate two close players?',
          value:
            `Order correct, ≤1 medal apart: **${Math.round(res.nearPairsAccuracy * 100)}%** ` +
            `_(95% ${Math.round(res.nearLo * 100)}–${Math.round(res.nearHi * 100)}%, ${res.nearPairs} pairs from ${rows.length} players)_\n` +
            `Order correct, all pairs: **${Math.round(res.allPairsAccuracy * 100)}%** ` +
            `_(95% ${Math.round(res.allLo * 100)}–${Math.round(res.allHi * 100)}%)_\n` +
            '_Bootstrapped over players, not pairs — pairs from 48 players are not independent._',
          inline: false,
        },
        {
          name: '📐 Is the flat slope real?',
          value: fitNote,
          inline: false,
        },
        {
          name: '🔮 Predictive value',
          value: predictive
            ? `Knowing Turbo rank narrows a guess at ranked MMR from **±${Math.round(predictive.priorSD)}** to ` +
              `**±${Math.round(predictive.posteriorSD)} MMR** _(${Math.round(predictive.reductionPct * 100)}% cut, whole ladder)_\n` +
              (predictiveBand
                ? `Within Archon–Divine: **±${Math.round(predictiveBand.priorSD)}** → **±${Math.round(predictiveBand.posteriorSD)} MMR** ` +
                  `_(${Math.round(predictiveBand.reductionPct * 100)}% cut)_\n`
                : '') +
              `One player's 95% interval: **±${Math.round(predictive.interval95)} MMR** — cohort-level only, never an individual read.`
            : 'n/a',
          inline: false,
        },
        { name: 'Turbo-lean by measurable range', value: rangeLines.join('\n'), inline: false },
        { name: 'Turbo-lean by ranked bracket', value: bracketLines.join('\n'), inline: false },
        {
          name: '⚠️ What this cannot say',
          value:
            '**No causation.** Nothing here shows Turbo skill *causes* ranked skill or the reverse; general Dota ability drives both.\n' +
            '**No single "the" correlation.** It depends on the skill band, and always will.\n' +
            '**Nothing about Immortals**, who sit above the estimator\'s ceiling.\n' +
            'The cohort is a friend group plus their frequent teammates, so intervals assume an independence that does not hold, ' +
            'and the estimator was tuned on these same players.',
          inline: false,
        },
      ], title.length + description.length))
      .setImage('attachment://turbo-study.png')
      .setTimestamp();

    // ── Message 2: estimator diagnostics ─────────────────────────────────────
    const diagTitle = '🔧 Turbo Study — Estimator Diagnostics';
    const diagDescription = 'Health of the instrument behind the report above. Not findings about Dota.';
    const diagnostics = new EmbedBuilder()
      .setColor('#64748b')
      .setTitle(diagTitle)
      .setDescription(diagDescription)
      .addFields(safeFields([
        {
          name: 'Coverage',
          value:
            `Registered: **${registeredUsers.length}** | calibrated: **${candidates.length}** | in statistics: **${rows.length}**\n` +
            `Missing visible ranked medal: **${missingVisible.length}** | registered uncalibrated: **${uncalibratedRegistered.length}**`,
          inline: false,
        },
        { name: '🏆 Top Turbo (estimated)', value: fitLines(topTurbo, '—'), inline: true },
        { name: '🎖️ Top Ranked (visible MMR)', value: fitLines(topRanked, '—'), inline: true },
        { name: 'Estimator Health', value: healthLines.join('\n'), inline: false },
        { name: 'Should we apply the bias correction?', value: calibrationLine, inline: false },
        { name: 'Experimental Estimator V2', value: experimentalStudyLine, inline: false },
        { name: 'Experimental V2 Movers', value: experimentalMoversLine, inline: false },
        { name: 'Largest Turbo-lean', value: fitLines(largestGaps, 'None found.'), inline: false },
        { name: 'Lean Extremes', value: extremesLine, inline: true },
        { name: 'Trend vs Last Run', value: trendLine, inline: true },
        { name: 'Turbo score vs Turbo rank', value: fmtCorr(scoreCorr), inline: false },
        { name: 'Inverse-variance weighted r', value: fmtCorr(weightedCorr), inline: false },
        { name: 'Next Actions', value: fitLines(actionLines, 'No immediate study actions.'), inline: false },
      ], diagTitle.length + diagDescription.length))
      .setImage('attachment://turbo-bias.png')
      .setTimestamp();

    // Two messages, because Discord's 6000-character ceiling applies to the whole
    // message, not per embed. The findings land first and stand alone; if the
    // diagnostics follow-up fails the report is still complete.
    await progress.edit({ content: null, embeds: [findings], files: [scatterAttachment, csvAttachment] });
    if (message.channel.isSendable()) {
      await message.channel.send({ embeds: [diagnostics], files: [residualAttachment] });
    }
  } catch (error) {
    logger.error('Error in turbo study command:', error);
    await message.reply('An error occurred while building the Turbo study. Please try again later.');
  }
}
