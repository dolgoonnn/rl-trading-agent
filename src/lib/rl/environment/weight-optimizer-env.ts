/**
 * Weight Optimizer Environment
 *
 * RL environment where PPO learns regime-adaptive weight multipliers
 * for the 10 confluence scoring factors.
 *
 * Key design principles:
 * 1. RL doesn't pick strategies — the confluence scorer does that.
 * 2. PPO outputs MULTIPLIERS on the base weights (not raw weights).
 * 3. Preserves domain knowledge (calibrated base weights) while allowing adaptation.
 * 4. Tiny state/action space (~14 features, 10 outputs, ~1K params) to prevent memorization.
 *
 * Episode structure:
 *   - One episode = one walk-forward window (720 bars / 1 month)
 *   - Every N bars (default: 24 = 1 day): PPO observes state, outputs multipliers
 *   - Confluence scorer runs with adjusted weights for next N bars
 *   - Reward = risk-adjusted PnL of trades in that window
 */

import type { Candle } from '@/types';
import type { FuturesSnapshot } from '@/lib/data/binance-futures-api';
import {
  ConfluenceScorer,
  type ConfluenceWeights,
  type ConfluenceConfig,
  PRODUCTION_STRATEGY_CONFIG,
} from '../strategies/confluence-scorer';
import {
  detectRegime,
  regimeLabel,
  type MarketRegime,
} from '@/lib/ict';
import {
  buildOrderFlowFeatures,
  type OrderFlowFeatures,
} from './order-flow-features';

// ============================================
// Types
// ============================================

export interface WeightOptimizerConfig {
  /** How many bars between PPO decisions (default: 24 = ~1 day) */
  decisionInterval: number;
  /** Episode length in bars (default: 720 = ~1 month) */
  episodeLength: number;
  /** Commission per side (default: 0.001 = 0.1%) */
  commission: number;
  /** Slippage per side (default: 0.0005 = 0.05%) */
  slippage: number;
  /** Max bars to hold a position (default: 72) */
  maxHoldBars: number;
  /** Confluence scorer base config */
  confluenceConfig: Partial<ConfluenceConfig>;
  /** Log-space scale for multiplier mapping: mult = exp(action * multiplierScale).
   *  action=0 → mult=1.0, action=±1 → mult ∈ [exp(-scale), exp(scale)].
   *  Default 0.7 → range [0.5, 2.0]. */
  multiplierScale: number;
}

const DEFAULT_CONFIG: WeightOptimizerConfig = {
  decisionInterval: 24,
  episodeLength: 720,
  commission: 0.0005,   // Maker fee: 0.05%/side
  slippage: 0.0002,     // Minimal slippage with limit orders: 0.02%/side
  maxHoldBars: 72,
  confluenceConfig: {
    activeStrategies: ['order_block'],
    minThreshold: 3.5,
    suppressedRegimes: ['ranging+normal', 'ranging+high', 'downtrend+high'],
    obFreshnessHalfLife: 15,
    atrExtensionBands: 3.0,
    strategyConfig: {
      ...PRODUCTION_STRATEGY_CONFIG,
      slPlacementMode: 'dynamic_rr' as const,
    },
  },
  multiplierScale: 0.7, // exp(±0.7) ≈ [0.50, 2.01]
};

/** 14-dimensional state for PPO */
export interface WeightOptimizerState {
  features: number[];
}

/** Names of the 10 weights that PPO adjusts */
export const WEIGHT_NAMES: (keyof ConfluenceWeights)[] = [
  'structureAlignment',
  'killZoneActive',
  'liquiditySweep',
  'obProximity',
  'fvgAtCE',
  'recentBOS',
  'rrRatio',
  'oteZone',
  'breakerConfluence',
  'obFvgConfluence',
];

/**
 * Compact action space: 3 dimensions instead of 10.
 * Maps agent outputs to weight groups:
 *   action[0] = global multiplier (scales ALL weights uniformly)
 *   action[1] = structure bias (structureAlignment, recentBOS, killZoneActive)
 *   action[2] = proximity bias (obProximity, fvgAtCE, oteZone, breakerConfluence, obFvgConfluence)
 * Remaining weights (liquiditySweep, rrRatio) use only the global multiplier.
 */
export const COMPACT_ACTION_SIZE = 3;

