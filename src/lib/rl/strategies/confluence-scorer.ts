/**
 * Deterministic Rule-Based Confluence Scorer
 *
 * Replaces the fragile RL meta-strategy agent (1/19 pass rate) with a transparent
 * weighted scoring system grounded in ICT methodology.
 *
 * At each bar:
 * 1. Build ICT context (structure, OBs, FVGs, kill zones, liquidity, breakers)
 * 2. Run all 4 active strategies (OB, FVG, BOS continuation, CHoCH reversal)
 * 3. Score each signal against 10 confluence factors
 * 4. Take the highest-scoring signal IF it exceeds the threshold
 * 5. Otherwise WAIT (no trade)
 *
 * Every factor is documented, every score is traceable, and the system
 * is fully deterministic -- same inputs always produce same outputs.
 */

import type {
  Candle,
  BreakerBlock,
  OrderBlock,
  FairValueGap,
  StructureBreak,
} from '@/types';
import {
  checkKillZone,
  hasRecentLiquiditySweep,
  getActiveBreakers,
  isPriceAtBreaker,
  detectRegime,
  regimeLabel,
  DEFAULT_REGIME_CONFIG,
  analyzeMarketStructure,
  type MarketRegime,
  type RegimeDetectorConfig,
} from '@/lib/ict';
import type { KillZoneInfo } from '@/lib/ict/kill-zones';
import {
  ICTStrategyManager,
  type StrategySignal,
  type StrategyConfig,
  type ICTStrategyContext,
  type StrategyName,
} from './ict-strategies';

// ============================================
// Types
// ============================================

/** Tunable weight for each confluence factor */
export interface ConfluenceWeights {
  /** Market bias matches trade direction */
  structureAlignment: number;
  /** Trading during high-probability session */
  killZoneActive: number;
  /** Recent liquidity sweep confirming direction */
  liquiditySweep: number;
  /** Unmitigated order block nearby and fresh */
  obProximity: number;
  /** FVG at consequent encroachment with displacement */
  fvgAtCE: number;
  /** Recent break of structure in signal direction */
  recentBOS: number;
  /** Risk:Reward ratio meets quality threshold */
  rrRatio: number;
  /** Entry in the OTE (62%-79%) Fibonacci retracement zone */
  oteZone: number;
  /** Price at an active breaker block */
  breakerConfluence: number;
  /** Both OB and FVG present near price */
  obFvgConfluence: number;
}

/**
 * Default weights calibrated to ICT methodology priorities.
 *
 * Calibration notes (from diagnose-signals.ts):
 * - killZoneActive has NEGATIVE delta (higher in losers) → reduced from 1.5 to 0.5
 * - structureAlignment, liquiditySweep, rrRatio are most predictive of wins
 */
/**
 * Iteration 6 weights — calibrated from factor-performance correlation analysis.
 *
 * Changes from Iter 5:
 * - liquiditySweep 1.5 → 2.0 (strongest positive predictor of wins)
 * - rrRatio 1.0 → 1.5 (higher R:R trades win more often)
 * - breakerConfluence 0.25 → 0 (negatively correlated — actively harms selection)
 */
export const DEFAULT_WEIGHTS: ConfluenceWeights = {
  structureAlignment: 2.0,
  killZoneActive: 0.5,       // Weakly negative, but cheap — keep at reduced weight
  liquiditySweep: 2.0,       // Strongest positive predictor of wins
  obProximity: 1.0,
  fvgAtCE: 1.0,
  recentBOS: 1.0,
  rrRatio: 1.5,              // Strong predictor: higher R:R trades win more often
  oteZone: 0.5,
  breakerConfluence: 0,      // Disabled: negatively correlated with wins
  obFvgConfluence: 1.0,
};

/** Regime filter configuration for suppressing trades in unfavorable market conditions */
export interface RegimeFilterConfig {
  /** Enable regime-based trade suppression */
  enabled: boolean;
  /** Minimum efficiency ratio to allow trades (0-1, default: 0.25) */
  minEfficiency: number;
  /** Minimum trend strength to allow trades (0-1, default: 0.2) */
  minTrendStrength: number;
  /** Maximum ATR percentile — suppress during extreme volatility (0-1, default: 0.90) */
  maxVolatilityPercentile: number;
  /** Minimum ATR percentile — suppress during dead markets (0-1, default: 0.10) */
  minVolatilityPercentile: number;
  /** Override regime detector config (optional) */
  regimeConfig?: Partial<RegimeDetectorConfig>;
}

export const DEFAULT_REGIME_FILTER: RegimeFilterConfig = {
  enabled: false,
  minEfficiency: 0.25,
  minTrendStrength: 0.20,
  maxVolatilityPercentile: 0.90,
  minVolatilityPercentile: 0.10,
};

