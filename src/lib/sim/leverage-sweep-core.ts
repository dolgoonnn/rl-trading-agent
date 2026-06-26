/**
 * leverage-sweep-core.ts
 *
 * Pure core for sweeping a set of positions across leverage levels and building
 * the leverage-curve (terminalWealth, liqRate, maxDD, Sharpe) at each level.
 *
 * COMPOSITION: delegates all simulation math to simulatePosition (Task 2) and
 * all equity-curve math to buildLeverageEquityCurve (Task 3). This module adds
 * only the fan-out loop and the per-curve Sharpe computation.
 *
 * NOTE on Sharpe: computed as mean(stepReturns) / std(stepReturns) using
 * population std over the NON-TRIVIAL step returns returned by
 * buildLeverageEquityCurve. This is an INTRA-SAMPLE, per-trade Sharpe for
 * relative comparison across leverage levels only — it is NOT annualized and
 * does NOT substitute for DSR (which is a follow-up task).
 */

import type { Candle } from '@/types/candle';
import type { SimPosition } from './types';
import { simulatePosition } from './simulator';
import { buildLeverageEquityCurve } from './leverage-equity';
import { DefaultFillModel } from './fill-model';
import { FlatFrictionCostModel } from './cost-model';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface SweepRow {
  leverage: number;
  terminalWealth: number;
  liqRate: number;
  maxDD: number;
  sharpe: number;
  blown: boolean;
  trades: number;
}

export interface SweepEntry {
  symbol: string;
  position: SimPosition;
  candles: Candle[];
}

export interface SweepOpts {
  leverages: number[];
  f: number;
  mmr: number;
  liqFeeFrac: number;
  friction: number;
  partialTP: { fraction: number; triggerR: number; beBuffer: number };
  maxBars: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Population standard deviation (not sample). Returns 0 if arr has < 2 elements. */
function popStd(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
  const variance = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

/** Mean of an array. Returns 0 for empty arrays. */
function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

/**
 * Per-trade Sharpe: mean(stepReturns) / std(stepReturns).
 * Returns 0 when std == 0 (all returns identical, including empty).
 * Uses population std for consistency with the brief.
 */
function perTradeSharpe(stepReturns: number[]): number {
  const std = popStd(stepReturns);
  if (std === 0) return 0;
  return mean(stepReturns) / std;
}

// ---------------------------------------------------------------------------
// Core sweep function
// ---------------------------------------------------------------------------

/**
 * Re-simulate the given entries at each leverage level and return one SweepRow
 * per leverage. The order of rows matches the input `opts.leverages` array.
 *
 * For each entry the candle start index is resolved via:
 *   `idx = candles.findIndex(c => c.timestamp >= position.entryTimestamp)`
 * mirroring replayTrade. Entries whose index resolves to -1 are silently
 * skipped (counted but not included in the trades count for that row).
 *
 * The same entry-index resolution is performed once, before the leverage loop,
 * so all leverage levels see the same resolvable/skipped split.
 */
export function sweepLeverage(entries: SweepEntry[], opts: SweepOpts): SweepRow[] {
  // Pre-resolve entry indices — identical for all leverage levels.
  interface Resolved {
    symbol: string;
    position: SimPosition;
    candles: Candle[];
    startIndex: number;
  }

  const resolved: Resolved[] = [];
  for (const entry of entries) {
    const idx = entry.candles.findIndex((c) => c.timestamp >= entry.position.entryTimestamp);
    if (idx === -1) continue; // unresolvable — skip silently
    resolved.push({
      symbol: entry.symbol,
      position: entry.position,
      candles: entry.candles,
      startIndex: idx + 1, // +1 mirrors replayTrade: trade starts on the bar AFTER entry
    });
  }

  const rows: SweepRow[] = [];

  for (const L of opts.leverages) {
    const fillModel = new DefaultFillModel(new FlatFrictionCostModel(opts.friction));

    const trades: { netReturn: number; liquidated: boolean }[] = [];

    for (const { position, candles, startIndex } of resolved) {
      const result = simulatePosition(position, candles, startIndex, {
        fillModel,
        config: {
          entryTiming: 'signal_close',
          maxBars: opts.maxBars,
          barMs: 3_600_000,
          exitMode: 'partial_tp',
          partialTP: opts.partialTP,
          leverage: L,
          mmr: opts.mmr,
        },
      });

      if (result === null) continue; // no candles at startIndex — skip

      trades.push({ netReturn: result.netReturn, liquidated: result.liquidated });
    }

    const curve = buildLeverageEquityCurve(trades, {
      leverage: L,
      f: opts.f,
      mmr: opts.mmr,
      liqFeeFrac: opts.liqFeeFrac,
    });

    rows.push({
      leverage: L,
      terminalWealth: curve.terminalWealth,
      liqRate: curve.liqRate,
      maxDD: curve.maxDD,
      sharpe: perTradeSharpe(curve.stepReturns),
      blown: curve.blown,
      trades: trades.length,
    });
  }

  return rows;
}
