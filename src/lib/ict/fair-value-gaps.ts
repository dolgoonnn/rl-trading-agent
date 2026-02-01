/**
 * Fair Value Gap (FVG) Detection
 * Identifies price imbalances where price moved too fast
 */

import type { Candle, FairValueGap } from '@/types';

export interface FVGConfig {
  minSizePercent: number; // Minimum gap size as % of price
  maxAgeCandles: number; // Maximum age before FVG expires
}

const DEFAULT_CONFIG: FVGConfig = {
  minSizePercent: 0.1,
  maxAgeCandles: 50,
};

/**
 * Detect bullish FVGs
 * Bullish FVG = Gap between candle 1 high and candle 3 low (price moved up fast)
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

      if (gapPercent >= config.minSizePercent) {
        fvgs.push({
          type: 'bullish',
          status: 'unfilled',
          high: candle3.low, // Top of gap
          low: candle1.high, // Bottom of gap
          size: gapSize,
          sizePercent: gapPercent,
          index: i + 1, // Index of middle candle
          timestamp: candle2.timestamp,
          fillPercent: 0,
        });
      }
    }
  }

  return fvgs;
}

/**
 * Detect bearish FVGs
 * Bearish FVG = Gap between candle 1 low and candle 3 high (price moved down fast)
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

      if (gapPercent >= config.minSizePercent) {
        fvgs.push({
          type: 'bearish',
          status: 'unfilled',
          high: candle1.low, // Top of gap
          low: candle3.high, // Bottom of gap
          size: gapSize,
          sizePercent: gapPercent,
          index: i + 1, // Index of middle candle
          timestamp: candle2.timestamp,
          fillPercent: 0,
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
  maxAge: number = 50
): FairValueGap[] {
  return fvgs.filter(
    (fvg) =>
      fvg.status !== 'filled' &&
      currentIndex - fvg.index <= maxAge
  );
}
