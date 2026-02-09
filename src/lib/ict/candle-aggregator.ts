/**
 * Timestamp-aligned candle aggregation.
 *
 * Groups lower-timeframe candles into higher-timeframe candles
 * aligned to natural time boundaries (e.g., 15m → 1H aligned to hour start).
 *
 * Unlike the chunk-based aggregateToHigherTimeframe() in confluence-scorer.ts,
 * this produces candles aligned to wall-clock time boundaries.
 */

import type { Candle } from '@/types/candle';

/**
 * Aggregate candles to a higher timeframe aligned to time boundaries.
 *
 * @param candles - Source candles (must be sorted by timestamp ascending)
 * @param targetMinutes - Target candle duration in minutes (e.g., 60 for 1H, 240 for 4H)
 * @returns Aggregated candles aligned to targetMinutes boundaries.
 *          Incomplete final candle is included (may represent partial period).
 */
export function aggregateCandles(
  candles: Candle[],
  targetMinutes: number,
): Candle[] {
  if (candles.length === 0) return [];

  const targetMs = targetMinutes * 60 * 1000;
  const result: Candle[] = [];

  let currentBucket = -1;
  let bucketCandles: Candle[] = [];

  for (const candle of candles) {
    const bucket = Math.floor(candle.timestamp / targetMs);

    if (bucket !== currentBucket) {
      // Flush previous bucket
      if (bucketCandles.length > 0) {
        result.push(mergeBucket(bucketCandles));
      }
      currentBucket = bucket;
      bucketCandles = [candle];
    } else {
      bucketCandles.push(candle);
    }
  }

  // Flush final bucket
  if (bucketCandles.length > 0) {
    result.push(mergeBucket(bucketCandles));
  }

  return result;
}

/**
 * Get the bucket start timestamp for a given candle timestamp.
 * Useful for mapping a 15m candle back to its parent 1H candle.
 */
export function getBucketTimestamp(
  timestamp: number,
  targetMinutes: number,
): number {
  const targetMs = targetMinutes * 60 * 1000;
  return Math.floor(timestamp / targetMs) * targetMs;
}

/**
 * Build an index mapping from higher-TF candle timestamp → array of source candle indices.
 * This allows efficient lookup: "which 15m candles belong to this 1H candle?"
 */
export function buildTimeframeIndex(
  candles: Candle[],
  targetMinutes: number,
): Map<number, number[]> {
  const targetMs = targetMinutes * 60 * 1000;
  const index = new Map<number, number[]>();

  for (let i = 0; i < candles.length; i++) {
    const bucketTs = Math.floor(candles[i]!.timestamp / targetMs) * targetMs;
    const existing = index.get(bucketTs);
    if (existing) {
      existing.push(i);
    } else {
      index.set(bucketTs, [i]);
    }
  }

  return index;
}

function mergeBucket(candles: Candle[]): Candle {
  const first = candles[0]!;
  const last = candles[candles.length - 1]!;

  let high = first.high;
  let low = first.low;
  let volume = 0;

  for (const c of candles) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
    volume += c.volume;
  }

  return {
    timestamp: first.timestamp,
    open: first.open,
    high,
    low,
    close: last.close,
    volume,
  };
}
