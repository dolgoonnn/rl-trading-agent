/**
 * ICT Strategies Module
 */

export {
  // Types
  type StrategyAction,
  type StrategyName,
  type StrategySignal,
  type StrategyExitSignal,
  type ICTStrategyContext,
  type ICTStrategy,
  type StrategyConfig,

  // Constants
  StrategyActions,
  STRATEGY_COUNT,
  DEFAULT_STRATEGY_CONFIG,

  // Functions
  strategyActionToName,

  // Strategies
  OrderBlockStrategy,
  FVGStrategy,
  BOSContinuationStrategy,
  CHoCHReversalStrategy,
  WaitStrategy,

  // Manager
  ICTStrategyManager,
} from './ict-strategies';

export {
  // Types
  type ConfluenceWeights,
  type ConfluenceConfig,
  type ScoredSignal,
  type ConfluenceScorerResult,

  // Constants
  DEFAULT_WEIGHTS,
  DEFAULT_CONFLUENCE_CONFIG,
  PRODUCTION_STRATEGY_CONFIG,

  // Scorer
  ConfluenceScorer,
} from './confluence-scorer';
