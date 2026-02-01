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

export class KBRewardShaper {
  private config: KBIntegrationConfig;

  constructor(config: Partial<KBIntegrationConfig> = {}) {
    this.config = { ...DEFAULT_KB_CONFIG, ...config };
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
   * Apply KB bonus to base reward
   */
  shapeReward(
    baseReward: number,
    kbContext: KBContext | null,
    action: ExitAction,
    positionSide: 'long' | 'short'
  ): { reward: number; result: KBRewardResult } {
    const result = this.calculateKBBonus(baseReward, kbContext, action, positionSide);

    // Apply bonus as percentage of |baseReward| or absolute if base is zero
    let shapedReward = baseReward;
    if (Math.abs(baseReward) > 0.01) {
      shapedReward = baseReward * (1 + result.bonus);
    } else {
      shapedReward = baseReward + result.bonus * 0.1; // Small absolute bonus
    }

    return {
      reward: shapedReward,
      result,
    };
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
}
