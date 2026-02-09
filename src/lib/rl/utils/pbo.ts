/**
 * Probability of Backtest Overfitting (PBO)
 *
 * Implementation of the Combinatorially Symmetric Cross-Validation (CSCV) method
 * from Bailey, Borwein, López de Prado & Zhu (2017):
 * "The Probability of Backtest Overfitting"
 *
 * The core idea: if you test N configurations on walk-forward windows,
 * the "best" one may just be lucky. PBO estimates the probability that
 * the in-sample winner underperforms out-of-sample.
 *
 * PBO > 0.50 → model selection is worse than coin-flip → reject
 * PBO < 0.25 → strong evidence of genuine edge
 */

// ============================================
// Types
// ============================================

export interface WindowResult {
  /** Identifier for the model/config being tested */
  configId: string;
  /** Performance metric for each walk-forward window (e.g., Sharpe) */
  windowMetrics: number[];
}

export interface PBOResult {
  /** Probability of backtest overfitting [0, 1] */
  pbo: number;
  /** Number of CSCV combinations tested */
  numCombinations: number;
  /** Number of combinations where IS winner underperformed OOS */
  numOverfit: number;
  /** Rank distribution of IS winner in OOS (lower = better) */
  oosRankDistribution: number[];
  /** Whether the result passes the threshold (PBO < threshold) */
  passes: boolean;
  /** Threshold used */
  threshold: number;
  /** Average OOS performance of IS winner (logit) */
  avgLogitOOS: number;
}

export interface PBOConfig {
  /** PBO threshold — reject if above this (default: 0.50) */
  threshold: number;
  /** Minimum number of windows required (default: 6) */
  minWindows: number;
  /** Minimum number of configs to compare (default: 2) */
  minConfigs: number;
}

const DEFAULT_PBO_CONFIG: PBOConfig = {
  threshold: 0.50,
  minWindows: 6,
  minConfigs: 2,
};

// ============================================
// CSCV Implementation
// ============================================

/**
 * Calculate PBO using Combinatorially Symmetric Cross-Validation.
 *
 * @param results  Array of WindowResult — one per config, each with performance per window
 * @param config   PBO configuration
 * @returns PBOResult with overfitting probability
 */
export function calculatePBO(
  results: WindowResult[],
  config: Partial<PBOConfig> = {},
): PBOResult {
  const cfg = { ...DEFAULT_PBO_CONFIG, ...config };
  const numConfigs = results.length;
  const numWindows = results[0]?.windowMetrics.length ?? 0;

  // Validate inputs
  if (numConfigs < cfg.minConfigs) {
    throw new Error(`PBO requires at least ${cfg.minConfigs} configs, got ${numConfigs}`);
  }
  if (numWindows < cfg.minWindows) {
    throw new Error(`PBO requires at least ${cfg.minWindows} windows, got ${numWindows}`);
  }

  // Build performance matrix: configs × windows
  const matrix: number[][] = results.map((r) => [...r.windowMetrics]);

  // Ensure all configs have same number of windows
  for (const row of matrix) {
    if (row.length !== numWindows) {
      throw new Error(`All configs must have same number of windows (${numWindows})`);
    }
  }

  // Generate all CSCV partitions
  // We split N windows into two halves of size N/2 (approximately)
  // For N windows, there are C(N, N/2) ways to split
  const halfSize = Math.floor(numWindows / 2);
  const combinations = generateCombinations(numWindows, halfSize);

  let numOverfit = 0;
  const oosRankDistribution: number[] = [];
  let logitSum = 0;

  for (const isIndices of combinations) {
    // OOS indices = complement of IS indices
    const oosIndices = Array.from({ length: numWindows }, (_, i) => i)
      .filter((i) => !isIndices.includes(i));

    // Calculate IS performance for each config
    const isPerformance: { configIdx: number; metric: number }[] = [];
    const oosPerformance: { configIdx: number; metric: number }[] = [];

    for (let c = 0; c < numConfigs; c++) {
      const isMetric = mean(isIndices.map((i) => matrix[c]![i]!));
      const oosMetric = mean(oosIndices.map((i) => matrix[c]![i]!));
      isPerformance.push({ configIdx: c, metric: isMetric });
      oosPerformance.push({ configIdx: c, metric: oosMetric });
    }

    // Find IS winner
    isPerformance.sort((a, b) => b.metric - a.metric);
    const isWinnerIdx = isPerformance[0]!.configIdx;

    // Find OOS rank of IS winner
    oosPerformance.sort((a, b) => b.metric - a.metric);
    const oosRank = oosPerformance.findIndex((p) => p.configIdx === isWinnerIdx);
    oosRankDistribution.push(oosRank);

    // IS winner's relative rank in OOS (0 = best, 1 = worst)
    const relativeRank = oosRank / (numConfigs - 1);

    // Logit of relative rank for averaging
    const adjustedRank = Math.max(0.01, Math.min(0.99, relativeRank));
    logitSum += Math.log(adjustedRank / (1 - adjustedRank));

    // Count as overfitted if IS winner is in bottom half OOS
    if (relativeRank > 0.5) {
      numOverfit++;
    }
  }

  const pbo = numOverfit / combinations.length;
  const avgLogitOOS = logitSum / combinations.length;

  return {
    pbo,
    numCombinations: combinations.length,
    numOverfit,
    oosRankDistribution,
    passes: pbo < cfg.threshold,
    threshold: cfg.threshold,
    avgLogitOOS,
  };
}