/** MTF (Multi-Timeframe) bias configuration */
export interface MTFBiasConfig {
  /** Enable MTF bias filtering (default: false) */
  enabled: boolean;
  /** Higher timeframe multiplier: 4 = aggregate 4 hourly candles into 1 (default: 4) */
  timeframeMultiple: number;
  /** Minimum candles needed on higher TF for structure analysis (default: 50) */
  minHigherTFCandles: number;
}

export const DEFAULT_MTF_BIAS: MTFBiasConfig = {
  enabled: false,
  timeframeMultiple: 4,
  minHigherTFCandles: 50,
};

/** Full configuration for the confluence scorer */
export interface ConfluenceConfig {
  /** Weight for each confluence factor */
  weights: ConfluenceWeights;
  /** Minimum total score to take a trade (default: 4.0) */
  minThreshold: number;
  /** Maximum age in bars for OB/FVG freshness scoring (default: 100) */
  maxStructureAge: number;
  /** Bars to look back for recent BOS (default: 30) */
  bosLookback: number;
  /** R:R threshold for the rrRatio bonus (default: 2.0) */
  minRR: number;
  /** Proximity (as fraction of price) for OB+FVG confluence check (default: 0.02) */
  obFvgProximity: number;
  /** Hard filter: reject signals below this R:R before scoring (default: 1.5) */
  minSignalRR: number;
  /** Require kill zone for entry (default: false) */
  requireKillZone: boolean;
  /** Minimum cooldown bars between same-strategy signals (default: 6) */
  cooldownBars: number;
  /** Override strategy config (e.g., tighter entry criteria for production) */
  strategyConfig: Partial<StrategyConfig>;
  /** Require momentum confirmation (3-bar close direction, default: true) */
  requireMomentum: boolean;
  /** Number of consecutive bars for momentum confirmation (default: 3) */
  momentumBars: number;
  /** Require structure alignment as hard filter, not just scored (default: true) */
  requireStructureAlignment: boolean;
  /** Regime-based trade suppression (default: disabled) */
  regimeFilter: RegimeFilterConfig;
  /** Active strategies to evaluate (default: ['order_block', 'fvg']) */
  activeStrategies: StrategyName[];
  /** Regime labels to suppress (e.g., ['ranging+normal']) — trades in these regimes are skipped */
  suppressedRegimes: string[];
  /** Multi-timeframe bias filter configuration */
  mtfBias: MTFBiasConfig;
}

export const DEFAULT_CONFLUENCE_CONFIG: ConfluenceConfig = {
  weights: { ...DEFAULT_WEIGHTS },
  minThreshold: 4.0,
  maxStructureAge: 100,
  bosLookback: 30,
  minRR: 2.0,
  obFvgProximity: 0.02,
  minSignalRR: 1.5,
  requireKillZone: false,
  cooldownBars: 6,          // Minimum 6 bars between same-strategy signals
  strategyConfig: {},
  requireMomentum: false,   // DISABLED: ICT entries are pullback-based, momentum contradicts
  momentumBars: 3,
  requireStructureAlignment: false, // Scored by confluence factor, not hard-filtered
  regimeFilter: { ...DEFAULT_REGIME_FILTER },
  activeStrategies: ['order_block', 'fvg'],
  suppressedRegimes: [],
  mtfBias: { ...DEFAULT_MTF_BIAS },
};

/**
 * Tighter strategy config for production/backtest use.
 * The default strategy config was loosened for RL exploration.
 * This restores proper ICT methodology standards.
 *
 * Key calibration notes (from diagnose-signals.ts analysis):
 * - 48% of losses hit SL within 3 bars at 1.5×ATR → widened to 2.0×ATR
 * - 65.7% of losing trades reached 0.5R+ before SL → wider stops retain winners
 * - With SL 2.0×ATR and TP 4.0×ATR, breakeven win rate is ~33%
 */
/**
 * Iteration 6 production config — 2-strategy system (OB + FVG).
 */
export const PRODUCTION_STRATEGY_CONFIG: Partial<StrategyConfig> = {
  minConfluence: 2,            // Require 2+ confluence factors
  maxStructureAge: 50,         // OBs older than 50 bars are stale (FVG capped at 30 in strategy)
  minRiskReward: 1.5,          // After widening SL, R:R drops; 1.5 is floor
  stopLossATRMultiple: 2.0,    // Wider stops: 48% of losses hit SL in 3 bars at 1.5
  takeProfitATRMultiple: 4.0,  // Higher TP for 2:1 R:R with wider stops
  proximityPercent: 0.005,     // Tighter OB touch zone
  useKillZoneFilter: false,    // Kill zones scored by confluence, not hard filtered
  killZoneConfig: {
    primaryOnly: false,
    includeAsian: true,
    minSessionQuality: 0.3,
  },
  requireLiquiditySweep: false,
  liquiditySweepBonus: 0.15,
};

