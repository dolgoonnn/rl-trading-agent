/**
 * Deflated Sharpe Ratio (DSR)
 *
 * Adjusts Sharpe Ratio for selection bias when testing multiple strategies/models.
 * When running N trials and selecting the best, the observed Sharpe is inflated.
 *
 * Formula: DSR = SR - haircut
 * Where haircut = sqrt(Var[SR] * 2 * ln(N))
 *
 * Reference: Bailey & de Prado (2014) "The Deflated Sharpe Ratio"
 * https://arxiv.org/abs/1405.4981
 */

export interface SharpeTrialResult {
  /** Sharpe ratio from the trial */
  sharpe: number;
  /** Number of trades (for estimating variance) */
  trades: number;
  /** Standard deviation of returns (optional, for better variance estimate) */
  returnStd?: number;
  /** Skewness of returns (optional) */
  skewness?: number;
  /** Kurtosis of returns (optional) */
  kurtosis?: number;
}

export interface DeflatedSharpeResult {
  /** Original Sharpe ratio */
  originalSharpe: number;
  /** Deflated Sharpe ratio accounting for selection bias */
  deflatedSharpe: number;
  /** Haircut applied to the original Sharpe */
  haircut: number;
  /** Estimated variance of Sharpe ratio */
  sharpeVariance: number;
  /** Number of trials used for deflation */
  numTrials: number;
  /** Whether the deflated Sharpe is still positive (meaningful) */
  isSignificant: boolean;
}

/**
 * Calculate the variance of the Sharpe ratio estimator
 *
 * Using the formula from Lo (2002):
 * Var(SR) ≈ (1 + 0.5 * SR^2 - γ3 * SR + (γ4 - 1)/4 * SR^2) / T
 *
 * Where:
 * - T is the number of observations (trades)
 * - γ3 is skewness (0 for normal)
 * - γ4 is kurtosis (3 for normal)
 *
 * Simplified when skewness/kurtosis unknown: Var(SR) ≈ (1 + 0.5 * SR^2) / T
 */
export function estimateSharpeVariance(
  sharpe: number,
  numObservations: number,
  skewness: number = 0,
  kurtosis: number = 3
): number {
  if (numObservations <= 1) return Infinity;

  // Full formula with skewness and kurtosis
  const sr2 = sharpe * sharpe;
  const variance =
    (1 + 0.5 * sr2 - skewness * sharpe + ((kurtosis - 1) / 4) * sr2) /
    numObservations;

  return Math.max(0.0001, variance); // Ensure positive
}

/**
 * Calculate the haircut for multiple testing correction
 *
 * Using the formula: haircut = sqrt(Var[SR] * 2 * ln(N))
 *
 * This accounts for the "winner's curse" when selecting the best
 * result from N independent trials.
 */
export function calculateHaircut(
  sharpeVariance: number,
  numTrials: number
): number {
  if (numTrials <= 1) return 0;

  return Math.sqrt(sharpeVariance * 2 * Math.log(numTrials));
}

/**
 * Calculate Deflated Sharpe Ratio for a single trial
 *
 * @param sharpe - Observed Sharpe ratio
 * @param numTrades - Number of trades (for variance estimation)
 * @param numTrials - Total number of trials/experiments conducted
 * @param options - Optional parameters for better variance estimation
 */
export function calculateDeflatedSharpe(
  sharpe: number,
  numTrades: number,
  numTrials: number,
  options: {
    skewness?: number;
    kurtosis?: number;
  } = {}
): DeflatedSharpeResult {
  const { skewness = 0, kurtosis = 3 } = options;

  // Estimate variance of the Sharpe ratio
  const sharpeVariance = estimateSharpeVariance(
    sharpe,
    numTrades,
    skewness,
    kurtosis
  );

  // Calculate haircut
  const haircut = calculateHaircut(sharpeVariance, numTrials);

  // Deflated Sharpe
  const deflatedSharpe = sharpe - haircut;

  return {
    originalSharpe: sharpe,
    deflatedSharpe,
    haircut,
    sharpeVariance,
    numTrials,
    isSignificant: deflatedSharpe > 0,
  };
}

/**
 * Calculate Deflated Sharpe Ratio for a set of trial results
 *
 * Uses the best Sharpe from all trials and applies appropriate correction
 *
 * @param trials - Array of trial results
 */
export function calculateDeflatedSharpeFromTrials(
  trials: SharpeTrialResult[]
): DeflatedSharpeResult {
  if (trials.length === 0) {
    throw new Error('At least one trial result is required');
  }

  // Find the best trial
  const bestTrial = trials.reduce((best, current) =>
    current.sharpe > best.sharpe ? current : best
  );

  return calculateDeflatedSharpe(
    bestTrial.sharpe,
    bestTrial.trades,
    trials.length,
    {
      skewness: bestTrial.skewness,
      kurtosis: bestTrial.kurtosis,
    }
  );
}

/**
 * Rank models by deflated Sharpe ratio
 *
 * This accounts for the fact that models tested earlier have
 * less selection bias than models tested later.
 *
 * @param trials - Array of trial results in chronological order
 * @returns Trials with their deflated Sharpe ratios, sorted by DSR
 */
export function rankModelsByDeflatedSharpe(
  trials: Array<SharpeTrialResult & { modelId: string }>
): Array<{
  modelId: string;
  originalSharpe: number;
  deflatedSharpe: number;
  rank: number;
}> {
  const results = trials.map((trial, index) => {
    // Each model is evaluated against all trials up to and including this one
    const trialsUpToNow = index + 1;
    const dsr = calculateDeflatedSharpe(
      trial.sharpe,
      trial.trades,
      trialsUpToNow,
      {
        skewness: trial.skewness,
        kurtosis: trial.kurtosis,
      }
    );

    return {
      modelId: trial.modelId,
      originalSharpe: trial.sharpe,
      deflatedSharpe: dsr.deflatedSharpe,
      rank: 0, // Will be set after sorting
    };
  });

  // Sort by deflated Sharpe (descending)
  results.sort((a, b) => b.deflatedSharpe - a.deflatedSharpe);

  // Assign ranks
  results.forEach((r, i) => {
    r.rank = i + 1;
  });

  return results;
}

