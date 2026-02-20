/**
 * F2F Gold Strategy — Simulation Loop
 *
 * Pure function: takes signals + params, outputs trades + equity curve.
 * No side effects, no I/O, no global state.
 *
 * Position sizing: vol-targeted, Kelly-scaled, capped at 2x leverage.
 * Exits: hard stop (2×ATR), trailing stop (1.5×ATR), timeout (30d), de-risk (p_bear > 0.50).
 */

import type {
  F2FSignal,
  F2FTrade,
  F2FExitReason,
  F2FSimulationResult,
} from './types';
import { F2F_FIXED_PARAMS } from './types';

// ============================================
// Position State (internal)
// ============================================

interface ActivePosition {
  entryIndex: number;
  entryTimestamp: number;
  entryPrice: number;
  weight: number;
  direction: 'long' | 'short';
  hardStop: number;
  trailingStop: number;
  /** Peak price for longs, trough price for shorts */
  extremePrice: number;
  daysHeld: number;
  pBullAtEntry: number;
  atrAtEntry: number;
}

// ============================================
// Position Sizing
// ============================================

/**
 * Compute position weight using vol-targeting + Kelly fraction.
 *
 * Full formula: w = min(L, sigma_target/sigma_hat) x (p-0.5)/0.5 x f_star - gamma|Δw| + baseline x w_vol
 *
 * Where:
 * - σ* = daily vol target (0.15 / √252)
 * - σ̂ = EWMA daily vol
 * - p = p_bull for longs, p_bear for shorts
 * - f* = Kelly fraction (0.40)
 * - γ = market impact penalty (default 0 = disabled)
 * - baseline = fraction of vol-target held always (default 0 = disabled)
 */
export function computePositionWeight(
  signal: F2FSignal,
  direction: 'long' | 'short' = 'long',
  prevWeight: number = 0,
): number {
  const fp = F2F_FIXED_PARAMS;

  if (signal.ewmaVol <= 0) return 0;

  // Vol-targeting ratio
  const volRatio = Math.min(fp.leverageCap, fp.dailyVolTarget / signal.ewmaVol);

  // Confidence scaling: use p_bull for longs, p_bear for shorts
  const p = direction === 'long' ? signal.pBull : signal.pBear;
  const confidence = Math.max(0, (p - 0.5) / 0.5);

  let weight = volRatio * confidence * fp.kellyFraction;

  // Market impact penalty: reduce weight by γ × |weight change|
  if (fp.marketImpactGamma > 0) {
    const deltaW = Math.abs(weight - prevWeight);
    weight = Math.max(0, weight - fp.marketImpactGamma * deltaW);
  }

  // Baseline position: always hold a small fraction of vol-targeted weight
  if (fp.baselinePositionFraction > 0) {
    weight += fp.baselinePositionFraction * volRatio;
  }

  // Clamp to leverage cap
  return Math.min(weight, fp.leverageCap);
}

// ============================================
// Exit Logic
// ============================================

/**
 * Check all exit conditions. Returns the first triggered exit reason, or null if holding.
 *
 * Uses close price for stop checks (daily bar system — end-of-day decision, no intraday resolution).
 * Handles both long and short positions.
 */
export function checkExits(
  position: ActivePosition,
  signal: F2FSignal,
): F2FExitReason | null {
  const fp = F2F_FIXED_PARAMS;

  if (position.direction === 'long') {
    // 1. Hard stop: close breached stop level (below entry)
    if (signal.close <= position.hardStop) {
      return 'hard_stop';
    }

    // 2. Trailing stop: close breached trailing level (below peak)
    if (signal.close <= position.trailingStop) {
      return 'trailing_stop';
    }

    // 3. Timeout
    if (position.daysHeld >= fp.timeoutDays) {
      return 'timeout';
    }

    // 4. De-risk: p_bear > 0.50 (bullish conviction lost)
    if (signal.pBear > 0.50) {
      return 'derisk';
    }
  } else {
    // Short position: stops are above entry/trough

    // 1. Hard stop: close breached stop level (above entry)
    if (signal.close >= position.hardStop) {
      return 'hard_stop';
    }

    // 2. Trailing stop: close breached trailing level (above trough)
    if (signal.close >= position.trailingStop) {
      return 'trailing_stop';
    }

    // 3. Timeout
    if (position.daysHeld >= fp.timeoutDays) {
      return 'timeout';
    }

    // 4. De-risk: p_bull > 0.50 (bearish conviction lost)
    if (signal.pBull > 0.50) {
      return 'derisk';
    }
  }

  return null;
}

