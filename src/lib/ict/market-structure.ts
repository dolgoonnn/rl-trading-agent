/**
 * Market Structure Detection
 * Identifies swing points, BOS (Break of Structure), CHoCH (Change of Character)
 */

import type { Candle, SwingPoint, StructureBreak, MarketStructure, Bias } from '@/types';

export interface SwingDetectionConfig {
  lookback: number; // Number of candles to look back for swing confirmation
  minStrength: number; // Minimum swing strength to consider
}

const DEFAULT_CONFIG: SwingDetectionConfig = {
  lookback: 5,
  minStrength: 2,
};

/**
 * Detect swing highs in candle data
 */
export function detectSwingHighs(
  candles: Candle[],
  config: SwingDetectionConfig = DEFAULT_CONFIG
): SwingPoint[] {
  const swings: SwingPoint[] = [];
  const { lookback } = config;

  for (let i = lookback; i < candles.length - lookback; i++) {
    const current = candles[i];
    if (!current) continue;

    let isSwingHigh = true;
    let strength = 0;

    // Check left side
    for (let j = 1; j <= lookback; j++) {
      const leftCandle = candles[i - j];
      if (!leftCandle || leftCandle.high >= current.high) {
        isSwingHigh = false;
        break;
      }
      strength++;
    }

    // Check right side
    if (isSwingHigh) {
      for (let j = 1; j <= lookback; j++) {
        const rightCandle = candles[i + j];
        if (!rightCandle || rightCandle.high >= current.high) {
          isSwingHigh = false;
          break;
        }
        strength++;
      }
    }

    if (isSwingHigh) {
      swings.push({
        index: i,
        price: current.high,
        timestamp: current.timestamp,
        type: 'high',
        strength,
      });
    }
  }

  return swings;
}

/**
 * Detect swing lows in candle data
 */
export function detectSwingLows(
  candles: Candle[],
  config: SwingDetectionConfig = DEFAULT_CONFIG
): SwingPoint[] {
  const swings: SwingPoint[] = [];
  const { lookback } = config;

  for (let i = lookback; i < candles.length - lookback; i++) {
    const current = candles[i];
    if (!current) continue;

    let isSwingLow = true;
    let strength = 0;

    // Check left side
    for (let j = 1; j <= lookback; j++) {
      const leftCandle = candles[i - j];
      if (!leftCandle || leftCandle.low <= current.low) {
        isSwingLow = false;
        break;
      }
      strength++;
    }

    // Check right side
    if (isSwingLow) {
      for (let j = 1; j <= lookback; j++) {
        const rightCandle = candles[i + j];
        if (!rightCandle || rightCandle.low <= current.low) {
          isSwingLow = false;
          break;
        }
        strength++;
      }
    }

    if (isSwingLow) {
      swings.push({
        index: i,
        price: current.low,
        timestamp: current.timestamp,
        type: 'low',
        strength,
      });
    }
  }

  return swings;
}

/**
 * Detect Break of Structure (BOS) - trend continuation
 * BOS occurs when price breaks a swing point IN THE DIRECTION of the prevailing trend:
 * - Uptrend: price breaks above swing high → bullish BOS (continuation)
 * - Downtrend: price breaks below swing low → bearish BOS (continuation)
 */
