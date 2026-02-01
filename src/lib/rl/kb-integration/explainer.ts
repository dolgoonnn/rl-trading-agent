/**
 * KB Decision Explainer
 * Generates human-readable explanations for trading decisions with KB context
 */

import type {
  KBContext,
  KBDecisionExplanation,
  KBTradingRule,
  KBRewardResult,
} from './types';
import type { ExitAction } from '../types';
import { ExitActions } from '../types';

/**
 * Detailed explanation result
 */
export interface DetailedExplanation {
  /** Summary line */
  summary: string;
  /** Action taken */
  action: string;
  /** Primary concept */
  primaryConcept?: string;
  /** Concept details */
  concepts: ConceptDetail[];
  /** Rule analysis */
  rules: RuleAnalysis;
  /** Confidence assessment */
  confidence: ConfidenceAssessment;
  /** Reward breakdown */
  rewardBreakdown?: RewardBreakdown;
}

interface ConceptDetail {
  name: string;
  similarity: number;
  relevance: 'high' | 'medium' | 'low';
  excerpt?: string;
}

interface RuleAnalysis {
  supporting: string[];
  conflicting: string[];
  neutral: string[];
  netAlignment: number;
}

interface ConfidenceAssessment {
  overall: number;
  conceptMatch: number;
  ruleAlignment: number;
  dataQuality: number;
}

interface RewardBreakdown {
  base: number;
  kbBonus: number;
  final: number;
  components: {
    similarityBonus: number;
    alignedRulesBonus: number;
    conflictPenalty: number;
  };
}

export class KBDecisionExplainer {
  /**
   * Generate full explanation for a decision
   */
  explain(
    action: ExitAction,
    kbContext: KBContext | null,
    _kbReward: KBRewardResult | null,
    _baseReward?: number
  ): KBDecisionExplanation {
    const actionName = this.actionToName(action);

    if (!kbContext || kbContext.matches.length === 0) {
      return {
        action: actionName,
        supportingConcepts: [],
        supportingRules: [],
        conflictingRules: [],
        confidence: 0,
        explanation: 'No KB context available. Decision based on market features only.',
      };
    }

    // Extract supporting concepts
    const supportingConcepts = kbContext.matches
      .filter((m) => m.similarity >= 0.5)
      .map((m) => m.concept)
      .filter((c): c is string => c !== undefined);

    // Categorize rules
    const supportingRules = kbContext.alignedRules
      .filter((r) => this.ruleSupportsAction(r, action))
      .map((r) => r.text);

    const conflictingRules = kbContext.conflictingRules.map((r) => r.text);

    // Calculate confidence
    const confidence = this.calculateConfidence(kbContext, action);

    // Generate explanation text
    const explanation = this.generateExplanationText(
      actionName,
      kbContext,
      supportingRules.length,
      conflictingRules.length,
      confidence
    );

    return {
      action: actionName,
      primaryConcept: kbContext.primaryConcept,
      supportingConcepts,
      supportingRules,
      conflictingRules,
      confidence,
      explanation,
    };
  }

  /**
   * Generate detailed explanation with all context
   */
  explainDetailed(
    action: ExitAction,
    kbContext: KBContext | null,
    kbReward: KBRewardResult | null,
    baseReward?: number
  ): DetailedExplanation {
    const actionName = this.actionToName(action);

    if (!kbContext || kbContext.matches.length === 0) {
      return {
        summary: 'Decision made without KB context',
        action: actionName,
        concepts: [],
        rules: {
          supporting: [],
          conflicting: [],
          neutral: [],
          netAlignment: 0,
        },
        confidence: {
          overall: 0,
          conceptMatch: 0,
          ruleAlignment: 0,
          dataQuality: 0,
        },
      };
    }

    // Build concept details
    const concepts: ConceptDetail[] = kbContext.matches.map((m) => ({
      name: m.concept ?? 'Unknown',
      similarity: m.similarity,
      relevance: this.getRelevanceLevel(m.similarity),
      excerpt: this.extractExcerpt(m.chunk.content),
    }));

    // Analyze rules
    const rules = this.analyzeRules(kbContext, action);

    // Assess confidence
    const confidence = this.assessConfidence(kbContext, action);

    // Build reward breakdown if available
    let rewardBreakdown: RewardBreakdown | undefined;
    if (kbReward && baseReward !== undefined) {
      rewardBreakdown = {
        base: baseReward,
        kbBonus: kbReward.bonus,
        final: baseReward * (1 + kbReward.bonus),
        components: {
          similarityBonus: kbReward.components.similarityBonus,
          alignedRulesBonus: kbReward.components.alignedRulesBonus,
          conflictPenalty: kbReward.components.conflictingRulesPenalty,
        },
      };
    }

    // Generate summary
    const summary = this.generateSummary(
      actionName,
      kbContext,
      confidence.overall
    );

    return {
      summary,
      action: actionName,
      primaryConcept: kbContext.primaryConcept,
      concepts,
      rules,
      confidence,
      rewardBreakdown,
    };
  }