const STRUCTURE_WEIGHTS: (keyof ConfluenceWeights)[] = [
  'structureAlignment', 'recentBOS', 'killZoneActive',
];
const PROXIMITY_WEIGHTS: (keyof ConfluenceWeights)[] = [
  'obProximity', 'fvgAtCE', 'oteZone', 'breakerConfluence', 'obFvgConfluence',
];

export const STATE_SIZE = 14; // 6 regime + 4 order flow + 4 performance
export const ACTION_SIZE = COMPACT_ACTION_SIZE; // 3 (was 10)

/** Result of one PPO step */
export interface WeightOptimizerStepResult {
  state: WeightOptimizerState;
  reward: number;
  done: boolean;
  info: {
    trades: number;
    wins: number;
    pnl: number;
    barsProcessed: number;
    currentMultipliers: Record<string, number>;
  };
}

// ============================================
// Simple Trade Tracker
// ============================================

interface SimplePosition {
  side: 'long' | 'short';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  entryBar: number;
}

interface SimpleTradeResult {
  pnl: number;
  won: boolean;
}

// ============================================
// Environment
// ============================================

export class WeightOptimizerEnvironment {
  private config: WeightOptimizerConfig;
  private scorer: ConfluenceScorer;

  // Episode state
  private candles: Candle[] = [];
  private futuresSnapshots: FuturesSnapshot[] = [];
  private episodeStart = 0;
  private currentBar = 0;
  private stepCount = 0;

  // Performance tracking (rolling window)
  private recentTrades: SimpleTradeResult[] = [];
  private currentPosition: SimplePosition | null = null;
  private currentMultipliers: Record<string, number> = {};

  // Derived stats
  private rollingWinRate = 0;
  private rollingPnL = 0;
  private maxEquity = 0;
  private currentEquity = 0;
  private currentDrawdown = 0;

  constructor(config: Partial<WeightOptimizerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.scorer = new ConfluenceScorer(this.config.confluenceConfig);

    // Init multipliers to 1.0 (no change)
    for (const name of WEIGHT_NAMES) {
      this.currentMultipliers[name] = 1.0;
    }
  }

  /** Set candle data for the episode */
  setData(candles: Candle[], futuresSnapshots?: FuturesSnapshot[]): void {
    this.candles = candles;
    this.futuresSnapshots = futuresSnapshots ?? [];
  }

  /**
   * Reset the environment for a new episode.
   * @param startIndex The global index in the candle array where the episode begins.
   */
  reset(startIndex: number): WeightOptimizerState {
    this.episodeStart = startIndex;
    this.currentBar = startIndex;
    this.stepCount = 0;
    this.recentTrades = [];
    this.currentPosition = null;
    this.maxEquity = 1.0;
    this.currentEquity = 1.0;
    this.currentDrawdown = 0;
    this.rollingWinRate = 0.5;
    this.rollingPnL = 0;
    this.scorer.resetCooldowns(); // Critical: clear scorer state between episodes

    for (const name of WEIGHT_NAMES) {
      this.currentMultipliers[name] = 1.0;
    }

    return this.buildState();
  }

