/**
 * Reconciliation harness — diffs simulated fills against live bot_trades.
 *
 * This file is split into two clear sections:
 *   1. PURE CORE (diffTrades, reconcileReport) — no DB imports, fully unit-testable.
 *   2. IMPURE LOADERS (loadLiveTrades, replayTrade) — DB/filesystem edge; the ONE
 *      allowed impure surface of the sim package.
 */

// ─── 1. PURE CORE ──────────────────────────────────────────────────────────

import type { SimTradeResult } from './types';

export interface TradeDiff {
  id: string;
  symbol: string;
  simNet: number;
  liveNet: number;
  netDelta: number;
  reasonMatch: boolean;
  barsHeldMatch: boolean;
}

export interface ReconcileReport {
  count: number;
  meanAbsNetDelta: number;
  reasonMatchRate: number;
  barsHeldMatchRate: number;
  pass: boolean;
  diffs: TradeDiff[];
}

export function diffTrades(
  sim: SimTradeResult,
  live: { netReturn: number; exitReason: string; barsHeld: number },
  id: string,
  symbol: string,
  simBarsHeld?: number,
): TradeDiff {
  return {
    id,
    symbol,
    simNet: sim.netReturn,
    liveNet: live.netReturn,
    netDelta: sim.netReturn - live.netReturn,
    reasonMatch: sim.exitReason === live.exitReason,
    barsHeldMatch: simBarsHeld === undefined ? true : simBarsHeld === live.barsHeld,
  };
}

export function reconcileReport(
  diffs: TradeDiff[],
  tol: { netBps: number; reasonRate: number; barsRate: number },
): ReconcileReport {
  const count = diffs.length;
  const meanAbsNetDelta = count
    ? diffs.reduce((s, d) => s + Math.abs(d.netDelta), 0) / count
    : 0;
  const reasonMatchRate = count
    ? diffs.filter((d) => d.reasonMatch).length / count
    : 1;
  const barsHeldMatchRate = count
    ? diffs.filter((d) => d.barsHeldMatch).length / count
    : 1;
  const pass =
    meanAbsNetDelta <= tol.netBps / 1e4 &&
    reasonMatchRate >= tol.reasonRate &&
    barsHeldMatchRate >= tol.barsRate;
  return { count, meanAbsNetDelta, reasonMatchRate, barsHeldMatchRate, pass, diffs };
}

// ─── 2. IMPURE LOADERS ─────────────────────────────────────────────────────
// These imports are isolated here so the pure core above remains DB-free.

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { BotTradeRow } from '@/lib/data/schema';
import { botTrades } from '@/lib/data/schema';
import * as schema from '@/lib/data/schema';
import { eq } from 'drizzle-orm';
import type { SimPosition, SimConfig } from './types';
import type { FillModel } from './fill-model';
import { simulatePosition } from './simulator';
import type { Candle } from '@/types/candle';
import { resolveSimConfig } from './resolve-config';

// Drizzle DB type scoped to the project schema
type DrizzleDB = BetterSQLite3Database<typeof schema>;

/**
 * Load completed bot trades from the database.
 * Optionally filter to a specific symbol.
 */
export async function loadLiveTrades(db: DrizzleDB, symbol?: string): Promise<BotTradeRow[]> {
  if (symbol) {
    return db.select().from(botTrades).where(eq(botTrades.symbol, symbol));
  }
  return db.select().from(botTrades);
}

/**
 * Reconstruct a SimPosition from a BotTradeRow and run simulatePosition.
 * Returns null if the candle slice starting at entryTimestamp cannot be found.
 */
export function replayTrade(
  row: BotTradeRow,
  candles: Candle[],
  fillModel: FillModel,
  config: SimConfig,
): SimTradeResult | null {
  // Find the candle index at or just after entryTimestamp
  const startIndex = candles.findIndex((c) => c.timestamp >= row.entryTimestamp);
  if (startIndex === -1) return null;

  const position: SimPosition = {
    direction: row.direction as 'long' | 'short',
    entryPrice: row.entryPrice,
    entryTimestamp: row.entryTimestamp,
    entryIndex: startIndex,
    stopLoss: row.stopLoss,
    takeProfit: row.takeProfit,
    strategy: row.strategy,
  };

  // Start SL/TP checking at the bar AFTER entry (startIndex + 1), mirroring the
  // production convention (backtest-confluence calls simulatePosition with i + 1,
  // entryIndex = i). Entering at a bar's close means that already-closed bar
  // cannot fill the position — checking it would manufacture false sim/live drift.
  return simulatePosition(position, candles, startIndex + 1, { fillModel, config });
}

/**
 * Replay a live bot trade using the exact SimConfig the strategy ran with.
 *
 * This is the seam that fixes the pre-fix bug where every row was replayed
 * through a hardcoded `simple` config regardless of strategy. Now each row's
 * strategy is resolved to its deployed config (e.g. order_block → partial_tp),
 * so the blend math in simulatePosition matches what the live bot did.
 *
 * Pure (no DB, no Date.now, no fetch) — delegates to replayTrade.
 */
export function replayLiveRow(
  row: BotTradeRow,
  candles: Candle[],
  fillModel: FillModel,
): SimTradeResult | null {
  return replayTrade(row, candles, fillModel, resolveSimConfig(row.strategy));
}
