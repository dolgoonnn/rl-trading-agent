/**
 * KB Reward Shaper
 * Adds reward bonuses/penalties based on KB alignment
 */

import type {
  KBIntegrationConfig,
  KBContext,
  KBRewardResult,
  KBTradingRule,
} from './types';
import { DEFAULT_KB_CONFIG } from './types';
import type { ExitAction } from '../types';
import { ExitActions } from '../types';

/**
 * Asymmetric loss configuration for reward shaping
 * Research suggests penalizing losses 1.5-2x more than rewarding wins
 */
export interface AsymmetricLossConfig {
  /** Enable asymmetric loss (default: true) */
  enabled: boolean;
  /** Multiplier for loss penalties (default: 2.0) */
  lossMultiplier: number;
  /** Multiplier for win bonuses (default: 1.0) */
  winMultiplier: number;
  /** Additional penalty for early exits on losing trades (default: 0.5) */
  earlyLossExitPenalty: number;
  /** Bonus for letting winners run (default: 0.3) */
  winnerHoldBonus: number;
}

const DEFAULT_ASYMMETRIC_CONFIG: AsymmetricLossConfig = {
  enabled: true,
  lossMultiplier: 2.0,
  winMultiplier: 1.0,
  earlyLossExitPenalty: 0.5,
  winnerHoldBonus: 0.3,
};

export class KBRewardShaper {
  private config: KBIntegrationConfig;
  private asymmetricConfig: AsymmetricLossConfig;

  constructor(
    config: Partial<KBIntegrationConfig> = {},
    asymmetricConfig: Partial<AsymmetricLossConfig> = {}
  ) {
    this.config = { ...DEFAULT_KB_CONFIG, ...config };
    this.asymmetricConfig = { ...DEFAULT_ASYMMETRIC_CONFIG, ...asymmetricConfig };
  }

  /**
   * Calculate KB-based reward bonus/penalty
   *
   * @param _baseReward - The original reward from environment (unused, kept for API consistency)
   * @param kbContext - KB context for current situation
   * @param action - Action taken by agent
   * @param positionSide - Current position direction
   * @returns KBRewardResult with bonus and breakdown
   */
  calculateKBBonus(
    _baseReward: number,
    kbContext: KBContext | null,
    action: ExitAction,
    positionSide: 'long' | 'short'
  ): KBRewardResult {
    // If KB not enabled or no context, return zero bonus
    if (!this.config.enabled || !this.config.useKBRewardShaping || !kbContext) {
      return this.createEmptyResult();
    }

    // Calculate individual bonus components
    const similarityBonus = this.calculateSimilarityBonus(kbContext);
    const alignedRulesBonus = this.calculateAlignedRulesBonus(
      kbContext,
      action,
      positionSide
    );
    const conflictingRulesPenalty = this.calculateConflictingRulesPenalty(
      kbContext,
      action,
      positionSide
    );

    // Sum up components
    const rawBonus = similarityBonus + alignedRulesBonus - conflictingRulesPenalty;

    // Cap to max bonus
    const cappedBonus = Math.max(
      -this.config.maxKBRewardBonus,
      Math.min(this.config.maxKBRewardBonus, rawBonus)
    );

    return {
      bonus: cappedBonus,
      components: {
        similarityBonus,
        alignedRulesBonus,
        conflictingRulesPenalty,
      },
      context: kbContext,
    };
  }

  /**
   * Calculate bonus from high concept similarity
   */
  private calculateSimilarityBonus(kbContext: KBContext): number {
    if (kbContext.matches.length === 0) return 0;

    const topSimilarity = kbContext.matches[0]?.similarity ?? 0;

    // Bonus for high similarity match
    if (topSimilarity >= this.config.highSimilarityThreshold) {
      return this.config.highSimilarityBonus;
    }

    // Scaled bonus for moderate similarity
    if (topSimilarity >= 0.5) {
      const scale = (topSimilarity - 0.5) / (this.config.highSimilarityThreshold - 0.5);
      return this.config.highSimilarityBonus * scale * 0.5;
    }

    return 0;
  }

