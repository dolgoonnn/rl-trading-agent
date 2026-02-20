/**
 * F2F Gold Strategy — Walk-Forward Optimizer
 *
 * Grid-search λ×θ (10×10 = 100 combos) per walk-forward window.
 * 10yr train → 6mo val → 1mo slide.
 *
 * The optimizer:
 * 1. For each window, grid-searches λ×θ on train data (max Sharpe)
 * 2. Freezes best params and evaluates on OOS (validation) data
 * 3. Collects all OOS trades and reports pass rate
 * 4. Returns finalParams from the last window (for live deployment)
 */

import type { Candle } from '@/types/candle';
import type {
  F2FOptimizedParams,
  F2FWalkForwardConfig,
  F2FWindowResult,
  F2FOptimizationResult,
  F2FSimulationResult,
  F2FTrade,
  F2FExitReason,
} from './types';
import { F2F_GRID, F2F_DEFAULT_WF_CONFIG, F2F_FIXED_PARAMS } from './types';
import { generateSignals } from './signals';
import { type RegimeFilterType } from './indicators';
import { runF2FSimulation, type F2FDirectionMode } from './strategy';

// ============================================
// Grid Search for a Single Window
// ============================================

interface GridResult {
  lambda: number;
  theta: number;
  sharpe: number;
  trades: number;
}

/**
 * Grid-search λ×θ on training data, maximizing Sharpe.
 *
 * @param candles    Full candle array (need indices before trainStart for warm-up)
 * @param trainStart Train window start index
 * @param trainEnd   Train window end index (exclusive)
 * @param friction   One-way friction
 *
 * @returns Best (lambda, theta) and their train Sharpe
 */
function gridSearchTrain(
  candles: Candle[],
  trainStart: number,
  trainEnd: number,
  friction: number,
  directionMode: F2FDirectionMode = 'long-only',
  regimeFilter: RegimeFilterType = 'none',
): GridResult {
  let bestResult: GridResult = { lambda: 0.94, theta: 0.94, sharpe: -Infinity, trades: 0 };

  for (let lambda = F2F_GRID.lambdaMin; lambda <= F2F_GRID.lambdaMax + 1e-9; lambda += F2F_GRID.lambdaStep) {
    for (let theta = F2F_GRID.thetaMin; theta <= F2F_GRID.thetaMax + 1e-9; theta += F2F_GRID.thetaStep) {
      const roundedLambda = Math.round(lambda * 100) / 100;
      const roundedTheta = Math.round(theta * 100) / 100;

      const params: F2FOptimizedParams = { lambda: roundedLambda, theta: roundedTheta };

      const signals = generateSignals(
        candles,
        params,
        trainStart,
        trainEnd,
        trainStart,
        trainEnd,
        regimeFilter,
      );

      const result = runF2FSimulation(signals, friction, directionMode);

      if (result.sharpe > bestResult.sharpe) {
        bestResult = {
          lambda: roundedLambda,
          theta: roundedTheta,
          sharpe: result.sharpe,
          trades: result.trades.length,
        };
      }
    }
  }

  return bestResult;
}

// ============================================
// Walk-Forward Optimization
// ============================================

export interface WalkForwardProgressCallback {
  (windowIndex: number, totalWindows: number, result: F2FWindowResult): void;
}

/**
 * Run full walk-forward optimization.
 *
 * For each window:
 * 1. Grid-search on [trainStart, trainEnd) → best λ, θ
 * 2. Generate signals on [valStart, valEnd) using train stats
 * 3. Run simulation → collect OOS trades
 *
 * @param candles       Full daily candle array (2005-present)
 * @param config        Walk-forward config (train/val/slide sizes)
 * @param friction      One-way friction (default: 0.0005 = 5bps)
 * @param onProgress    Optional callback for progress reporting
 * @param directionMode Direction mode for trading (default: 'long-only')
 * @param regimeFilter  Regime filter type (default: 'none')
 *
 * @returns F2FOptimizationResult with all window results and aggregate metrics
 */
