/**
 * Scalp Strategy Types
 *
 * Extends the ICT strategy interfaces for multi-timeframe scalp trading.
 * Strategies operate on 5m candles with 1H bias filtering.
 */

import type { Candle } from '@/types/candle';
import type { StrategySignal, StrategyExitSignal } from '@/lib/rl/strategies/ict-strategies';

export type ScalpStrategyName =
  | 'ict_5m'
  | 'mean_reversion'
  | 'bb_squeeze'
  | 'atr_breakout'
  | 'silver_bullet'
  | 'session_range';

/** Kill zone mode for crypto-specific session tuning */
export type KillZoneMode =
  | 'traditional'   // London Open (02-05 NY) + NY Open (08-11 NY)
  | 'crypto'        // US hours (13:00-17:00 UTC) + London (08:00-11:00 UTC)
  | 'all_sessions'; // No kill zone filter

export interface ScalpStrategySignal extends StrategySignal {
  /** The 1H bias direction that this signal aligns with */
  htfBias: 'bullish' | 'bearish';
  /** 5m bar index at signal time */
  barIndex5m: number;
}

export interface ScalpStrategy {
  name: ScalpStrategyName;

  /**
   * Detect entry on 5m candles with HTF context.
   *
   * @param candles5m - 5-minute candles for strategy analysis
   * @param currentIndex - Current bar index in candles5m
   * @param candles1h - 1-hour candles for directional bias
   * @param htfIndex - Current 1H bar index (most recent closed 1H bar)
   */
  detectEntry(
    candles5m: Candle[],
    currentIndex: number,
    candles1h: Candle[],
    htfIndex: number,
  ): ScalpStrategySignal | null;

  detectExit(
    candles5m: Candle[],
    currentIndex: number,
    entryIndex: number,
    direction: 'long' | 'short',
  ): StrategyExitSignal;
}

/** ICT 5m strategy-specific configuration */
export interface ICT5mConfig {
  /** Target risk:reward ratio (default: 1.5) */
  targetRR: number;
  /** Minimum R:R filter — reject signals below this (default: 1.2) */
  minRR: number;
  /** Max distance from OB midpoint as fraction of price (default: 0.005 = 0.5%) */
  obProximity: number;
  /** Kill zone filtering mode (default: 'traditional') */
  killZoneMode: KillZoneMode;
}

export const DEFAULT_ICT5M_CONFIG: ICT5mConfig = {
  targetRR: 1.5,
  minRR: 1.2,
  obProximity: 0.005,
  killZoneMode: 'traditional',
};

/** Scalp backtest configuration */
export interface ScalpBacktestConfig {
  strategy: ScalpStrategyName;
  symbol: string;
  symbols: string[];
  frictionPerSide: number;
  maxBars: number;
  cooldownBars: number;
  threshold: number;
  trainBars: number;
  valBars: number;
  slideBars: number;
  exitMode: 'simple' | 'partial_tp';
  partialTP?: {
    fraction: number;
    triggerR: number;
    beBuffer: number;
  };
  /** Regimes to suppress (e.g., ["ranging+normal", "ranging+high"]) */
  suppressRegimes: string[];
  /** ICT 5m strategy config overrides */
  ict5mConfig: ICT5mConfig;
}

export const DEFAULT_SCALP_CONFIG: ScalpBacktestConfig = {
  strategy: 'ict_5m',
  symbol: 'BTCUSDT',
  symbols: ['BTCUSDT'],
  frictionPerSide: 0.0005,  // 0.05% maker fee
  maxBars: 36,               // 3 hours on 5m
  cooldownBars: 4,           // 20 min on 5m
  threshold: 4.0,
  trainBars: 4320,           // 15 days of 5m
  valBars: 1440,             // 5 days of 5m
  slideBars: 1440,           // 5 days slide
  exitMode: 'simple',
  suppressRegimes: [],
  ict5mConfig: { ...DEFAULT_ICT5M_CONFIG },
};
