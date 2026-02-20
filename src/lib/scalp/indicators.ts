/**
 * Scalp Technical Indicators
 *
 * Shared, stateless indicator library for scalp strategies.
 * All functions are pure: (candles, index, params) => value.
 * No side effects, no mutable state.
 */

import type { Candle } from '@/types/candle';

// ============================================
// ATR (Average True Range)
// ============================================

/**
 * Calculate ATR at a given index.
 * Returns 0 if insufficient data.
 */
export function calculateATR(candles: Candle[], index: number, period = 14): number {
  if (index < period) return 0;

  let sum = 0;
  for (let i = index - period + 1; i <= index; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1];
    const prevClose = prev ? prev.close : c.open;
    sum += Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
  }

  return sum / period;
}

// ============================================
// EMA (Exponential Moving Average)
// ============================================

/**
 * Calculate EMA at a given index using close prices.
 * Uses recursive definition: EMA[i] = close * k + EMA[i-1] * (1-k)
 * Seeds with SMA of first `period` bars.
 */
export function calculateEMA(candles: Candle[], index: number, period: number): number {
  if (index < period - 1) return candles[index]?.close ?? 0;

  const k = 2 / (period + 1);

  // Seed with SMA
  let ema = 0;
  for (let i = 0; i < period; i++) {
    ema += candles[i]!.close;
  }
  ema /= period;

  // Apply EMA from period onwards
  for (let i = period; i <= index; i++) {
    ema = candles[i]!.close * k + ema * (1 - k);
  }

  return ema;
}

/**
 * Calculate EMA from a raw values array at a given index.
 */
export function calculateEMAFromValues(values: number[], index: number, period: number): number {
  if (index < period - 1) return values[index] ?? 0;

  const k = 2 / (period + 1);

  let ema = 0;
  for (let i = 0; i < period; i++) {
    ema += values[i]!;
  }
  ema /= period;

  for (let i = period; i <= index; i++) {
    ema = values[i]! * k + ema * (1 - k);
  }

  return ema;
}

// ============================================
// RSI (Relative Strength Index)
// ============================================

/**
 * Calculate RSI at a given index.
 * Uses Wilder's smoothing (exponential average of gains/losses).
 * Returns 50 if insufficient data.
 */