/** A signal with its computed score and factor breakdown */
export interface ScoredSignal {
  /** The original strategy signal */
  signal: StrategySignal;
  /** Sum of all weighted factor scores */
  totalScore: number;
  /** Each factor name mapped to its weighted contribution (0 if not present) */
  factorBreakdown: Record<string, number>;
}

/** Result of evaluating all strategies at a given bar */
export interface ConfluenceScorerResult {
  /** The highest-scoring signal that exceeded the threshold, or null */
  selectedSignal: ScoredSignal | null;
  /** All signals scored (for diagnostics and calibration) */
  allScored: ScoredSignal[];
  /** Whether the scorer recommends a trade or waiting */
  action: 'trade' | 'wait';
  /** Human-readable reasoning for the decision */
  reasoning: string[];
  /** Detected regime at this bar (if regime filter enabled) */
  regime?: MarketRegime;
}

// ============================================
// ConfluenceScorer
// ============================================

export class ConfluenceScorer {
  private config: ConfluenceConfig;
  private strategyManager: ICTStrategyManager;
  /** Track last trade bar per strategy for cooldown */
  private lastTradeBar: Map<string, number> = new Map();
  /** Last detected regime (available after evaluate() when regime filter is enabled) */
  private lastRegime: MarketRegime | null = null;

  constructor(config?: Partial<ConfluenceConfig>) {
    this.config = {
      ...DEFAULT_CONFLUENCE_CONFIG,
      ...config,
      weights: {
        ...DEFAULT_CONFLUENCE_CONFIG.weights,
        ...config?.weights,
      },
      strategyConfig: {
        ...DEFAULT_CONFLUENCE_CONFIG.strategyConfig,
        ...config?.strategyConfig,
      },
      regimeFilter: {
        ...DEFAULT_REGIME_FILTER,
        ...config?.regimeFilter,
      },
      activeStrategies: config?.activeStrategies ?? DEFAULT_CONFLUENCE_CONFIG.activeStrategies,
      suppressedRegimes: config?.suppressedRegimes ?? DEFAULT_CONFLUENCE_CONFIG.suppressedRegimes,
      mtfBias: {
        ...DEFAULT_MTF_BIAS,
        ...config?.mtfBias,
      },
    };
    this.strategyManager = new ICTStrategyManager(this.config.strategyConfig);
  }

  /** Reset cooldown tracking (e.g., between walk-forward windows) */
  resetCooldowns(): void {
    this.lastTradeBar.clear();
  }

  // ------------------------------------------
  // Public API
  // ------------------------------------------

