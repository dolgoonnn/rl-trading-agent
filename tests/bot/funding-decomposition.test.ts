import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '@/lib/data/schema';
import type { BotPosition } from '@/types/bot';

const HOUR_MS = 3_600_000;
const DAY0 = Date.UTC(2024, 0, 1, 0, 0, 0, 0);
const at = (hour: number, minute = 0): number => DAY0 + hour * HOUR_MS + minute * 60_000;

// In-memory DB shared with the position-tracker module under test (mocked below).
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let testDb: TestDb;

// position-tracker imports the `db` singleton from '@/lib/data/db'. Redirect it
// to a fresh in-memory database per test so closePosition writes are inspectable
// and never touch the real on-disk file.
vi.mock('@/lib/data/db', () => ({
  get db() {
    return testDb;
  },
  get schema() {
    return schema;
  },
}));

// Imported AFTER the mock is registered.
import { PositionTracker } from '@/lib/bot/position-tracker';
import { RUN20_STRATEGY_CONFIG } from '@/lib/bot/config';
import type { FundingSettlementSeries } from '@/lib/cost/funding-ledger';

// Friction is attributed from the SAME production config the close path reads,
// so these constants track config drift instead of hard-coding magic numbers.
const FRICTION_PER_SIDE = RUN20_STRATEGY_CONFIG.frictionPerSide;
const PARTIAL_TP_FRACTION = RUN20_STRATEGY_CONFIG.partialTP.fraction;

function freshDb(): TestDb {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  return db;
}

function makePosition(overrides: Partial<BotPosition> = {}): BotPosition {
  const entryPrice = 100;
  const exitPrice = 102; // +2% gross-of-funding (friction already in these prices)
  return {
    id: 'trade-1',
    symbol: 'BTCUSDT',
    direction: 'long',
    status: 'closed',
    entryPrice,
    rawEntryPrice: entryPrice,
    entryTimestamp: at(23, 0), // 23:00
    entryBarIndex: 0,
    stopLoss: 98,
    takeProfit: 104,
    currentSL: 98,
    positionSizeUSDT: 1000,
    riskAmountUSDT: 20,
    strategy: 'order_block',
    confluenceScore: 6.2,
    factorBreakdown: { obProximity: 2.7 },
    regime: 'uptrend+normal',
    partialTaken: false,
    partialPnlPercent: 0,
    exitPrice,
    exitTimestamp: at(24 + 9, 0), // next-day 09:00 ⇒ crosses 00:00 + 08:00
    exitReason: 'take_profit',
    barsHeld: 10,
    pnlPercent: 0.02,
    pnlUSDT: 20,
    ...overrides,
  };
}

