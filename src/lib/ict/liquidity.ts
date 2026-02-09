/**
 * ICT Liquidity Detection
 *
 * Detects liquidity pools (areas where stop losses cluster):
 * - BSL (Buy-Side Liquidity): Equal highs, recent highs where shorts have stops
 * - SSL (Sell-Side Liquidity): Equal lows, recent lows where longs have stops
 *
 * Also detects liquidity sweeps (price taking out liquidity then reversing)
 * which is a key ICT concept for high-probability entries.
 */

import type { Candle, LiquidityLevel, LiquiditySweep, LiquidityType, SwingPoint } from '@/types';
import { analyzeMarketStructure } from './market-structure';

export interface LiquidityConfig {
  /** Tolerance for considering prices "equal" (as % of price) */
  equalTolerance: number;
  /** Minimum touches for liquidity level */
  minTouches: number;
  /** Lookback period for finding levels */
  lookbackBars: number;
  /** Bars to look back for recent sweeps */
  recentSweepBars: number;
  /** Minimum sweep exceedance (as % of price) */
  minSweepExceedance: number;
}

const DEFAULT_CONFIG: LiquidityConfig = {
  equalTolerance: 0.0005,   // 0.05% tolerance for equal highs/lows (tightened from 0.1%)
  minTouches: 2,            // 2 touches minimum (3 was too restrictive, killed all sweeps)
  lookbackBars: 50,         // Look back 50 bars
  recentSweepBars: 10,      // Recent sweep within 10 bars
  minSweepExceedance: 0.001, // Minimum 0.1% past level (doubled from 0.05%)
};

/**
 * Detect liquidity levels from price data
 */
export function detectLiquidityLevels(
  candles: Candle[],
  config: Partial<LiquidityConfig> = {}
): LiquidityLevel[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const levels: LiquidityLevel[] = [];

  if (candles.length < cfg.lookbackBars) return levels;

  // Get swing points for better liquidity detection
  const structure = analyzeMarketStructure(candles);
  const swingHighs = structure.swingHighs;
  const swingLows = structure.swingLows;

  // Detect BSL (Buy-Side Liquidity) - Equal highs
  const bslLevels = detectEqualLevels(
    swingHighs,
    candles,
    'bsl',
    cfg.equalTolerance,
    cfg.minTouches
  );
  levels.push(...bslLevels);

  // Detect SSL (Sell-Side Liquidity) - Equal lows
  const sslLevels = detectEqualLevels(
    swingLows,
    candles,
    'ssl',
    cfg.equalTolerance,
    cfg.minTouches
  );
  levels.push(...sslLevels);

  // Also detect recent highs/lows as single-touch liquidity
  const recentHighs = detectRecentExtremes(candles, 'bsl', cfg.lookbackBars);
  const recentLows = detectRecentExtremes(candles, 'ssl', cfg.lookbackBars);

  levels.push(...recentHighs);
  levels.push(...recentLows);

  return levels;
}

/**
 * Detect equal highs/lows (liquidity pools)
 */
function detectEqualLevels(
  swings: SwingPoint[],
  candles: Candle[],
  type: LiquidityType,
  tolerance: number,
  minTouches: number
): LiquidityLevel[] {
  const levels: LiquidityLevel[] = [];
  const processed = new Set<number>();

  for (let i = 0; i < swings.length; i++) {
    if (processed.has(i)) continue;

    const swing = swings[i];
    if (!swing) continue;

    const matchingSwings = [swing];

    // Find other swings at similar price
    for (let j = i + 1; j < swings.length; j++) {
      const other = swings[j];
      if (!other || processed.has(j)) continue;

      const priceDiff = Math.abs(swing.price - other.price) / swing.price;
      if (priceDiff <= tolerance) {
        matchingSwings.push(other);
        processed.add(j);
      }
    }

    processed.add(i);

    // Create liquidity level if enough touches
    if (matchingSwings.length >= minTouches) {
      const avgPrice = matchingSwings.reduce((sum, s) => sum + s.price, 0) / matchingSwings.length;
      const latestSwing = matchingSwings[matchingSwings.length - 1]!;

      // Check if level has been swept
      let status: 'active' | 'swept' = 'active';
      let sweepIndex: number | undefined;
      let sweepTimestamp: number | undefined;

      // Check if any candle after the last swing broke the level
      for (let k = latestSwing.index + 1; k < candles.length; k++) {
        const candle = candles[k];
        if (!candle) continue;

        if (type === 'bsl' && candle.high > avgPrice) {
          status = 'swept';
          sweepIndex = k;
          sweepTimestamp = candle.timestamp;
          break;
        }
        if (type === 'ssl' && candle.low < avgPrice) {
          status = 'swept';
          sweepIndex = k;
          sweepTimestamp = candle.timestamp;
          break;
        }
      }

      levels.push({
        type,
        price: avgPrice,
        strength: matchingSwings.length,
        index: latestSwing.index,
        timestamp: latestSwing.timestamp,
        status,
        sweepIndex,
        sweepTimestamp,
      });
    }
  }

  return levels;
}

