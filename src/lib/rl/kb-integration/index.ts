/**
 * KB-RL Integration Module
 *
 * Bridges the knowledge base (2,500+ ICT concept chunks) with the RL exit agent
 * to create an informed, explainable trading system.
 *
 * Usage:
 * ```typescript
 * import {
 *   KBHybridTradingEnvironment,
 *   KBExitStateBuilder,
 *   KBConceptMatcher,
 *   KBDecisionExplainer,
 * } from '@/lib/rl/kb-integration';
 *
 * // Create KB-enhanced environment
 * const env = new KBHybridTradingEnvironment(candles, {
 *   kbConfig: {
 *     enabled: true,
 *     addKBFeatures: true,
 *     useKBRewardShaping: true,
 *   },
 * });
 *
 * // Initialize KB (loads embeddings)
 * await env.initializeKB();
 *
 * // Training loop with KB features (22 instead of 18)
 * const state = env.step(action);
 * console.log('Features:', state.state?.features.length); // 22
 *
 * // Explain decisions
 * const explainer = new KBDecisionExplainer();
 * const explanation = explainer.explain(action, env.getKBContext(), env.getLastKBReward());
 * console.log(explanation.explanation);
 * ```
 */

// Types
export type {
  KBIntegrationConfig,
  KBConceptMatch,
  KBContext,
  KBTradingRule,
  KBStateFeatures,
  KBExitState,
  MarketQueryContext,
  KBRewardResult,
  KBDecisionExplanation,
  CacheEntry,
  CacheStats,
} from './types';

export { DEFAULT_KB_CONFIG } from './types';

// Concept Matcher
export { KBConceptMatcher } from './concept-matcher';

// State Builder
export {
  KBExitStateBuilder,
  type KBExtendedExitState,
  type KBExitStateBuilderConfig,
} from './kb-exit-state-builder';

// Reward Shaper
export { KBRewardShaper } from './kb-reward-shaper';

// Environment
export {
  KBHybridTradingEnvironment,
  type KBHybridStepInfo,
  type KBHybridStepResult,
  type KBHybridEnvConfig,
} from './kb-hybrid-env';

// Explainer
export {
  KBDecisionExplainer,
  type DetailedExplanation,
} from './explainer';
