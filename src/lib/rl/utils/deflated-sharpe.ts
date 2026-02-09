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
