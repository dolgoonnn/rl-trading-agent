/**
 * RL Trading Agent Module
 *
 * A reinforcement learning trading agent that learns from ICT concepts
 * and market data to make trading decisions.
 *
 * Usage:
 * ```typescript
 * import { TradingEnvironment, DQNAgent, Trainer } from '@/lib/rl';
 *
 * // Create and train agent
 * const trainer = new Trainer(candles);
 * const result = await trainer.train();
 *
 * // Use trained agent
 * const agent = result.agent;
 * const action = agent.selectAction(state.features, false);
 * ```
 */

// Types
export * from './types';

// Environment
export {
  TradingEnvironment,
  StateBuilder,
  RewardCalculator,
  type StateBuilderConfig,
  type RewardConfig,
  // Hybrid environment (rule-based entry + RL exit)
  HybridTradingEnvironment,
  EntryFilter,
  ExitStateBuilder,
  type HybridEnvConfig,
  type EntryFilterConfig,
  type ExitStateBuilderConfig,
} from './environment';

// Agent
export {
  DQNAgent,
  ReplayBuffer,
  PrioritizedReplayBuffer,
  type SerializedWeights,
  type DQNConfig,
  type BufferStats,
  type SerializedBuffer,
  type ReplayBufferConfig,
} from './agent';

// PPO Agent
export { PPOAgent, type PPOConfig } from './agent/ppo-agent';

// Base Agent Interface
export type { BaseAgent, ReplayAgent, RolloutAgent, AgentType } from './agent/base-agent';

// Networks
export {
  buildDenseNetwork,
  TransformerQNetwork,
  createQNetwork,
  type NetworkType,
  type DenseNetworkConfig,
  type TransformerNetworkConfig,
} from './agent/networks';

// Transformer components
export { TransformerEncoder, TransformerBlock } from './agent/transformer';
export { MultiHeadAttention, scaledDotProductAttention } from './agent/attention';

// Symbol configurations
export {
  SYMBOLS,
  getEnvConfigForSymbol,
  getSymbolsByProvider,
  getCryptoSymbols,
  getForexSymbols,
  getCommoditySymbols,
  normalizeSymbolName,
  type SymbolConfig,
  type DataProvider,
} from './config/symbols';

// Training
export {
  Trainer,
  Evaluator,
  backtestAgent,
  type TrainingResult,
  type BacktestResult,
  type TrainerCallbacks,
  type PerformanceMetrics,
} from './training';

// KB Integration (opt-in)
export * from './kb-integration';