/**
 * Update trailing stop based on new extreme.
 * Longs: trail below peak. Shorts: trail above trough.
 * Mutates in place for performance.
 *
 * Uses CURRENT ATR (signal.atr) per the paper: trailing stop widens when volatility expands.
 */
export function updateTrailingStop(
  position: ActivePosition,
  signal: F2FSignal,
): void {
  const fp = F2F_FIXED_PARAMS;

  if (position.direction === 'long') {
    // Update peak if new high
    if (signal.close > position.extremePrice) {
      position.extremePrice = signal.close;
      position.trailingStop = position.extremePrice - fp.trailingStopAtrMultiple * signal.atr;
    }
  } else {
    // Short: update trough if new low
    if (signal.close < position.extremePrice) {
      position.extremePrice = signal.close;
      position.trailingStop = position.extremePrice + fp.trailingStopAtrMultiple * signal.atr;
    }
  }
}

// ============================================
// Core Simulation
// ============================================

/**
 * Direction mode for simulation.
 * - 'long-only': original F2F behavior
 * - 'short-only': only short entries (for isolating short edge)
 * - 'both': long and short entries
 */
export type F2FDirectionMode = 'long-only' | 'short-only' | 'both';

/**
 * Run F2F simulation on pre-generated signals.
 *
 * @param signals       Ordered F2FSignal array
 * @param friction      One-way friction (e.g., 0.0005 = 5bps)
 * @param directionMode Which directions to trade (default: 'long-only')
 *
 * @returns F2FSimulationResult with trades, equity curve, and aggregate metrics
 */
