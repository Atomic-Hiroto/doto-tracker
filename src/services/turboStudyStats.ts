/**
 * Statistics primitives for the Turbo studies.
 *
 * Split out of turboStudy.ts after a full audit of the study's numbers found that
 * every headline figure was reported bare — no n, no interval, no robustness check —
 * and several were computed in ways that made them look better than they were.
 * Anything that produces a number a human will read as a fact lives here, and it
 * returns its own uncertainty alongside the point estimate so the caller cannot
 * print one without the other.
 */

export interface Point { x: number; y: number }
export interface WeightedPoint extends Point { w: number }

export const mean = (values: number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Sample standard deviation (n-1). Null below 2 points. */
export function sd(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

/** Median absolute deviation, scaled to be a consistent estimator of σ for normal data. */
export function madSigma(values: number[]): number | null {
  const med = median(values);
  if (med == null) return null;
  const dev = median(values.map((value) => Math.abs(value - med)));
  return dev == null ? null : 1.4826 * dev;
}

/**
 * Robust outlier cut: median + 3σ̂ where σ̂ comes from the MAD.
 *
 * The study used to hardcode "|gap| >= 900 MMR is an outlier", which on the live
 * cohort flagged 20% of rows — a threshold *below* one RMSE, so it was labelling
 * ordinary points as anomalies. Deriving the cut from the data keeps the label
 * meaning "unlike the rest of this cohort" no matter how the cohort's spread moves.
 */
export function outlierCut(values: number[], floor = 900): number {
  const med = median(values);
  const sigma = madSigma(values);
  if (med == null || sigma == null || sigma === 0) return floor;
  return Math.max(floor, med + 3 * sigma);
}

// ── Correlation ──────────────────────────────────────────────────────────────

export interface Correlation {
  r: number;
  n: number;
  /** Fisher-z 95% interval. Assumes independent rows; see the study's caveats field. */
  lo: number;
  hi: number;
  /** True when the interval straddles 0, i.e. the sign of the effect is not established. */
  spansZero: boolean;
}

/**
 * Pearson r with a Fisher-z 95% interval.
 *
 * Minimum n is 8, not 3. At n=3 an r of 0.99 is unremarkable under the null, and the
 * old 3-point floor let `+turbostudy` print "strong correlation" off three players.
 */
export function pearson(points: Point[], minN = 8): Correlation | null {
  const usable = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const n = usable.length;
  if (n < minN) return null;

  const xMean = mean(usable.map((p) => p.x));
  const yMean = mean(usable.map((p) => p.y));
  let cov = 0;
  let xVar = 0;
  let yVar = 0;
  for (const p of usable) {
    const dx = p.x - xMean;
    const dy = p.y - yMean;
    cov += dx * dy;
    xVar += dx * dx;
    yVar += dy * dy;
  }
  const denom = Math.sqrt(xVar * yVar);
  if (denom === 0) return null;

  const r = Math.max(-0.999999, Math.min(0.999999, cov / denom));
  const z = 0.5 * Math.log((1 + r) / (1 - r));
  const se = 1 / Math.sqrt(n - 3);
  const lo = Math.tanh(z - 1.96 * se);
  const hi = Math.tanh(z + 1.96 * se);
  return { r, n, lo, hi, spansZero: lo <= 0 && hi >= 0 };
}

/**
 * Inverse-variance weighted Pearson.
 *
 * The old version weighted by `effectiveSample × (confidence/100)`. Because
 * confidence *is* effectiveSample × 8 (capped at 100), that made the weight
 * ≈ 0.08 × effectiveSample² for every row below the cap — the sample size entered
 * twice. Correct weighting for points of differing precision is 1/σ², which is what
 * callers now pass in.
 */
export function weightedPearson(points: WeightedPoint[], minN = 8): Correlation | null {
  const usable = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.w > 0);
  const n = usable.length;
  if (n < minN) return null;

  const wSum = usable.reduce((sum, p) => sum + p.w, 0);
  if (wSum === 0) return null;
  const xMean = usable.reduce((sum, p) => sum + p.x * p.w, 0) / wSum;
  const yMean = usable.reduce((sum, p) => sum + p.y * p.w, 0) / wSum;

  let cov = 0;
  let xVar = 0;
  let yVar = 0;
  for (const p of usable) {
    const dx = p.x - xMean;
    const dy = p.y - yMean;
    cov += p.w * dx * dy;
    xVar += p.w * dx * dx;
    yVar += p.w * dy * dy;
  }
  const denom = Math.sqrt(xVar * yVar);
  if (denom === 0) return null;

  const r = Math.max(-0.999999, Math.min(0.999999, cov / denom));
  // Kish effective sample size: weighting buys precision but not degrees of freedom,
  // so the interval widens to reflect how concentrated the weights actually are.
  const wSq = usable.reduce((sum, p) => sum + p.w * p.w, 0);
  const nEff = Math.max(4, (wSum * wSum) / wSq);
  const z = 0.5 * Math.log((1 + r) / (1 - r));
  const se = 1 / Math.sqrt(nEff - 3);
  const lo = Math.tanh(z - 1.96 * se);
  const hi = Math.tanh(z + 1.96 * se);
  return { r, n, lo, hi, spansZero: lo <= 0 && hi >= 0 };
}

function ranks(values: number[]): number[] {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = new Array<number>(values.length);
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].value === sorted[i].value) j++;
    const rank = (i + j + 1) / 2;
    for (let k = i; k < j; k++) result[sorted[k].index] = rank;
    i = j;
  }
  return result;
}

