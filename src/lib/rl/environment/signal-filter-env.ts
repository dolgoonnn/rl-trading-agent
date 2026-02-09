/**
 * Signal Filter Environment
 *
 * Fundamentally different from weight optimizer:
 * PPO sees each INDIVIDUAL signal (not aggregate bars) and decides take/skip.
 *
 * Key differences:
 * 1. Action is binary: take (1) or skip (0) — direct mapping to outcome
 * 2. State includes signal-specific features (score, R:R, direction, regime)
 * 3. Reward is immediate: trade PnL for take, 0 for skip
 * 4. No temporal credit assignment problem — each decision is independent
 *
 * This is a contextual bandit, not a sequential MDP.
 * Simpler, more direct, and avoids the credit assignment failure of weight optimizer.
 */

import type { Candle } from '@/types';
import {
  ConfluenceScorer,
  type ConfluenceConfig,
  type ScoredSignal,
  PRODUCTION_STRATEGY_CONFIG,
} from '../strategies/confluence-scorer';
import {
  detectRegime,
  regimeLabel,
  type MarketRegime,
} from '@/lib/ict';

// ============================================
// Types
// ============================================

export interface SignalFilterConfig {
  /** Base confluence config (with low threshold to generate candidates) */
  confluenceConfig: Partial<ConfluenceConfig>;
  /** Commission per side */
  commission: number;
  /** Slippage per side */
  slippage: number;
  /** Max bars to hold a position */
  maxHoldBars: number;
}

const DEFAULT_CONFIG: SignalFilterConfig = {
  confluenceConfig: {
    activeStrategies: ['order_block'],
    minThreshold: 2.0, // Very low — let PPO decide the quality cutoff
    suppressedRegimes: ['ranging+normal', 'ranging+high', 'downtrend+high'],
    obFreshnessHalfLife: 15,
    atrExtensionBands: 3.0,
    strategyConfig: {
      ...PRODUCTION_STRATEGY_CONFIG,
      slPlacementMode: 'dynamic_rr' as const,
    },
  },
  commission: 0.0005,
  slippage: 0.0002,
  maxHoldBars: 72,
};

/** 12-dimensional state for the signal filter */
export const SIGNAL_FILTER_STATE_SIZE = 12;
/** Binary action: 0=skip, 1=take */
export const SIGNAL_FILTER_ACTION_SIZE = 2;

export interface SignalCandidate {
  signal: ScoredSignal;
  state: number[];
  candleIndex: number;
}

export interface SignalOutcome {
  pnl: number;
  won: boolean;
  exitBars: number;
}

// ============================================
// Environment
// ============================================

export class SignalFilterEnvironment {
  private config: SignalFilterConfig;
  private scorer: ConfluenceScorer;

  constructor(config: Partial<SignalFilterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.scorer = new ConfluenceScorer(this.config.confluenceConfig);
  }

  /**
   * Scan candles and collect all candidate signals with their states.
   * Returns signal+state pairs that PPO will decide on (take/skip).
   */
  collectCandidates(
    candles: Candle[],
    startIndex: number,
    endIndex: number,
  ): SignalCandidate[] {
    const candidates: SignalCandidate[] = [];
    let inPosition = false;
    let positionExitBar = -1;

    this.scorer.resetCooldowns();

    for (let i = startIndex; i < endIndex; i++) {
      if (!candles[i]) continue;

      // Skip if in position (no overlapping trades)
      if (inPosition && i <= positionExitBar) continue;
      inPosition = false;

      const result = this.scorer.evaluate(candles, i);

      if (result.action === 'trade' && result.selectedSignal) {
        const scored = result.selectedSignal;
        const state = this.buildSignalState(scored, candles, i, result.regime ?? null);

        candidates.push({
          signal: scored,
          state,
          candleIndex: i,
        });

        // Assume taken for cooldown purposes — simulate position
        inPosition = true;
        positionExitBar = i + this.config.maxHoldBars;
      }
    }

    return candidates;
  }