  /**
   * Format explanation for console logging
   */
  formatForConsole(explanation: DetailedExplanation): string {
    const lines: string[] = [];

    lines.push('');
    lines.push('='.repeat(60));
    lines.push('KB DECISION EXPLANATION');
    lines.push('='.repeat(60));
    lines.push('');
    lines.push(`Action: ${explanation.action.toUpperCase()}`);
    lines.push(`Summary: ${explanation.summary}`);
    lines.push('');

    if (explanation.primaryConcept) {
      lines.push(`Primary Concept: ${explanation.primaryConcept}`);
    }

    if (explanation.concepts.length > 0) {
      lines.push('');
      lines.push('Matched Concepts:');
      for (const concept of explanation.concepts) {
        const relevanceIcon =
          concept.relevance === 'high'
            ? '***'
            : concept.relevance === 'medium'
              ? '**'
              : '*';
        lines.push(
          `  ${relevanceIcon} ${concept.name}: ${(concept.similarity * 100).toFixed(0)}% match`
        );
        if (concept.excerpt) {
          lines.push(`      "${concept.excerpt}"`);
        }
      }
    }

    lines.push('');
    lines.push('Rule Analysis:');
    lines.push(
      `  Supporting: ${explanation.rules.supporting.length} | Conflicting: ${explanation.rules.conflicting.length}`
    );
    lines.push(
      `  Net Alignment: ${(explanation.rules.netAlignment * 100).toFixed(0)}%`
    );

    if (explanation.rules.supporting.length > 0) {
      lines.push('');
      lines.push('  Supporting Rules:');
      for (const rule of explanation.rules.supporting.slice(0, 3)) {
        lines.push(`    + ${this.truncate(rule, 70)}`);
      }
    }

    if (explanation.rules.conflicting.length > 0) {
      lines.push('');
      lines.push('  Conflicting Rules:');
      for (const rule of explanation.rules.conflicting.slice(0, 3)) {
        lines.push(`    - ${this.truncate(rule, 70)}`);
      }
    }

    lines.push('');
    lines.push('Confidence:');
    lines.push(
      `  Overall: ${(explanation.confidence.overall * 100).toFixed(0)}%`
    );
    lines.push(
      `  Concept Match: ${(explanation.confidence.conceptMatch * 100).toFixed(0)}%`
    );
    lines.push(
      `  Rule Alignment: ${(explanation.confidence.ruleAlignment * 100).toFixed(0)}%`
    );

    if (explanation.rewardBreakdown) {
      lines.push('');
      lines.push('Reward Shaping:');
      lines.push(`  Base Reward: ${explanation.rewardBreakdown.base.toFixed(4)}`);
      lines.push(
        `  KB Bonus: ${(explanation.rewardBreakdown.kbBonus * 100).toFixed(1)}%`
      );
      lines.push(
        `  Final Reward: ${explanation.rewardBreakdown.final.toFixed(4)}`
      );
    }

    lines.push('');
    lines.push('='.repeat(60));

    return lines.join('\n');
  }

  /**
   * Format explanation as compact single line
   */
  formatCompact(explanation: KBDecisionExplanation): string {
    const parts: string[] = [];

    parts.push(`[${explanation.action}]`);

    if (explanation.primaryConcept) {
      parts.push(`concept=${explanation.primaryConcept}`);
    }

    parts.push(`conf=${(explanation.confidence * 100).toFixed(0)}%`);
    parts.push(`rules=+${explanation.supportingRules.length}/-${explanation.conflictingRules.length}`);

    return parts.join(' | ');
  }

  // ============================================
  // Helper methods
  // ============================================

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

  private calculateConfidence(
    kbContext: KBContext,
    action: ExitAction
  ): number {
    if (kbContext.matches.length === 0) return 0;

    // Base confidence from top match similarity
    const topSimilarity = kbContext.matches[0]?.similarity ?? 0;

    // Boost from aligned rules
    const supportingRulesCount = kbContext.alignedRules.filter((r) =>
      this.ruleSupportsAction(r, action)
    ).length;
    const ruleBoost = Math.min(supportingRulesCount * 0.1, 0.3);

    // Penalty from conflicting rules
    const conflictPenalty = Math.min(
      kbContext.conflictingRules.length * 0.1,
      0.2
    );

    return Math.max(0, Math.min(1, topSimilarity + ruleBoost - conflictPenalty));
  }