export function spearman(points: Point[], minN = 8): Correlation | null {
  const usable = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (usable.length < minN) return null;
  const xr = ranks(usable.map((p) => p.x));
  const yr = ranks(usable.map((p) => p.y));
  return pearson(xr.map((rank, i) => ({ x: rank, y: yr[i] })), minN);
}

// ── Regression ───────────────────────────────────────────────────────────────

export interface Fit {
  slope: number;
  intercept: number;
  r2: number;
  n: number;
  /** Standard error of the slope; the "is it really below 1?" test needs this. */
  slopeSE: number;
  /** SD of the residuals about the line — the spread the model does not explain. */
  residualSD: number;
  slopeLo: number;
  slopeHi: number;
}

export function linearFit(points: Point[], minN = 8): Fit | null {
  const usable = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const n = usable.length;
  if (n < minN) return null;

  const xMean = mean(usable.map((p) => p.x));
  const yMean = mean(usable.map((p) => p.y));
  let num = 0;
  let den = 0;
  for (const p of usable) {
    num += (p.x - xMean) * (p.y - yMean);
    den += (p.x - xMean) ** 2;
  }
  if (den === 0) return null;

  const slope = num / den;
  const intercept = yMean - slope * xMean;
  const residuals = usable.map((p) => p.y - (slope * p.x + intercept));
  const s2 = residuals.reduce((sum, e) => sum + e * e, 0) / Math.max(1, n - 2);
  const slopeSE = Math.sqrt(s2 / den);
  const corr = pearson(usable, minN);
  return {
    slope,
    intercept,
    r2: corr ? corr.r * corr.r : 0,
    n,
    slopeSE,
    residualSD: Math.sqrt(s2),
    slopeLo: slope - 1.96 * slopeSE,
    slopeHi: slope + 1.96 * slopeSE,
  };
}

// ── Error metrics ────────────────────────────────────────────────────────────

export interface ErrorStats {
  n: number;
  mae: number;
  /** SE of the MAE. Any run-to-run move smaller than this is noise. */
  maeSE: number;
  rmse: number;
  medianGap: number;
  medianAbsGap: number;
  meanGap: number;
  /** 95% interval on the *mean* gap — tells you whether a bracket's bias is real. */
  meanGapLo: number;
  meanGapHi: number;
}