export function runWalkForwardOptimization(
  candles: Candle[],
  config: F2FWalkForwardConfig = F2F_DEFAULT_WF_CONFIG,
  friction: number = 0.0005,
  onProgress?: WalkForwardProgressCallback,
  directionMode: F2FDirectionMode = 'long-only',
  regimeFilter: RegimeFilterType = 'none',
): F2FOptimizationResult {
  const windows: F2FWindowResult[] = [];
  const allOOSTrades: F2FTrade[] = [];

  // Calculate total windows
  const totalBars = candles.length;
  const minStart = 0;
  let windowIndex = 0;

  for (let trainStart = minStart; trainStart + config.trainBars + config.valBars <= totalBars; trainStart += config.slideBars) {
    const trainEnd = trainStart + config.trainBars;
    const valStart = trainEnd;
    const valEnd = Math.min(valStart + config.valBars, totalBars);

    if (valEnd - valStart < 21) break; // Need at least 1 month of OOS data

    // Step 1: Grid search on train
    const bestGrid = gridSearchTrain(candles, trainStart, trainEnd, friction, directionMode, regimeFilter);

    // Step 2: Generate OOS signals using train stats
    const bestParams: F2FOptimizedParams = {
      lambda: bestGrid.lambda,
      theta: bestGrid.theta,
    };

    const oosSignals = generateSignals(
      candles,
      bestParams,
      trainStart,   // train stats from [trainStart, trainEnd)
      trainEnd,
      valStart,     // signals from [valStart, valEnd)
      valEnd,
      regimeFilter,
    );

    // Step 3: Simulate on OOS
    const oosResult = runF2FSimulation(oosSignals, friction, directionMode);

    const windowResult: F2FWindowResult = {
      windowIndex,
      trainStart,
      trainEnd,
      valStart,
      valEnd,
      bestLambda: bestGrid.lambda,
      bestTheta: bestGrid.theta,
      trainSharpe: bestGrid.sharpe,
      valSharpe: oosResult.sharpe,
      valTrades: oosResult.trades,
      pass: oosResult.sharpe > 0,
    };

    windows.push(windowResult);
    allOOSTrades.push(...oosResult.trades);

    if (onProgress) {
      const totalEstimated = Math.ceil((totalBars - config.trainBars - config.valBars) / config.slideBars) + 1;
      onProgress(windowIndex, totalEstimated, windowResult);
    }

    windowIndex++;
  }

  // Pass rate: fraction of eligible windows with positive OOS Sharpe
  // Skip windows with 0 trades (no signal in that period)
  const eligibleWindows = windows.filter((w) => w.valTrades.length > 0);
  const passRate = eligibleWindows.length > 0
    ? eligibleWindows.filter((w) => w.pass).length / eligibleWindows.length
    : 0;

  // Final params from last window (for live use)
  const lastWindow = windows[windows.length - 1];
  const finalParams: F2FOptimizedParams = lastWindow
    ? { lambda: lastWindow.bestLambda, theta: lastWindow.bestTheta }
    : { lambda: 0.94, theta: 0.94 };

  // Aggregate OOS metrics
  const aggregate = computeAggregateMetrics(allOOSTrades);

  return {
    windows,
    passRate,
    allOOSTrades,
    finalParams,
    aggregate,
  };
}

// ============================================
// Aggregate Metrics
// ============================================

function computeAggregateMetrics(trades: F2FTrade[]): F2FSimulationResult {
  let equity = 1.0;
  const equityCurve: number[] = [];
  for (const t of trades) {
    equityCurve.push(equity);
    equity *= 1 + t.pnlPercent;
  }
  equityCurve.push(equity);

  const totalPnl = equity - 1;
  const sharpe = computeSharpeFromEquityCurve(equityCurve);

  let peak = 0;
  let maxDrawdown = 0;
  for (const val of equityCurve) {
    if (val > peak) peak = val;
    if (peak > 0) {
      const dd = (peak - val) / peak;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  }

  const winRate = trades.length > 0
    ? trades.filter((t) => t.pnlPercent > 0).length / trades.length
    : 0;
  const avgDaysHeld = trades.length > 0
    ? trades.reduce((s, t) => s + t.daysHeld, 0) / trades.length
    : 0;

  const exitReasons: Record<F2FExitReason, number> = {
    hard_stop: 0,
    trailing_stop: 0,
    timeout: 0,
    derisk: 0,
    end_of_data: 0,
  };
  for (const t of trades) {
    exitReasons[t.exitReason]++;
  }

  return {
    trades,
    equityCurve,
    totalPnl,
    sharpe,
    maxDrawdown,
    winRate,
    avgDaysHeld,
    exitReasons,
  };
}

/**
 * Compute annualized Sharpe from per-bar equity curve.
 * Uses daily equity returns (including flat days) with √252 annualization.
 */
function computeSharpeFromEquityCurve(equityCurve: number[]): number {
  if (equityCurve.length < 3) return 0;

  const dailyReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    if (equityCurve[i - 1]! > 0) {
      dailyReturns.push(equityCurve[i]! / equityCurve[i - 1]! - 1);
    }
  }

  if (dailyReturns.length < 2) return 0;
  const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / dailyReturns.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * F2F_FIXED_PARAMS.annualizationFactor;
}
