/**
 * Market Regime Detection Module
 *
 * Classifies the current market regime along two axes:
 * - Trend: uptrend / downtrend / ranging
 * - Volatility: high / normal / low
 *
 * Used by the confluence scorer to suppress trades during unfavorable regimes
 * (e.g., ranging + low volatility = choppy price action that kills trend-following).
 *
 * Indicators:
 * 1. Efficiency ratio: |close[n] - close[0]| / sum(|close[i] - close[i-1]|)
 *    - High = trending, low = choppy/ranging
 * 2. ATR percentile: where current ATR sits in a rolling history
 *    - Normalizes across assets (BTC ATR vs SOL ATR)
 * 3. Trend strength: combined slope + swing structure alignment
 * 4. ADX-like directional movement (simplified, no external deps)
 */

import type { Candle } from '@/types';

// ============================================
// Types
// ============================================

export interface MarketRegime {
  /** Dominant trend direction */
  trend: 'uptrend' | 'downtrend' | 'ranging';
  /** Volatility classification */
  volatility: 'high' | 'normal' | 'low';
  /** Trend strength: 0 = no trend, 1 = strong trend */
  trendStrength: number;
  /** Current ATR as percentage of price */
  atrPercent: number;
  /** ATR percentile in rolling window (0 = lowest, 1 = highest) */
  atrPercentile: number;
  /** Efficiency ratio: directional movement / total movement (0-1) */
  efficiency: number;
  /** Smoothed directional index (0-1, higher = stronger directional movement) */
  directionalIndex: number;
  /** Classification confidence (0-1): how far from classification boundaries */
  confidence: number;
}

export interface RegimeDetectorConfig {
  /** Bars for trend/efficiency calculation (default: 100) */
  trendLookback: number;
  /** Bars for ATR percentile rolling window (default: 500) */
  atrRollingWindow: number;
  /** ATR period for current ATR calculation (default: 14) */
  atrPeriod: number;
  /** Efficiency threshold below which market is "ranging" (default: 0.25) */
  rangingEfficiencyThreshold: number;
  /** Efficiency threshold above which market is "trending" (default: 0.40) */
  trendingEfficiencyThreshold: number;
  /** ATR percentile below which volatility is "low" (default: 0.25) */
  lowVolatilityPercentile: number;
  /** ATR percentile above which volatility is "high" (default: 0.75) */
  highVolatilityPercentile: number;
  /** DI smoothing period (default: 14) */
  diPeriod: number;
}

export const DEFAULT_REGIME_CONFIG: RegimeDetectorConfig = {
  trendLookback: 100,
  atrRollingWindow: 500,
  atrPeriod: 14,
  rangingEfficiencyThreshold: 0.25,
  trendingEfficiencyThreshold: 0.40,
  lowVolatilityPercentile: 0.25,
  highVolatilityPercentile: 0.75,
  diPeriod: 14,
};

// ============================================
// Core Detection
// ============================================

/**
 * Detect market regime at a given index in the candle array.
 *
 * Requires at least `config.atrRollingWindow` bars of history for full
 * accuracy. Falls back gracefully with fewer bars.
 */
export function detectRegime(
  candles: Candle[],
  currentIndex: number,
  config: RegimeDetectorConfig = DEFAULT_REGIME_CONFIG,
): MarketRegime {
  // Ensure we have enough data
  const availableBars = currentIndex + 1;

  if (availableBars < 20) {
    return {
      trend: 'ranging',
      volatility: 'normal',
      trendStrength: 0,
      atrPercent: 0,
      atrPercentile: 0.5,
      efficiency: 0,
      directionalIndex: 0,
      confidence: 0,
    };
  }

  // 1. Calculate efficiency ratio
  const effLookback = Math.min(config.trendLookback, availableBars - 1);
  const efficiency = calculateEfficiencyRatio(candles, currentIndex, effLookback);

  // 2. Calculate ATR percent and percentile
  const { atrPercent, atrPercentile } = calculateATRPercentile(
    candles,
    currentIndex,
    config.atrPeriod,
    config.atrRollingWindow,
  );

  // 3. Calculate directional index (ADX-like)
  const diLookback = Math.min(config.diPeriod, availableBars - 1);
  const directionalIndex = calculateDirectionalIndex(candles, currentIndex, diLookback);

  // 4. Calculate trend strength (composite of efficiency + DI + slope)
  const slopeLookback = Math.min(config.trendLookback, availableBars - 1);
  const normalizedSlope = calculateNormalizedSlope(candles, currentIndex, slopeLookback);
  const trendStrength = calculateTrendStrength(efficiency, directionalIndex, normalizedSlope);

  // 5. Classify trend
  const trend = classifyTrend(
    efficiency,
    normalizedSlope,
    trendStrength,
    config.rangingEfficiencyThreshold,
    config.trendingEfficiencyThreshold,
  );

  // 6. Classify volatility
  const volatility = classifyVolatility(
    atrPercentile,
    config.lowVolatilityPercentile,
    config.highVolatilityPercentile,
  );

  // 7. Calculate classification confidence
  const confidence = calculateRegimeConfidence(
    efficiency,
    atrPercentile,
    config.rangingEfficiencyThreshold,
    config.trendingEfficiencyThreshold,
    config.lowVolatilityPercentile,
    config.highVolatilityPercentile,
  );

  return {
    trend,
    volatility,
    trendStrength,
    atrPercent,
    atrPercentile,
    efficiency,
    directionalIndex,
    confidence,
  };
}