  /**
   * Simulate taking a signal and compute the outcome.
   */
  simulateOutcome(
    candles: Candle[],
    signal: ScoredSignal,
    entryIndex: number,
  ): SignalOutcome {
    const sig = signal.signal;
    const friction = this.config.commission + this.config.slippage;

    const entryPrice = sig.direction === 'long'
      ? sig.entryPrice * (1 + friction)
      : sig.entryPrice * (1 - friction);

    for (let bar = entryIndex + 1; bar < entryIndex + this.config.maxHoldBars && bar < candles.length; bar++) {
      const candle = candles[bar];
      if (!candle) break;

      const slHit = sig.direction === 'long'
        ? candle.low <= sig.stopLoss
        : candle.high >= sig.stopLoss;
      const tpHit = sig.direction === 'long'
        ? candle.high >= sig.takeProfit
        : candle.low <= sig.takeProfit;

      let exitPrice: number | null = null;
      if (slHit) exitPrice = sig.stopLoss;
      else if (tpHit) exitPrice = sig.takeProfit;
      else if (bar === entryIndex + this.config.maxHoldBars - 1) exitPrice = candle.close;

      if (exitPrice !== null) {
        exitPrice = sig.direction === 'long'
          ? exitPrice * (1 - friction)
          : exitPrice * (1 + friction);

        const pnl = sig.direction === 'long'
          ? (exitPrice - entryPrice) / entryPrice
          : (entryPrice - exitPrice) / entryPrice;

        return { pnl, won: pnl > 0, exitBars: bar - entryIndex };
      }
    }

    // Fallback: close at last available candle
    const lastCandle = candles[Math.min(entryIndex + this.config.maxHoldBars - 1, candles.length - 1)];
    const exitPrice = lastCandle ? lastCandle.close : sig.entryPrice;
    const adjExitPrice = sig.direction === 'long'
      ? exitPrice * (1 - friction)
      : exitPrice * (1 + friction);
    const pnl = sig.direction === 'long'
      ? (adjExitPrice - entryPrice) / entryPrice
      : (entryPrice - adjExitPrice) / entryPrice;

    return { pnl, won: pnl > 0, exitBars: this.config.maxHoldBars };
  }

  // ============================================
  // State Building
  // ============================================

  /**
   * Build 12-dimensional state for a signal candidate.
   *
   * Features:
   * [0] confluenceScore: normalized (score / 10)
   * [1] riskReward: signal R:R ratio normalized (rr / 5)
   * [2] direction: 1 = long, -1 = short
   * [3] regimeTrend: 1 = uptrend, -1 = downtrend, 0 = ranging
   * [4] regimeVolatility: 0 = low, 0.5 = normal, 1 = high
   * [5] trendStrength: 0-1
   * [6] efficiency: 0-1
   * [7] atrPercentile: 0-1
   * [8] structureAlignScore: factor score / max weight (0-1)
   * [9] liquiditySweepScore: factor score / max weight (0-1)
   * [10] obFreshnessScore: obProximity factor / max weight (0-1)
   * [11] rrScore: rrRatio factor / max weight (0-1)
   */
  private buildSignalState(
    scored: ScoredSignal,
    candles: Candle[],
    currentIndex: number,
    regime: MarketRegime | null,
  ): number[] {
    const state: number[] = [];

    // Signal features (4)
    state.push(clamp(scored.totalScore / 10, 0, 1));
    const rr = scored.signal.takeProfit && scored.signal.stopLoss
      ? Math.abs(scored.signal.takeProfit - scored.signal.entryPrice) /
        Math.abs(scored.signal.entryPrice - scored.signal.stopLoss)
      : 2.0;
    state.push(clamp(rr / 5, 0, 1));
    state.push(scored.signal.direction === 'long' ? 1 : -1);

    // Regime features (5)
    if (regime) {
      const label = regimeLabel(regime);
      state.push(label.startsWith('uptrend') ? 1 : label.startsWith('downtrend') ? -1 : 0);
      state.push(label.endsWith('+high') ? 1 : label.endsWith('+low') ? 0 : 0.5);
      state.push(regime.trendStrength);
      state.push(regime.efficiency);
      state.push(regime.atrPercentile);
    } else {
      state.push(0, 0.5, 0, 0, 0.5);
    }

    // Factor breakdown features (4) — the most predictive factors
    const bd = scored.factorBreakdown;
    state.push(clamp((bd['structureAlignment'] ?? 0) / 2, 0, 1));
    state.push(clamp((bd['liquiditySweep'] ?? 0) / 2, 0, 1));
    state.push(clamp((bd['obProximity'] ?? 0) / 1, 0, 1));
    state.push(clamp((bd['rrRatio'] ?? 0) / 1.5, 0, 1));

    return state;
  }
}

function clamp(v: number, min: number, max: number): number {
  if (!isFinite(v)) return 0;
  return Math.max(min, Math.min(max, v));
}