  private getRelevanceLevel(similarity: number): 'high' | 'medium' | 'low' {
    if (similarity >= 0.7) return 'high';
    if (similarity >= 0.5) return 'medium';
    return 'low';
  }

  private extractExcerpt(content: string, maxLength: number = 100): string {
    const cleaned = content.replace(/\s+/g, ' ').trim();
    if (cleaned.length <= maxLength) return cleaned;
    return cleaned.substring(0, maxLength - 3) + '...';
  }

  private analyzeRules(
    kbContext: KBContext,
    action: ExitAction
  ): RuleAnalysis {
    const supporting: string[] = [];
    const conflicting: string[] = [];
    const neutral: string[] = [];

    // Analyze aligned rules
    for (const rule of kbContext.alignedRules) {
      if (this.ruleSupportsAction(rule, action)) {
        supporting.push(rule.text);
      } else if (rule.suggestedAction) {
        neutral.push(rule.text);
      }
    }

    // All conflicting rules go to conflicting
    for (const rule of kbContext.conflictingRules) {
      conflicting.push(rule.text);
    }

    // Calculate net alignment
    const totalRules = supporting.length + conflicting.length + neutral.length;
    const netAlignment =
      totalRules > 0
        ? (supporting.length - conflicting.length) / totalRules
        : 0;

    return {
      supporting,
      conflicting,
      neutral,
      netAlignment,
    };
  }

  private assessConfidence(
    kbContext: KBContext,
    action: ExitAction
  ): ConfidenceAssessment {
    // Concept match confidence
    const topSimilarity = kbContext.matches[0]?.similarity ?? 0;
    const avgSimilarity =
      kbContext.matches.length > 0
        ? kbContext.matches.reduce((sum, m) => sum + m.similarity, 0) /
          kbContext.matches.length
        : 0;
    const conceptMatch = (topSimilarity + avgSimilarity) / 2;

    // Rule alignment confidence
    const supportingCount = kbContext.alignedRules.filter((r) =>
      this.ruleSupportsAction(r, action)
    ).length;
    const conflictCount = kbContext.conflictingRules.length;
    const totalRules = supportingCount + conflictCount;
    const ruleAlignment =
      totalRules > 0 ? supportingCount / totalRules : 0.5;

    // Data quality (based on number of matches and rule richness)
    const matchQuality = Math.min(kbContext.matches.length / 3, 1);
    const ruleQuality = Math.min(
      (kbContext.alignedRules.length + kbContext.conflictingRules.length) / 5,
      1
    );
    const dataQuality = (matchQuality + ruleQuality) / 2;

    // Overall confidence
    const overall = conceptMatch * 0.4 + ruleAlignment * 0.4 + dataQuality * 0.2;

    return {
      overall,
      conceptMatch,
      ruleAlignment,
      dataQuality,
    };
  }

  private generateSummary(
    _action: string,
    kbContext: KBContext,
    confidence: number
  ): string {
    const parts: string[] = [];

    if (confidence > 0.7) {
      parts.push('High confidence decision');
    } else if (confidence > 0.4) {
      parts.push('Moderate confidence decision');
    } else {
      parts.push('Low confidence decision');
    }

    if (kbContext.primaryConcept) {
      parts.push(`based on ${kbContext.primaryConcept} concept`);
    }

    if (kbContext.alignmentScore > 0.3) {
      parts.push('with KB support');
    } else if (kbContext.alignmentScore < -0.3) {
      parts.push('despite KB caution signals');
    }

    return parts.join(' ') + '.';
  }

  private generateExplanationText(
    action: string,
    kbContext: KBContext,
    supportingCount: number,
    conflictingCount: number,
    confidence: number
  ): string {
    const parts: string[] = [];

    parts.push(`Agent chose to ${action.replace('_', ' ')}.`);

    if (kbContext.primaryConcept) {
      parts.push(`Primary KB concept: ${kbContext.primaryConcept}.`);
    }

    const topMatch = kbContext.matches[0];
    if (topMatch) {
      parts.push(`Best match: ${(topMatch.similarity * 100).toFixed(0)}% similarity.`);
    }

    if (supportingCount > 0) {
      parts.push(`${supportingCount} KB rule(s) support this action.`);
    }

    if (conflictingCount > 0) {
      parts.push(`Note: ${conflictingCount} KB rule(s) suggest caution.`);
    }

    parts.push(`Confidence: ${(confidence * 100).toFixed(0)}%.`);

    return parts.join(' ');
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  }
}
