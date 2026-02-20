/**
 * Candle Aggregator — 1m to any higher timeframe
 *
 * Aggregates 1-minute candles into 5m, 15m, or any custom interval.
 * Preserves OHLCV semantics:
 *   - Open: first candle in window
 *   - High: max high across window
 *   - Low: min low across window
 *   - Close: last candle in window
 *   - Volume: sum across window
 */

import type { Candle } from '@/types/candle';

const ONE_MINUTE_MS = 60_000;

/**
 * Aggregate 1m candles into a higher timeframe.
 *
 * @param candles1m - Input 1-minute candles (must be sorted chronologically)
 * @param targetMinutes - Target timeframe in minutes (e.g., 5, 15, 60)
 * @returns Aggregated candles with correct OHLCV
 */
export function aggregate(candles1m: Candle[], targetMinutes: number): Candle[] {
  if (targetMinutes <= 1) return candles1m;
  if (candles1m.length === 0) return [];

  const targetMs = targetMinutes * ONE_MINUTE_MS;
  const result: Candle[] = [];

  let windowStart = alignTimestamp(candles1m[0]!.timestamp, targetMs);
  let windowCandles: Candle[] = [];

  for (const candle of candles1m) {
    const candleWindow = alignTimestamp(candle.timestamp, targetMs);

    if (candleWindow !== windowStart && windowCandles.length > 0) {
      // Flush the completed window
      result.push(buildAggregated(windowCandles, windowStart));
      windowCandles = [];
      windowStart = candleWindow;
    }

    windowCandles.push(candle);
  }

  // Flush final window
  if (windowCandles.length > 0) {
    result.push(buildAggregated(windowCandles, windowStart));
  }

  return result;
}

/**
 * Align a timestamp to the start of a window.
 * E.g., for 5m: 12:03 → 12:00, 12:07 → 12:05
 */
function alignTimestamp(timestamp: number, intervalMs: number): number {
  return Math.floor(timestamp / intervalMs) * intervalMs;
}

/**
 * Build a single aggregated candle from a window of 1m candles.
 */
function buildAggregated(candles: Candle[], windowTimestamp: number): Candle {
  const first = candles[0]!;
  const last = candles[candles.length - 1]!;

  let high = -Infinity;
  let low = Infinity;
  let volume = 0;
  let takerBuyVolume: number | undefined;

  for (const c of candles) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
    volume += c.volume;
    if (c.takerBuyVolume !== undefined) {
      takerBuyVolume = (takerBuyVolume ?? 0) + c.takerBuyVolume;
    }
  }

  const aggregated: Candle = {
    timestamp: windowTimestamp,
    open: first.open,
    high,
    low,
    close: last.close,
    volume,
  };

  if (takerBuyVolume !== undefined) {
    aggregated.takerBuyVolume = takerBuyVolume;
  }

  return aggregated;
}

/**
 * Load and align 1H candles with 5m candles for HTF bias filtering.
 * Returns a map of 1H timestamp → 1H candle for O(1) lookup during backtesting.
 */
export function buildHTFLookup(htfCandles: Candle[]): Map<number, Candle> {
  const map = new Map<number, Candle>();
  for (const c of htfCandles) {
    map.set(c.timestamp, c);
  }
  return map;
}

/**
 * Find the most recent HTF candle at or before a given timestamp.
 * Used to determine 1H bias for a 5m bar.
 */
export function getHTFCandleAt(
  htfCandles: Candle[],
  timestamp: number,
  htfIntervalMs: number,
): Candle | null {
  const aligned = alignTimestamp(timestamp, htfIntervalMs);
  // Binary search for efficiency
  let lo = 0;
  let hi = htfCandles.length - 1;
  let best: Candle | null = null;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const c = htfCandles[mid]!;
    if (c.timestamp <= aligned) {
      best = c;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return best;
}
