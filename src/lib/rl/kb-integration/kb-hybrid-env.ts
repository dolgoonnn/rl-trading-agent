/**
 * KB-Enhanced Hybrid Trading Environment
 * Extends HybridTradingEnvironment with KB context tracking and reward shaping
 */

import type { Candle } from '@/types';
import type {
  ExitAction,
  HybridStepResult,
  HybridStepInfo,
  EntryFilterConfig,
} from '../types';
import { ExitActions } from '../types';
import {
  HybridTradingEnvironment,
  type HybridEnvConfig,
} from '../environment/hybrid-trading-env';
import type { ExitStateBuilderConfig } from '../environment/exit-state-builder';
import {
  KBExitStateBuilder,
  type KBExtendedExitState,
} from './kb-exit-state-builder';
import { KBRewardShaper } from './kb-reward-shaper';
import type {
  KBIntegrationConfig,
  KBContext,
  KBRewardResult,
  KBDecisionExplanation,
} from './types';
import { DEFAULT_KB_CONFIG } from './types';

/**
 * Extended step info with KB context
 */
export interface KBHybridStepInfo extends HybridStepInfo {
  /** KB context for this step */
  kbContext: KBContext | null;
  /** KB reward shaping result */
  kbReward: KBRewardResult | null;
  /** Human-readable KB explanation */
  kbExplanation?: string;
}

/**
 * Extended step result with KB information
 */
export interface KBHybridStepResult extends Omit<HybridStepResult, 'state' | 'info'> {
  state: KBExtendedExitState | null;
  info: KBHybridStepInfo;
}

/**
 * Configuration for KB-enhanced environment
 */
export interface KBHybridEnvConfig extends HybridEnvConfig {
  kbConfig: Partial<KBIntegrationConfig>;
}

export class KBHybridTradingEnvironment extends HybridTradingEnvironment {
  private kbConfig: KBIntegrationConfig;
  private kbStateBuilder: KBExitStateBuilder;
  private kbRewardShaper: KBRewardShaper;

  // KB context tracking
  private currentKBContext: KBContext | null = null;
  private lastKBReward: KBRewardResult | null = null;
  private kbInitialized: boolean = false;

  constructor(
    candles: Candle[],
    envConfig: Partial<KBHybridEnvConfig> = {},
    entryConfig: Partial<EntryFilterConfig> = {},
    stateConfig: Partial<ExitStateBuilderConfig> = {},
    training: boolean = true
  ) {
    // Initialize base environment (this creates its own state builder)
    super(candles, envConfig, entryConfig, stateConfig, training);

    // Set up KB configuration
    this.kbConfig = { ...DEFAULT_KB_CONFIG, ...envConfig.kbConfig };

    // Create KB-aware state builder
    this.kbStateBuilder = new KBExitStateBuilder({
      ...stateConfig,
      kbConfig: this.kbConfig,
    });

    // Create KB reward shaper
    this.kbRewardShaper = new KBRewardShaper(this.kbConfig);
  }

  /**
   * Initialize KB components (async)
   * Call this before using KB features
   */
  async initializeKB(): Promise<void> {
    if (this.kbInitialized) return;
    await this.kbStateBuilder.initialize();
    this.kbInitialized = true;
  }

  /**
   * Reset environment and clear KB context
   */
  override reset(): KBExtendedExitState | null {
    super.reset();
    this.currentKBContext = null;
    this.lastKBReward = null;
    this.kbStateBuilder.clearKBContext();
    return null;
  }

  /**
   * Step the environment with KB integration
   */
  override step(action: ExitAction | null): KBHybridStepResult {
    // Get position before step (for KB context tracking)
    const positionBeforeStep = this.getPosition();
    const wasInPosition = this.isInPosition();

    // Execute base step
    const baseResult = super.step(action);

    // Check if we just entered a position
    const justEnteredPosition =
      !wasInPosition && this.isInPosition() && baseResult.info.entrySignal;

    // Refresh KB context on position entry
    if (justEnteredPosition) {
      // Schedule async KB context refresh
      this.refreshKBContextAsync();
    }

    // Build KB-enhanced state
    let kbState: KBExtendedExitState | null = null;
    const currentPosition = this.getPosition();

    if (currentPosition && baseResult.state) {
      // Use sync state builder with cached KB context
      kbState = this.kbStateBuilder.buildSync(
        this.getCandles(),
        this.getCurrentIndex() - 1,
        currentPosition,
        this.isTraining()
      );
    }

    // Apply KB reward shaping
    let shapedReward = baseResult.reward;
    this.lastKBReward = null;

    if (
      this.kbConfig.enabled &&
      this.kbConfig.useKBRewardShaping &&
      action !== null &&
      positionBeforeStep
    ) {
      const { reward, result } = this.kbRewardShaper.shapeReward(
        baseResult.reward,
        this.currentKBContext,
        action,
        positionBeforeStep.side
      );
      shapedReward = reward;
      this.lastKBReward = result;
    }

    // Build KB-enhanced step info
    const kbInfo: KBHybridStepInfo = {
      ...baseResult.info,
      kbContext: this.currentKBContext,
      kbReward: this.lastKBReward,
      kbExplanation: this.currentKBContext
        ? this.kbStateBuilder.getConceptMatcher().getConfig().enabled
          ? this.currentKBContext.explanation
          : undefined
        : undefined,
    };

    return {
      state: kbState,
      reward: shapedReward,
      done: baseResult.done,
      info: kbInfo,
    };
  }