  /**
   * Take one step: PPO provides weight multipliers, environment simulates
   * the next `decisionInterval` bars with those weights, returns reward.
   *
   * @param action Raw PPO output: 10 values in [-1, 1].
   *               Mapped to multiplier range via: min + (action + 1) / 2 * (max - min)
   */
  step(action: number[]): WeightOptimizerStepResult {
    if (action.length !== ACTION_SIZE) {
      throw new Error(`Expected ${ACTION_SIZE} actions, got ${action.length}`);
    }

    // Map 3 compact actions → 10 weight multipliers
    const globalRaw = Math.max(-1, Math.min(1, action[0]!));
    const structRaw = Math.max(-1, Math.min(1, action[1]!));
    const proxRaw = Math.max(-1, Math.min(1, action[2]!));

    const scale = this.config.multiplierScale;
    const globalMult = Math.exp(globalRaw * scale);
    const structMult = Math.exp(structRaw * scale * 0.5); // Smaller range for group adjustments
    const proxMult = Math.exp(proxRaw * scale * 0.5);

    const multipliers: Partial<Record<keyof ConfluenceWeights, number>> = {};
    for (const name of WEIGHT_NAMES) {
      let mult = globalMult; // Base: global adjustment
      if (STRUCTURE_WEIGHTS.includes(name)) mult *= structMult;
      else if (PROXIMITY_WEIGHTS.includes(name)) mult *= proxMult;
      multipliers[name] = mult;
      this.currentMultipliers[name] = mult;
    }

    // Simulate the next decisionInterval bars
    const startBar = this.currentBar;
    const endBar = Math.min(
      this.currentBar + this.config.decisionInterval,
      this.episodeStart + this.config.episodeLength,
      this.candles.length,
    );

    let windowTrades = 0;
    let windowWins = 0;
    let windowPnL = 0;

    for (let bar = startBar; bar < endBar; bar++) {
      const candle = this.candles[bar];
      if (!candle) break;

      // Check exit for open position
      if (this.currentPosition) {
        const exited = this.checkPositionExit(candle, bar);
        if (exited) {
          const trade = this.recentTrades[this.recentTrades.length - 1]!;
          windowTrades++;
          if (trade.won) windowWins++;
          windowPnL += trade.pnl;
        }
      }

      // Check for new entry (no position)
      if (!this.currentPosition) {
        const result = this.scorer.evaluateWithWeightMultipliers(
          this.candles,
          bar,
          multipliers,
        );

        if (result.action === 'trade' && result.selectedSignal) {
          const sig = result.selectedSignal.signal;
          const friction = this.config.commission + this.config.slippage;
          const entryPrice = sig.direction === 'long'
            ? sig.entryPrice * (1 + friction)
            : sig.entryPrice * (1 - friction);

          this.currentPosition = {
            side: sig.direction,
            entryPrice,
            stopLoss: sig.stopLoss,
            takeProfit: sig.takeProfit,
            entryBar: bar,
          };
        }
      }
    }

    this.currentBar = endBar;
    this.stepCount++;

    // Update rolling stats
    this.rollingWinRate = this.recentTrades.length > 0
      ? this.recentTrades.filter((t) => t.won).length / this.recentTrades.length
      : 0.5;
    this.rollingPnL = this.recentTrades.reduce((sum, t) => sum + t.pnl, 0);

    // Compute reward: risk-adjusted PnL for this window
    const reward = this.computeReward(windowPnL, windowTrades, windowWins);

    // Check if episode is done
    const done = this.currentBar >= this.episodeStart + this.config.episodeLength
      || this.currentBar >= this.candles.length;

    return {
      state: this.buildState(),
      reward,
      done,
      info: {
        trades: windowTrades,
        wins: windowWins,
        pnl: windowPnL,
        barsProcessed: endBar - startBar,
        currentMultipliers: { ...this.currentMultipliers },
      },
    };
  }

  getStateSize(): number { return STATE_SIZE; }
  getActionSize(): number { return ACTION_SIZE; }

  // ============================================
  // State Building
  // ============================================

  private buildState(): WeightOptimizerState {
    const features: number[] = [];

    // --- Regime features (6) ---
    const regime = this.getRegimeAtCurrentBar();
    features.push(encodeRegimeTrend(regime)); // -1 to 1
    features.push(encodeRegimeVolatility(regime)); // 0 to 1
    features.push(regime?.trendStrength ?? 0); // 0 to 1
    features.push(regime?.efficiency ?? 0); // 0 to 1
    features.push(regime?.atrPercentile ?? 0.5); // 0 to 1
    features.push(regime ? (regime.atrPercentile > 0.7 ? 1 : 0) : 0); // binary: high vol

    // --- Order flow features (4) ---
    const of = this.getOrderFlowAtCurrentBar();
    features.push(of.fundingRate);
    features.push(of.openInterestChange1h);
    features.push(of.liquidationPressure);
    features.push(of.takerBuyRatio);

    // --- Performance features (4) ---
    features.push(clamp((this.rollingWinRate - 0.5) * 4, -1, 1)); // centered at 0.5
    features.push(clamp(this.rollingPnL * 10, -1, 1)); // scale ~10% → 1
    features.push(clamp(-this.currentDrawdown * 5, -1, 0)); // drawdown is negative
    features.push(clamp(this.recentTrades.length / 20, 0, 1)); // trade count normalized

    return { features };
  }

  private getRegimeAtCurrentBar(): MarketRegime | null {
    if (this.currentBar < 50 || this.currentBar >= this.candles.length) return null;
    try {
      return detectRegime(this.candles, this.currentBar);
    } catch {
      return null;
    }
  }

