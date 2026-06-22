import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '@/lib/data/schema';
import type { Candle } from '@/types/candle';
import { generateSignals, runF2FSimulation } from '@/lib/gold';
import {
  F2F_GOLD_STRATEGY,
  F2F_GOLD_SYMBOL,
  goldTradeToBotTradeRow,
  goldEquitySnapshotRow,
  persistGoldPaperTrade,
  persistGoldEquitySnapshot,
} from '@/lib/gold/paper-sleeve';

/**
 * Deterministic gold daily-candle fixture.
 *
 * The F2F long entry requires p_bull >= 0.52 AND Δỹ_t > 0 (and not regime
 * suppressed). A long, steady up-trend of daily bars saturates p_trend toward 1
 * and keeps Δỹ_t positive, so it reliably produces at least one long entry.
 */
const DAY_MS = 86_400_000;
const START_MS = 1_577_836_800_000; // 2020-01-01T00:00:00Z

function trendingGold(count: number, startPrice = 1500, step = 5): Candle[] {
  const candles: Candle[] = [];
  let open = startPrice;
  for (let i = 0; i < count; i++) {
    const close = open + step;
    candles.push({
      timestamp: START_MS + i * DAY_MS,
      open,
      high: Math.max(open, close) + 2,
      low: Math.min(open, close) - 2,
      close,
      volume: 1_000,
    });
    open = close;
  }
  return candles;
}

function inMemoryDb() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  return db;
}

describe('gold F2F paper sleeve — forward track record into bot_trades', () => {
  it('a trending fixture produces at least one F2F long entry', () => {
    const candles = trendingGold(300);
    // Train on the whole history, generate signals over the back half.
    const signals = generateSignals(candles, { lambda: 0.95, theta: 0.91 }, 0, candles.length, 60, candles.length, 'none');
    const sim = runF2FSimulation(signals, 0.0005, 'long-only');

    expect(sim.trades.length).toBeGreaterThan(0);
    expect(sim.trades.every((t) => t.direction === 'long')).toBe(true);
  });

  it('maps a closed F2F trade to a bot_trades row tagged f2f_gold / XAUTUSDT', () => {
    const candles = trendingGold(300);
    const signals = generateSignals(candles, { lambda: 0.95, theta: 0.91 }, 0, candles.length, 60, candles.length, 'none');
    const sim = runF2FSimulation(signals, 0.0005, 'long-only');
    const trade = sim.trades[0]!;

    const equityAfter = 10_000 * (1 + trade.pnlPercent);
    const row = goldTradeToBotTradeRow(trade, { equityAfter, drawdownFromPeak: 0 });

    expect(row.strategy).toBe(F2F_GOLD_STRATEGY);
    expect(row.strategy).toBe('f2f_gold');
    expect(row.symbol).toBe(F2F_GOLD_SYMBOL);
    expect(row.symbol).toBe('XAUTUSDT');
    expect(row.direction).toBe('long');
    expect(row.entryPrice).toBe(trade.entryPrice);
    expect(row.exitPrice).toBe(trade.exitPrice);
    expect(row.exitReason).toBe(trade.exitReason);
    expect(row.equityAfter).toBeCloseTo(equityAfter);
  });

  it('persists a PAPER gold trade to bot_trades and reads it back distinctly', () => {
    const db = inMemoryDb();
    const candles = trendingGold(300);
    const signals = generateSignals(candles, { lambda: 0.95, theta: 0.91 }, 0, candles.length, 60, candles.length, 'none');
    const sim = runF2FSimulation(signals, 0.0005, 'long-only');
    const trade = sim.trades[0]!;

    const id = persistGoldPaperTrade(db, trade, { equity: 10_000, peakEquity: 10_000 });

    const row = db.select().from(schema.botTrades).where(eq(schema.botTrades.id, id)).get();
    expect(row).toBeDefined();
    expect(row!.strategy).toBe('f2f_gold');
    expect(row!.symbol).toBe('XAUTUSDT');
    expect(row!.direction).toBe('long');

    // The gold sleeve is separable from the crypto sleeve by strategy+symbol.
    const goldRows = db.select().from(schema.botTrades).where(eq(schema.botTrades.strategy, 'f2f_gold')).all();
    expect(goldRows.length).toBe(1);
    const cryptoRows = db.select().from(schema.botTrades).where(eq(schema.botTrades.strategy, 'order_block')).all();
    expect(cryptoRows.length).toBe(0);
  });

  it('records an equity snapshot for the gold sleeve', () => {
    const db = inMemoryDb();
    const ts = START_MS + 300 * DAY_MS;

    const snap = goldEquitySnapshotRow({ timestamp: ts, equity: 10_250, peakEquity: 10_300, openPositions: 1, dailyPnl: 0.01, cumulativePnl: 0.025 });
    expect(snap.equity).toBe(10_250);
    expect(snap.drawdown).toBeCloseTo((10_300 - 10_250) / 10_300);

    persistGoldEquitySnapshot(db, { timestamp: ts, equity: 10_250, peakEquity: 10_300, openPositions: 1, dailyPnl: 0.01, cumulativePnl: 0.025 });

    const row = db.select().from(schema.botEquitySnapshots).get();
    expect(row).toBeDefined();
    expect(row!.equity).toBe(10_250);
    expect(row!.openPositions).toBe(1);
  });
});
