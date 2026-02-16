/**
 * Monte Carlo Simulation Utilities
 *
 * Provides statistical validation of trading strategy robustness through:
 * - Trade reshuffling (tests serial correlation dependency)
 * - Bootstrap sampling (confidence intervals)
 * - Trade skipping (simulates missed fills/latency)
 * - Parameter perturbation (tests parameter stability)
 *
 * Reference: Ernest Chan "Quantitative Trading", Lopez de Prado "Advances in Financial ML"
 */

/** Trade result with pnlPercent field (compatible with walk-forward TradeResult) */
export interface MCTradeResult {
  pnlPercent: number;
}

// ============================================
// Types
// ============================================

export interface MCDistribution {
  values: number[];
  mean: number;
  std: number;
  median: number;
  p5: number;
  p25: number;
  p75: number;
  p95: number;
  min: number;
  max: number;
}

export interface MCStatistics {
  /** Z-score: (real - mcMean) / mcStd */
  zScore: number;
  /** Fraction of MC iterations where metric >= real (lower = more significant) */
  pValue: number;
  /** real / mcMedian (> 1 means real outperforms MC median) */
  persistenceRatio: number;
  /** MC distribution summary */
  distribution: MCDistribution;
  /** Whether result is statistically significant (p < 0.05) */
  isSignificant: boolean;
}

export interface ReshuffleResult {
  sharpe: MCStatistics;
  maxDrawdown: MCStatistics;
  finalPnl: MCStatistics;
}

export interface BootstrapResult {
  sharpe: MCDistribution;
  maxDrawdown: MCDistribution;
  finalPnl: MCDistribution;
  winRate: MCDistribution;
}

export interface SkipTradesResult {
  skipRate: number;
  sharpe: MCDistribution;
  finalPnl: MCDistribution;
  /** Fraction of iterations that remained profitable */
  profitableFraction: number;
}

export interface PerturbationResult {
  /** Distribution of WF pass rates under parameter noise */
  passRates: MCDistribution;
  /** Distribution of total PnL under parameter noise */
  pnls: MCDistribution;
  /** Fragility score: fraction of perturbations that dropped pass rate > 5pp */
  fragilityScore: number;
}

// ============================================
// Core Metric Calculations
// ============================================

const DEFAULT_ANNUALIZATION_FACTOR = Math.sqrt(365 * 24); // 24/7 crypto markets

