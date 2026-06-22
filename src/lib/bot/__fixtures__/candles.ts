/**
 * Deterministic candle fixtures for bot tests.
 *
 * No randomness, no clock — every series is fully specified by its inputs so
 * tests can assert exact bot behavior (signals, exits, snapshot cadence).
 */

import type { Candle } from '@/types/candle';

const HOUR_MS = 3_600_000;

export interface MakeSeriesOptions {
  /** Timestamp (ms) of the first candle. Default: a fixed 2024 epoch. */
  startMs?: number;
  /** Number of candles to produce. */
  count: number;
  /** Open price of the first candle. */
  startPrice?: number;
  /** Per-bar price step (added to close each bar). Default 0 (flat). */
  step?: number;
  /** Spacing between candles in ms. Default 1h. */
  intervalMs?: number;
}

const DEFAULT_START_MS = 1_704_067_200_000; // 2024-01-01T00:00:00Z

/**
 * Build a deterministic OHLCV series. Each bar opens at the previous close
 * and closes `step` higher (or lower). High/low straddle the body by a small
 * fixed wick so the candles are always valid (low <= o/c <= high).
 */
export function makeSeries(opts: MakeSeriesOptions): Candle[] {
  const {
    startMs = DEFAULT_START_MS,
    count,
    startPrice = 100,
    step = 0,
    intervalMs = HOUR_MS,
  } = opts;

  const candles: Candle[] = [];
  let open = startPrice;

  for (let i = 0; i < count; i++) {
    const close = open + step;
    const high = Math.max(open, close) + 0.5;
    const low = Math.min(open, close) - 0.5;
    candles.push({
      timestamp: startMs + i * intervalMs,
      open,
      high,
      low,
      close,
      volume: 1_000,
    });
    open = close;
  }

  return candles;
}

/**
 * Append a single candle to a series, advancing time by one interval and
 * setting OHLC explicitly. Used to inject a precise "adverse" or "exit" bar.
 */
export function appendCandle(
  series: Candle[],
  ohlc: { open: number; high: number; low: number; close: number; volume?: number },
  intervalMs = HOUR_MS,
): Candle[] {
  const last = series[series.length - 1];
  const timestamp = (last ? last.timestamp : DEFAULT_START_MS) + intervalMs;
  return [
    ...series,
    {
      timestamp,
      open: ohlc.open,
      high: ohlc.high,
      low: ohlc.low,
      close: ohlc.close,
      volume: ohlc.volume ?? 1_000,
    },
  ];
}

/**
 * A minimal, deterministic long signal shaped like a confluence-scorer
 * ScoredSignal — enough for OrderManager.openPosition to build a position.
 * Entry/stop/take are explicit so the test can drive an exact exit.
 */
export function makeLongSignal(params: {
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  score?: number;
}): {
  signal: {
    direction: 'long';
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    strategy: string;
  };
  totalScore: number;
  factorBreakdown: Record<string, number>;
} {
  return {
    signal: {
      direction: 'long',
      entryPrice: params.entryPrice,
      stopLoss: params.stopLoss,
      takeProfit: params.takeProfit,
      strategy: 'order_block',
    },
    totalScore: params.score ?? 6.5,
    factorBreakdown: { obProximity: 2.7, recentBOS: 2.2 },
  };
}
