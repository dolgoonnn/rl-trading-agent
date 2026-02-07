/**
 * GT-Score (Generalized Trading Score)
 *
 * A composite objective function that combines multiple performance metrics
 * to provide a more robust measure of trading model quality than Sharpe alone.
 *
 * Components:
 * - Sharpe Ratio: Risk-adjusted return
 * - Sortino Ratio: Downside risk-adjusted return (penalizes only bad volatility)
 * - Max Drawdown: Capital protection measure
 * - Consistency: Win rate and profit factor
 *
 * Reference: ABC Money (2025) "Enhancing Deep Reinforcement Learning Models in Algorithmic Trading"
 */

export interface TradeResult {
  pnl: number;
  pnlPercent: number;
  holdingPeriod?: number;
}

export interface GTScoreWeights {
  /** Weight for Sharpe Ratio component (default: 0.4) */
  sharpe: number;
  /** Weight for Sortino Ratio component (default: 0.3) */
  sortino: number;
  /** Weight for max drawdown penalty (default: 0.15) */
  maxDrawdown: number;
  /** Weight for consistency score (default: 0.15) */
  consistency: number;
}

export interface GTScoreConfig {
  /** Component weights */
  weights: GTScoreWeights;
  /** Annualization factor for Sharpe/Sortino (default: sqrt(252*24) for hourly) */
  annualizationFactor: number;
  /** Target downside deviation for Sortino (default: 0) */
  targetReturn: number;
  /** Maximum acceptable drawdown (default: 0.20 = 20%) */
  maxAcceptableDrawdown: number;
  /** Minimum trades for valid scoring (default: 10) */
  minTrades: number;
}

export interface GTScoreResult {
  /** Final composite score */
  gtScore: number;
  /** Individual component scores */
  components: {
    sharpe: number;
    sortino: number;
    drawdownPenalty: number;
    consistency: number;
  };
  /** Raw metrics before normalization */
  rawMetrics: {
    sharpeRatio: number;
    sortinoRatio: number;
    maxDrawdown: number;
    winRate: number;
    profitFactor: number;
    avgWin: number;
    avgLoss: number;
    totalTrades: number;
  };
  /** Whether the score is valid (enough trades) */
  isValid: boolean;
}

const DEFAULT_WEIGHTS: GTScoreWeights = {
  sharpe: 0.4,
  sortino: 0.3,
  maxDrawdown: 0.15,
  consistency: 0.15,
};

const DEFAULT_CONFIG: GTScoreConfig = {
  weights: DEFAULT_WEIGHTS,
  annualizationFactor: Math.sqrt(252 * 24), // Hourly data
  targetReturn: 0,
  maxAcceptableDrawdown: 0.20,
  minTrades: 10,
};

/**
 * Calculate Sharpe Ratio from trade results
 */
export function calculateSharpeRatio(
  returns: number[],
  annualizationFactor: number
): number {
  if (returns.length < 2) return 0;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) /
    (returns.length - 1);
  const std = Math.sqrt(variance);

  if (std === 0) return 0;

  return (mean / std) * annualizationFactor;
}

/**
 * Calculate Sortino Ratio from trade results
 *
 * Unlike Sharpe, only penalizes downside volatility (negative returns)
 */
export function calculateSortinoRatio(
  returns: number[],
  targetReturn: number,
  annualizationFactor: number
): number {
  if (returns.length < 2) return 0;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;

  // Calculate downside deviation (only negative deviations from target)
  const downsideReturns = returns.filter((r) => r < targetReturn);
  if (downsideReturns.length === 0) {
    // All returns above target - very good, return high score
    return mean > 0 ? 10 : 0;
  }

  const downsideSquaredSum = downsideReturns.reduce(
    (sum, r) => sum + Math.pow(r - targetReturn, 2),
    0
  );
  const downsideDeviation = Math.sqrt(downsideSquaredSum / returns.length);

  if (downsideDeviation === 0) return 0;

  return ((mean - targetReturn) / downsideDeviation) * annualizationFactor;
}

/**
 * Calculate max drawdown from equity curve
 */
export function calculateMaxDrawdown(returns: number[]): number {
  if (returns.length === 0) return 0;

  // Build equity curve
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;

  for (const r of returns) {
    equity *= 1 + r;
    if (equity > peak) {
      peak = equity;
    }
    const drawdown = (peak - equity) / peak;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  return maxDrawdown;
}

/**
 * Calculate consistency score based on win rate and profit factor
 */
export function calculateConsistencyScore(trades: TradeResult[]): {
  score: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
} {
  if (trades.length === 0) {
    return { score: 0, winRate: 0, profitFactor: 0, avgWin: 0, avgLoss: 0 };
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);

  const winRate = wins.length / trades.length;

  const totalWins = wins.reduce((sum, t) => sum + t.pnl, 0);
  const totalLosses = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));

  const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? 10 : 0;

  const avgWin = wins.length > 0 ? totalWins / wins.length : 0;
  const avgLoss = losses.length > 0 ? totalLosses / losses.length : 0;

  // Consistency score combines win rate and profit factor
  // Win rate normalized: [0, 1] -> [0, 0.5]
  // Profit factor normalized: [0, 3+] -> [0, 0.5]
  const winRateScore = winRate * 0.5;
  const pfScore = Math.min(profitFactor / 3, 1) * 0.5;

  return {
    score: winRateScore + pfScore,
    winRate,
    profitFactor,
    avgWin,
    avgLoss,
  };
}

/**
 * Normalize a metric to [0, 1] range using sigmoid-like transformation
 */