export function errorStats(gaps: number[]): ErrorStats | null {
  const n = gaps.length;
  if (n === 0) return null;
  const abs = gaps.map(Math.abs);
  const mae = mean(abs);
  const absSD = sd(abs) ?? 0;
  const gapSD = sd(gaps) ?? 0;
  const meanGap = mean(gaps);
  const gapSE = gapSD / Math.sqrt(n);
  return {
    n,
    mae,
    maeSE: absSD / Math.sqrt(n),
    rmse: Math.sqrt(mean(gaps.map((g) => g * g))),
    medianGap: median(gaps) ?? 0,
    medianAbsGap: median(abs) ?? 0,
    meanGap,
    meanGapLo: meanGap - 1.96 * gapSE,
    meanGapHi: meanGap + 1.96 * gapSE,
  };
}

// ── Out-of-sample calibration check ──────────────────────────────────────────

export interface CalibrationCheck {
  n: number;
  slope: number;
  intercept: number;
  /** MAE of the raw estimate against the reference axis. */
  rawMAE: number;
  rawRMSE: number;
  /** MAE after inverting the fit, refitted without each held-out row. */
  looMAE: number;
  looRMSE: number;
  /** looMAE - rawMAE, with a paired SE. Negative means the correction helps. */
  delta: number;
  deltaSE: number;
  promote: boolean;
  verdict: string;
}

/**
 * Leave-one-out test of "should the estimator apply the calibration the study prints?"
 *
 * Every run of `+turbostudy` computes a slope and intercept describing a clean,
 * monotone bias (low ranks over-estimated, high ranks under-estimated) and then does
 * nothing with them. The obvious next step is to invert the line — but inverting a
 * slope of ~0.72 multiplies every residual by 1/0.72, so it trades a smaller average
 * error for a fatter tail. Whether that is a win is an empirical question, and it has
 * to be answered out-of-sample: refitting on all n rows and scoring the same n rows
 * would grade the correction on its own training data.
 */
export function calibrationCheck(points: Point[], minN = 12): CalibrationCheck | null {
  const usable = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const n = usable.length;
  if (n < minN) return null;

  const full = linearFit(usable, minN);
  if (!full || full.slope <= 0.05) return null;

  const rawErrors = usable.map((p) => p.y - p.x);
  const looErrors = usable.map((_, i) => {
    const rest = usable.filter((__, j) => j !== i);
    const fit = linearFit(rest, 4);
    if (!fit || fit.slope <= 0.05) return usable[i].y - usable[i].x;
    return (usable[i].y - fit.intercept) / fit.slope - usable[i].x;
  });

  const rawAbs = rawErrors.map(Math.abs);
  const looAbs = looErrors.map(Math.abs);
  const rawMAE = mean(rawAbs);
  const looMAE = mean(looAbs);
  const paired = looAbs.map((v, i) => v - rawAbs[i]);
  const deltaSE = (sd(paired) ?? 0) / Math.sqrt(n);
  const delta = mean(paired);

  // Promote only when the improvement clears its own paired standard error and the
  // tail does not get worse: a correction that halves the median error while doubling
  // the worst case is not an improvement to a rank shown to a human.
  const rawRMSE = Math.sqrt(mean(rawErrors.map((e) => e * e)));
  const looRMSE = Math.sqrt(mean(looErrors.map((e) => e * e)));
  const promote = delta < -1.96 * deltaSE && looRMSE <= rawRMSE;

  const verdict = promote
    ? `✅ Out-of-sample MAE improves by ${Math.abs(Math.round(delta))} ±${Math.round(deltaSE)} MMR and RMSE does not regress — worth promoting into the estimator.`
    : delta < 0 && looRMSE > rawRMSE
      ? `⚪ Rejected: MAE improves by ${Math.abs(Math.round(delta))} ±${Math.round(deltaSE)} MMR but RMSE worsens ${Math.round(rawRMSE)} → ${Math.round(looRMSE)}. Inverting a ${full.slope.toFixed(2)} slope amplifies every residual by ${(1 / full.slope).toFixed(2)}×, so the tail pays for the average.`
      : delta >= 0
        ? `⚪ Rejected: out-of-sample MAE gets *worse* by ${Math.round(delta)} ±${Math.round(deltaSE)} MMR. The bias line is fitted to noise at this n.`
        : `⚪ Rejected: MAE change ${Math.round(delta)} ±${Math.round(deltaSE)} MMR does not clear its own standard error.`;

  return {
    n,
    slope: full.slope,
    intercept: full.intercept,
    rawMAE,
    rawRMSE,
    looMAE,
    looRMSE,
    delta,
    deltaSE,
    promote,
    verdict,
  };
}