// ============================================
// Efficiency Ratio
// ============================================

/**
 * Kaufman's Efficiency Ratio: |net movement| / total path length.
 * 1.0 = perfectly directional, 0.0 = price went nowhere despite moving a lot.
 */
function calculateEfficiencyRatio(
  candles: Candle[],
  endIndex: number,
  lookback: number,
): number {
  const startIndex = endIndex - lookback;
  if (startIndex < 0) return 0;

  const startCandle = candles[startIndex];
  const endCandle = candles[endIndex];
  if (!startCandle || !endCandle) return 0;

  const netMovement = Math.abs(endCandle.close - startCandle.close);

  let totalPath = 0;
  for (let i = startIndex + 1; i <= endIndex; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    if (!prev || !curr) continue;
    totalPath += Math.abs(curr.close - prev.close);
  }

  if (totalPath === 0) return 0;
  return netMovement / totalPath;
}

// ============================================
// ATR Percentile
// ============================================

/**
 * Calculate current ATR as % of price and its percentile in a rolling window.
 * Percentile normalizes across assets (BTC ~$90k vs SOL ~$200).
 */
function calculateATRPercentile(
  candles: Candle[],
  currentIndex: number,
  atrPeriod: number,
  rollingWindow: number,
): { atrPercent: number; atrPercentile: number } {
  const currentATR = calculateATR(candles, currentIndex, atrPeriod);
  const currentPrice = candles[currentIndex]?.close ?? 1;
  const atrPercent = currentATR / currentPrice;

  // Build ATR history for percentile calculation
  const historyStart = Math.max(atrPeriod + 1, currentIndex - rollingWindow);
  const atrHistory: number[] = [];

  // Sample every 10 bars to avoid O(n*m) complexity
  const step = Math.max(1, Math.floor((currentIndex - historyStart) / 50));
  for (let i = historyStart; i <= currentIndex; i += step) {
    const atr = calculateATR(candles, i, atrPeriod);
    const price = candles[i]?.close ?? 1;
    atrHistory.push(atr / price);
  }

  if (atrHistory.length < 2) {
    return { atrPercent, atrPercentile: 0.5 };
  }

  // Percentile: fraction of historical values <= current value
  const belowCount = atrHistory.filter((v) => v <= atrPercent).length;
  const atrPercentile = belowCount / atrHistory.length;

  return { atrPercent, atrPercentile };
}

/**
 * Simple ATR calculation over a given period ending at endIndex.
 */
