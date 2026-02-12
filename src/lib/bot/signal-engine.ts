/**
 * Signal Engine — Wraps ICT Detectors + Confluence Scorer for Live Use
 *
 * Takes candle arrays and produces scored trade signals using the
 * same ConfluenceScorer and ICT detectors used in backtesting.
 * Ensures zero simulation mismatch between backtest and live.
 */

import type { Candle } from '@/types/candle';
import type { BotSymbol } from '@/types/bot';
import {
  ConfluenceScorer,
  type ConfluenceScorerResult,
  type ScoredSignal,
  PRODUCTION_STRATEGY_CONFIG,
} from '@/lib/rl/strategies/confluence-scorer';
import { regimeLabel } from '@/lib/ict/regime-detector';
import type { StrategyConfig } from '@/types/bot';

export interface SignalResult {
  /** Whether a trade signal was produced */
  hasSignal: boolean;
  /** The scored signal if produced */
  signal: ScoredSignal | null;
  /** Current regime label */
  regime: string;
  /** Reasoning for the decision */
  reasoning: string[];
  /** All signals scored (for diagnostics) */
  allScored: ScoredSignal[];
}

export class SignalEngine {
  private scorers: Map<string, ConfluenceScorer> = new Map();
  private config: StrategyConfig;

  constructor(config: StrategyConfig) {
    this.config = config;
  }

  /**
   * Evaluate a candle array and return the best signal if any.
   * This is the primary entry point — call once per symbol per bar.
   *
   * @param candles Full candle history for the symbol (chronological)
   * @param symbol Symbol being evaluated
   * @returns SignalResult with signal details
   */
  evaluate(candles: Candle[], symbol: BotSymbol): SignalResult {
    const scorer = this.getOrCreateScorer(symbol);
    const currentIndex = candles.length - 1;

    if (currentIndex < 50) {
      return {
        hasSignal: false,
        signal: null,
        regime: 'unknown',
        reasoning: ['Insufficient candle history for analysis'],
        allScored: [],
      };
    }

    const result: ConfluenceScorerResult = scorer.evaluate(candles, currentIndex);

    const regime = result.regime
      ? regimeLabel(result.regime)
      : (scorer.getLastRegime() ? regimeLabel(scorer.getLastRegime()!) : 'unknown');

    return {
      hasSignal: result.action === 'trade' && result.selectedSignal !== null,
      signal: result.selectedSignal,
      regime,
      reasoning: result.reasoning,
      allScored: result.allScored,
    };
  }

  /**
   * Get or create a ConfluenceScorer for a symbol.
   * Each symbol gets its own scorer to maintain independent cooldown tracking.
   */
  private getOrCreateScorer(symbol: BotSymbol): ConfluenceScorer {
    let scorer = this.scorers.get(symbol);
    if (!scorer) {
      scorer = new ConfluenceScorer({
        weights: { ...this.config.weights },
        minThreshold: this.config.baseThreshold,
        activeStrategies: this.config.activeStrategies,
        suppressedRegimes: this.config.suppressedRegimes,
        obFreshnessHalfLife: this.config.obHalfLife,
        atrExtensionBands: this.config.atrExtensionBands,
        cooldownBars: this.config.cooldownBars,
        regimeThresholdOverrides: this.config.regimeThresholds,
        strategyConfig: {
          ...PRODUCTION_STRATEGY_CONFIG,
        },
      });
      this.scorers.set(symbol, scorer);
    }
    return scorer;
  }

  /** Reset all scorer cooldowns (e.g., after a restart) */
  resetCooldowns(): void {
    for (const scorer of this.scorers.values()) {
      scorer.resetCooldowns();
    }
  }

  /** Get the underlying scorer for a symbol (for diagnostics) */
  getScorer(symbol: BotSymbol): ConfluenceScorer | undefined {
    return this.scorers.get(symbol);
  }
}
