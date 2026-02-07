// Environment module exports
export { TradingEnvironment } from './trading-env';
export { StateBuilder, type StateBuilderConfig } from './state-builder';
export { RewardCalculator, type RewardConfig } from './reward-calculator';

// Multi-objective reward (Phase 2 research)
export {
  MultiObjectiveRewardCalculator,
  type ObjectiveRewards,
  type MultiObjectiveConfig,
} from './multi-objective-reward';

// Hybrid environment (rule-based entry + RL exit)
export { HybridTradingEnvironment, type HybridEnvConfig } from './hybrid-trading-env';
export { EntryFilter, type EntryFilterConfig } from './entry-filter';
export { ExitStateBuilder, type ExitStateBuilderConfig } from './exit-state-builder';

// Feature reduction for anti-overfitting
export {
  FeatureReducer,
  createFeatureReducer,
  type FeatureReducerConfig,
  type FeatureReducerStats,
} from './feature-reducer';

// ICT Meta-Strategy environment
export {
  ICTMetaStrategyEnvironment,
  type MetaStrategyState,
  type MetaStrategyStepResult,
  type MetaStrategyStepInfo,
  type MetaStrategyEnvConfig,
  DEFAULT_META_STRATEGY_CONFIG,
} from './ict-meta-env';