  /**
   * Refresh KB context asynchronously
   * Called when a new position is opened
   */
  private async refreshKBContextAsync(): Promise<void> {
    const position = this.getPosition();
    if (!position) return;

    try {
      this.currentKBContext = await this.kbStateBuilder.refreshKBContext(
        this.getCandles(),
        this.getCurrentIndex(),
        position
      );
    } catch {
      // KB refresh failed - continue without KB context
      this.currentKBContext = null;
    }
  }

  /**
   * Force refresh KB context (sync interface for async operation)
   * Returns a promise that resolves when context is refreshed
   */
  async refreshKBContext(): Promise<KBContext | null> {
    const position = this.getPosition();
    if (!position) return null;

    try {
      this.currentKBContext = await this.kbStateBuilder.refreshKBContext(
        this.getCandles(),
        this.getCurrentIndex(),
        position
      );
      return this.currentKBContext;
    } catch {
      return null;
    }
  }

  /**
   * Get current KB context
   */
  getKBContext(): KBContext | null {
    return this.currentKBContext;
  }

  /**
   * Get last KB reward result
   */
  getLastKBReward(): KBRewardResult | null {
    return this.lastKBReward;
  }

  /**
   * Generate decision explanation for current state
   */
  explainDecision(action: ExitAction): KBDecisionExplanation {
    const actionName = this.actionToName(action);

    if (!this.currentKBContext || this.currentKBContext.matches.length === 0) {
      return {
        action: actionName,
        supportingConcepts: [],
        supportingRules: [],
        conflictingRules: [],
        confidence: 0,
        explanation: 'No KB context available for this decision.',
      };
    }

    const supportingConcepts = this.currentKBContext.matches
      .filter((m) => m.similarity >= 0.5)
      .map((m) => m.concept)
      .filter((c): c is string => c !== undefined);

    const supportingRules = this.currentKBContext.alignedRules
      .filter((r) => r.suggestedAction === actionName)
      .map((r) => r.text);

    const conflictingRules = this.currentKBContext.conflictingRules.map(
      (r) => r.text
    );

    const confidence = Math.min(
      1,
      this.currentKBContext.matches[0]?.similarity ?? 0
    );

    const explanation = this.generateExplanation(
      actionName,
      supportingConcepts,
      supportingRules,
      conflictingRules
    );

    return {
      action: actionName,
      primaryConcept: this.currentKBContext.primaryConcept,
      supportingConcepts,
      supportingRules,
      conflictingRules,
      confidence,
      explanation,
    };
  }

  /**
   * Convert action enum to name
   */
  private actionToName(
    action: ExitAction
  ): 'hold' | 'exit_market' | 'tighten_stop' | 'take_partial' {
    switch (action) {
      case ExitActions.HOLD:
        return 'hold';
      case ExitActions.EXIT_MARKET:
        return 'exit_market';
      case ExitActions.TIGHTEN_STOP:
        return 'tighten_stop';
      case ExitActions.TAKE_PARTIAL:
        return 'take_partial';
      default:
        return 'hold';
    }
  }

  /**
   * Generate human-readable explanation
   */
  private generateExplanation(
    action: string,
    supportingConcepts: string[],
    supportingRules: string[],
    conflictingRules: string[]
  ): string {
    const parts: string[] = [];

    parts.push(`Agent chose to ${action.replace('_', ' ')}.`);

    if (supportingConcepts.length > 0) {
      parts.push(`Relevant ICT concepts: ${supportingConcepts.join(', ')}.`);
    }

    if (supportingRules.length > 0) {
      parts.push(`${supportingRules.length} KB rule(s) support this action.`);
    }

    if (conflictingRules.length > 0) {
      parts.push(`Note: ${conflictingRules.length} KB rule(s) suggest caution.`);
    }

    return parts.join(' ');
  }

  /**
   * Get feature size (base + KB features)
   */
  override getStateSize(): number {
    return this.kbStateBuilder.getFeatureSize();
  }

  /**
   * Check if environment is in training mode
   */
  private isTraining(): boolean {
    // Access private training field via reflection
    // This is a workaround since training is not exposed in base class
    return (this as unknown as { training: boolean }).training;
  }

  /**
   * Get KB state builder
   */
  getKBStateBuilder(): KBExitStateBuilder {
    return this.kbStateBuilder;
  }

  /**
   * Get KB reward shaper
   */
  getKBRewardShaper(): KBRewardShaper {
    return this.kbRewardShaper;
  }

  /**
   * Check if KB is enabled
   */
  isKBEnabled(): boolean {
    return this.kbConfig.enabled;
  }

  /**
   * Get KB configuration
   */
  getKBConfig(): KBIntegrationConfig {
    return { ...this.kbConfig };
  }

  /**
   * Update KB configuration
   */
  updateKBConfig(config: Partial<KBIntegrationConfig>): void {
    this.kbConfig = { ...this.kbConfig, ...config };
    this.kbStateBuilder.updateKBConfig(this.kbConfig);
    this.kbRewardShaper.updateConfig(this.kbConfig);
  }

  /**
   * Get cache statistics from concept matcher
   */
  getKBCacheStats() {
    return this.kbStateBuilder.getConceptMatcher().getCacheStats();
  }

  /**
   * Override getCurrentState to use KB state builder
   * Returns KB-enhanced state if KB is enabled and in position
   */
  override getCurrentState(): KBExtendedExitState | null {
    const position = this.getPosition();
    if (!position) return null;

    const candles = this.getCandles();
    const currentIndex = this.getCurrentIndex();

    // Build state using KB state builder (includes KB features)
    return this.kbStateBuilder.build(
      candles,
      currentIndex,
      position,
      this.isTraining()
    );
  }
}