  /**
   * Calculate bonus from aligned rules
   */
  private calculateAlignedRulesBonus(
    kbContext: KBContext,
    action: ExitAction,
    _positionSide: 'long' | 'short'
  ): number {
    let bonus = 0;
    let rulesApplied = 0;
    const maxRules = 5; // Cap at 5 rules

    for (const rule of kbContext.alignedRules) {
      if (rulesApplied >= maxRules) break;

      // Check if rule supports current action
      const actionSupported = this.ruleSupportsAction(rule, action);

      if (actionSupported) {
        // Weight by rule confidence
        bonus += this.config.ruleAlignmentBonus * rule.confidence;
        rulesApplied++;
      }
    }

    // Additional bonus if overall alignment is positive
    if (kbContext.alignmentScore > 0.3) {
      bonus += this.config.ruleAlignmentBonus * 0.5;
    }

    return bonus;
  }

  /**
   * Calculate penalty from conflicting rules
   */
  private calculateConflictingRulesPenalty(
    kbContext: KBContext,
    action: ExitAction,
    _positionSide: 'long' | 'short'
  ): number {
    let penalty = 0;
    let rulesApplied = 0;
    const maxRules = 5;

    for (const rule of kbContext.conflictingRules) {
      if (rulesApplied >= maxRules) break;

      // Check if we're ignoring a rule that suggests a different action
      const ruleSuggestsDifferentAction = this.ruleConflictsWithAction(rule, action);

      if (ruleSuggestsDifferentAction) {
        penalty += this.config.ruleConflictPenalty * rule.confidence;
        rulesApplied++;
      }
    }

    // Additional penalty if overall alignment is negative
    if (kbContext.alignmentScore < -0.3) {
      penalty += this.config.ruleConflictPenalty * 0.5;
    }

    return penalty;
  }

  /**
   * Check if a rule supports the given action
   */
  private ruleSupportsAction(rule: KBTradingRule, action: ExitAction): boolean {
    if (!rule.suggestedAction) return false;

    switch (action) {
      case ExitActions.HOLD:
        return rule.suggestedAction === 'hold';
      case ExitActions.EXIT_MARKET:
        return rule.suggestedAction === 'exit';
      case ExitActions.TIGHTEN_STOP:
        return rule.suggestedAction === 'tighten_stop';
      case ExitActions.TAKE_PARTIAL:
        return rule.suggestedAction === 'take_partial';
      default:
        return false;
    }
  }

  /**
   * Check if a rule conflicts with the given action
   */
  private ruleConflictsWithAction(rule: KBTradingRule, action: ExitAction): boolean {
    if (!rule.suggestedAction) return false;

    // A rule conflicts if it explicitly suggests a different action
    switch (action) {
      case ExitActions.HOLD:
        // Holding conflicts with rules suggesting exit
        return rule.suggestedAction === 'exit';
      case ExitActions.EXIT_MARKET:
        // Exiting conflicts with rules suggesting to hold
        return rule.suggestedAction === 'hold';
      case ExitActions.TIGHTEN_STOP:
        // Generally compatible with most rules
        return false;
      case ExitActions.TAKE_PARTIAL:
        // Partial exit conflicts with pure hold rules
        return rule.suggestedAction === 'hold';
      default:
        return false;
    }
  }

  /**
   * Create empty result (no KB bonus)
   */
  private createEmptyResult(): KBRewardResult {
    return {
      bonus: 0,
      components: {
        similarityBonus: 0,
        alignedRulesBonus: 0,
        conflictingRulesPenalty: 0,
      },
      context: null,
    };
  }

  /**
   * Apply KB bonus to base reward with asymmetric loss
   * Losses are penalized 2x more than wins are rewarded (academic consensus 2025-2026)
   *
   * @param baseReward - The original reward from environment
   * @param kbContext - KB context for current situation
   * @param action - Action taken by agent
   * @param positionSide - Current position direction
   * @param isClosingTrade - Whether this action closes a position
   * @param tradePnL - PnL of the trade if closing (optional)
   */
  shapeReward(
    baseReward: number,
    kbContext: KBContext | null,
    action: ExitAction,
    positionSide: 'long' | 'short',
    isClosingTrade: boolean = false,
    tradePnL?: number
  ): { reward: number; result: KBRewardResult } {
    const result = this.calculateKBBonus(baseReward, kbContext, action, positionSide);

    // Apply KB bonus as percentage of |baseReward| or absolute if base is zero
    let shapedReward = baseReward;
    if (Math.abs(baseReward) > 0.01) {
      shapedReward = baseReward * (1 + result.bonus);
    } else {
      shapedReward = baseReward + result.bonus * 0.1;
    }

    // Apply asymmetric loss if enabled
    if (this.asymmetricConfig.enabled) {
      shapedReward = this.applyAsymmetricLoss(
        shapedReward,
        action,
        isClosingTrade,
        tradePnL,
        kbContext
      );
    }

    return {
      reward: shapedReward,
      result,
    };
  }