export function calculateRSI(candles: Candle[], index: number, period = 14): number {
  if (index < period) return 50;

  // First period: simple averages
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = candles[i]!.close - candles[i - 1]!.close;
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  // Subsequent periods: Wilder's smoothing
  for (let i = period + 1; i <= index; i++) {
    const change = candles[i]!.close - candles[i - 1]!.close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ============================================
// Bollinger Bands
// ============================================

export interface BollingerBands {
  upper: number;
  middle: number;
  lower: number;
  width: number;  // (upper - lower) / middle — normalized bandwidth
}

/**
 * Calculate Bollinger Bands at a given index.
 * Returns middle=close, width=0 if insufficient data.
 */
export function calculateBollingerBands(
  candles: Candle[],
  index: number,
  period = 20,
  stdDevMultiple = 2,
): BollingerBands {
  if (index < period - 1) {
    const close = candles[index]?.close ?? 0;
    return { upper: close, middle: close, lower: close, width: 0 };
  }

  // SMA
  let sum = 0;
  for (let i = index - period + 1; i <= index; i++) {
    sum += candles[i]!.close;
  }
  const middle = sum / period;

  // Standard deviation
  let variance = 0;
  for (let i = index - period + 1; i <= index; i++) {
    const diff = candles[i]!.close - middle;
    variance += diff * diff;
  }
  const stdDev = Math.sqrt(variance / period);

  const upper = middle + stdDev * stdDevMultiple;
  const lower = middle - stdDev * stdDevMultiple;
  const width = middle > 0 ? (upper - lower) / middle : 0;

  return { upper, middle, lower, width };
}

// ============================================
// VWAP (Volume Weighted Average Price)
// ============================================

/**
 * Calculate session VWAP from sessionStartIndex to index.
 * Session boundaries are defined by the caller (typically reset at UTC midnight).
 */
export function calculateVWAP(
  candles: Candle[],
  sessionStartIndex: number,
  index: number,
): number {
  let cumulativeTPV = 0; // TP * Volume
  let cumulativeVolume = 0;

  for (let i = sessionStartIndex; i <= index; i++) {
    const c = candles[i]!;
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumulativeTPV += typicalPrice * c.volume;
    cumulativeVolume += c.volume;
  }

  if (cumulativeVolume === 0) return candles[index]?.close ?? 0;
  return cumulativeTPV / cumulativeVolume;
}

/**
 * Find the session start index for a given timestamp.
 * Sessions reset at UTC midnight (00:00).
 */
export function findSessionStart(candles: Candle[], index: number): number {
  const currentDate = new Date(candles[index]!.timestamp);
  const dayStart = new Date(Date.UTC(
    currentDate.getUTCFullYear(),
    currentDate.getUTCMonth(),
    currentDate.getUTCDate(),
  )).getTime();

  // Walk backwards to find first candle of the day
  for (let i = index; i >= 0; i--) {
    if (candles[i]!.timestamp < dayStart) return i + 1;
  }
  return 0;
}

// ============================================
// MACD (Moving Average Convergence Divergence)
// ============================================

export interface MACD {
  macdLine: number;
  signalLine: number;
  histogram: number;
}

/**
 * Calculate MACD at a given index.
 * Default: 12/26/9 (fast/slow/signal).
 */
export function calculateMACD(
  candles: Candle[],
  index: number,
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MACD {
  const fastEMA = calculateEMA(candles, index, fastPeriod);
  const slowEMA = calculateEMA(candles, index, slowPeriod);
  const macdLine = fastEMA - slowEMA;

  // For signal line, we need MACD history
  // Build MACD values array up to index
  const macdValues: number[] = [];
  for (let i = 0; i <= index; i++) {
    const f = calculateEMA(candles, i, fastPeriod);
    const s = calculateEMA(candles, i, slowPeriod);
    macdValues.push(f - s);
  }

  const signalLine = calculateEMAFromValues(macdValues, index, signalPeriod);
  const histogram = macdLine - signalLine;

  return { macdLine, signalLine, histogram };
}

// ============================================
// BB Squeeze Detection
// ============================================

export interface SqueezeState {
  /** Whether bands are currently squeezed */
  isSqueezed: boolean;
  /** Number of consecutive bars in squeeze */
  squeezeBars: number;
  /** Whether just expanded (squeeze ended this bar) */
  justExpanded: boolean;
  /** Current BB width / ATR ratio */
  widthToAtrRatio: number;
}

/**
 * Detect Bollinger Band squeeze at a given index.
 * Squeeze = BB width < ATR * threshold for N consecutive bars.
 *
 * @param squeezeThreshold - BB width / ATR ratio below which = squeeze (default: 1.0)
 * @param minSqueezeBars - Minimum consecutive bars to qualify as squeeze (default: 6)
 */
export function detectBBSqueeze(
  candles: Candle[],
  index: number,
  bbPeriod = 20,
  atrPeriod = 14,
  squeezeThreshold = 1.0,
  minSqueezeBars = 6,
): SqueezeState {
  const atr = calculateATR(candles, index, atrPeriod);
  const bb = calculateBollingerBands(candles, index, bbPeriod);

  if (atr === 0) {
    return { isSqueezed: false, squeezeBars: 0, justExpanded: false, widthToAtrRatio: 0 };
  }

  const bbRange = bb.upper - bb.lower;
  const widthToAtrRatio = bbRange / atr;
  const currentlySqueezed = widthToAtrRatio < squeezeThreshold;

  // Count consecutive squeeze bars
  let squeezeBars = 0;
  if (currentlySqueezed) {
    squeezeBars = 1;
    for (let i = index - 1; i >= Math.max(0, index - 50); i--) {
      const prevATR = calculateATR(candles, i, atrPeriod);
      const prevBB = calculateBollingerBands(candles, i, bbPeriod);
      if (prevATR === 0) break;
      const prevRatio = (prevBB.upper - prevBB.lower) / prevATR;
      if (prevRatio < squeezeThreshold) {
        squeezeBars++;
      } else {
        break;
      }
    }
  }

  // Check if just expanded (was squeezed last bar, not anymore)
  let justExpanded = false;
  if (!currentlySqueezed && index > 0) {
    const prevATR = calculateATR(candles, index - 1, atrPeriod);
    const prevBB = calculateBollingerBands(candles, index - 1, bbPeriod);
    if (prevATR > 0) {
      const prevRatio = (prevBB.upper - prevBB.lower) / prevATR;
      justExpanded = prevRatio < squeezeThreshold;
    }
  }

  return {
    isSqueezed: currentlySqueezed && squeezeBars >= minSqueezeBars,
    squeezeBars: currentlySqueezed ? squeezeBars : 0,
    justExpanded,
    widthToAtrRatio,
  };
}

// ============================================
// Volume Analysis
// ============================================

/**
 * Calculate average volume over a period ending at index.
 */
export function calculateAvgVolume(candles: Candle[], index: number, period = 20): number {
  const start = Math.max(0, index - period + 1);
  let sum = 0;
  let count = 0;
  for (let i = start; i <= index; i++) {
    sum += candles[i]!.volume;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Get volume ratio: current volume / average volume.
 */
export function getVolumeRatio(candles: Candle[], index: number, period = 20): number {
  const avg = calculateAvgVolume(candles, index, period);
  if (avg === 0) return 1;
  return candles[index]!.volume / avg;
}
