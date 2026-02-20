/**
 * F2F Gold Strategy — Barrel Exports
 *
 * Independent gold module. No ICT imports.
 * Only external dependency: Candle type from @/types/candle.
 */

// Types & constants
export {
  F2F_FIXED_PARAMS,
  F2F_GRID,
  F2F_DEFAULT_WF_CONFIG,
  type F2FOptimizedParams,
  type F2FWalkForwardConfig,
  type F2FSignal,
  type F2FTrainStats,
  type F2FTrade,
  type F2FExitReason,
  type F2FSimulationResult,
  type F2FWindowResult,
  type F2FOptimizationResult,
} from './types';

// Indicators
export {
  computeSmoothedLogPrices,
  computeDeltaSmoothed,
  computeTrainStats,
  computeZScores,
  computeEWMAVol,
  computeATR,
  computeMomentum,
  computeMA200RegimeFilter,
  computeZScore50RegimeFilter,
  type RegimeFilterType,
} from './indicators';

// Signals
export {
  generateSignals,
  generateWindowSignals,
  getTrainStats,
} from './signals';

// Strategy
export {
  computePositionWeight,
  checkExits,
  updateTrailingStop,
  runF2FSimulation,
  type F2FDirectionMode,
} from './strategy';

// Optimizer
export {
  runWalkForwardOptimization,
  type WalkForwardProgressCallback,
} from './optimizer';