/**
 * Minimum Track Record Length (MinTRL) — Bailey & de Prado (2012/2014).
 *
 * The minimum number of observations `n` required for an observed Sharpe ratio
 * `SR` to be statistically distinguishable (at the given confidence) from a
 * benchmark Sharpe `SR*`. Below `n`, the Sharpe estimate is too noisy to act
 * on — in the kill-switch this gates the DSR layer so it may only DE-RISK (never
 * HARD-halt) until enough live observations have accumulated.
 *
 * Formula (non-normal returns, per-observation Sharpe):
 *   MinTRL = 1 + (1 - γ3·SR + (γ4−1)/4·SR²) · ( Z_conf / (SR − SR*) )²
 * where γ3 = skewness, γ4 = kurtosis, Z_conf is the one-sided normal quantile.
 *
 * The `(SR − SR*)²` denominator means a tiny edge over the benchmark needs a
 * LONG track record; a large edge needs a short one. Returns a positive integer
 * (ceil). When `SR <= SR*` the edge is non-positive and no finite track record
 * makes it significant — we return Infinity.
 *
 * Reference: Bailey & de Prado (2012) "The Sharpe Ratio Efficient Frontier",
 * Journal of Risk. https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1821643
 */
export function minTrackRecordLength(args: {
  /** Observed (per-observation) Sharpe ratio. */
  sharpe: number;
  /** Benchmark Sharpe to beat (SR*). Default 0 (beat the risk-free baseline). */
  targetSharpe?: number;
  /** Skewness of returns (0 = normal). */
  skewness?: number;
  /** Kurtosis of returns (3 = normal). */
  kurtosis?: number;
  /** Confidence level for the one-sided test (default 0.95). */
  confidenceLevel?: number;
}): number {
  const {
    sharpe,
    targetSharpe = 0,
    skewness = 0,
    kurtosis = 3,
    confidenceLevel = 0.95,
  } = args;

  const edge = sharpe - targetSharpe;
  if (edge <= 0) return Infinity; // no positive edge over benchmark → never significant

  const z = normalQuantile(confidenceLevel);
  const variancePrefactor =
    1 - skewness * sharpe + ((kurtosis - 1) / 4) * sharpe * sharpe;
  // Guard against a degenerate (negative) prefactor from extreme moments.
  const safePrefactor = Math.max(0, variancePrefactor);

  const minTrl = 1 + safePrefactor * (z / edge) ** 2;
  return Math.ceil(minTrl);
}

/**
 * One-sided standard-normal quantile (inverse CDF) via the Acklam/Beasley-Springer
 * rational approximation. Accurate to ~1e-9 over (0,1) — ample for MinTRL gating.
 */
function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) {
    throw new Error(`normalQuantile: p must be in (0,1), got ${p}`);
  }
  // Coefficients (Acklam, 2003).
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  let q: number;
  let r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (
      ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
    );
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
}

/**
 * Probabilistic Sharpe Ratio (PSR) — Bailey & de Prado.
 *
 * P(true Sharpe > benchmark) given the observed Sharpe, sample size, and the
 * return moments. Used by the kill-switch DSR layer: a PSR below the configured
 * threshold (e.g. 0.95) vs the benchmark `targetSharpe = c` means the observed
 * edge is NOT conclusively above the floor.
 *
 *   PSR = Φ( (SR − SR*)·√(n−1) / √(1 − γ3·SR + (γ4−1)/4·SR²) )
 */
export function probabilisticSharpeRatio(args: {
  sharpe: number;
  numObservations: number;
  targetSharpe?: number;
  skewness?: number;
  kurtosis?: number;
}): number {
  const {
    sharpe,
    numObservations,
    targetSharpe = 0,
    skewness = 0,
    kurtosis = 3,
  } = args;
  if (numObservations <= 1) return 0;

  const denom = Math.sqrt(
    Math.max(1e-12, 1 - skewness * sharpe + ((kurtosis - 1) / 4) * sharpe * sharpe),
  );
  const stat = ((sharpe - targetSharpe) * Math.sqrt(numObservations - 1)) / denom;
  return standardNormalCdf(stat);
}

/** Standard-normal CDF via erf (Abramowitz & Stegun 7.1.26). */
function standardNormalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/**
 * Calculate the minimum Sharpe ratio needed to be significant
 * given the number of trials already conducted
 *
 * @param numTrials - Number of trials/experiments conducted
 * @param expectedTrades - Expected number of trades
 * @param confidenceLevel - Desired confidence level (default 0.95)
 */
export function getMinSignificantSharpe(
  numTrials: number,
  expectedTrades: number,
  confidenceLevel: number = 0.95
): number {
  // Start with SR = 0 and find where DSR would be positive
  // This is an approximation using the simplified variance formula

  // For DSR > 0, we need: SR > sqrt(Var[SR] * 2 * ln(N))
  // With Var[SR] ≈ (1 + 0.5 * SR^2) / T

  // Solving iteratively
  let sr = 0.5; // Initial guess
  for (let i = 0; i < 100; i++) {
    const variance = (1 + 0.5 * sr * sr) / expectedTrades;
    const required = Math.sqrt(variance * 2 * Math.log(numTrials));
    sr = required * 1.1; // Add 10% buffer

    if (Math.abs(sr - required) < 0.01) break;
  }

  return sr;
}
