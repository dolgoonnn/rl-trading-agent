/**
 * Candle Aggregator Utility
 * Aggregates lower timeframe candles to higher timeframe (e.g., 1H → 4H)
 * Used for multi-timeframe analysis in the exit state builder
 */

import type { Candle } from '@/types';

/**
 * Aggregation result with mapping info
 */
export interface AggregatedCandles {
  /** Aggregated higher timeframe candles */
  candles: Candle[];
  /** Starting timestamp of HTF period for index mapping */
  htfStartTimestamp: number;
  /** Period size in milliseconds (e.g., 4 * 3600 * 1000 for 4H) */
  periodMs: number;
  /** Number of LTF candles per HTF candle */
  candlesPerPeriod: number;
}

/**
 * Candle Aggregator for multi-timeframe analysis
 * Aggregates 1H candles into 4H candles (or any multiple)
 */
export class CandleAggregator {
  /**
   * Aggregate candles to a higher timeframe
   * @param candles - Array of lower timeframe candles
   * @param factor - Aggregation factor (e.g., 4 for 1H→4H)
   * @returns Aggregated candles with mapping info
   */
  static aggregate(candles: Candle[], factor: number = 4): AggregatedCandles {
    if (candles.length === 0) {
      return {
        candles: [],
        htfStartTimestamp: 0,
        periodMs: 0,
        candlesPerPeriod: factor,
      };
    }

    // Detect LTF period from first two candles
    const ltfPeriodMs =
      candles.length >= 2
        ? candles[1]!.timestamp - candles[0]!.timestamp
        : 3600 * 1000; // Default 1H

    const htfPeriodMs = ltfPeriodMs * factor;

    // Calculate the HTF period start for the first candle
    // Align to HTF boundaries (e.g., 0:00, 4:00, 8:00 for 4H)
    const firstTimestamp = candles[0]!.timestamp;
    const htfStartTimestamp = Math.floor(firstTimestamp / htfPeriodMs) * htfPeriodMs;

    const aggregated: Candle[] = [];
    let currentPeriodStart = htfStartTimestamp;
    let periodCandles: Candle[] = [];

    for (const candle of candles) {
      // Check if this candle belongs to the current HTF period
      const candlePeriodStart = Math.floor(candle.timestamp / htfPeriodMs) * htfPeriodMs;

      if (candlePeriodStart !== currentPeriodStart) {
        // New period - aggregate previous candles
        if (periodCandles.length > 0) {
          aggregated.push(CandleAggregator.mergeCandles(periodCandles, currentPeriodStart));
        }
        currentPeriodStart = candlePeriodStart;
        periodCandles = [candle];
      } else {
        periodCandles.push(candle);
      }
    }

    // Don't forget the last period
    if (periodCandles.length > 0) {
      aggregated.push(CandleAggregator.mergeCandles(periodCandles, currentPeriodStart));
    }

    return {
      candles: aggregated,
      htfStartTimestamp,
      periodMs: htfPeriodMs,
      candlesPerPeriod: factor,
    };
  }

  /**
   * Aggregate 1H candles to 4H candles
   * Convenience method with factor=4
   */
  static aggregateTo4H(candles: Candle[]): AggregatedCandles {
    return CandleAggregator.aggregate(candles, 4);
  }

  /**
   * Map a lower timeframe index to corresponding higher timeframe index
   * @param ltfIndex - Index in the LTF candle array
   * @param ltfCandles - The LTF candle array
   * @param htfResult - The aggregation result
   * @returns Index in the HTF candle array, or -1 if not found
   */
  static mapToHTFIndex(
    ltfIndex: number,
    ltfCandles: Candle[],
    htfResult: AggregatedCandles
  ): number {
    if (ltfIndex < 0 || ltfIndex >= ltfCandles.length) {
      return -1;
    }

    const ltfCandle = ltfCandles[ltfIndex];
    if (!ltfCandle) return -1;

    // Find which HTF period this LTF candle belongs to
    const candlePeriodStart =
      Math.floor(ltfCandle.timestamp / htfResult.periodMs) * htfResult.periodMs;

    // Find the corresponding HTF candle
    for (let i = 0; i < htfResult.candles.length; i++) {
      if (htfResult.candles[i]!.timestamp === candlePeriodStart) {
        return i;
      }
    }

    return -1;
  }

  /**
   * Get the HTF candle corresponding to an LTF index
   * @param ltfIndex - Index in the LTF candle array
   * @param ltfCandles - The LTF candle array
   * @param htfResult - The aggregation result
   * @returns The HTF candle or null
   */
  static getHTFCandle(
    ltfIndex: number,
    ltfCandles: Candle[],
    htfResult: AggregatedCandles
  ): Candle | null {
    const htfIndex = CandleAggregator.mapToHTFIndex(ltfIndex, ltfCandles, htfResult);
    if (htfIndex < 0) return null;
    return htfResult.candles[htfIndex] ?? null;
  }

  /**
   * Merge multiple candles into a single aggregated candle
   */
  private static mergeCandles(candles: Candle[], periodTimestamp: number): Candle {
    if (candles.length === 0) {
      throw new Error('Cannot merge empty candle array');
    }

    const first = candles[0]!;
    const last = candles[candles.length - 1]!;

    let high = first.high;
    let low = first.low;
    let volume = 0;

    for (const candle of candles) {
      if (candle.high > high) high = candle.high;
      if (candle.low < low) low = candle.low;
      volume += candle.volume ?? 0;
    }

    return {
      timestamp: periodTimestamp,
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
    };
  }

  /**
   * Get candles for a lookback window at HTF
   * Returns HTF candles ending at/before the current HTF index
   * @param htfIndex - Current index in HTF candle array
   * @param htfCandles - The HTF candle array
   * @param lookback - Number of HTF candles to return
   */
  static getHTFLookback(htfIndex: number, htfCandles: Candle[], lookback: number): Candle[] {
    const start = Math.max(0, htfIndex - lookback + 1);
    return htfCandles.slice(start, htfIndex + 1);
  }
}