  /**
   * Evaluate all 4 active strategies at the current bar and return the
   * best scoring signal (if any exceeds threshold).
   *
   * This is the main entry point -- call it once per bar.
   */
  evaluate(
    candles: Candle[],
    currentIndex: number,
  ): ConfluenceScorerResult {
    const reasoning: string[] = [];
    this.lastRegime = null;

    // Use a lookback slice so all indices (OB, FVG, structure breaks)
    // are relative to this window. This fixes the index mismatch where
    // buildContext produces slice-local indices but strategies receive
    // the global currentIndex.
    const sliceStart = Math.max(0, currentIndex - 100);
    const lookbackCandles = candles.slice(sliceStart, currentIndex + 1);
    const localIndex = lookbackCandles.length - 1;

    // 1. Build ICT context using the lookback slice
    const ctx = this.strategyManager.buildContext(lookbackCandles, localIndex);

    // Kill zone hard filter (if enabled)
    if (this.config.requireKillZone) {
      const kz: KillZoneInfo = checkKillZone(ctx.timestamp);
      if (!kz.inKillZone) {
        reasoning.push('Outside kill zone -- skipping');
        return {
          selectedSignal: null,
          allScored: [],
          action: 'wait',
          reasoning,
        };
      }
    }

    // Regime filter (if enabled) — cheap early exit before expensive strategy evaluation
    if (this.config.regimeFilter.enabled) {
      const regimeConfig = this.config.regimeFilter.regimeConfig
        ? { ...DEFAULT_REGIME_CONFIG, ...this.config.regimeFilter.regimeConfig }
        : undefined;
      const regime = detectRegime(candles, currentIndex, regimeConfig);
      this.lastRegime = regime;

      const rf = this.config.regimeFilter;
      if (regime.efficiency < rf.minEfficiency && regime.trendStrength < rf.minTrendStrength) {
        reasoning.push(
          `Regime suppressed: ${regimeLabel(regime)} — ` +
          `efficiency ${regime.efficiency.toFixed(3)} < ${rf.minEfficiency}, ` +
          `trendStrength ${regime.trendStrength.toFixed(3)} < ${rf.minTrendStrength}`,
        );
        return {
          selectedSignal: null,
          allScored: [],
          action: 'wait',
          reasoning,
          regime,
        };
      }

      if (regime.atrPercentile > rf.maxVolatilityPercentile) {
        reasoning.push(
          `Regime suppressed: extreme volatility — ` +
          `ATR percentile ${regime.atrPercentile.toFixed(3)} > ${rf.maxVolatilityPercentile}`,
        );
        return {
          selectedSignal: null,
          allScored: [],
          action: 'wait',
          reasoning,
          regime,
        };
      }

      if (regime.atrPercentile < rf.minVolatilityPercentile) {
        reasoning.push(
          `Regime suppressed: dead market — ` +
          `ATR percentile ${regime.atrPercentile.toFixed(3)} < ${rf.minVolatilityPercentile}`,
        );
        return {
          selectedSignal: null,
          allScored: [],
          action: 'wait',
          reasoning,
          regime,
        };
      }
    }

    // Regime label suppression (simple label-based, independent of parametric regime filter)
    if (this.config.suppressedRegimes.length > 0) {
      // Detect regime if not already detected above
      if (!this.lastRegime) {
        const regimeConfig = this.config.regimeFilter.regimeConfig
          ? { ...DEFAULT_REGIME_CONFIG, ...this.config.regimeFilter.regimeConfig }
          : undefined;
        this.lastRegime = detectRegime(candles, currentIndex, regimeConfig);
      }
      const label = regimeLabel(this.lastRegime);
      if (this.config.suppressedRegimes.includes(label)) {
        reasoning.push(
          `Regime suppressed by label: ${label} is in suppressedRegimes list`,
        );
        return {
          selectedSignal: null,
          allScored: [],
          action: 'wait',
          reasoning,
          regime: this.lastRegime,
        };
      }
    }

    // MTF bias filter: higher timeframe structure must align with signal direction
    // Computed once per bar, stored for signal-level filtering below
    let mtfBias: 'bullish' | 'bearish' | 'neutral' | null = null;
    if (this.config.mtfBias.enabled) {
      const htfCandles = aggregateToHigherTimeframe(
        candles.slice(0, currentIndex + 1),
        this.config.mtfBias.timeframeMultiple,
      );
      if (htfCandles.length >= this.config.mtfBias.minHigherTFCandles) {
        const htfStructure = analyzeMarketStructure(htfCandles);
        mtfBias = htfStructure.bias;
        reasoning.push(`MTF bias (${this.config.mtfBias.timeframeMultiple}x): ${mtfBias}`);
      } else {
        reasoning.push(
          `MTF bias: insufficient HTF candles (${htfCandles.length} < ${this.config.mtfBias.minHigherTFCandles})`,
        );
      }
    }

    // 2. Detect breaker blocks from the same window
    const breakers = getActiveBreakers(lookbackCandles);

    // 3. Collect signals from all active strategies (using slice + local index)
    const signals: StrategySignal[] = [];
    for (const strategyName of this.config.activeStrategies) {
      // Cooldown check: skip if strategy fired too recently
      if (this.config.cooldownBars > 0) {
        const lastBar = this.lastTradeBar.get(strategyName);
        if (lastBar !== undefined && (currentIndex - lastBar) < this.config.cooldownBars) {
          continue; // Silent skip - don't spam reasoning
        }
      }

      const strategy = this.strategyManager.getStrategy(strategyName);
      const signal = strategy.detectEntry(lookbackCandles, localIndex, ctx);
      if (signal) {
        // Hard R:R filter: reject signals below minSignalRR
        if (signal.riskReward < this.config.minSignalRR) {
          reasoning.push(
            `${signal.strategy} rejected: R:R ${signal.riskReward.toFixed(2)} < ${this.config.minSignalRR}`,
          );
          continue;
        }

        // Structure alignment hard filter (except CHoCH which IS the structure event)
        if (this.config.requireStructureAlignment && signal.strategy !== 'choch_reversal') {
          const bias = ctx.structure.bias;
          const aligned =
            (bias === 'bullish' && signal.direction === 'long') ||
            (bias === 'bearish' && signal.direction === 'short');
          if (!aligned) {
            reasoning.push(
              `${signal.strategy} rejected: bias ${bias} misaligns with ${signal.direction}`,
            );
            continue;
          }
        }

        // MTF bias alignment: reject signals that contradict higher TF structure
        if (mtfBias && mtfBias !== 'neutral') {
          const aligned =
            (mtfBias === 'bullish' && signal.direction === 'long') ||
            (mtfBias === 'bearish' && signal.direction === 'short');
          if (!aligned) {
            reasoning.push(
              `${signal.strategy} rejected: MTF bias ${mtfBias} misaligns with ${signal.direction}`,
            );
            continue;
          }
        }

        // Momentum confirmation: last N bars close in signal direction
        if (this.config.requireMomentum) {
          const momentumOk = this.checkMomentum(lookbackCandles, localIndex, signal.direction);
          if (!momentumOk) {
            reasoning.push(
              `${signal.strategy} rejected: no ${this.config.momentumBars}-bar momentum for ${signal.direction}`,
            );
            continue;
          }
        }

        signals.push(signal);
      }
    }

    if (signals.length === 0) {
      reasoning.push('No strategy produced a qualifying signal at this bar');
      return {
        selectedSignal: null,
        allScored: [],
        action: 'wait',
        reasoning,
      };
    }

    // 4. Score each signal (using slice + local index for consistency)
    const allScored: ScoredSignal[] = signals.map((signal) =>
      this.scoreSignal(signal, lookbackCandles, localIndex, ctx, breakers),
    );

    // 5. Sort descending by total score
    allScored.sort((a, b) => b.totalScore - a.totalScore);

    // 6. Log all signal scores
    for (const scored of allScored) {
      reasoning.push(
        `${scored.signal.strategy} (${scored.signal.direction}): score ${scored.totalScore.toFixed(2)}`,
      );
    }

    // 7. Select the best signal if it exceeds threshold
    const best = allScored[0];
    if (best && best.totalScore >= this.config.minThreshold) {
      // Record cooldown for this strategy
      this.lastTradeBar.set(best.signal.strategy, currentIndex);

      reasoning.push(
        `Selected ${best.signal.strategy} with score ${best.totalScore.toFixed(2)} >= threshold ${this.config.minThreshold}`,
      );
      return {
        selectedSignal: best,
        allScored,
        action: 'trade',
        reasoning,
      };
    }

    // 8. Nothing passed threshold
    const topScore = best ? best.totalScore.toFixed(2) : '0';
    reasoning.push(
      `Best score ${topScore} < threshold ${this.config.minThreshold} -- waiting`,
    );
    return {
      selectedSignal: null,
      allScored,
      action: 'wait',
      reasoning,
    };
  }