export function detectBOS(
  candles: Candle[],
  swingHighs: SwingPoint[],
  swingLows: SwingPoint[]
): StructureBreak[] {
  const breaks: StructureBreak[] = [];

  if (swingHighs.length < 2 || swingLows.length < 2) return breaks;

  // Determine current trend from swing structure
  const trend = determineTrendFromSwings(swingHighs, swingLows);

  // Track which swings have been broken
  const brokenHighs = new Set<number>();
  const brokenLows = new Set<number>();

  // Iterate through candles looking for structure breaks
  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;

    // In uptrend, look for breaks above swing highs (bullish BOS)
    if (trend === 'bullish' || trend === 'neutral') {
      for (const swing of swingHighs) {
        // Only break swings that formed before this candle
        if (swing.index >= i) continue;
        // Don't double-count breaks
        if (brokenHighs.has(swing.index)) continue;

        // Check if candle broke above the swing high
        if (candle.high > swing.price) {
          brokenHighs.add(swing.index);

          // Calculate confidence
          const confidence = calculateBreakConfidence(candle, swing, 'high', candles);

          breaks.push({
            type: 'bos',
            direction: 'bullish',
            brokenSwing: swing,
            breakCandle: candle,
            breakIndex: i,
            timestamp: candle.timestamp,
            confidence,
          });
        }
      }
    }

    // In downtrend, look for breaks below swing lows (bearish BOS)
    if (trend === 'bearish' || trend === 'neutral') {
      for (const swing of swingLows) {
        if (swing.index >= i) continue;
        if (brokenLows.has(swing.index)) continue;

        if (candle.low < swing.price) {
          brokenLows.add(swing.index);

          const confidence = calculateBreakConfidence(candle, swing, 'low', candles);

          breaks.push({
            type: 'bos',
            direction: 'bearish',
            brokenSwing: swing,
            breakCandle: candle,
            breakIndex: i,
            timestamp: candle.timestamp,
            confidence,
          });
        }
      }
    }
  }

  return breaks;
}

/**
 * Detect Change of Character (CHoCH) - potential reversal
 * CHoCH occurs when price breaks a swing point AGAINST the prevailing trend:
 * - Uptrend: price breaks below swing low → bearish CHoCH (reversal signal)
 * - Downtrend: price breaks above swing high → bullish CHoCH (reversal signal)
 */
export function detectCHoCH(
  candles: Candle[],
  swingHighs: SwingPoint[],
  swingLows: SwingPoint[]
): StructureBreak[] {
  const breaks: StructureBreak[] = [];

  if (swingHighs.length < 2 || swingLows.length < 2) return breaks;

  // Determine current trend from swing structure
  const trend = determineTrendFromSwings(swingHighs, swingLows);

  // Track which swings have been broken
  const brokenHighs = new Set<number>();
  const brokenLows = new Set<number>();

  // Iterate through candles looking for structure breaks
  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;

    // In uptrend, look for breaks below swing lows (bearish CHoCH - reversal)
    if (trend === 'bullish') {
      for (const swing of swingLows) {
        if (swing.index >= i) continue;
        if (brokenLows.has(swing.index)) continue;

        if (candle.low < swing.price) {
          brokenLows.add(swing.index);

          const confidence = calculateBreakConfidence(candle, swing, 'low', candles);

          breaks.push({
            type: 'choch',
            direction: 'bearish',
            brokenSwing: swing,
            breakCandle: candle,
            breakIndex: i,
            timestamp: candle.timestamp,
            confidence,
          });
        }
      }
    }

    // In downtrend, look for breaks above swing highs (bullish CHoCH - reversal)
    if (trend === 'bearish') {
      for (const swing of swingHighs) {
        if (swing.index >= i) continue;
        if (brokenHighs.has(swing.index)) continue;

        if (candle.high > swing.price) {
          brokenHighs.add(swing.index);

          const confidence = calculateBreakConfidence(candle, swing, 'high', candles);

          breaks.push({
            type: 'choch',
            direction: 'bullish',
            brokenSwing: swing,
            breakCandle: candle,
            breakIndex: i,
            timestamp: candle.timestamp,
            confidence,
          });
        }
      }
    }
  }

  return breaks;
}

/**
 * Determine trend from swing structure
 */
function determineTrendFromSwings(
  swingHighs: SwingPoint[],
  swingLows: SwingPoint[]
): 'bullish' | 'bearish' | 'neutral' {
  if (swingHighs.length < 2 || swingLows.length < 2) return 'neutral';

  const recentHighs = swingHighs.slice(-2);
  const recentLows = swingLows.slice(-2);

  const [hh1, hh2] = recentHighs;
  const [ll1, ll2] = recentLows;

  if (!hh1 || !hh2 || !ll1 || !ll2) return 'neutral';

  const higherHighs = hh2.price > hh1.price;
  const higherLows = ll2.price > ll1.price;
  const lowerHighs = hh2.price < hh1.price;
  const lowerLows = ll2.price < ll1.price;

  if (higherHighs && higherLows) return 'bullish';
  if (lowerHighs && lowerLows) return 'bearish';
  return 'neutral';
}