function normalizeMetric(value: number, center: number, scale: number): number {
  // Sigmoid-like normalization centered at 'center' with 'scale' determining steepness
  return 1 / (1 + Math.exp(-(value - center) / scale));
}

/**
 * Calculate the composite GT-Score for a set of trades
 *
 * @param trades - Array of trade results
 * @param config - Configuration options
 */
export function calculateGTScore(
  trades: TradeResult[],
  config: Partial<GTScoreConfig> = {}
): GTScoreResult {
  const cfg: GTScoreConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    weights: { ...DEFAULT_WEIGHTS, ...config.weights },
  };

  // Check minimum trades
  if (trades.length < cfg.minTrades) {
    return {
      gtScore: 0,
      components: { sharpe: 0, sortino: 0, drawdownPenalty: 0, consistency: 0 },
      rawMetrics: {
        sharpeRatio: 0,
        sortinoRatio: 0,
        maxDrawdown: 0,
        winRate: 0,
        profitFactor: 0,
        avgWin: 0,
        avgLoss: 0,
        totalTrades: trades.length,
      },
      isValid: false,
    };
  }

  const returns = trades.map((t) => t.pnlPercent);

  // Calculate raw metrics
  const sharpeRatio = calculateSharpeRatio(returns, cfg.annualizationFactor);
  const sortinoRatio = calculateSortinoRatio(
    returns,
    cfg.targetReturn,
    cfg.annualizationFactor
  );
  const maxDrawdown = calculateMaxDrawdown(returns);
  const consistencyResult = calculateConsistencyScore(trades);

  // Normalize components to [0, 1]
  // Sharpe: center=1.0, scale=1.5 -> SR of 1 maps to ~0.5, SR of 3 maps to ~0.9
  const sharpeComponent = normalizeMetric(sharpeRatio, 1.0, 1.5);

  // Sortino: center=1.5, scale=2.0 -> More lenient than Sharpe (higher is better)
  const sortinoComponent = normalizeMetric(sortinoRatio, 1.5, 2.0);

  // Drawdown penalty: 0% DD = 1.0, maxAcceptable DD = 0.5, higher DD = lower score
  const drawdownPenalty = Math.max(
    0,
    1 - maxDrawdown / cfg.maxAcceptableDrawdown
  );

  // Consistency already in [0, 1]
  const consistencyComponent = consistencyResult.score;

  // Calculate weighted composite score
  const gtScore =
    cfg.weights.sharpe * sharpeComponent +
    cfg.weights.sortino * sortinoComponent +
    cfg.weights.maxDrawdown * drawdownPenalty +
    cfg.weights.consistency * consistencyComponent;

  return {
    gtScore,
    components: {
      sharpe: sharpeComponent,
      sortino: sortinoComponent,
      drawdownPenalty,
      consistency: consistencyComponent,
    },
    rawMetrics: {
      sharpeRatio,
      sortinoRatio,
      maxDrawdown,
      winRate: consistencyResult.winRate,
      profitFactor: consistencyResult.profitFactor,
      avgWin: consistencyResult.avgWin,
      avgLoss: consistencyResult.avgLoss,
      totalTrades: trades.length,
    },
    isValid: true,
  };
}

/**
 * Compare two models using GT-Score
 *
 * @returns Positive if modelA is better, negative if modelB is better
 */
export function compareModels(
  tradesA: TradeResult[],
  tradesB: TradeResult[],
  config: Partial<GTScoreConfig> = {}
): {
  scoreA: number;
  scoreB: number;
  winner: 'A' | 'B' | 'tie';
  margin: number;
} {
  const resultA = calculateGTScore(tradesA, config);
  const resultB = calculateGTScore(tradesB, config);

  const margin = resultA.gtScore - resultB.gtScore;
  const TIE_THRESHOLD = 0.02; // 2% difference is considered a tie

  return {
    scoreA: resultA.gtScore,
    scoreB: resultB.gtScore,
    winner:
      Math.abs(margin) < TIE_THRESHOLD ? 'tie' : margin > 0 ? 'A' : 'B',
    margin,
  };
}

/**
 * Rank multiple models by GT-Score
 */
export function rankModels(
  models: Array<{ id: string; trades: TradeResult[] }>,
  config: Partial<GTScoreConfig> = {}
): Array<{
  id: string;
  gtScore: number;
  rank: number;
  result: GTScoreResult;
}> {
  const results = models.map((model) => ({
    id: model.id,
    result: calculateGTScore(model.trades, config),
    gtScore: 0,
    rank: 0,
  }));

  results.forEach((r) => {
    r.gtScore = r.result.gtScore;
  });

  // Sort by GT-Score descending
  results.sort((a, b) => b.gtScore - a.gtScore);

  // Assign ranks
  results.forEach((r, i) => {
    r.rank = i + 1;
  });

  return results;
}

/**
 * Get a human-readable assessment of a GT-Score
 */
export function assessGTScore(gtScore: number): {
  rating: 'Excellent' | 'Good' | 'Fair' | 'Poor' | 'Bad';
  description: string;
} {
  if (gtScore >= 0.8) {
    return {
      rating: 'Excellent',
      description: 'Outstanding risk-adjusted performance with strong consistency',
    };
  }
  if (gtScore >= 0.65) {
    return {
      rating: 'Good',
      description: 'Solid performance with reasonable risk management',
    };
  }
  if (gtScore >= 0.5) {
    return {
      rating: 'Fair',
      description: 'Average performance, room for improvement in risk or consistency',
    };
  }
  if (gtScore >= 0.35) {
    return {
      rating: 'Poor',
      description: 'Below average, significant concerns with performance metrics',
    };
  }
  return {
    rating: 'Bad',
    description: 'Unacceptable performance, major issues with strategy',
  };
}
