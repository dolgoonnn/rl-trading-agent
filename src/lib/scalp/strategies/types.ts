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
  | 'volatility_breakout'
  | 'microstructure_proxy';

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

/** Scalp backtest configuration */
export interface ScalpBacktestConfig {
  strategy: ScalpStrategyName;
  symbol: string;
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
}

export const DEFAULT_SCALP_CONFIG: ScalpBacktestConfig = {
  strategy: 'ict_5m',
  symbol: 'BTCUSDT',
  frictionPerSide: 0.0005,  // 0.05% maker fee
  maxBars: 36,               // 3 hours on 5m
  cooldownBars: 4,           // 20 min on 5m
  threshold: 4.0,
  trainBars: 4320,           // 15 days of 5m
  valBars: 1440,             // 5 days of 5m
  slideBars: 1440,           // 5 days slide
  exitMode: 'simple',
};