  /**
   * Score a single signal against all 10 confluence factors.
   *
   * Each factor returns a value in [0, 1] which is multiplied by its weight.
   * The total is the sum of all weighted factor scores.
   */
  scoreSignal(
    signal: StrategySignal,
    candles: Candle[],
    currentIndex: number,
    ctx: ICTStrategyContext,
    breakers: BreakerBlock[],
  ): ScoredSignal {
    const w = this.config.weights;
    const breakdown: Record<string, number> = {};

    // Factor 1: Structure alignment
    const structureRaw = this.scoreStructureAlignment(signal, ctx);
    breakdown['structureAlignment'] = structureRaw * w.structureAlignment;

    // Factor 2: Kill zone active
    const killZoneRaw = this.scoreKillZone(ctx.timestamp);
    breakdown['killZoneActive'] = killZoneRaw * w.killZoneActive;

    // Factor 3: Liquidity sweep confirmation
    const sweepRaw = this.scoreLiquiditySweep(signal, candles, currentIndex);
    breakdown['liquiditySweep'] = sweepRaw * w.liquiditySweep;

    // Factor 4: OB proximity + freshness
    const obRaw = this.scoreOBProximity(signal, currentIndex);
    breakdown['obProximity'] = obRaw * w.obProximity;

    // Factor 5: FVG at CE + displacement
    const fvgRaw = this.scoreFVGQuality(signal);
    breakdown['fvgAtCE'] = fvgRaw * w.fvgAtCE;

    // Factor 6: Recent BOS in direction
    const bosRaw = this.scoreRecentBOS(signal, ctx, currentIndex);
    breakdown['recentBOS'] = bosRaw * w.recentBOS;

    // Factor 7: R:R ratio quality
    const rrRaw = this.scoreRiskReward(signal);
    breakdown['rrRatio'] = rrRaw * w.rrRatio;

    // Factor 8: OTE zone position (BOS continuation only)
    const oteRaw = this.scoreOTEZone(signal, candles, currentIndex);
    breakdown['oteZone'] = oteRaw * w.oteZone;

    // Factor 9: Breaker block confluence
    const breakerRaw = this.scoreBreakerConfluence(signal, breakers);
    breakdown['breakerConfluence'] = breakerRaw * w.breakerConfluence;

    // Factor 10: OB + FVG confluence (both present near price)
    const obFvgRaw = this.scoreOBFVGConfluence(signal, ctx);
    breakdown['obFvgConfluence'] = obFvgRaw * w.obFvgConfluence;

    const totalScore = Object.values(breakdown).reduce(
      (sum, val) => sum + val,
      0,
    );

    return {
      signal,
      totalScore,
      factorBreakdown: breakdown,
    };
  }

