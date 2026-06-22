import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '@/lib/data/schema';

/**
 * Migration 0004 — additive schema keystone.
 *
 * Verifies that running ALL migrations (0000..0004) against a fresh :memory:
 * DB produces the new persistence surface for bot survival hardening:
 *   - bot_kill_switch (singleton)
 *   - decision_log (append-only)
 *   - skipped_signals
 *   - pnl_cells
 *   - bot_trades cost columns (gross/friction/funding/net returns + fundingPaidUsdt)
 *
 * Each new table gets an insert+select round-trip via the Drizzle schema, and
 * a bot_trades insert confirms the new cost columns default to 0.
 */
function migratedDb() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  return { db, sqlite };
}

describe('migration 0004 — additive persistence', () => {
  it('runs all migrations cleanly against a fresh in-memory DB', () => {
    expect(() => migratedDb()).not.toThrow();
  });

  it('bot_kill_switch round-trips (singleton)', () => {
    const { db } = migratedDb();
    db.insert(schema.botKillSwitch)
      .values({
        id: 1,
        halted: true,
        reason: 'hardKillDD breached',
        source: 'risk-engine',
        haltedAt: 1_700_000_000_000,
        manualReview: true,
      })
      .run();

    const rows = db.select().from(schema.botKillSwitch).all();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(1);
    expect(row.halted).toBe(true);
    expect(row.reason).toBe('hardKillDD breached');
    expect(row.source).toBe('risk-engine');
    expect(row.haltedAt).toBe(1_700_000_000_000);
    expect(row.manualReview).toBe(true);
  });

  it('bot_kill_switch defaults: not halted, manualReview on', () => {
    const { db } = migratedDb();
    db.insert(schema.botKillSwitch).values({ id: 1 }).run();
    const row = db.select().from(schema.botKillSwitch).get();
    expect(row?.halted).toBe(false);
    expect(row?.manualReview).toBe(true);
    expect(row?.reason).toBeNull();
    expect(row?.source).toBeNull();
    expect(row?.haltedAt).toBeNull();
  });

  it('decision_log round-trips (append-only)', () => {
    const { db } = migratedDb();
    db.insert(schema.decisionLog)
      .values({
        createdAt: 1_700_000_000_000,
        type: 'halt',
        symbol: 'BTCUSDT',
        detail: JSON.stringify({ reason: 'dd' }),
      })
      .run();

    const row = db.select().from(schema.decisionLog).get();
    expect(row?.id).toBeGreaterThan(0);
    expect(row?.createdAt).toBe(1_700_000_000_000);
    expect(row?.type).toBe('halt');
    expect(row?.symbol).toBe('BTCUSDT');
    expect(JSON.parse(row!.detail!)).toEqual({ reason: 'dd' });
  });

  it('decision_log allows null symbol/detail', () => {
    const { db } = migratedDb();
    db.insert(schema.decisionLog)
      .values({ createdAt: 1, type: 'startup' })
      .run();
    const row = db.select().from(schema.decisionLog).get();
    expect(row?.symbol).toBeNull();
    expect(row?.detail).toBeNull();
  });

  it('skipped_signals round-trips', () => {
    const { db } = migratedDb();
    db.insert(schema.skippedSignals)
      .values({
        ts: 1_700_000_000_000,
        symbol: 'ETHUSDT',
        reason: 'mark_deviation',
        signalEntry: 3000.5,
        score: 6.2,
        regime: 'uptrend+normal',
        detail: JSON.stringify({ bps: 73 }),
      })
      .run();

    const row = db.select().from(schema.skippedSignals).get();
    expect(row?.id).toBeGreaterThan(0);
    expect(row?.ts).toBe(1_700_000_000_000);
    expect(row?.symbol).toBe('ETHUSDT');
    expect(row?.reason).toBe('mark_deviation');
    expect(row?.signalEntry).toBeCloseTo(3000.5);
    expect(row?.score).toBeCloseTo(6.2);
    expect(row?.regime).toBe('uptrend+normal');
    expect(JSON.parse(row!.detail!)).toEqual({ bps: 73 });
  });

  it('skipped_signals allows null optionals (only ts/symbol/reason required)', () => {
    const { db } = migratedDb();
    db.insert(schema.skippedSignals)
      .values({ ts: 1, symbol: 'SOLUSDT', reason: 'stale_candle' })
      .run();
    const row = db.select().from(schema.skippedSignals).get();
    expect(row?.signalEntry).toBeNull();
    expect(row?.score).toBeNull();
    expect(row?.regime).toBeNull();
    expect(row?.detail).toBeNull();
  });

  it('pnl_cells round-trips', () => {
    const { db } = migratedDb();
    db.insert(schema.pnlCells)
      .values({
        weekOf: 1_700_000_000_000,
        regime: 'uptrend+normal',
        symbol: 'BTCUSDT',
        confluenceBucket: '6-7',
        exitReason: 'take_profit',
        n: 42,
        meanNet: 0.012,
        sumNet: 0.504,
        winRate: 0.55,
        sumGross: 0.6,
        sumFunding: -0.05,
        sumFriction: -0.045,
        fundingPctOfGross: 0.083,
      })
      .run();

    const row = db.select().from(schema.pnlCells).get();
    expect(row?.id).toBeGreaterThan(0);
    expect(row?.weekOf).toBe(1_700_000_000_000);
    expect(row?.regime).toBe('uptrend+normal');
    expect(row?.symbol).toBe('BTCUSDT');
    expect(row?.confluenceBucket).toBe('6-7');
    expect(row?.exitReason).toBe('take_profit');
    expect(row?.n).toBe(42);
    expect(row?.meanNet).toBeCloseTo(0.012);
    expect(row?.sumNet).toBeCloseTo(0.504);
    expect(row?.winRate).toBeCloseTo(0.55);
    expect(row?.sumGross).toBeCloseTo(0.6);
    expect(row?.sumFunding).toBeCloseTo(-0.05);
    expect(row?.sumFriction).toBeCloseTo(-0.045);
    expect(row?.fundingPctOfGross).toBeCloseTo(0.083);
  });

  it('bot_trades insert reads back new cost columns defaulting to 0', () => {
    const { db } = migratedDb();
    // Insert WITHOUT specifying the new cost columns — they must default to 0.
    db.insert(schema.botTrades)
      .values({
        id: 'trade-1',
        symbol: 'BTCUSDT',
        direction: 'long',
        entryPrice: 50_000,
        exitPrice: 51_000,
        entryTimestamp: 1_700_000_000_000,
        exitTimestamp: 1_700_003_600_000,
        stopLoss: 49_000,
        takeProfit: 52_000,
        positionSizeUSDT: 1_000,
        riskAmountUSDT: 20,
        strategy: 'order_block',
        confluenceScore: 6.5,
        factorBreakdown: '{}',
        regime: 'uptrend+normal',
        exitReason: 'take_profit',
        barsHeld: 4,
        pnlPercent: 0.02,
        pnlUSDT: 20,
        equityAfter: 10_020,
        drawdownFromPeak: 0,
        createdAt: 1_700_003_600_000,
      })
      .run();

    const row = db
      .select()
      .from(schema.botTrades)
      .where(eq(schema.botTrades.id, 'trade-1'))
      .get();

    expect(row).toBeDefined();
    expect(row?.grossReturn).toBe(0);
    expect(row?.frictionReturn).toBe(0);
    expect(row?.fundingReturn).toBe(0);
    expect(row?.netReturn).toBe(0);
    expect(row?.fundingPaidUsdt).toBe(0);
  });

  it('bot_trades accepts explicit cost-column values', () => {
    const { db } = migratedDb();
    db.insert(schema.botTrades)
      .values({
        id: 'trade-2',
        symbol: 'ETHUSDT',
        direction: 'short',
        entryPrice: 3_000,
        exitPrice: 2_950,
        entryTimestamp: 1,
        exitTimestamp: 2,
        stopLoss: 3_050,
        takeProfit: 2_900,
        positionSizeUSDT: 500,
        riskAmountUSDT: 10,
        strategy: 'order_block',
        confluenceScore: 7.1,
        factorBreakdown: '{}',
        regime: 'downtrend+normal',
        exitReason: 'stop_loss',
        barsHeld: 1,
        pnlPercent: 0.0166,
        pnlUSDT: 8.3,
        equityAfter: 10_008,
        drawdownFromPeak: 0,
        createdAt: 3,
        grossReturn: 0.02,
        frictionReturn: -0.0007,
        fundingReturn: 0.0011,
        netReturn: 0.0204,
        fundingPaidUsdt: 0.55,
      })
      .run();

    const row = db
      .select()
      .from(schema.botTrades)
      .where(eq(schema.botTrades.id, 'trade-2'))
      .get();

    expect(row?.grossReturn).toBeCloseTo(0.02);
    expect(row?.frictionReturn).toBeCloseTo(-0.0007);
    expect(row?.fundingReturn).toBeCloseTo(0.0011);
    expect(row?.netReturn).toBeCloseTo(0.0204);
    expect(row?.fundingPaidUsdt).toBeCloseTo(0.55);
  });
});
