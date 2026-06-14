/**
 * F2F Gold Paper Sleeve — forward track-record persistence.
 *
 * Task 3b: the gold F2F bot (`scripts/run-gold-bot.ts`) accumulates a forward
 * PAPER track record so the 2026-09-11 charter review can read it. The bot's
 * own state lives in `data/gold-bot-state.json`, which the review (it reads
 * `data/ict-trading.db`) cannot see. This thin seam mirrors each closed paper
 * trade + each equity tick into `bot_trades` / `bot_equity_snapshots` — the
 * SAME tables the crypto forward loop uses — tagged distinctly so Task 4
 * per-symbol/per-strategy review can separate the gold sleeve from crypto.
 *
 * PAPER ONLY. No order routing, no real-money keys. Pure mappers + injectable
 * DB writes so the whole thing is unit-testable against an in-memory SQLite.
 *
 * Independent from ICT: only imports the gold strategy's F2FTrade type and the
 * shared Drizzle schema.
 */

import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/data/schema';
import type { NewBotTradeRow, NewBotEquitySnapshotRow } from '@/lib/data/schema';
import type { F2FTrade } from './types';

/** Drizzle/better-sqlite3 DB handle (matches `db` from `@/lib/data/db`). */
type GoldDb = ReturnType<typeof drizzle<typeof schema>>;

/** Strategy tag for gold F2F rows — keeps the sleeve separable from crypto. */
export const F2F_GOLD_STRATEGY = 'f2f_gold' as const;

/** Symbol traded by the gold sleeve (XAUUSDT delisted → Tether Gold). */
export const F2F_GOLD_SYMBOL = 'XAUTUSDT' as const;

/**
 * Map a closed F2F paper trade into a `bot_trades` row.
 *
 * The F2F trade returns are already net of friction (pnlPercent = weight ×
 * gross − 2·friction·weight), expressed as a fraction. We store them as the
 * net return and decompose gross/friction so the audit invariant
 * gross + friction + funding === net holds (funding is 0 for spot gold).
 *
 * @param trade   Closed F2F trade from `runF2FSimulation` / the bot's tick.
 * @param ctx     equityAfter + drawdownFromPeak captured at close (USDT).
 * @param notional Position notional in USDT used to express USDT-denominated
 *                 fields (default 10_000 = the bot's default capital).
 */
export function goldTradeToBotTradeRow(
  trade: F2FTrade,
  ctx: { equityAfter: number; drawdownFromPeak: number },
  notional = 10_000,
): NewBotTradeRow {
  const grossReturn = trade.direction === 'long'
    ? (trade.exitPrice - trade.entryPrice) / trade.entryPrice
    : (trade.entryPrice - trade.exitPrice) / trade.entryPrice;
  const netReturn = trade.pnlPercent;
  // Everything not explained by gross is friction (no funding on spot gold).
  const frictionReturn = netReturn - trade.weight * grossReturn;

  return {
    id: `f2f-gold-${trade.entryTimestamp}-${trade.exitTimestamp}`,
    symbol: F2F_GOLD_SYMBOL,
    direction: trade.direction,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    entryTimestamp: trade.entryTimestamp,
    exitTimestamp: trade.exitTimestamp,
    stopLoss: trade.hardStop,
    takeProfit: 0, // F2F has no fixed TP — exits are trailing/timeout/derisk.
    positionSizeUSDT: trade.weight * notional,
    riskAmountUSDT: Math.abs(trade.entryPrice - trade.hardStop) / trade.entryPrice * trade.weight * notional,
    strategy: F2F_GOLD_STRATEGY,
    confluenceScore: trade.pBullAtEntry,
    factorBreakdown: JSON.stringify({ pBull: trade.pBullAtEntry, atr: trade.atrAtEntry, weight: trade.weight }),
    regime: 'gold_daily',
    exitReason: trade.exitReason,
    barsHeld: trade.daysHeld,
    pnlPercent: netReturn,
    pnlUSDT: netReturn * notional,
    equityAfter: ctx.equityAfter,
    drawdownFromPeak: ctx.drawdownFromPeak,
    grossReturn: trade.weight * grossReturn,
    frictionReturn,
    fundingReturn: 0,
    netReturn,
    fundingPaidUsdt: 0,
    createdAt: Date.now(),
  };
}

/**
 * Build a `bot_equity_snapshots` row for the gold sleeve.
 * drawdown is derived from peakEquity so callers can't pass an inconsistent value.
 */
export function goldEquitySnapshotRow(args: {
  timestamp: number;
  equity: number;
  peakEquity: number;
  openPositions: number;
  dailyPnl: number;
  cumulativePnl: number;
}): NewBotEquitySnapshotRow {
  const drawdown = args.peakEquity > 0 ? (args.peakEquity - args.equity) / args.peakEquity : 0;
  return {
    timestamp: args.timestamp,
    equity: args.equity,
    peakEquity: args.peakEquity,
    drawdown,
    openPositions: args.openPositions,
    dailyPnl: args.dailyPnl,
    cumulativePnl: args.cumulativePnl,
  };
}

/**
 * Persist a closed gold paper trade to `bot_trades`. Returns the row id.
 * Idempotent on (entryTimestamp, exitTimestamp) via the deterministic id —
 * a re-run that re-closes the same trade overwrites rather than duplicates.
 */
export function persistGoldPaperTrade(
  db: GoldDb,
  trade: F2FTrade,
  state: { equity: number; peakEquity: number },
  notional = 10_000,
): string {
  const equityAfter = state.equity;
  const drawdownFromPeak = state.peakEquity > 0
    ? (state.peakEquity - state.equity) / state.peakEquity
    : 0;
  const row = goldTradeToBotTradeRow(trade, { equityAfter, drawdownFromPeak }, notional);
  db.insert(schema.botTrades).values(row).onConflictDoUpdate({
    target: schema.botTrades.id,
    set: row,
  }).run();
  return row.id;
}

/** Persist a gold-sleeve equity snapshot to `bot_equity_snapshots`. */
export function persistGoldEquitySnapshot(
  db: GoldDb,
  args: {
    timestamp: number;
    equity: number;
    peakEquity: number;
    openPositions: number;
    dailyPnl: number;
    cumulativePnl: number;
  },
): void {
  db.insert(schema.botEquitySnapshots).values(goldEquitySnapshotRow(args)).run();
}
