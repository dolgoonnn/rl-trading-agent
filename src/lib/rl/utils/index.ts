/**
 * RL Utilities
 *
 * Helper functions for model evaluation and selection
 */

// Deflated Sharpe Ratio - accounts for selection bias from multiple trials
export {
  calculateDeflatedSharpe,
  calculateDeflatedSharpeFromTrials,
  rankModelsByDeflatedSharpe,
  getMinSignificantSharpe,
  estimateSharpeVariance,
  calculateHaircut,
  type SharpeTrialResult,
  type DeflatedSharpeResult,
} from './deflated-sharpe';

// GT-Score - composite objective combining Sharpe, Sortino, drawdown, consistency
export {
  calculateGTScore,
  calculateSharpeRatio,
  calculateSortinoRatio,
  calculateMaxDrawdown,
  calculateConsistencyScore,
  compareModels,
  rankModels,
  assessGTScore,
  type TradeResult,
  type GTScoreWeights,
  type GTScoreConfig,
  type GTScoreResult,
} from './gt-score';