  /** Get the current configuration (for diagnostics) */
  getConfig(): ConfluenceConfig {
    return { ...this.config, weights: { ...this.config.weights } };
  }

  /** Get the underlying strategy manager (for exit checking during position hold) */
  getStrategyManager(): ICTStrategyManager {
    return this.strategyManager;
  }

  /**
   * Build ICT context for a given bar (for use during position management).
   * Uses the same lookback-slice approach as evaluate().
   */
  buildContextAt(candles: Candle[], currentIndex: number): ICTStrategyContext {
    const sliceStart = Math.max(0, currentIndex - 100);
    const lookbackCandles = candles.slice(sliceStart, currentIndex + 1);
    const localIndex = lookbackCandles.length - 1;
    return this.strategyManager.buildContext(lookbackCandles, localIndex);
  }

  /** Update weights at runtime (for calibration scripts) */
  setWeights(weights: Partial<ConfluenceWeights>): void {
    this.config.weights = { ...this.config.weights, ...weights };
  }

  /** Update threshold at runtime (for calibration scripts) */
  setThreshold(threshold: number): void {
    this.config.minThreshold = threshold;
  }

  /** Get last detected regime (null if regime filter disabled or not yet evaluated) */
  getLastRegime(): MarketRegime | null {
    return this.lastRegime;
  }

  /** Update regime filter at runtime (for calibration scripts) */
  setRegimeFilter(filter: Partial<RegimeFilterConfig>): void {
    this.config.regimeFilter = { ...this.config.regimeFilter, ...filter };
  }

  /** Update active strategies at runtime (for A/B testing) */
  setActiveStrategies(strategies: StrategyName[]): void {
    this.config.activeStrategies = strategies;
  }

  /** Update suppressed regimes at runtime */
  setSuppressedRegimes(regimes: string[]): void {
    this.config.suppressedRegimes = regimes;
  }

  /** Update MTF bias config at runtime */
  setMTFBias(config: Partial<MTFBiasConfig>): void {
    this.config.mtfBias = { ...this.config.mtfBias, ...config };
  }

  // ------------------------------------------
  // Hard Filter Helpers
  // ------------------------------------------

  /**
   * Check if the last N candles show momentum in the signal direction.
   * For long: last N candles all closed higher than they opened (bullish closes)
   * For short: last N candles all closed lower than they opened (bearish closes)
   *
   * This filters out entries where the immediate price action contradicts
   * the signal direction (e.g., going long during a bearish run).
   */
  private checkMomentum(
    candles: Candle[],
    currentIndex: number,
    direction: 'long' | 'short',
  ): boolean {
    const barsToCheck = this.config.momentumBars;

    // Need enough history
    if (currentIndex < barsToCheck) return false;

    let confirmCount = 0;
    for (let i = currentIndex - barsToCheck + 1; i <= currentIndex; i++) {
      const c = candles[i];
      if (!c) return false;

      if (direction === 'long' && c.close > c.open) confirmCount++;
      if (direction === 'short' && c.close < c.open) confirmCount++;
    }

    // Require majority (at least N-1 out of N) to allow one doji/indecision
    return confirmCount >= barsToCheck - 1;
  }

  // ------------------------------------------
  // Factor Scoring Functions
  // ------------------------------------------

  /**
   * Factor 1: Structure Alignment (0 or 1)
   *
   * Market bias must match trade direction:
   * - Bullish bias + long signal = 1.0
   * - Bearish bias + short signal = 1.0
   * - For CHoCH reversal, check for recent CHoCH in signal direction instead
   * - Mismatch = 0
   */
  private scoreStructureAlignment(
    signal: StrategySignal,
    ctx: ICTStrategyContext,
  ): number {
    // CHoCH reversal is a special case -- the bias may not yet have updated
    // but the CHoCH itself IS the structure event that matters
    if (signal.strategy === 'choch_reversal' && signal.structureBreak) {
      const choch = signal.structureBreak;
      if (choch.type === 'choch' && choch.direction === signalToBias(signal.direction)) {
        return 1;
      }
    }

    const bias = ctx.structure.bias;
    if (bias === 'neutral') return 0;

    if (
      (bias === 'bullish' && signal.direction === 'long') ||
      (bias === 'bearish' && signal.direction === 'short')
    ) {
      return 1;
    }

    return 0;
  }

