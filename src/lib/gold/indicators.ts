/**
 * F2F Gold Strategy — Pure Indicator Functions
 *
 * All functions are pure (no side effects) and operate on typed arrays for performance.
 * Each computes a single indicator series from candle data.
 */

import type { Candle } from '@/types/candle';
import type { F2FTrainStats } from './types';

// ============================================
// Smoothed Log-Price (EMA on log-prices)
// ============================================

/**
 * Compute exponentially smoothed log-prices.
 *
 * ỹ_t = λ·ỹ_{t-1} + (1-λ)·log(P_t)
 *
 * Seed: ỹ_0 = log(P_0)
 *
 * @returns Float64Array of smoothed log-prices (same length as candles)
 */
export function computeSmoothedLogPrices(
  candles: Candle[],
  lambda: number,
): Float64Array {
  const n = candles.length;
  const result = new Float64Array(n);

  if (n === 0) return result;

  result[0] = Math.log(candles[0]!.close);

  for (let i = 1; i < n; i++) {
    result[i] = lambda * result[i - 1]! + (1 - lambda) * Math.log(candles[i]!.close);
  }

  return result;
}

/**
 * Compute delta of smoothed log-prices: Δỹ_t = ỹ_t - ỹ_{t-1}
 *
 * @returns Float64Array of deltas (length = n, first element is 0)
 */
export function computeDeltaSmoothed(smoothed: Float64Array): Float64Array {
  const n = smoothed.length;
  const result = new Float64Array(n);

  for (let i = 1; i < n; i++) {
    result[i] = smoothed[i]! - smoothed[i - 1]!;
  }

  return result;
}

// ============================================
// Training Statistics
// ============================================

/**
 * Compute mean and std of Δỹ over a training window.
 *
 * CRITICAL: Must be recomputed per λ value (slope distribution depends on λ).
 */
export function computeTrainStats(
  deltaSmoothed: Float64Array,
  trainStart: number,
  trainEnd: number,
): F2FTrainStats {
  const n = trainEnd - trainStart;
  if (n <= 1) return { mu: 0, sigma: 1 };

  let sum = 0;
  for (let i = trainStart; i < trainEnd; i++) {
    sum += deltaSmoothed[i]!;
  }
  const mu = sum / n;

  let sumSq = 0;
  for (let i = trainStart; i < trainEnd; i++) {
    const d = deltaSmoothed[i]! - mu;
    sumSq += d * d;
  }
  const sigma = Math.sqrt(sumSq / n);

  return { mu, sigma: Math.max(sigma, 1e-10) };
}

// ============================================
// Z-Score
// ============================================

/**
 * Compute z-scores of Δỹ using training statistics.
 *
 * z_t = (Δỹ_t - μ_train) / σ_train
 *
 * Clipped to [-3, +3] as per paper.
 */
export function computeZScores(
  deltaSmoothed: Float64Array,
  trainStats: F2FTrainStats,
  clipMin: number = -3,
  clipMax: number = 3,
): Float64Array {
  const n = deltaSmoothed.length;
  const result = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const raw = (deltaSmoothed[i]! - trainStats.mu) / trainStats.sigma;
    result[i] = Math.max(clipMin, Math.min(clipMax, raw));
  }

  return result;
}

// ============================================
// EWMA Volatility
// ============================================

/**
 * Compute EWMA volatility of daily log returns.
 *
 * σ̂²_t = θ·σ̂²_{t-1} + (1-θ)·r²_t
 *
 * Where r_t = log(P_t / P_{t-1})
 *
 * Seed: σ̂²_0 = average r² over first 20 bars (or available bars)
 *
 * @returns Float64Array of EWMA vol (daily std dev, NOT variance)
 */
export function computeEWMAVol(
  candles: Candle[],
  theta: number,
): Float64Array {
  const n = candles.length;
  const result = new Float64Array(n);

  if (n < 2) return result;

  // Compute log returns
  const logReturns = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    logReturns[i] = Math.log(candles[i]!.close / candles[i - 1]!.close);
  }

  // Seed: average r² over first 20 bars
  const seedPeriod = Math.min(20, n - 1);
  let seedVar = 0;
  for (let i = 1; i <= seedPeriod; i++) {
    seedVar += logReturns[i]! * logReturns[i]!;
  }
  seedVar /= seedPeriod;

  // EWMA recursion
  let variance = seedVar;
  result[0] = Math.sqrt(Math.max(variance, 1e-10));

  for (let i = 1; i < n; i++) {
    const r2 = logReturns[i]! * logReturns[i]!;
    variance = theta * variance + (1 - theta) * r2;
    result[i] = Math.sqrt(Math.max(variance, 1e-10));
  }

  return result;
}