describe('PositionTracker.closePosition — funding decomposition persisted', () => {
  beforeEach(() => {
    testDb = freshDb();
  });

  it('stores 4 components satisfying gross + friction + funding === net (epsilon)', () => {
    const tracker = new PositionTracker(10_000);
    const pos = makePosition();
    // 23:00 → 09:00 crosses 00:00 + 08:00. Constant +1bp funding ⇒ long PAYS.
    const fundingSeries: FundingSettlementSeries = {
      rateAt: () => 0.0001,
    };

    tracker.closePosition(pos, fundingSeries);

    const row = testDb.select().from(schema.botTrades).get();
    expect(row).toBeDefined();
    if (!row) throw new Error('no trade row');

    const sum = row.grossReturn + row.frictionReturn + row.fundingReturn;
    expect(sum).toBeCloseTo(row.netReturn, 12);

    // Non-partial trade ⇒ 2 friction sides (entry + final exit).
    expect(row.frictionReturn).toBeCloseTo(-(2 * FRICTION_PER_SIDE), 12);
    // gross is the friction-free, first-order estimate: pnlPercent − frictionReturn.
    expect(row.grossReturn).toBeCloseTo(0.02 - row.frictionReturn, 12);
    // funding is negative for a long paying.
    expect(row.fundingReturn).toBeLessThan(0);
    expect(row.fundingReturn).toBeCloseTo(-0.0001 * 2, 12);
    expect(row.netReturn).toBeLessThan(row.grossReturn);
  });

  it('NON-partial trade: friction = 2 sides, gross = pnlPercent − friction, net derived two ways agree', () => {
    const tracker = new PositionTracker(10_000);
    const pos = makePosition({ partialTaken: false });
    const fundingSeries: FundingSettlementSeries = { rateAt: () => 0.0001 };

    tracker.closePosition(pos, fundingSeries);

    const row = testDb.select().from(schema.botTrades).get();
    if (!row) throw new Error('no trade row');

    // Friction: exactly 2 sides at the configured per-side rate.
    expect(row.frictionReturn).toBe(-(2 * FRICTION_PER_SIDE));
    // Gross is the friction-free estimate.
    expect(row.grossReturn).toBeCloseTo(row.pnlPercent - row.frictionReturn, 12);
    // Additive invariant.
    expect(
      Math.abs((row.grossReturn + row.frictionReturn + row.fundingReturn) - row.netReturn),
    ).toBeLessThan(1e-9);
    // Independent audit: net derived from (pnlPercent + funding) must agree — the
    // friction leg cancels because gross was defined as pnlPercent − friction.
    expect(Math.abs(row.netReturn - (row.pnlPercent + row.fundingReturn))).toBeLessThan(1e-9);
  });

  it('PARTIAL-TP trade: nSides includes the fraction (2 + fraction)', () => {
    const tracker = new PositionTracker(10_000);
    const pos = makePosition({ partialTaken: true, partialPnlPercent: 0.012 });
    const fundingSeries: FundingSettlementSeries = { rateAt: () => 0.0001 };

    tracker.closePosition(pos, fundingSeries);

    const row = testDb.select().from(schema.botTrades).get();
    if (!row) throw new Error('no trade row');

    // 3 fills when partial taken (entry, partial exit, final exit) ⇒ the partial
    // exit side is fraction-weighted: nSides = 2 + fraction.
    expect(row.frictionReturn).toBeCloseTo(-((2 + PARTIAL_TP_FRACTION) * FRICTION_PER_SIDE), 12);
    expect(row.grossReturn).toBeCloseTo(row.pnlPercent - row.frictionReturn, 12);
    // Both invariants still hold.
    expect(
      Math.abs((row.grossReturn + row.frictionReturn + row.fundingReturn) - row.netReturn),
    ).toBeLessThan(1e-9);
    expect(Math.abs(row.netReturn - (row.pnlPercent + row.fundingReturn))).toBeLessThan(1e-9);
  });

  it('fundingPaidUsdt sign matches direction (long pays ⇒ negative)', () => {
    const tracker = new PositionTracker(10_000);
    const pos = makePosition({ direction: 'long' });
    const fundingSeries: FundingSettlementSeries = { rateAt: () => 0.0001 };

    tracker.closePosition(pos, fundingSeries);

    const row = testDb.select().from(schema.botTrades).get();
    if (!row) throw new Error('no trade row');
    expect(row.fundingPaidUsdt).toBeLessThan(0);
    // fundingPaidUsdt = fundingReturn * positionSizeUSDT
    expect(row.fundingPaidUsdt).toBeCloseTo(row.fundingReturn * pos.positionSizeUSDT, 9);
  });

  it('SHORT receives positive funding ⇒ fundingPaidUsdt > 0', () => {
    const tracker = new PositionTracker(10_000);
    // For a short, gross pnl from 100→102 would be negative, but the
    // decomposition only cares about sign of the funding leg here.
    const pos = makePosition({ direction: 'short', pnlPercent: -0.02, pnlUSDT: -20 });
    const fundingSeries: FundingSettlementSeries = { rateAt: () => 0.0001 };

    tracker.closePosition(pos, fundingSeries);

    const row = testDb.select().from(schema.botTrades).get();
    if (!row) throw new Error('no trade row');
    expect(row.fundingReturn).toBeGreaterThan(0);
    expect(row.fundingPaidUsdt).toBeGreaterThan(0);
  });

  it('no funding series ⇒ fundingReturn=0, net=pnlPercent, never crashes', () => {
    const tracker = new PositionTracker(10_000);
    const pos = makePosition();

    expect(() => tracker.closePosition(pos)).not.toThrow();

    const row = testDb.select().from(schema.botTrades).get();
    if (!row) throw new Error('no trade row');
    expect(row.fundingReturn).toBe(0);
    expect(row.fundingPaidUsdt).toBe(0);
    // With funding=0, net === pnlPercent (friction is embedded in gross, not net).
    expect(row.netReturn).toBeCloseTo(row.pnlPercent, 12);
    expect(row.grossReturn + row.frictionReturn + row.fundingReturn).toBeCloseTo(
      row.netReturn,
      12,
    );
  });

  it('preserves existing pnlPercent / pnlUSDT semantics (unchanged)', () => {
    const tracker = new PositionTracker(10_000);
    const pos = makePosition();
    const fundingSeries: FundingSettlementSeries = { rateAt: () => 0.0001 };

    tracker.closePosition(pos, fundingSeries);

    const row = testDb.select().from(schema.botTrades).get();
    if (!row) throw new Error('no trade row');
    expect(row.pnlPercent).toBe(0.02);
    expect(row.pnlUSDT).toBe(20);
  });
});