// ── Paired model comparison ──────────────────────────────────────────────────

export interface PairedComparison {
  n: number;
  baselineMAE: number;
  challengerMAE: number;
  delta: number;
  deltaSE: number;
  lo: number;
  hi: number;
  significant: boolean;
}

/**
 * Compare two estimators on the *same* rows.
 *
 * The old V2 verdict compared V2's MAE over the rows that had a V2 estimate against
 * V1's MAE over *all* rows, and called any move of 25 MMR "material". Two different
 * denominators, and a fixed threshold that has no relationship to the spread of the
 * data. Both estimators see identical inputs here, so this is a paired difference.
 */
export function pairedMAEComparison(baseline: number[], challenger: number[]): PairedComparison | null {
  if (baseline.length !== challenger.length || baseline.length < 8) return null;
  const b = baseline.map(Math.abs);
  const c = challenger.map(Math.abs);
  const diff = c.map((v, i) => v - b[i]);
  const delta = mean(diff);
  const deltaSE = (sd(diff) ?? 0) / Math.sqrt(diff.length);
  return {
    n: diff.length,
    baselineMAE: mean(b),
    challengerMAE: mean(c),
    delta,
    deltaSE,
    lo: delta - 1.96 * deltaSE,
    hi: delta + 1.96 * deltaSE,
    significant: Math.abs(delta) > 1.96 * deltaSE,
  };
}

// ── Resolution ───────────────────────────────────────────────────────────────

export interface Resolution {
  /** Fraction of comparable pairs the estimate orders the same way as the reference. */
  allPairsAccuracy: number;
  allPairs: number;
  /** Same, restricted to pairs whose true gap is under `nearBand`. The honest test. */
  nearPairsAccuracy: number;
  nearPairs: number;
}

/**
 * How finely can the estimate actually discriminate?
 *
 * A correlation computed over a cohort spanning Herald to Immortal mostly measures
 * whether the estimator can tell those two apart. Pair-ordering accuracy restricted to
 * players who are genuinely close is the question a reader actually cares about —
 * "can it rank me against someone one medal away?" — and 50% is a coin flip.
 */
export function resolution(points: Point[], nearBand: number): Resolution {
  let all = 0;
  let allOk = 0;
  let near = 0;
  let nearOk = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[i].x - points[j].x;
      const dy = points[i].y - points[j].y;
      if (dx === 0) continue;
      all++;
      const agree = Math.sign(dx) === Math.sign(dy);
      if (agree) allOk++;
      if (Math.abs(dx) <= nearBand) {
        near++;
        if (agree) nearOk++;
      }
    }
  }
  return {
    allPairsAccuracy: all ? allOk / all : 0,
    allPairs: all,
    nearPairsAccuracy: near ? nearOk / near : 0,
    nearPairs: near,
  };
}

// ── Formatting ───────────────────────────────────────────────────────────────

/**
 * Render a correlation with its n and interval, and refuse to attach a strength
 * adjective when the interval is too wide to support one. The old `fmtCorr` printed
 * "0.34 (weak)" and "0.90 (strong)" in the same voice, with no n and no interval.
 */
export function fmtCorr(c: Correlation | null): string {
  if (c == null) return 'n/a _(too few rows)_';
  const width = c.hi - c.lo;
  const label = c.spansZero
    ? 'not distinguishable from zero'
    : width > 0.5
      ? 'direction only — interval too wide to grade'
      : Math.abs(c.r) >= 0.8 ? 'strong'
        : Math.abs(c.r) >= 0.5 ? 'moderate'
          : Math.abs(c.r) >= 0.25 ? 'weak'
            : 'very weak';
  return `${c.r.toFixed(2)} [${c.lo.toFixed(2)}, ${c.hi.toFixed(2)}] n=${c.n} _(${label})_`;
}
