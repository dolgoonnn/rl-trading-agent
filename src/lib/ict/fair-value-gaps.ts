/**
 * Fair Value Gap (FVG) Detection
 * Identifies price imbalances where price moved too fast
 *
 * ICT Methodology:
 * - FVG must form from DISPLACEMENT (strong impulsive move after liquidity sweep)
 * - Entry should be at Consequent Encroachment (CE) - the 50% midpoint of FVG
 * - "CE is respected far more often than the entire FVG" - TheSimpleICT
 */

import type { Candle, FairValueGap } from '@/types';

export interface FVGConfig {
  minSizePercent: number; // Minimum gap size as % of price (legacy fallback)
  minSizeATR?: number; // Minimum gap size as ATR-14 multiple (overrides minSizePercent). Auto-scales across assets.
  maxAgeCandles: number; // Maximum age before FVG expires
  displacementMultiple: number; // Candle 2 body must be > this * avg body size
  avgBodyLookback: number; // Bars to calculate average body size
}

const DEFAULT_CONFIG: FVGConfig = {
  minSizePercent: 0.4,       // Default: fixed 0.4% (tuned for crypto). Set minSizeATR to override.
  maxAgeCandles: 30,         // Reduced from 50 — FVGs older than 30 bars are stale
  displacementMultiple: 1.5, // 1.5x average body = displacement
  avgBodyLookback: 14,
};

/**
 * Calculate ATR (Average True Range) for size validation.
 * Used to make FVG detection volatility-adaptive across asset classes.
 */
function calculateATR(candles: Candle[], endIndex: number, period: number = 14): number {
  const start = Math.max(1, endIndex - period + 1);
  let sum = 0;
  let count = 0;

  for (let i = start; i <= endIndex; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    if (!curr || !prev) continue;

    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    sum += tr;
    count++;
  }

  return count > 0 ? sum / count : 0;
}

/**
 * Compute the minimum gap size threshold (in absolute price units).
 * ATR-based if configured, otherwise falls back to percentage-based.
 */
function getMinGapSize(candles: Candle[], index: number, price: number, config: FVGConfig): number {
  if (config.minSizeATR !== undefined) {
    const atr = calculateATR(candles, index);
    return atr * config.minSizeATR;
  }
  return price * config.minSizePercent / 100;
}

/**
 * Calculate average candle body size over a lookback period
 */
function calculateAvgBodySize(candles: Candle[], endIndex: number, lookback: number): number {
  const startIdx = Math.max(0, endIndex - lookback);
  const relevantCandles = candles.slice(startIdx, endIndex);

  if (relevantCandles.length === 0) return 0;

  const totalBodySize = relevantCandles.reduce((sum, c) => {
    return sum + Math.abs(c.close - c.open);
  }, 0);

  return totalBodySize / relevantCandles.length;
}

/**
 * Check if candle 2 (middle candle) represents displacement
 * Displacement = strong impulsive move, indicated by body size > 1.5x average
 */
function isDisplacementCandle(
  candle: Candle,
  candles: Candle[],
  index: number,
  config: FVGConfig
): boolean {
  const avgBodySize = calculateAvgBodySize(candles, index, config.avgBodyLookback);
  if (avgBodySize === 0) return true; // Default to true if can't calculate

  const candleBodySize = Math.abs(candle.close - candle.open);
  return candleBodySize > avgBodySize * config.displacementMultiple;
}

/**
 * Detect bullish FVGs
 * Bullish FVG = Gap between candle 1 high and candle 3 low (price moved up fast)
 *
 * ICT Methodology:
 * - Must be from displacement (candle 2 body > 1.5x average body size)
 * - CE (Consequent Encroachment) = 50% midpoint of gap
 */
export function detectBullishFVGs(
  candles: Candle[],
  config: FVGConfig = DEFAULT_CONFIG
): FairValueGap[] {
  const fvgs: FairValueGap[] = [];

  for (let i = 0; i < candles.length - 2; i++) {
    const candle1 = candles[i];
    const candle2 = candles[i + 1];
    const candle3 = candles[i + 2];

    if (!candle1 || !candle2 || !candle3) continue;

    // Bullish FVG: candle3.low > candle1.high
    if (candle3.low > candle1.high) {
      const gapSize = candle3.low - candle1.high;
      const gapPercent = (gapSize / candle2.close) * 100;
      const minGap = getMinGapSize(candles, i + 1, candle2.close, config);

      if (gapSize >= minGap) {
        // Hard-require displacement — non-displacement FVGs are noise
        const hasDisplacement = isDisplacementCandle(candle2, candles, i + 1, config);
        if (!hasDisplacement) continue;

        // Calculate Consequent Encroachment (CE) - 50% midpoint
        const fvgHigh = candle3.low;
        const fvgLow = candle1.high;
        const ce = (fvgHigh + fvgLow) / 2;

        fvgs.push({
          type: 'bullish',
          status: 'unfilled',
          high: fvgHigh, // Top of gap
          low: fvgLow, // Bottom of gap
          size: gapSize,
          sizePercent: gapPercent,
          index: i + 1, // Index of middle candle
          timestamp: candle2.timestamp,
          fillPercent: 0,
          consequentEncroachment: ce,
          displacement: hasDisplacement,
        });
      }
    }
  }

  return fvgs;
}