function calcSharpe(returns: number[], annualizationFactor: number = DEFAULT_ANNUALIZATION_FACTOR): number {
  if (returns.length < 2) {
    if (returns.length === 1 && returns[0]! > 0) return 0.01;
    return 0;
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * annualizationFactor;
}

function calcMaxDrawdown(returns: number[]): number {
  if (returns.length === 0) return 0;
  let equity = 1.0;
  let peak = 1.0;
  let maxDD = 0;
  for (const r of returns) {
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function calcFinalPnl(returns: number[]): number {
  if (returns.length === 0) return 0;
  let equity = 1.0;
  for (const r of returns) {
    equity *= 1 + r;
  }
  return equity - 1;
}

function calcWinRate(returns: number[]): number {
  if (returns.length === 0) return 0;
  const wins = returns.filter((r) => r > 0).length;
  return wins / returns.length;
}

// ============================================
// Distribution Helpers
// ============================================

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

function buildDistribution(values: number[]): MCDistribution {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return {
    values,
    mean,
    std: Math.sqrt(variance),
    median: percentile(sorted, 50),
    p5: percentile(sorted, 5),
    p25: percentile(sorted, 25),
    p75: percentile(sorted, 75),
    p95: percentile(sorted, 95),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

// ============================================
// Fisher-Yates Shuffle
// ============================================

function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

// ============================================
// Monte Carlo Simulations
// ============================================

/**
 * Reshuffle trade order randomly and rebuild equity curve.
 * Tests if the edge depends on trade ordering (serial correlation).
 * If real Sharpe >> shuffled Sharpe, the strategy benefits from specific sequencing.
 */
export function reshuffleTrades(
  trades: MCTradeResult[],
  iterations: number,
  annualizationFactor?: number
): ReshuffleResult {
  const realReturns = trades.map((t) => t.pnlPercent);
  const realSharpe = calcSharpe(realReturns, annualizationFactor);
  const realMaxDD = calcMaxDrawdown(realReturns);
  const realPnl = calcFinalPnl(realReturns);

  const sharpes: number[] = [];
  const maxDDs: number[] = [];
  const pnls: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const shuffled = shuffleArray(realReturns);
    sharpes.push(calcSharpe(shuffled, annualizationFactor));
    maxDDs.push(calcMaxDrawdown(shuffled));
    pnls.push(calcFinalPnl(shuffled));
  }

  return {
    sharpe: computeMCStatistics(realSharpe, sharpes),
    maxDrawdown: computeMCStatistics(realMaxDD, maxDDs),
    finalPnl: computeMCStatistics(realPnl, pnls),
  };
}

/**
 * Bootstrap: sample trades with replacement and compute metrics.
 * Provides confidence intervals for expected performance.
 */
export function bootstrapTrades(
  trades: MCTradeResult[],
  iterations: number,
  sampleSize?: number,
  annualizationFactor?: number
): BootstrapResult {
  const returns = trades.map((t) => t.pnlPercent);
  const n = sampleSize ?? returns.length;

  const sharpes: number[] = [];
  const maxDDs: number[] = [];
  const pnls: number[] = [];
  const winRates: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const sample: number[] = [];
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(Math.random() * returns.length);
      sample.push(returns[idx]!);
    }
    sharpes.push(calcSharpe(sample, annualizationFactor));
    maxDDs.push(calcMaxDrawdown(sample));
    pnls.push(calcFinalPnl(sample));
    winRates.push(calcWinRate(sample));
  }

  return {
    sharpe: buildDistribution(sharpes),
    maxDrawdown: buildDistribution(maxDDs),
    finalPnl: buildDistribution(pnls),
    winRate: buildDistribution(winRates),
  };
}

/**
 * Randomly skip a percentage of trades to simulate missed fills, latency, connectivity.
 * Tests how robust the edge is when execution is imperfect.
 */
export function skipTrades(
  trades: MCTradeResult[],
  skipRate: number,
  iterations: number,
  annualizationFactor?: number
): SkipTradesResult {
  const returns = trades.map((t) => t.pnlPercent);
  const keepRate = 1 - skipRate;

  const sharpes: number[] = [];
  const pnls: number[] = [];
  let profitable = 0;

  for (let i = 0; i < iterations; i++) {
    const kept = returns.filter(() => Math.random() < keepRate);
    if (kept.length === 0) {
      sharpes.push(0);
      pnls.push(0);
      continue;
    }
    sharpes.push(calcSharpe(kept, annualizationFactor));
    const pnl = calcFinalPnl(kept);
    pnls.push(pnl);
    if (pnl > 0) profitable++;
  }

  return {
    skipRate,
    sharpe: buildDistribution(sharpes),
    finalPnl: buildDistribution(pnls),
    profitableFraction: profitable / iterations,
  };
}

/**
 * Jitter all CMA-ES parameters by gaussian noise and run full WF evaluation.
 * Tests parameter stability (joint perturbation, different from 1-at-a-time sensitivity).
 *
 * @param baseParams - Raw CMA-ES parameter vector (23 dims)
 * @param specs - Parameter spec names (for decoding)
 * @param sigma - Noise level as fraction (e.g., 0.05 = 5% jitter)
 * @param iterations - Number of perturbations to test
 * @param evaluator - Callback that runs full WF and returns metrics
 */
export async function perturbParameters(
  baseParams: number[],
  _specs: string[],
  sigma: number,
  iterations: number,
  evaluator: (params: number[]) => Promise<{ passRate: number; pnl: number; trades: number }>
): Promise<PerturbationResult> {
  const passRates: number[] = [];
  const pnls: number[] = [];

  // Get baseline for fragility comparison
  const baseline = await evaluator(baseParams);
  const basePassRate = baseline.passRate;

  for (let i = 0; i < iterations; i++) {
    // Jitter each parameter by gaussian noise proportional to sigma
    const perturbed = baseParams.map((val) => {
      const noise = gaussianRandom() * sigma * Math.abs(val);
      return val + noise;
    });

    const result = await evaluator(perturbed);
    passRates.push(result.passRate);
    pnls.push(result.pnl);
  }

  // Fragility: fraction of perturbations that dropped pass rate > 5pp
  const fragile = passRates.filter((pr) => pr < basePassRate - 0.05).length;

  return {
    passRates: buildDistribution(passRates),
    pnls: buildDistribution(pnls),
    fragilityScore: fragile / iterations,
  };
}

/**
 * Compute MC statistics comparing a real metric to its MC distribution.
 */
export function computeMCStatistics(
  realMetric: number,
  mcValues: number[]
): MCStatistics {
  const dist = buildDistribution(mcValues);

  // Z-score
  const zScore = dist.std > 0 ? (realMetric - dist.mean) / dist.std : 0;

  // P-value: fraction of MC iterations where metric >= real
  // For Sharpe/PnL: lower p-value = more significant (real beats MC)
  const pValue = mcValues.filter((v) => v >= realMetric).length / mcValues.length;

  // Persistence ratio
  const persistenceRatio = dist.median !== 0 ? realMetric / dist.median : 0;

  return {
    zScore,
    pValue,
    persistenceRatio,
    distribution: dist,
    isSignificant: pValue < 0.05,
  };
}

// ============================================
// Helpers
// ============================================

/** Box-Muller transform for gaussian random numbers */
function gaussianRandom(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
