/**
 * Signal Engine — Wraps ICT Detectors + Confluence Scorer for Live Use
 *
 * Takes candle arrays and produces scored trade signals using the
 * same ConfluenceScorer and ICT detectors used in backtesting.
 * Ensures zero simulation mismatch between backtest and live.
 */

import type { Candle } from '@/types/candle';
import type { BotSymbol, StrategyConfig } from '@/types/bot';
import {
  ConfluenceScorer,
  type ConfluenceWeights,
  type ConfluenceScorerResult,
  type ScoredSignal,
  PRODUCTION_STRATEGY_CONFIG,
} from '@/lib/rl/strategies/confluence-scorer';
import { regimeLabel } from '@/lib/ict/regime-detector';
import { RUN18_STRATEGY_CONFIG } from './config';

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
  /** Per-symbol strategy config override. */
  private configOverrides: Map<string, StrategyConfig> = new Map();

  /**
   * Create a signal engine.
   * @param defaultConfig Default strategy config (defaults to RUN18_STRATEGY_CONFIG)
   */
  constructor(defaultConfig?: StrategyConfig) {
    if (defaultConfig) {
      this.configOverrides.set('__default__', defaultConfig);
    }
  }

  /**
   * Set a strategy config override for a specific symbol.
   * Clears any cached scorer for the symbol.
   */
  setSymbolConfig(symbol: string, config: StrategyConfig): void {
    this.configOverrides.set(symbol, config);
    this.scorers.delete(symbol); // Force re-creation with new config
  }

  /**
   * Evaluate a candle array and return the best signal if any.
   * This is the primary entry point — call once per symbol per bar.
   *
   * @param candles Full candle history for the symbol (chronological)
   * @param symbol Symbol being evaluated
   * @param currentIndex Optional explicit index into the candle array. Defaults to
   *   candles.length - 1. Pass this when the candle array is the full dataset and
   *   you want to evaluate at a specific point (e.g., replay/backtest mode).
   * @returns SignalResult with signal details
   */
  evaluate(candles: Candle[], symbol: BotSymbol, currentIndex?: number): SignalResult {
    const scorer = this.getOrCreateScorer(symbol);
    const idx = currentIndex ?? candles.length - 1;

    if (idx < 50) {
      return {
        hasSignal: false,
        signal: null,
        regime: 'unknown',
        reasoning: ['Insufficient candle history for analysis'],
        allScored: [],
      };
    }

    const result: ConfluenceScorerResult = scorer.evaluate(candles, idx);

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
   * Each symbol gets its own scorer instance with shared config.
   */
  private getOrCreateScorer(symbol: BotSymbol): ConfluenceScorer {
    let scorer = this.scorers.get(symbol);
    if (!scorer) {
      const config = this.configOverrides.get(symbol)
        ?? this.configOverrides.get('__default__')
        ?? RUN18_STRATEGY_CONFIG;

      scorer = new ConfluenceScorer({
        weights: config.weights as unknown as ConfluenceWeights,
        minThreshold: config.baseThreshold,
        activeStrategies: config.activeStrategies,
        suppressedRegimes: config.suppressedRegimes,
        obFreshnessHalfLife: config.obHalfLife,
        atrExtensionBands: config.atrExtensionBands,
        cooldownBars: config.cooldownBars,
        regimeThresholdOverrides: config.regimeThresholds,
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