/**
 * Detect bearish FVGs
 * Bearish FVG = Gap between candle 1 low and candle 3 high (price moved down fast)
 *
 * ICT Methodology:
 * - Must be from displacement (candle 2 body > 1.5x average body size)
 * - CE (Consequent Encroachment) = 50% midpoint of gap
 */
export function detectBearishFVGs(
  candles: Candle[],
  config: FVGConfig = DEFAULT_CONFIG
): FairValueGap[] {
  const fvgs: FairValueGap[] = [];

  for (let i = 0; i < candles.length - 2; i++) {
    const candle1 = candles[i];
    const candle2 = candles[i + 1];
    const candle3 = candles[i + 2];

    if (!candle1 || !candle2 || !candle3) continue;

    // Bearish FVG: candle3.high < candle1.low
    if (candle3.high < candle1.low) {
      const gapSize = candle1.low - candle3.high;
      const gapPercent = (gapSize / candle2.close) * 100;
      const minGap = getMinGapSize(candles, i + 1, candle2.close, config);

      if (gapSize >= minGap) {
        // Hard-require displacement — non-displacement FVGs are noise
        const hasDisplacement = isDisplacementCandle(candle2, candles, i + 1, config);
        if (!hasDisplacement) continue;

        // Calculate Consequent Encroachment (CE) - 50% midpoint
        const fvgHigh = candle1.low;
        const fvgLow = candle3.high;
        const ce = (fvgHigh + fvgLow) / 2;

        fvgs.push({
          type: 'bearish',
          status: 'unfilled',
          high: fvgHigh, // Top of gap
          low: fvgLow, // Bottom of gap
          size: gapSize,
          sizePercent: gapPercent,
          index: i + 1, // Index of middle candle
          timestamp: candle2.timestamp,
          fillPercent: 0,
          consequentEncroachment: ce,
          displacement: hasDisplacement,
        });
      }
    }
  }

  return fvgs;
}

/**
 * Check FVG fill status
 */
export function checkFVGFill(
  fvg: FairValueGap,
  candles: Candle[],
  fromIndex: number
): FairValueGap {
  const gapSize = fvg.high - fvg.low;

  for (let i = fromIndex; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;

    if (fvg.type === 'bullish') {
      // Price needs to return down into the gap
      if (candle.low <= fvg.high) {
        const fillAmount = Math.min(fvg.high - candle.low, gapSize);
        const fillPercent = (fillAmount / gapSize) * 100;

        return {
          ...fvg,
          fillPercent: Math.max(fvg.fillPercent, fillPercent),
          status: fillPercent >= 100 ? 'filled' : fillPercent > 0 ? 'partially_filled' : 'unfilled',
        };
      }
    } else {
      // Price needs to return up into the gap
      if (candle.high >= fvg.low) {
        const fillAmount = Math.min(candle.high - fvg.low, gapSize);
        const fillPercent = (fillAmount / gapSize) * 100;

        return {
          ...fvg,
          fillPercent: Math.max(fvg.fillPercent, fillPercent),
          status: fillPercent >= 100 ? 'filled' : fillPercent > 0 ? 'partially_filled' : 'unfilled',
        };
      }
    }
  }

  return fvg;
}

/**
 * Detect all FVGs in candle data
 */
export function detectFairValueGaps(
  candles: Candle[],
  config: FVGConfig = DEFAULT_CONFIG
): FairValueGap[] {
  const bullishFVGs = detectBullishFVGs(candles, config);
  const bearishFVGs = detectBearishFVGs(candles, config);

  return [...bullishFVGs, ...bearishFVGs].sort((a, b) => a.index - b.index);
}

/**
 * Get active (unfilled/partially filled) FVGs
 */
export function getActiveFVGs(
  fvgs: FairValueGap[],
  currentIndex: number,
  maxAge: number = 30
): FairValueGap[] {
  return fvgs.filter(
    (fvg) =>
      fvg.status !== 'filled' &&
      currentIndex - fvg.index <= maxAge
  );
}