export function runF2FSimulation(
  signals: F2FSignal[],
  friction: number = 0.0005,
  directionMode: F2FDirectionMode = 'long-only',
): F2FSimulationResult {
  const fp = F2F_FIXED_PARAMS;
  const trades: F2FTrade[] = [];
  const equityCurve = new Array<number>(signals.length);

  let equity = 1.0;
  let position: ActivePosition | null = null;

  for (let i = 0; i < signals.length; i++) {
    const signal = signals[i]!;
    equityCurve[i] = equity;

    if (position !== null) {
      // Update trailing stop before checking exits
      updateTrailingStop(position, signal);
      position.daysHeld++;

      const exitReason = checkExits(position, signal);

      if (exitReason !== null) {
        // Close position — all exits fill at close (daily bar system)
        const exitPrice = signal.close;

        // PnL: long = (exit - entry) / entry, short = (entry - exit) / entry
        const grossReturn = position.direction === 'long'
          ? (exitPrice - position.entryPrice) / position.entryPrice
          : (position.entryPrice - exitPrice) / position.entryPrice;
        const netReturn = position.weight * grossReturn - 2 * friction * position.weight;

        equity *= 1 + netReturn;

        trades.push({
          entryIndex: position.entryIndex,
          entryTimestamp: position.entryTimestamp,
          entryPrice: position.entryPrice,
          exitIndex: signal.index,
          exitTimestamp: signal.timestamp,
          exitPrice,
          exitReason,
          direction: position.direction,
          weight: position.weight,
          pnlPercent: netReturn,
          daysHeld: position.daysHeld,
          pBullAtEntry: position.pBullAtEntry,
          atrAtEntry: position.atrAtEntry,
          hardStop: position.hardStop,
          trailingStop: position.trailingStop,
          peakPrice: position.extremePrice,
        });

        position = null;
        equityCurve[i] = equity;
      }
    }

    // Entry: only if flat
    if (position === null) {
      const allowLong = directionMode === 'long-only' || directionMode === 'both';
      const allowShort = directionMode === 'short-only' || directionMode === 'both';

      if (allowLong && signal.isLongEntry) {
        const weight = computePositionWeight(signal, 'long');
        if (weight > 0.01) {
          position = {
            entryIndex: signal.index,
            entryTimestamp: signal.timestamp,
            entryPrice: signal.close,
            weight,
            direction: 'long',
            hardStop: signal.close - fp.hardStopAtrMultiple * signal.atr,
            trailingStop: signal.close - fp.trailingStopAtrMultiple * signal.atr,
            extremePrice: signal.close,
            daysHeld: 0,
            pBullAtEntry: signal.pBull,
            atrAtEntry: signal.atr,
          };
        }
      } else if (allowShort && signal.isShortEntry) {
        const weight = computePositionWeight(signal, 'short');
        if (weight > 0.01) {
          position = {
            entryIndex: signal.index,
            entryTimestamp: signal.timestamp,
            entryPrice: signal.close,
            weight,
            direction: 'short',
            // Short: hard stop above entry, trailing above trough
            hardStop: signal.close + fp.hardStopAtrMultiple * signal.atr,
            trailingStop: signal.close + fp.trailingStopAtrMultiple * signal.atr,
            extremePrice: signal.close,
            daysHeld: 0,
            pBullAtEntry: signal.pBull,
            atrAtEntry: signal.atr,
          };
        }
      }
    }
  }

  // Close any remaining position at end of data
  if (position !== null) {
    const lastSignal = signals[signals.length - 1]!;
    const grossReturn = position.direction === 'long'
      ? (lastSignal.close - position.entryPrice) / position.entryPrice
      : (position.entryPrice - lastSignal.close) / position.entryPrice;
    const netReturn = position.weight * grossReturn - 2 * friction * position.weight;
    equity *= 1 + netReturn;

    trades.push({
      entryIndex: position.entryIndex,
      entryTimestamp: position.entryTimestamp,
      entryPrice: position.entryPrice,
      exitIndex: lastSignal.index,
      exitTimestamp: lastSignal.timestamp,
      exitPrice: lastSignal.close,
      exitReason: 'end_of_data',
      direction: position.direction,
      weight: position.weight,
      pnlPercent: netReturn,
      daysHeld: position.daysHeld,
      pBullAtEntry: position.pBullAtEntry,
      atrAtEntry: position.atrAtEntry,
      hardStop: position.hardStop,
      trailingStop: position.trailingStop,
      peakPrice: position.extremePrice,
    });
  }

  // Compute aggregate metrics
  const totalPnl = equity - 1;
  const sharpe = computeSharpeFromEquityCurve(equityCurve);
  const maxDrawdown = computeMaxDrawdown(equityCurve);
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

// ============================================
// Metrics (local — uses √252 for daily)
// ============================================

/**
 * Compute annualized Sharpe from per-bar equity curve.
 *
 * CRITICAL: Uses daily equity curve returns (including flat days),
 * NOT per-trade returns. Annualization factor √252 is correct only
 * for daily-frequency return series.
 */
function computeSharpeFromEquityCurve(equityCurve: number[]): number {
  if (equityCurve.length < 3) return 0;

  // Compute daily returns from equity curve
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

/**
 * Max drawdown from equity curve.
 */
function computeMaxDrawdown(equityCurve: number[]): number {
  let peak = 0;
  let maxDD = 0;

  for (const val of equityCurve) {
    if (val > peak) peak = val;
    if (peak > 0) {
      const dd = (peak - val) / peak;
      if (dd > maxDD) maxDD = dd;
    }
  }

  return maxDD;
}
