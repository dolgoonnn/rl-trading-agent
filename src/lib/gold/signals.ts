/**
 * F2F Gold Strategy — Signal Generation
 *
 * Generates F2FSignal[] from pre-computed indicator arrays.
 * Separated from strategy loop so the optimizer can re-run strategy
 * cheaply without recomputing signals for unchanged λ.
 */

import type { Candle } from '@/types/candle';
import type { F2FSignal, F2FTrainStats, F2FOptimizedParams } from './types';
import { F2F_FIXED_PARAMS } from './types';
import {
  computeSmoothedLogPrices,
  computeDeltaSmoothed,
  computeTrainStats,
  computeZScores,
  computeEWMAVol,
  computeATR,
  computeMomentum,
  computeMA200RegimeFilter,
  computeZScore50RegimeFilter,
  type RegimeFilterType,
} from './indicators';

// ============================================
// Signal Generation
// ============================================

/**
 * Generate F2F signals for a candle array.
 *
 * @param candles    Full candle array
 * @param params     Optimized params (λ, θ)
 * @param trainStart Start index for training stats (inclusive)
 * @param trainEnd   End index for training stats (exclusive)
 * @param signalStart Generate signals from this index (must be >= trainEnd for no look-ahead)
 * @param signalEnd  Generate signals up to this index (exclusive, default: candles.length)
 *
 * @returns Array of F2FSignal for [signalStart, signalEnd)
 */
export function generateSignals(
  candles: Candle[],
  params: F2FOptimizedParams,
  trainStart: number,
  trainEnd: number,
  signalStart: number,
  signalEnd?: number,
  regimeFilter: RegimeFilterType = 'none',
): F2FSignal[] {
  const end = signalEnd ?? candles.length;
  const fp = F2F_FIXED_PARAMS;

  // Pre-compute indicator arrays over full candle range
  const smoothed = computeSmoothedLogPrices(candles, params.lambda);
  const deltaSmoothed = computeDeltaSmoothed(smoothed);
  const trainStats = computeTrainStats(deltaSmoothed, trainStart, trainEnd);
  const zScores = computeZScores(deltaSmoothed, trainStats, fp.zScoreClipMin, fp.zScoreClipMax);
  const ewmaVol = computeEWMAVol(candles, params.theta);
  const atr = computeATR(candles, fp.atrPeriod);
  const momentum = computeMomentum(candles, fp.momentumLookback);

  // Compute regime filter
  let regimeSuppressed: boolean[];
  if (regimeFilter === 'ma200') {
    regimeSuppressed = computeMA200RegimeFilter(candles);
  } else if (regimeFilter === 'zscore50') {
    regimeSuppressed = computeZScore50RegimeFilter(zScores);
  } else {
    regimeSuppressed = new Array(candles.length).fill(false);
  }

  // Generate signals
  const signals: F2FSignal[] = [];

  for (let i = signalStart; i < end; i++) {
    const candle = candles[i]!;

    // p_trend = (clip(z_t, -3, 3) + 3) / 6  ∈ [0, 1]
    const pTrend = (zScores[i]! + 3) / 6;

    // p_bull = ω·p_trend + (1-ω)·m_t
    const pBull = fp.trendBlendWeight * pTrend + (1 - fp.trendBlendWeight) * momentum[i]!;
    const pBear = 1 - pBull;

    const isSuppressed = regimeSuppressed[i]!;

    // Long entry: p_bull >= threshold AND Δỹ_t > 0, suppressed by regime filter
    const isLongEntry = !isSuppressed && pBull >= fp.activationThreshold && deltaSmoothed[i]! > 0;

    // Short entry: p_bear >= threshold AND Δỹ_t < 0, suppressed by regime filter
    const isShortEntry = !isSuppressed && pBear >= fp.activationThreshold && deltaSmoothed[i]! < 0;

    signals.push({
      index: i,
      timestamp: candle.timestamp,
      smoothedLogPrice: smoothed[i]!,
      deltaSmoothed: deltaSmoothed[i]!,
      zScore: zScores[i]!,
      pTrend,
      momentum: momentum[i]!,
      pBull,
      pBear,
      atr: atr[i]!,
      ewmaVol: ewmaVol[i]!,
      close: candle.close,
      low: candle.low,
      isLongEntry,
      isShortEntry,
      isRegimeSuppressed: isSuppressed,
    });
  }

  return signals;
}

/**
 * Generate signals for a specific window using train stats.
 * Convenience wrapper for the optimizer.
 */
export function generateWindowSignals(
  candles: Candle[],
  params: F2FOptimizedParams,
  trainStart: number,
  trainEnd: number,
  windowStart: number,
  windowEnd: number,
): F2FSignal[] {
  return generateSignals(candles, params, trainStart, trainEnd, windowStart, windowEnd);
}

/**
 * Compute training stats only (for the optimizer to check train Sharpe).
 */
export function getTrainStats(
  candles: Candle[],
  lambda: number,
  trainStart: number,
  trainEnd: number,
): F2FTrainStats {
  const smoothed = computeSmoothedLogPrices(candles, lambda);
  const deltaSmoothed = computeDeltaSmoothed(smoothed);
  return computeTrainStats(deltaSmoothed, trainStart, trainEnd);
}