/**
 * Detect recent highs/lows as liquidity targets
 */
function detectRecentExtremes(
  candles: Candle[],
  type: LiquidityType,
  lookbackBars: number
): LiquidityLevel[] {
  const levels: LiquidityLevel[] = [];

  if (candles.length < lookbackBars) return levels;

  const recentCandles = candles.slice(-lookbackBars);
  const current = candles[candles.length - 1];
  if (!current) return levels;

  if (type === 'bsl') {
    // Find highest high in lookback
    let maxHigh = -Infinity;
    let maxIndex = 0;
    let maxTimestamp = 0;

    recentCandles.forEach((c, i) => {
      if (c.high > maxHigh) {
        maxHigh = c.high;
        maxIndex = candles.length - lookbackBars + i;
        maxTimestamp = c.timestamp;
      }
    });

    // Only add if not at current candle (would be untested)
    if (maxIndex < candles.length - 1) {
      // Check if swept
      let status: 'active' | 'swept' = 'active';
      let sweepIndex: number | undefined;
      let sweepTimestamp: number | undefined;

      for (let i = maxIndex + 1; i < candles.length; i++) {
        const c = candles[i];
        if (c && c.high > maxHigh) {
          status = 'swept';
          sweepIndex = i;
          sweepTimestamp = c.timestamp;
          break;
        }
      }

      levels.push({
        type: 'bsl',
        price: maxHigh,
        strength: 1,
        index: maxIndex,
        timestamp: maxTimestamp,
        status,
        sweepIndex,
        sweepTimestamp,
      });
    }
  } else {
    // Find lowest low in lookback
    let minLow = Infinity;
    let minIndex = 0;
    let minTimestamp = 0;

    recentCandles.forEach((c, i) => {
      if (c.low < minLow) {
        minLow = c.low;
        minIndex = candles.length - lookbackBars + i;
        minTimestamp = c.timestamp;
      }
    });

    if (minIndex < candles.length - 1) {
      let status: 'active' | 'swept' = 'active';
      let sweepIndex: number | undefined;
      let sweepTimestamp: number | undefined;

      for (let i = minIndex + 1; i < candles.length; i++) {
        const c = candles[i];
        if (c && c.low < minLow) {
          status = 'swept';
          sweepIndex = i;
          sweepTimestamp = c.timestamp;
          break;
        }
      }

      levels.push({
        type: 'ssl',
        price: minLow,
        strength: 1,
        index: minIndex,
        timestamp: minTimestamp,
        status,
        sweepIndex,
        sweepTimestamp,
      });
    }
  }

  return levels;
}

/**
 * Detect liquidity sweeps (price took out liquidity then reversed)
 */