  /**
   * Factor 2: Kill Zone Active (0 / 0.3 / 0.7 / 1.0)
   *
   * Fractional scoring based on session priority:
   * - London Open / NY Open (priority 3) = 1.0
   * - London Close (priority 2) = 0.7
   * - Asian Session (priority 1) = 0.3
   * - Outside all kill zones = 0
   */
  private scoreKillZone(timestamp: number): number {
    const kz: KillZoneInfo = checkKillZone(timestamp);

    if (!kz.inKillZone) return 0;

    switch (kz.priority) {
      case 3: return 1.0;   // London Open, NY Open
      case 2: return 0.7;   // London Close
      case 1: return 0.3;   // Asian
      default: return 0;
    }
  }

  /**
   * Factor 3: Liquidity Sweep Confirmation (0 or 1)
   *
   * For long signals: check for recent SSL sweep (sell-side liquidity taken)
   * For short signals: check for recent BSL sweep (buy-side liquidity taken)
   */
  private scoreLiquiditySweep(
    signal: StrategySignal,
    candles: Candle[],
    currentIndex: number,
  ): number {
    const result = hasRecentLiquiditySweep(
      candles,
      currentIndex,
      signal.direction,
    );
    return result.hasSweep ? 1 : 0;
  }

  /**
   * Factor 4: OB Proximity + Freshness (0 to 1, continuous)
   *
   * Only applies if the signal references an order block.
   * Freshness scoring:
   * - Age < 20 bars: 1.0
   * - Age < 50 bars: 0.7
   * - Age < maxStructureAge: 0.3
   * - Older or mitigated: 0
   */
  private scoreOBProximity(
    signal: StrategySignal,
    currentIndex: number,
  ): number {
    const ob: OrderBlock | undefined = signal.orderBlock;
    if (!ob) return 0;
    if (ob.status !== 'unmitigated') return 0;

    const age = currentIndex - ob.index;
    if (age < 0) return 0;

    if (age < 20) return 1.0;
    if (age < 50) return 0.7;
    if (age < this.config.maxStructureAge) return 0.3;

    return 0;
  }

  /**
   * Factor 5: FVG at CE + Displacement (0 to 1, continuous)
   *
   * Only applies if the signal references an FVG.
   * - Base score for having an FVG: 0.5
   * - Displacement bonus: +0.3 if FVG formed from displacement
   * - Size bonus: up to +0.2 based on FVG size percentage
   *   (sizePercent * 10, capped at 0.2)
   */
  private scoreFVGQuality(signal: StrategySignal): number {
    const fvg: FairValueGap | undefined = signal.fvg;
    if (!fvg) return 0;
    if (fvg.status === 'filled') return 0;

    let score = 0.5;

    if (fvg.displacement) {
      score += 0.3;
    }

    // Size bonus: larger FVGs are more significant
    // sizePercent of 0.02 (2%) would give full 0.2 bonus
    score += Math.min(0.2, fvg.sizePercent * 10);

    return Math.min(1, score);
  }

  /**
   * Factor 6: Recent BOS in Direction (0 or 1)
   *
   * Checks for a BOS within `bosLookback` bars, in the signal direction,
   * with confidence >= 0.5.
   */
  private scoreRecentBOS(
    signal: StrategySignal,
    ctx: ICTStrategyContext,
    currentIndex: number,
  ): number {
    const targetDirection = signalToBias(signal.direction);

    const recentBOS = ctx.structure.structureBreaks.find(
      (sb: StructureBreak) =>
        sb.type === 'bos' &&
        sb.direction === targetDirection &&
        currentIndex - sb.breakIndex <= this.config.bosLookback &&
        sb.confidence >= 0.5,
    );

    return recentBOS ? 1 : 0;
  }

  /**
   * Factor 7: R:R Ratio Quality (0 or 1)
   *
   * Checks if signal.riskReward >= config.minRR (default 2.0).
   */
  private scoreRiskReward(signal: StrategySignal): number {
    return signal.riskReward >= this.config.minRR ? 1 : 0;
  }