function calculateATR(
  candles: Candle[],
  endIndex: number,
  period: number,
): number {
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

// ============================================
// Directional Index (Simplified ADX)
// ============================================

/**
 * Simplified directional movement index.
 * Measures how much of the price movement is directional vs random.
 *
 * Returns 0-1 where:
 * - 0 = no directional movement (equal +DM and -DM)
 * - 1 = strong directional movement (one side dominates)
 */
function calculateDirectionalIndex(
  candles: Candle[],
  endIndex: number,
  period: number,
): number {
  const start = Math.max(1, endIndex - period + 1);
  let plusDM = 0;
  let minusDM = 0;

  for (let i = start; i <= endIndex; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    if (!curr || !prev) continue;

    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;

    if (upMove > downMove && upMove > 0) {
      plusDM += upMove;
    }
    if (downMove > upMove && downMove > 0) {
      minusDM += downMove;
    }
  }

  const totalDM = plusDM + minusDM;
  if (totalDM === 0) return 0;

  // DX = |+DI - -DI| / (+DI + -DI)
  // Since we're using raw DM (not normalized by ATR), this gives us
  // a 0-1 measure of directional dominance
  return Math.abs(plusDM - minusDM) / totalDM;
}

// ============================================
// Normalized Slope
// ============================================

/**
 * Calculate price slope normalized by ATR to be asset-independent.
 * Returns a value roughly in [-1, 1]:
 * - Positive = uptrend
 * - Negative = downtrend
 * - Near 0 = flat
 */
function calculateNormalizedSlope(
  candles: Candle[],
  endIndex: number,
  lookback: number,
): number {
  const startIndex = endIndex - lookback;
  if (startIndex < 0) return 0;

  const startCandle = candles[startIndex];
  const endCandle = candles[endIndex];
  if (!startCandle || !endCandle) return 0;

  const priceChange = endCandle.close - startCandle.close;

  // Normalize by average price and lookback to get per-bar fractional change
  const avgPrice = (startCandle.close + endCandle.close) / 2;
  if (avgPrice === 0) return 0;

  const perBarChange = priceChange / (avgPrice * lookback);

  // Scale to roughly [-1, 1] range
  // 0.001 per bar = ~10% per 100 bars = moderate trend
  const scaleFactor = 1000;
  return Math.max(-1, Math.min(1, perBarChange * scaleFactor));
}

// ============================================
// Classification
// ============================================

/**
 * Composite trend strength from multiple indicators.
 * Each component contributes equally, result is 0-1.
 */
function calculateTrendStrength(
  efficiency: number,
  directionalIndex: number,
  normalizedSlope: number,
): number {
  // Efficiency already in 0-1
  // DI already in 0-1
  // |slope| in 0-1
  const absSlope = Math.abs(normalizedSlope);

  return (efficiency + directionalIndex + absSlope) / 3;
}

/**
 * Classify trend direction from indicators.
 */
function classifyTrend(
  efficiency: number,
  normalizedSlope: number,
  trendStrength: number,
  rangingThreshold: number,
  trendingThreshold: number,
): 'uptrend' | 'downtrend' | 'ranging' {
  // If efficiency is very low, market is ranging regardless of slope
  if (efficiency < rangingThreshold && trendStrength < 0.3) {
    return 'ranging';
  }

  // If efficiency is high enough for a trend, check direction
  if (efficiency >= trendingThreshold || trendStrength >= 0.4) {
    return normalizedSlope >= 0 ? 'uptrend' : 'downtrend';
  }

  // In between: use a combination
  if (Math.abs(normalizedSlope) > 0.3) {
    return normalizedSlope > 0 ? 'uptrend' : 'downtrend';
  }

  return 'ranging';
}

/**
 * Calculate classification confidence (0-1).
 * Higher when efficiency and ATR percentile are far from classification boundaries.
 * Lower when they're near the thresholds (ambiguous regime).
 */
function calculateRegimeConfidence(
  efficiency: number,
  atrPercentile: number,
  rangingThreshold: number,
  trendingThreshold: number,
  lowVolPct: number,
  highVolPct: number,
): number {
  // Trend confidence: distance from nearest classification boundary
  const trendMidpoint = (rangingThreshold + trendingThreshold) / 2;
  const trendRange = trendingThreshold - rangingThreshold;
  const trendDist = trendRange > 0
    ? Math.min(
        Math.abs(efficiency - rangingThreshold),
        Math.abs(efficiency - trendingThreshold),
      ) / trendRange
    : 0;
  // If clearly ranging (below threshold) or clearly trending (above), high confidence
  const trendConfidence = efficiency < rangingThreshold || efficiency > trendingThreshold
    ? Math.min(1, 0.5 + trendDist)
    : Math.max(0, 0.5 - (0.5 - trendDist));

  // Volatility confidence: distance from classification boundaries
  const volDist = Math.min(
    Math.abs(atrPercentile - lowVolPct),
    Math.abs(atrPercentile - highVolPct),
  );
  const volRange = highVolPct - lowVolPct;
  const volConfidence = volRange > 0
    ? Math.min(1, volDist / (volRange * 0.5))
    : 0.5;

  // Combined: geometric mean (both must be confident)
  return Math.sqrt(trendConfidence * volConfidence);
}

/**
 * Classify volatility from ATR percentile.
 */
function classifyVolatility(
  atrPercentile: number,
  lowThreshold: number,
  highThreshold: number,
): 'high' | 'normal' | 'low' {
  if (atrPercentile >= highThreshold) return 'high';
  if (atrPercentile <= lowThreshold) return 'low';
  return 'normal';
}

// ============================================
// Convenience: Regime Label
// ============================================

/**
 * Get a human-readable label for the regime (e.g., "uptrend+normal").
 */
export function regimeLabel(regime: MarketRegime): string {
  return `${regime.trend}+${regime.volatility}`;
}

/**
 * Check if the regime is favorable for trend-following strategies.
 * Returns true if the regime has sufficient trend + efficiency.
 */
export function isFavorableForTrending(
  regime: MarketRegime,
  minEfficiency: number = 0.25,
  minTrendStrength: number = 0.2,
): boolean {
  return (
    regime.trend !== 'ranging' &&
    regime.efficiency >= minEfficiency &&
    regime.trendStrength >= minTrendStrength
  );
}