export function detectLiquiditySweeps(
  candles: Candle[],
  levels: LiquidityLevel[],
  config: Partial<LiquidityConfig> = {}
): LiquiditySweep[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const sweeps: LiquiditySweep[] = [];

  if (candles.length < 2) return sweeps;

  for (const level of levels) {
    if (level.status !== 'swept' || !level.sweepIndex) continue;

    const sweepCandle = candles[level.sweepIndex];
    if (!sweepCandle) continue;

    // Calculate how far price exceeded the level
    let priceExceeded: number;
    if (level.type === 'bsl') {
      priceExceeded = sweepCandle.high - level.price;
    } else {
      priceExceeded = level.price - sweepCandle.low;
    }

    // Check minimum exceedance
    if (priceExceeded / level.price < cfg.minSweepExceedance) continue;

    // Check for reversal after sweep (candle closed back below/above level)
    let reversed = false;
    if (level.type === 'bsl') {
      // BSL sweep: price went above, should close back below or near
      reversed = sweepCandle.close <= level.price * 1.001; // Allow small margin
    } else {
      // SSL sweep: price went below, should close back above or near
      reversed = sweepCandle.close >= level.price * 0.999;
    }

    // Only count as sweep if there was a reversal (wick rejection)
    if (reversed) {
      sweeps.push({
        level,
        sweepCandle,
        sweepIndex: level.sweepIndex,
        timestamp: level.sweepTimestamp!,
        priceExceeded,
      });
    }
  }

  return sweeps;
}

/**
 * Check if there was a recent liquidity sweep
 */
export function hasRecentLiquiditySweep(
  candles: Candle[],
  currentIndex: number,
  direction: 'long' | 'short',
  config: Partial<LiquidityConfig> = {}
): { hasSweep: boolean; sweep?: LiquiditySweep } {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Get candles up to current index
  const relevantCandles = candles.slice(0, currentIndex + 1);
  if (relevantCandles.length < cfg.lookbackBars) {
    return { hasSweep: false };
  }

  // Detect levels and sweeps
  const levels = detectLiquidityLevels(relevantCandles, cfg);
  const sweeps = detectLiquiditySweeps(relevantCandles, levels, cfg);

  // For longs, we want SSL sweep (sell-side liquidity taken out, then price reverses up)
  // For shorts, we want BSL sweep (buy-side liquidity taken out, then price reverses down)
  const targetType: LiquidityType = direction === 'long' ? 'ssl' : 'bsl';

  // Find recent sweep of target type
  const recentSweeps = sweeps.filter(
    (s) =>
      s.level.type === targetType &&
      currentIndex - s.sweepIndex <= cfg.recentSweepBars
  );

  if (recentSweeps.length > 0) {
    // Return the most recent one
    const mostRecent = recentSweeps[recentSweeps.length - 1]!;
    return { hasSweep: true, sweep: mostRecent };
  }

  return { hasSweep: false };
}

/**
 * Get liquidity sweep confidence score
 * Higher score = stronger sweep confirmation
 */
export function getLiquiditySweepScore(
  sweep: LiquiditySweep
): number {
  let score = 0;

  // Base score for having a sweep
  score += 0.3;

  // Strength of level (more touches = more reliable)
  score += Math.min(0.3, sweep.level.strength * 0.1);

  // How much price exceeded level (larger = more significant sweep)
  const exceedancePercent = sweep.priceExceeded / sweep.level.price;
  score += Math.min(0.2, exceedancePercent * 20);

  // Wick rejection (reversal on same candle)
  const candleRange = sweep.sweepCandle.high - sweep.sweepCandle.low;
  let wickRatio: number;

  if (sweep.level.type === 'bsl') {
    // Upper wick should be significant
    const upperWick = sweep.sweepCandle.high - Math.max(sweep.sweepCandle.open, sweep.sweepCandle.close);
    wickRatio = upperWick / candleRange;
  } else {
    // Lower wick should be significant
    const lowerWick = Math.min(sweep.sweepCandle.open, sweep.sweepCandle.close) - sweep.sweepCandle.low;
    wickRatio = lowerWick / candleRange;
  }

  score += Math.min(0.2, wickRatio);

  return Math.min(1, score);
}

/**
 * Check if a sweep confirms a setup direction
 */
export function sweepConfirmsDirection(
  sweep: LiquiditySweep,
  direction: 'long' | 'short'
): boolean {
  // SSL sweep confirms long (stops taken below, then reversal up)
  // BSL sweep confirms short (stops taken above, then reversal down)
  if (direction === 'long' && sweep.level.type === 'ssl') return true;
  if (direction === 'short' && sweep.level.type === 'bsl') return true;
  return false;
}
