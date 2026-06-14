import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '@/lib/data/schema';
import type { BotPosition, BotSymbol } from '@/types/bot';

const HOUR_MS = 3_600_000;
const DAY0 = Date.UTC(2024, 0, 1, 0, 0, 0, 0);
const at = (hour: number, minute = 0): number => DAY0 + hour * HOUR_MS + minute * 60_000;

// ---------------------------------------------------------------------------
// In-memory DB shared with position-tracker (mocked, mirrors funding-decomposition.test.ts)
// ---------------------------------------------------------------------------
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let testDb: TestDb;

vi.mock('@/lib/data/db', () => ({
  get db() {
    return testDb;
  },
  get schema() {
    return schema;
  },
}));

import { PositionTracker } from '@/lib/bot/position-tracker';
import { DataFeed } from '@/lib/bot/data-feed';
import type { FundingSettlementSeries } from '@/lib/cost/funding-ledger';

function freshDb(): TestDb {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  return db;
}

function makePosition(overrides: Partial<BotPosition> = {}): BotPosition {
  return {
    id: 'trade-1',
    symbol: 'BTCUSDT',
    direction: 'long',
    status: 'closed',
    entryPrice: 100,
    rawEntryPrice: 100,
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
    exitPrice: 102,
    exitTimestamp: at(24 + 9, 0), // next-day 09:00 ⇒ crosses 00:00 + 08:00
    exitReason: 'take_profit',
    barsHeld: 10,
    pnlPercent: 0.02,
    pnlUSDT: 20,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake Bybit funding-history client. Returns NEWEST-FIRST rows like the real
// API. We can configure a fixture + force an error to exercise the fail-safe.
// ---------------------------------------------------------------------------
interface FundingRow {
  symbol: string;
  fundingRate: string;
  fundingRateTimestamp: string;
}

class StubFundingFeed extends DataFeed {
  public calls: { startTime?: number; endTime?: number; limit?: number }[] = [];
  private rows: FundingRow[];
  private shouldThrow: boolean;
  private retCode: number;

  constructor(rows: FundingRow[], opts: { throwErr?: boolean; retCode?: number } = {}) {
    super();
    this.rows = rows;
    this.shouldThrow = opts.throwErr ?? false;
    this.retCode = opts.retCode ?? 0;
    // Replace the private RestClientV5 with a stub exposing getFundingRateHistory.
    (this as unknown as { client: unknown }).client = {
      getFundingRateHistory: async (params: {
        startTime?: number;
        endTime?: number;
        limit?: number;
      }) => {
        this.calls.push({
          startTime: params.startTime,
          endTime: params.endTime,
          limit: params.limit,
        });
        if (this.shouldThrow) throw new Error('boom: network down');
        // Filter to the requested endTime window, newest-first (Bybit order).
        const list = this.rows
          .filter((r) => params.endTime === undefined || parseInt(r.fundingRateTimestamp, 10) <= params.endTime)
          .sort((a, b) => parseInt(b.fundingRateTimestamp, 10) - parseInt(a.fundingRateTimestamp, 10))
          .slice(0, params.limit ?? 200);
        return {
          retCode: this.retCode,
          retMsg: this.retCode === 0 ? 'OK' : 'error',
          result: { category: 'linear', list },
        };
      },
    };
  }
}

const SYMBOL: BotSymbol = 'BTCUSDT';

function row(settlementMs: number, rate: number): FundingRow {
  return {
    symbol: SYMBOL,
    fundingRate: String(rate),
    fundingRateTimestamp: String(settlementMs),
  };
}

describe('DataFeed.getFundingHistory — Bybit funding/history parsing', () => {
  it('returns settlements in the window, ascending, with parsed rates', async () => {
    const feed = new StubFundingFeed([
      row(at(24, 0), 0.0001), // 00:00 next day, inside window
      row(at(24 + 8, 0), 0.0002), // 08:00 next day, inside window
      row(at(16, 0), 0.0009), // 16:00 day 0 — BEFORE entry window
      row(at(24 + 16, 0), 0.0005), // 16:00 next day — AFTER exit window
    ]);

    const out = await feed.getFundingHistory(SYMBOL, at(23, 0), at(24 + 9, 0));

    expect(out).toEqual([
      { settlementMs: at(24, 0), fundingRate: 0.0001 },
      { settlementMs: at(24 + 8, 0), fundingRate: 0.0002 },
    ]);
  });

  it('FAIL-SAFE: returns [] on a thrown client error (never crashes a close)', async () => {
    const feed = new StubFundingFeed([row(at(24, 0), 0.0001)], { throwErr: true });
    const out = await feed.getFundingHistory(SYMBOL, at(23, 0), at(24 + 9, 0));
    expect(out).toEqual([]);
  });

  it('FAIL-SAFE: returns [] on a non-zero retCode', async () => {
    const feed = new StubFundingFeed([row(at(24, 0), 0.0001)], { retCode: 10001 });
    const out = await feed.getFundingHistory(SYMBOL, at(23, 0), at(24 + 9, 0));
    expect(out).toEqual([]);
  });

  it('returns [] for an inverted window (endMs < startMs)', async () => {
    const feed = new StubFundingFeed([row(at(24, 0), 0.0001)]);
    const out = await feed.getFundingHistory(SYMBOL, at(24 + 9, 0), at(23, 0));
    expect(out).toEqual([]);
  });

  it('caches within the TTL (no second client call for the same window)', async () => {
    const feed = new StubFundingFeed([row(at(24, 0), 0.0001)]);
    const nowMs = at(48, 0);
    await feed.getFundingHistory(SYMBOL, at(23, 0), at(24 + 9, 0), nowMs);
    const callsAfterFirst = feed.calls.length;
    await feed.getFundingHistory(SYMBOL, at(23, 0), at(24 + 9, 0), nowMs + 1000);
    expect(feed.calls.length).toBe(callsAfterFirst); // served from cache
  });
});

describe('closePosition with a series built from real funding history', () => {
  beforeEach(() => {
    testDb = freshDb();
  });

  it('WITH a fixture series spanning 00:00 + 08:00 ⇒ nonzero, sign-correct funding (long pays)', async () => {
    const feed = new StubFundingFeed([
      row(at(24, 0), 0.0001), // +1bp
      row(at(24 + 8, 0), 0.0003), // +3bp
    ]);
    // Build the rateAt lookup exactly the way run-bot.buildFundingSeries does.
    const settlements = await feed.getFundingHistory(SYMBOL, at(23, 0), at(24 + 9, 0));
    const byInstant = new Map(settlements.map((s) => [s.settlementMs, s.fundingRate]));
    const series: FundingSettlementSeries = {
      rateAt: (ms: number) => byInstant.get(ms) ?? 0,
    };

    const tracker = new PositionTracker(10_000);
    tracker.closePosition(makePosition({ direction: 'long' }), series);

    const r = testDb.select().from(schema.botTrades).get();
    if (!r) throw new Error('no trade row');
    // Long pays positive funding: −(0.0001 + 0.0003) = −0.0004.
    expect(r.fundingReturn).toBeCloseTo(-0.0004, 12);
    expect(r.fundingReturn).toBeLessThan(0);
    expect(r.fundingReturn).not.toBe(0);
    // De-tautologized reconciliation holds: net == pnlPercent + funding.
    expect(r.netReturn).toBeCloseTo(r.pnlPercent + r.fundingReturn, 12);
    expect(r.grossReturn + r.frictionReturn + r.fundingReturn).toBeCloseTo(r.netReturn, 12);
  });

  it('SHORT with positive funding ⇒ positive funding (short receives)', async () => {
    const feed = new StubFundingFeed([row(at(24, 0), 0.0001), row(at(24 + 8, 0), 0.0003)]);
    const settlements = await feed.getFundingHistory(SYMBOL, at(23, 0), at(24 + 9, 0));
    const byInstant = new Map(settlements.map((s) => [s.settlementMs, s.fundingRate]));
    const series: FundingSettlementSeries = { rateAt: (ms: number) => byInstant.get(ms) ?? 0 };

    const tracker = new PositionTracker(10_000);
    tracker.closePosition(makePosition({ direction: 'short', pnlPercent: -0.02, pnlUSDT: -20 }), series);

    const r = testDb.select().from(schema.botTrades).get();
    if (!r) throw new Error('no trade row');
    expect(r.fundingReturn).toBeCloseTo(0.0004, 12);
    expect(r.fundingReturn).toBeGreaterThan(0);
  });

  it('BACK-COMPAT: no series ⇒ fundingReturn 0, net == pnlPercent, never crashes', () => {
    const tracker = new PositionTracker(10_000);
    expect(() => tracker.closePosition(makePosition())).not.toThrow();
    const r = testDb.select().from(schema.botTrades).get();
    if (!r) throw new Error('no trade row');
    expect(r.fundingReturn).toBe(0);
    expect(r.netReturn).toBeCloseTo(r.pnlPercent, 12);
  });

  it('empty funding history (fail-safe []) ⇒ series omitted ⇒ 0 funding booked', async () => {
    const feed = new StubFundingFeed([], { throwErr: true });
    const settlements = await feed.getFundingHistory(SYMBOL, at(23, 0), at(24 + 9, 0));
    expect(settlements).toEqual([]);
    // run-bot.buildFundingSeries returns undefined for an empty history.
    const series = settlements.length === 0 ? undefined : ({} as FundingSettlementSeries);

    const tracker = new PositionTracker(10_000);
    tracker.closePosition(makePosition(), series);

    const r = testDb.select().from(schema.botTrades).get();
    if (!r) throw new Error('no trade row');
    expect(r.fundingReturn).toBe(0);
  });
});