  private getOrderFlowAtCurrentBar(): OrderFlowFeatures {
    if (this.futuresSnapshots.length === 0) {
      return {
        fundingRate: 0, fundingRateTrend: 0,
        openInterestChange1h: 0, openInterestChange24h: 0,
        longShortRatio: 0, takerBuyRatio: 0,
        liquidationPressure: 0, liquidationVolume: 0,
        fundingOIDivergence: 0, crowdingSignal: 0,
      };
    }
    return buildOrderFlowFeatures(this.futuresSnapshots, this.candles, this.currentBar);
  }

  // ============================================
  // Position Management (Simple SL/TP)
  // ============================================

  private checkPositionExit(candle: Candle, bar: number): boolean {
    if (!this.currentPosition) return false;

    const pos = this.currentPosition;
    const barsHeld = bar - pos.entryBar;
    const friction = this.config.commission + this.config.slippage;

    // SL check
    const slHit = pos.side === 'long'
      ? candle.low <= pos.stopLoss
      : candle.high >= pos.stopLoss;

    // TP check
    const tpHit = pos.side === 'long'
      ? candle.high >= pos.takeProfit
      : candle.low <= pos.takeProfit;

    // Max bars check
    const maxBars = barsHeld >= this.config.maxHoldBars;

    let exitPrice: number | null = null;
    if (slHit) exitPrice = pos.stopLoss;
    else if (tpHit) exitPrice = pos.takeProfit;
    else if (maxBars) exitPrice = candle.close;

    if (exitPrice === null) return false;

    // Apply exit friction
    exitPrice = pos.side === 'long'
      ? exitPrice * (1 - friction)
      : exitPrice * (1 + friction);

    // Calculate PnL
    const pnl = pos.side === 'long'
      ? (exitPrice - pos.entryPrice) / pos.entryPrice
      : (pos.entryPrice - exitPrice) / pos.entryPrice;

    const trade: SimpleTradeResult = { pnl, won: pnl > 0 };
    this.recentTrades.push(trade);

    // Keep only last 50 trades for rolling stats
    if (this.recentTrades.length > 50) {
      this.recentTrades.shift();
    }

    // Update equity tracking
    this.currentEquity *= (1 + pnl * 0.1); // Assume 10% position size
    if (this.currentEquity > this.maxEquity) this.maxEquity = this.currentEquity;
    this.currentDrawdown = (this.maxEquity - this.currentEquity) / this.maxEquity;

    this.currentPosition = null;
    return true;
  }

  // ============================================
  // Reward Function
  // ============================================

  /**
   * Reward = quality-focused risk-adjusted PnL.
   *
   * Design principles:
   * - 0 trades is NEUTRAL (system generates ~7/month, many 24-bar windows have 0)
   * - Winning trades rewarded proportional to PnL
   * - Losing trades penalized with asymmetric scaling (losses hurt more)
   * - NO per-trade bonus (prevents over-trading)
   * - Drawdown penalty for capital preservation
   */
  private computeReward(windowPnL: number, trades: number, wins: number): number {
    if (trades === 0) return 0; // Neutral for no activity

    // Asymmetric PnL scaling: losses penalized 1.5x
    let reward: number;
    if (windowPnL >= 0) {
      reward = clamp(windowPnL * 20, 0, 2);
    } else {
      reward = clamp(windowPnL * 30, -3, 0); // 1.5x penalty for losses
    }

    // Win rate quality: bonus for high WR, penalty for low WR
    const wr = wins / trades;
    if (wr >= 0.5) {
      reward += 0.15 * (wr - 0.5); // Small bonus above 50%
    } else {
      reward -= 0.3 * (0.5 - wr); // Larger penalty below 50%
    }

    // Drawdown penalty
    if (this.currentDrawdown > 0.05) {
      reward -= this.currentDrawdown * 2;
    }

    return reward;
  }
}

// ============================================
// Helpers
// ============================================

function clamp(value: number, min: number, max: number): number {
  if (!isFinite(value)) return 0;
  return Math.max(min, Math.min(max, value));
}

function encodeRegimeTrend(regime: MarketRegime | null): number {
  if (!regime) return 0;
  const label = regimeLabel(regime);
  if (label.startsWith('uptrend')) return 1;
  if (label.startsWith('downtrend')) return -1;
  return 0;
}

function encodeRegimeVolatility(regime: MarketRegime | null): number {
  if (!regime) return 0.5;
  const label = regimeLabel(regime);
  if (label.endsWith('+high')) return 1;
  if (label.endsWith('+low')) return 0;
  return 0.5; // normal
}