/**
 * Quick PBO estimate using random sampling instead of all combinations.
 * For large window counts where full enumeration is too expensive.
 */
export function estimatePBO(
  results: WindowResult[],
  numSamples: number = 1000,
  config: Partial<PBOConfig> = {},
): PBOResult {
  const cfg = { ...DEFAULT_PBO_CONFIG, ...config };
  const numConfigs = results.length;
  const numWindows = results[0]?.windowMetrics.length ?? 0;

  if (numConfigs < cfg.minConfigs || numWindows < cfg.minWindows) {
    throw new Error(`Insufficient data: ${numConfigs} configs, ${numWindows} windows`);
  }

  const matrix: number[][] = results.map((r) => [...r.windowMetrics]);
  const halfSize = Math.floor(numWindows / 2);

  let numOverfit = 0;
  const oosRankDistribution: number[] = [];
  let logitSum = 0;

  for (let sample = 0; sample < numSamples; sample++) {
    // Random partition
    const allIndices = Array.from({ length: numWindows }, (_, i) => i);
    shuffleArray(allIndices);
    const isIndices = allIndices.slice(0, halfSize);
    const oosIndices = allIndices.slice(halfSize);

    // IS/OOS performance
    const isPerf: number[] = [];
    const oosPerf: number[] = [];
    for (let c = 0; c < numConfigs; c++) {
      isPerf.push(mean(isIndices.map((i) => matrix[c]![i]!)));
      oosPerf.push(mean(oosIndices.map((i) => matrix[c]![i]!)));
    }

    // IS winner
    let bestIS = 0;
    for (let c = 1; c < numConfigs; c++) {
      if (isPerf[c]! > isPerf[bestIS]!) bestIS = c;
    }

    // OOS rank of IS winner
    const sortedOOS = oosPerf.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
    const oosRank = sortedOOS.findIndex((s) => s.i === bestIS);
    oosRankDistribution.push(oosRank);

    const relativeRank = oosRank / Math.max(1, numConfigs - 1);
    const adjustedRank = Math.max(0.01, Math.min(0.99, relativeRank));
    logitSum += Math.log(adjustedRank / (1 - adjustedRank));

    if (relativeRank > 0.5) numOverfit++;
  }

  const pbo = numOverfit / numSamples;

  return {
    pbo,
    numCombinations: numSamples,
    numOverfit,
    oosRankDistribution,
    passes: pbo < cfg.threshold,
    threshold: cfg.threshold,
    avgLogitOOS: logitSum / numSamples,
  };
}

// ============================================
// Helpers
// ============================================

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function shuffleArray(arr: number[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}

/**
 * Generate all combinations of size k from n elements.
 * For large n, this can be expensive — use estimatePBO with random sampling instead.
 * Caps at 10000 combinations to prevent memory issues.
 */
function generateCombinations(n: number, k: number): number[][] {
  const maxCombinations = 10000;
  const result: number[][] = [];

  function backtrack(start: number, current: number[]): void {
    if (result.length >= maxCombinations) return;
    if (current.length === k) {
      result.push([...current]);
      return;
    }
    for (let i = start; i < n; i++) {
      current.push(i);
      backtrack(i + 1, current);
      current.pop();
    }
  }

  backtrack(0, []);
  return result;
}