  /**
   * Apply asymmetric loss function
   * Penalizes losses more heavily than rewarding wins to improve risk:reward ratio
   */
  private applyAsymmetricLoss(
    reward: number,
    action: ExitAction,
    isClosingTrade: boolean,
    tradePnL?: number,
    kbContext?: KBContext | null
  ): number {
    let adjustedReward = reward;

    // If closing a trade, apply asymmetric multipliers based on PnL
    if (isClosingTrade && tradePnL !== undefined) {
      if (tradePnL < 0) {
        // Loss: Apply heavier penalty (2x default)
        adjustedReward = reward * this.asymmetricConfig.lossMultiplier;

        // Additional penalty for exiting early on losers (cutting losses too late)
        // Only if KB suggests we should have held or had conflicting signals
        if (kbContext && kbContext.alignmentScore < -0.2) {
          adjustedReward -= this.asymmetricConfig.earlyLossExitPenalty * Math.abs(tradePnL);
        }
      } else if (tradePnL > 0) {
        // Win: Standard multiplier
        adjustedReward = reward * this.asymmetricConfig.winMultiplier;

        // Bonus for KB-aligned winning exits
        if (kbContext && kbContext.alignmentScore > 0.3) {
          adjustedReward += this.asymmetricConfig.winnerHoldBonus * tradePnL;
        }
      }
    }

    // Encourage holding winners, discourage holding losers
    if (action === ExitActions.HOLD && !isClosingTrade) {
      // If KB strongly suggests exit but agent holds, slight penalty
      if (kbContext) {
        const exitSuggestions = kbContext.alignedRules.filter(
          (r) => r.suggestedAction === 'exit'
        );
        if (exitSuggestions.length >= 2) {
          adjustedReward -= 0.02; // Small penalty for ignoring exit signals
        }
      }
    }

    return adjustedReward;
  }

  /**
   * Get explanation of reward shaping
   */
  explainShaping(result: KBRewardResult): string {
    if (!result.context) {
      return 'No KB context available for reward shaping.';
    }

    const parts: string[] = [];

    if (result.components.similarityBonus > 0) {
      parts.push(
        `+${(result.components.similarityBonus * 100).toFixed(1)}% from high concept similarity`
      );
    }

    if (result.components.alignedRulesBonus > 0) {
      parts.push(
        `+${(result.components.alignedRulesBonus * 100).toFixed(1)}% from aligned KB rules`
      );
    }

    if (result.components.conflictingRulesPenalty > 0) {
      parts.push(
        `-${(result.components.conflictingRulesPenalty * 100).toFixed(1)}% from conflicting rules`
      );
    }

    if (parts.length === 0) {
      return 'No KB-based reward adjustments.';
    }

    return `KB reward shaping: ${parts.join(', ')}. Net: ${result.bonus >= 0 ? '+' : ''}${(result.bonus * 100).toFixed(1)}%`;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<KBIntegrationConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): KBIntegrationConfig {
    return { ...this.config };
  }

  /**
   * Check if reward shaping is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled && this.config.useKBRewardShaping;
  }

  /**
   * Update asymmetric loss configuration
   */
  updateAsymmetricConfig(config: Partial<AsymmetricLossConfig>): void {
    this.asymmetricConfig = { ...this.asymmetricConfig, ...config };
  }

  /**
   * Get asymmetric loss configuration
   */
  getAsymmetricConfig(): AsymmetricLossConfig {
    return { ...this.asymmetricConfig };
  }

  /**
   * Check if asymmetric loss is enabled
   */
  isAsymmetricEnabled(): boolean {
    return this.asymmetricConfig.enabled;
  }
}