  /**
   * Factor 8: OTE Zone Position (0 or 1)
   *
   * Only applies to `bos_continuation` signals with a structureBreak reference.
   * Checks if the entry price is in the 62%-79% Fibonacci retracement zone.
   *
   * For bullish BOS: retracement = (swingHigh - entryPrice) / (swingHigh - swingLow)
   * For bearish BOS: retracement = (entryPrice - swingLow) / (swingHigh - swingLow)
   *
   * OTE zone: retracement in [0.62, 0.79]
   */
  private scoreOTEZone(
    signal: StrategySignal,
    _candles: Candle[],
    _currentIndex: number,
  ): number {
    // Only applies to BOS continuation strategy
    if (signal.strategy !== 'bos_continuation') return 0;

    const sb: StructureBreak | undefined = signal.structureBreak;
    if (!sb) return 0;

    let retracement: number;

    if (sb.direction === 'bullish') {
      const swingLow = sb.brokenSwing.price;
      const swingHigh = sb.breakCandle.high;
      const swingRange = swingHigh - swingLow;
      if (swingRange <= 0) return 0;
      retracement = (swingHigh - signal.entryPrice) / swingRange;
    } else {
      const swingHigh = sb.brokenSwing.price;
      const swingLow = sb.breakCandle.low;
      const swingRange = swingHigh - swingLow;
      if (swingRange <= 0) return 0;
      retracement = (signal.entryPrice - swingLow) / swingRange;
    }

    // OTE zone: 62% to 79%
    if (retracement >= 0.62 && retracement <= 0.79) {
      return 1;
    }

    return 0;
  }

  /**
   * Factor 9: Breaker Block Confluence (0 or 1)
   *
   * Checks if the current price is at an active breaker block
   * whose direction matches the signal direction.
   * - Bullish breaker (support) matches long signals
   * - Bearish breaker (resistance) matches short signals
   */
  private scoreBreakerConfluence(
    signal: StrategySignal,
    breakers: BreakerBlock[],
  ): number {
    const result = isPriceAtBreaker(signal.entryPrice, breakers);

    if (!result.atBreaker || !result.breaker) return 0;

    // Breaker direction must match signal direction
    // bullish breaker -> long, bearish breaker -> short
    if (
      (result.breaker.type === 'bullish' && signal.direction === 'long') ||
      (result.breaker.type === 'bearish' && signal.direction === 'short')
    ) {
      return 1;
    }

    return 0;
  }

  /**
   * Factor 10: OB + FVG Confluence (0 or 1)
   *
   * Both an unmitigated OB and an unfilled FVG must be present
   * near the current price (within obFvgProximity) and aligned
   * with the signal direction.
   */
  private scoreOBFVGConfluence(
    signal: StrategySignal,
    ctx: ICTStrategyContext,
  ): number {
    const price = ctx.currentPrice;
    const proximity = this.config.obFvgProximity;

    if (signal.direction === 'long') {
      // Need bullish OB near price
      const hasBullishOB = ctx.orderBlocks.some(
        (ob: OrderBlock) =>
          ob.type === 'bullish' &&
          ob.status === 'unmitigated' &&
          Math.abs(price - ob.high) / price <= proximity,
      );

      // Need bullish FVG near price
      const hasBullishFVG = ctx.fvgs.some(
        (fvg: FairValueGap) =>
          fvg.type === 'bullish' &&
          fvg.status !== 'filled' &&
          Math.abs(price - fvg.high) / price <= proximity,
      );

      return hasBullishOB && hasBullishFVG ? 1 : 0;
    } else {
      // Need bearish OB near price
      const hasBearishOB = ctx.orderBlocks.some(
        (ob: OrderBlock) =>
          ob.type === 'bearish' &&
          ob.status === 'unmitigated' &&
          Math.abs(price - ob.low) / price <= proximity,
      );

      // Need bearish FVG near price
      const hasBearishFVG = ctx.fvgs.some(
        (fvg: FairValueGap) =>
          fvg.type === 'bearish' &&
          fvg.status !== 'filled' &&
          Math.abs(price - fvg.low) / price <= proximity,
      );

      return hasBearishOB && hasBearishFVG ? 1 : 0;
    }
  }
}

// ============================================
// Helpers
// ============================================

/**
 * Aggregate lower-timeframe candles into higher-timeframe candles.
 * E.g., 1H candles with multiple=4 → 4H candles.
 *
 * Groups candles in chunks of `multiple` from the start.
 * Incomplete final chunk is dropped to avoid partial candles.
 */
export function aggregateToHigherTimeframe(
  candles: Candle[],
  multiple: number,
): Candle[] {
  if (multiple <= 1) return candles;

  const result: Candle[] = [];
  const fullChunks = Math.floor(candles.length / multiple);

  for (let i = 0; i < fullChunks; i++) {
    const start = i * multiple;
    const chunk = candles.slice(start, start + multiple);
    const first = chunk[0]!;
    const last = chunk[chunk.length - 1]!;

    result.push({
      timestamp: first.timestamp,
      open: first.open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: last.close,
      volume: chunk.reduce((sum, c) => sum + c.volume, 0),
    });
  }

  return result;
}

/** Map signal direction to structure bias label */
function signalToBias(direction: 'long' | 'short'): 'bullish' | 'bearish' {
  return direction === 'long' ? 'bullish' : 'bearish';
}