// ============================================
// ATR (Average True Range)
// ============================================

/**
 * Compute ATR using exponential moving average (Wilder's method).
 *
 * @returns Float64Array of ATR values (same length as candles)
 */
export function computeATR(
  candles: Candle[],
  period: number,
): Float64Array {
  const n = candles.length;
  const result = new Float64Array(n);

  if (n < 2) return result;

  // True range
  const tr = new Float64Array(n);
  tr[0] = candles[0]!.high - candles[0]!.low;

  for (let i = 1; i < n; i++) {
    const c = candles[i]!;
    const prevClose = candles[i - 1]!.close;
    tr[i] = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
  }

  // Seed: SMA of first `period` true ranges
  const seedEnd = Math.min(period, n);
  let atrSum = 0;
  for (let i = 0; i < seedEnd; i++) {
    atrSum += tr[i]!;
  }
  let atr = atrSum / seedEnd;

  for (let i = 0; i < seedEnd; i++) {
    result[i] = atr;
  }

  // Wilder's EMA: ATR_t = ((period-1)·ATR_{t-1} + TR_t) / period
  for (let i = seedEnd; i < n; i++) {
    atr = ((period - 1) * atr + tr[i]!) / period;
    result[i] = atr;
  }

  return result;
}

// ============================================
// Momentum
// ============================================

/**
 * Compute binary momentum indicator.
 *
 * m_t = 1 if P_t / P_{t-lookback} > 1, else 0
 *
 * For bars with insufficient lookback, m_t = 0.
 */
export function computeMomentum(
  candles: Candle[],
  lookback: number,
): Float64Array {
  const n = candles.length;
  const result = new Float64Array(n);

  for (let i = lookback; i < n; i++) {
    result[i] = candles[i]!.close / candles[i - lookback]!.close > 1 ? 1 : 0;
  }

  return result;
}

// ============================================
// Regime Filters (fixed lookbacks, no optimized params)
// ============================================

export type RegimeFilterType = 'ma200' | 'zscore50' | 'none';

/**
 * MA-based regime filter: suppress entries when price < 200-day SMA AND SMA is declining.
 *
 * Returns boolean array where true = regime suppressed (don't enter).
 */
export function computeMA200RegimeFilter(candles: Candle[]): boolean[] {
  const n = candles.length;
  const lookback = 200;
  const result = new Array<boolean>(n).fill(false);

  if (n < lookback + 1) return result;

  // Compute 200-day SMA
  const sma = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < lookback; i++) {
    sum += candles[i]!.close;
  }
  sma[lookback - 1] = sum / lookback;

  for (let i = lookback; i < n; i++) {
    sum += candles[i]!.close - candles[i - lookback]!.close;
    sma[i] = sum / lookback;
  }

  // Suppress: price < SMA AND SMA is declining (SMA today < SMA yesterday)
  for (let i = lookback; i < n; i++) {
    const priceBelowMA = candles[i]!.close < sma[i]!;
    const maDecreasing = sma[i]! < sma[i - 1]!;
    result[i] = priceBelowMA && maDecreasing;
  }

  return result;
}

/**
 * Z-score-based regime filter: suppress entries when trailing 50-bar average z-score < threshold.
 *
 * Uses the model's own z-score signal — no new indicators needed.
 * Default threshold: -0.5 (bearish momentum).
 */
export function computeZScore50RegimeFilter(
  zScores: Float64Array,
  threshold: number = -0.5,
): boolean[] {
  const n = zScores.length;
  const lookback = 50;
  const result = new Array<boolean>(n).fill(false);

  if (n < lookback) return result;

  // Rolling mean of z-scores
  let sum = 0;
  for (let i = 0; i < lookback; i++) {
    sum += zScores[i]!;
  }

  for (let i = lookback; i < n; i++) {
    sum += zScores[i]! - zScores[i - lookback]!;
    const avgZScore = sum / lookback;
    result[i] = avgZScore < threshold;
  }

  return result;
}