/**
 * Calculate confidence score for a structure break
 * Confidence based on:
 * - Swing strength (higher = more significant level)
 * - Break distance (how far past the level)
 * - Close confirmation (candle closed past level vs just wick)
 */
function calculateBreakConfidence(
  breakCandle: Candle,
  swing: SwingPoint,
  type: 'high' | 'low',
  candles: Candle[]
): number {
  let confidence = 0.5; // Base confidence

  // 1. Swing strength bonus (+0.15 max)
  // Normalize swing strength (typically 2-10)
  const normalizedStrength = Math.min(swing.strength / 10, 1);
  confidence += normalizedStrength * 0.15;

  // 2. Break distance bonus (+0.20 max)
  // How far price exceeded the level
  const atr = calculateLocalATR(candles, Math.max(0, swing.index - 14), swing.index);
  let breakDistance: number;
  if (type === 'high') {
    breakDistance = (breakCandle.high - swing.price) / atr;
  } else {
    breakDistance = (swing.price - breakCandle.low) / atr;
  }
  // Cap at 2 ATR for max bonus
  confidence += Math.min(breakDistance / 2, 1) * 0.20;

  // 3. Close confirmation bonus (+0.15)
  // Did the candle CLOSE past the level (stronger) or just wick through?
  if (type === 'high') {
    if (breakCandle.close > swing.price) {
      confidence += 0.15; // Full bonus for close confirmation
    } else if (breakCandle.high > swing.price) {
      confidence += 0.05; // Partial for wick only
    }
  } else {
    if (breakCandle.close < swing.price) {
      confidence += 0.15;
    } else if (breakCandle.low < swing.price) {
      confidence += 0.05;
    }
  }

  return Math.min(confidence, 1);
}

/**
 * Calculate ATR for a range of candles
 */
function calculateLocalATR(candles: Candle[], startIdx: number, endIdx: number): number {
  const relevantCandles = candles.slice(Math.max(0, startIdx), endIdx + 1);
  if (relevantCandles.length < 2) return 1;

  let sum = 0;
  for (let i = 1; i < relevantCandles.length; i++) {
    const high = relevantCandles[i]!.high;
    const low = relevantCandles[i]!.low;
    const prevClose = relevantCandles[i - 1]!.close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    sum += tr;
  }

  return sum / (relevantCandles.length - 1) || 1;
}

/**
 * Determine market bias from structure
 */
export function determineBias(
  swingHighs: SwingPoint[],
  swingLows: SwingPoint[]
): Bias {
  if (swingHighs.length < 2 || swingLows.length < 2) {
    return 'neutral';
  }

  const lastTwoHighs = swingHighs.slice(-2);
  const lastTwoLows = swingLows.slice(-2);

  const hh1 = lastTwoHighs[0];
  const hh2 = lastTwoHighs[1];
  const ll1 = lastTwoLows[0];
  const ll2 = lastTwoLows[1];

  if (!hh1 || !hh2 || !ll1 || !ll2) {
    return 'neutral';
  }

  const higherHighs = hh2.price > hh1.price;
  const higherLows = ll2.price > ll1.price;
  const lowerHighs = hh2.price < hh1.price;
  const lowerLows = ll2.price < ll1.price;

  if (higherHighs && higherLows) {
    return 'bullish';
  } else if (lowerHighs && lowerLows) {
    return 'bearish';
  }

  return 'neutral';
}

/**
 * Analyze market structure from candle data
 */
export function analyzeMarketStructure(
  candles: Candle[],
  config: SwingDetectionConfig = DEFAULT_CONFIG
): MarketStructure {
  const swingHighs = detectSwingHighs(candles, config);
  const swingLows = detectSwingLows(candles, config);
  const bias = determineBias(swingHighs, swingLows);

  const bosBreaks = detectBOS(candles, swingHighs, swingLows);
  const chochBreaks = detectCHoCH(candles, swingHighs, swingLows);

  return {
    bias,
    swingHighs,
    swingLows,
    structureBreaks: [...bosBreaks, ...chochBreaks],
    lastHH: swingHighs.at(-1),
    lastHL: swingLows.at(-1),
    lastLH: undefined, // TODO: Track properly
    lastLL: undefined, // TODO: Track properly
  };
}
