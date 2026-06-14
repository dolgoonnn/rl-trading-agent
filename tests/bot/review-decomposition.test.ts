import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '@/lib/data/schema';
import { botTrades, pnlCells } from '@/lib/data/schema';
import {
  bucketConfluence,
  decomposePnlCells,
  coldCohortScan,
  materializePnlCells,
  type ReviewTradeRow,
} from '@/lib/bot/review';

/**
 * Review per-cell decomposition — PURE function over trade rows (DI'd, no DB).
 *
 * Fixture: trades across 2 regimes × 2 symbols with KNOWN gross/friction/funding/net.
 * Each row's net is constructed so the additive invariant
 *   gross + friction + funding === net
 * holds exactly, letting us assert per-cell aggregates and the invariant.
 */

const HOUR_MS = 3_600_000;
const DAY0 = Date.UTC(2024, 0, 1, 0, 0, 0, 0);

/** Build a row where net is derived so the additive invariant holds exactly. */
function row(
  over: Partial<ReviewTradeRow> & {
    grossReturn: number;
    frictionReturn: number;
    fundingReturn: number;
  },
): ReviewTradeRow {
  const net = over.grossReturn + over.frictionReturn + over.fundingReturn;
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    symbol: over.symbol ?? 'BTCUSDT',
    regime: over.regime ?? 'uptrend+normal',
    exitReason: over.exitReason ?? 'take_profit',
    confluenceScore: over.confluenceScore ?? 6.5,
    entryTimestamp: over.entryTimestamp ?? DAY0,
    grossReturn: over.grossReturn,
    frictionReturn: over.frictionReturn,
    fundingReturn: over.fundingReturn,
    netReturn: over.netReturn ?? net,
  };
}

describe('bucketConfluence', () => {
  it('buckets below 5 as "<5"', () => {
    expect(bucketConfluence(0)).toBe('<5');
    expect(bucketConfluence(4.99)).toBe('<5');
  });

  it('boundary 5 → "5-6" (left-inclusive)', () => {
    expect(bucketConfluence(5)).toBe('5-6');
    expect(bucketConfluence(5.99)).toBe('5-6');
  });

  it('boundary 6 → "6-7" (left-inclusive)', () => {
    expect(bucketConfluence(6)).toBe('6-7');
    expect(bucketConfluence(6.99)).toBe('6-7');
  });

  it('boundary 7 → "7+" (left-inclusive, open above)', () => {
    expect(bucketConfluence(7)).toBe('7+');
    expect(bucketConfluence(12.3)).toBe('7+');
  });
});

describe('decomposePnlCells — pure aggregation', () => {
  it('groups by (regime × symbol × confluenceBucket × exitReason)', () => {
    const trades: ReviewTradeRow[] = [
      // Cell A: BTC, uptrend+normal, bucket 6-7, take_profit — 2 winners
      row({ symbol: 'BTCUSDT', regime: 'uptrend+normal', confluenceScore: 6.5, exitReason: 'take_profit', grossReturn: 0.03, frictionReturn: -0.001, fundingReturn: -0.0005 }),
      row({ symbol: 'BTCUSDT', regime: 'uptrend+normal', confluenceScore: 6.2, exitReason: 'take_profit', grossReturn: 0.02, frictionReturn: -0.001, fundingReturn: -0.0005 }),
      // Cell B: ETH, downtrend+normal, bucket 5-6, stop_loss — 1 loser
      row({ symbol: 'ETHUSDT', regime: 'downtrend+normal', confluenceScore: 5.4, exitReason: 'stop_loss', grossReturn: -0.01, frictionReturn: -0.001, fundingReturn: 0.0002 }),
    ];

    const cells = decomposePnlCells(trades);

    // 2 distinct cells (the 2 BTC trades collapse into one).
    expect(cells).toHaveLength(2);

    const cellA = cells.find(
      (c) => c.symbol === 'BTCUSDT' && c.exitReason === 'take_profit',
    );
    const cellB = cells.find(
      (c) => c.symbol === 'ETHUSDT' && c.exitReason === 'stop_loss',
    );
    expect(cellA).toBeDefined();
    expect(cellB).toBeDefined();
    if (!cellA || !cellB) throw new Error('missing cell');

    // Cell A aggregates.
    expect(cellA.regime).toBe('uptrend+normal');
    expect(cellA.confluenceBucket).toBe('6-7');
    expect(cellA.n).toBe(2);
    expect(cellA.sumGross).toBeCloseTo(0.05, 12);
    expect(cellA.sumFriction).toBeCloseTo(-0.002, 12);
    expect(cellA.sumFunding).toBeCloseTo(-0.001, 12);
    expect(cellA.sumNet).toBeCloseTo(0.05 - 0.002 - 0.001, 12);
    expect(cellA.meanNet).toBeCloseTo(cellA.sumNet / 2, 12);
    expect(cellA.winRate).toBe(1); // both net-positive

    // Cell B aggregates.
    expect(cellB.confluenceBucket).toBe('5-6');
    expect(cellB.n).toBe(1);
    expect(cellB.winRate).toBe(0); // net-negative
  });

  it('additive invariant holds per cell (sumGross + sumFriction + sumFunding === sumNet)', () => {
    const trades: ReviewTradeRow[] = [
      row({ grossReturn: 0.03, frictionReturn: -0.0012, fundingReturn: -0.0007 }),
      row({ grossReturn: 0.011, frictionReturn: -0.0009, fundingReturn: 0.0003 }),
      row({ grossReturn: -0.02, frictionReturn: -0.0011, fundingReturn: -0.0001 }),
    ];

    const cells = decomposePnlCells(trades);
    expect(cells).toHaveLength(1); // all share the default cell key

    const cell = cells[0]!;
    const recomputed = cell.sumGross + cell.sumFriction + cell.sumFunding;
    expect(Math.abs(recomputed - cell.sumNet)).toBeLessThan(1e-9);
  });

  it('flags low-confidence cells where n < 20', () => {
    // 19 trades → low confidence.
    const small = Array.from({ length: 19 }, () =>
      row({ grossReturn: 0.01, frictionReturn: -0.001, fundingReturn: -0.0001 }),
    );
    const [cellSmall] = decomposePnlCells(small);
    expect(cellSmall!.n).toBe(19);
    expect(cellSmall!.lowConfidence).toBe(true);

    // 20 trades → not low confidence (boundary).
    const exactly20 = Array.from({ length: 20 }, () =>
      row({ grossReturn: 0.01, frictionReturn: -0.001, fundingReturn: -0.0001 }),
    );
    const [cell20] = decomposePnlCells(exactly20);
    expect(cell20!.n).toBe(20);
    expect(cell20!.lowConfidence).toBe(false);
  });

  it('flags cost-trap cells where sumGross > 0 but sumNet < 0 (funding/friction eats the edge)', () => {
    // Positive gross, but funding + friction flip the cell net-negative.
    const trades: ReviewTradeRow[] = [
      row({ grossReturn: 0.004, frictionReturn: -0.003, fundingReturn: -0.0025 }),
      row({ grossReturn: 0.003, frictionReturn: -0.003, fundingReturn: -0.0025 }),
    ];
    const [cell] = decomposePnlCells(trades);
    expect(cell!.sumGross).toBeGreaterThan(0);
    expect(cell!.sumNet).toBeLessThan(0);
    expect(cell!.costTrap).toBe(true);
  });

  it('flags cost-trap cells where fundingPctOfGross > 0.35', () => {
    // |sumFunding| / |sumGross| = 0.04 / 0.10 = 0.40 > 0.35.
    const trades: ReviewTradeRow[] = [
      row({ grossReturn: 0.10, frictionReturn: -0.001, fundingReturn: -0.04 }),
    ];
    const [cell] = decomposePnlCells(trades);
    expect(cell!.fundingPctOfGross).toBeCloseTo(0.4, 12);
    expect(cell!.costTrap).toBe(true);
  });

  it('computes fundingPctOfGross = |sumFunding| / |sumGross|, guarding div-by-zero', () => {
    const trades: ReviewTradeRow[] = [
      row({ grossReturn: 0.2, frictionReturn: -0.001, fundingReturn: -0.02 }),
    ];
    const [cell] = decomposePnlCells(trades);
    expect(cell!.fundingPctOfGross).toBeCloseTo(0.02 / 0.2, 12);

    // sumGross === 0 ⇒ guarded to 0 (no NaN/Infinity).
    const zeroGross: ReviewTradeRow[] = [
      row({ grossReturn: 0.05, frictionReturn: 0, fundingReturn: -0.01 }),
      row({ grossReturn: -0.05, frictionReturn: 0, fundingReturn: -0.01 }),
    ];
    const [cellZero] = decomposePnlCells(zeroGross);
    expect(cellZero!.sumGross).toBeCloseTo(0, 12);
    expect(cellZero!.fundingPctOfGross).toBe(0);
    expect(Number.isFinite(cellZero!.fundingPctOfGross)).toBe(true);
  });

  it('winRate counts net-positive trades / n', () => {
    const trades: ReviewTradeRow[] = [
      row({ grossReturn: 0.03, frictionReturn: -0.001, fundingReturn: 0 }), // net +
      row({ grossReturn: 0.02, frictionReturn: -0.001, fundingReturn: 0 }), // net +
      row({ grossReturn: -0.04, frictionReturn: -0.001, fundingReturn: 0 }), // net -
      row({ grossReturn: -0.05, frictionReturn: -0.001, fundingReturn: 0 }), // net -
    ];
    const [cell] = decomposePnlCells(trades);
    expect(cell!.n).toBe(4);
    expect(cell!.winRate).toBe(0.5);
  });
});

// ============================================================================
// FIX 2 — legacy P&L fallback: read pnl_percent when cost cols are 0/absent
// ============================================================================

describe('decomposePnlCells — legacy pnl_percent fallback', () => {
  it('uses pnl_percent as realized net on legacy rows (cost cols 0), not 0', () => {
    // Legacy rows: cost cols all 0, but pnl_percent IS populated. These predate
    // the cost-column writer; reading netReturn directly would report 0.0.
    const legacy: ReviewTradeRow[] = [
      {
        id: 'L1',
        symbol: 'BTCUSDT',
        regime: 'uptrend+normal',
        exitReason: 'take_profit',
        confluenceScore: 6.5,
        entryTimestamp: DAY0,
        grossReturn: 0,
        frictionReturn: 0,
        fundingReturn: 0,
        netReturn: 0,
        pnlPercent: 0.02, // real realized net
      },
      {
        id: 'L2',
        symbol: 'BTCUSDT',
        regime: 'uptrend+normal',
        exitReason: 'take_profit',
        confluenceScore: 6.4,
        entryTimestamp: DAY0,
        grossReturn: 0,
        frictionReturn: 0,
        fundingReturn: 0,
        netReturn: 0,
        pnlPercent: -0.01, // real realized loss
      },
    ];

    const [cell] = decomposePnlCells(legacy);
    expect(cell!.n).toBe(2);
    // sumNet/meanNet reflect REAL pnl_percent, NOT 0.
    expect(cell!.sumNet).toBeCloseTo(0.01, 12);
    expect(cell!.meanNet).toBeCloseTo(0.005, 12);
    // winRate from realized P&L: 1 of 2 net-positive.
    expect(cell!.winRate).toBe(0.5);
  });

  it('prefers netReturn on new rows and falls back to pnl_percent only on legacy rows', () => {
    // Mixed: 1 new row (cost cols set, pnl_percent stale/absent) + 1 legacy row.
    const mixed: ReviewTradeRow[] = [
      // NEW row: cost cols populated → netReturn wins, pnl_percent ignored.
      {
        id: 'N1',
        symbol: 'ETHUSDT',
        regime: 'uptrend+normal',
        exitReason: 'take_profit',
        confluenceScore: 6.5,
        entryTimestamp: DAY0,
        grossReturn: 0.031,
        frictionReturn: -0.001,
        fundingReturn: 0,
        netReturn: 0.03,
        pnlPercent: 999, // garbage — must NOT be used because netReturn is set
      },
      // LEGACY row: cost cols 0 → fall back to pnl_percent.
      {
        id: 'L1',
        symbol: 'ETHUSDT',
        regime: 'uptrend+normal',
        exitReason: 'take_profit',
        confluenceScore: 6.5,
        entryTimestamp: DAY0,
        grossReturn: 0,
        frictionReturn: 0,
        fundingReturn: 0,
        netReturn: 0,
        pnlPercent: 0.05,
      },
    ];

    const [cell] = decomposePnlCells(mixed);
    expect(cell!.n).toBe(2);
    // 0.03 (from netReturn) + 0.05 (from pnl_percent) = 0.08, NOT 999.x.
    expect(cell!.sumNet).toBeCloseTo(0.08, 12);
    expect(cell!.winRate).toBe(1); // both realized-positive
  });
});

// ============================================================================
// FIX 3 — cold-cohort scan: no false DECAYING alarms on flat/insufficient data
// ============================================================================

describe('coldCohortScan — no false decay alarms', () => {
  const MONTH_MS = 30 * 24 * HOUR_MS;

  /** Build n trades in a given month with explicit realized pnl_percent values. */
  function cohort(monthOffset: number, pnls: number[]): ReviewTradeRow[] {
    const base = DAY0 + monthOffset * MONTH_MS;
    return pnls.map((p, i) => ({
      id: `c${monthOffset}-${i}`,
      symbol: 'BTCUSDT',
      regime: 'uptrend+normal',
      exitReason: p > 0 ? 'take_profit' : 'stop_loss',
      confluenceScore: 6.5,
      entryTimestamp: base + i * HOUR_MS,
      grossReturn: 0,
      frictionReturn: 0,
      fundingReturn: 0,
      netReturn: 0,
      pnlPercent: p,
    }));
  }

  it('does NOT flag a flat all-zero cohort as DECAYING (even with enough trades)', () => {
    // 30 legacy rows whose realized P&L is exactly 0 — no economics at all.
    const flat = cohort(0, Array.from({ length: 30 }, () => 0));
    const [stat] = coldCohortScan(flat);
    expect(stat!.n).toBe(30);
    expect(stat!.meanNet).toBe(0);
    expect(stat!.decaying).toBe(false);
  });

  it('does NOT flag a cohort with n below the min-confidence threshold', () => {
    // 5 trades (< MIN_COHORT_N) with a clearly negative trend.
    const small = cohort(0, [-0.05, -0.06, -0.04, -0.07, -0.05]);
    const [stat] = coldCohortScan(small);
    expect(stat!.n).toBe(5);
    expect(stat!.decaying).toBe(false);
  });

  it('DOES flag a genuinely negative, sufficiently-large cohort as DECAYING', () => {
    // 30 trades, persistently negative realized net → real decay signal.
    const bad = cohort(0, Array.from({ length: 30 }, (_, i) => -0.02 - (i % 3) * 0.005));
    const [stat] = coldCohortScan(bad);
    expect(stat!.n).toBe(30);
    expect(stat!.meanNet).toBeLessThan(0);
    expect(stat!.decaying).toBe(true);
  });
});

// ============================================================================
// FIX 1 — materializePnlCells is idempotent per weekOf (no doubling on re-run)
// ============================================================================

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

function freshDb(): TestDb {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  return db;
}

/** Insert a minimal bot_trades row (legacy-shaped: cost cols 0, pnl_percent set). */
function insertTrade(
  db: TestDb,
  over: { id: string; symbol?: string; regime?: string; exitReason?: string; confluenceScore?: number; pnlPercent: number },
): void {
  db.insert(botTrades)
    .values({
      id: over.id,
      symbol: over.symbol ?? 'BTCUSDT',
      direction: 'long',
      entryPrice: 100,
      exitPrice: 102,
      entryTimestamp: DAY0,
      exitTimestamp: DAY0 + HOUR_MS,
      stopLoss: 99,
      takeProfit: 103,
      positionSizeUSDT: 1000,
      riskAmountUSDT: 10,
      strategy: 'order_block',
      confluenceScore: over.confluenceScore ?? 6.5,
      factorBreakdown: '{}',
      regime: over.regime ?? 'uptrend+normal',
      exitReason: over.exitReason ?? 'take_profit',
      barsHeld: 1,
      pnlPercent: over.pnlPercent,
      pnlUSDT: over.pnlPercent * 1000,
      equityAfter: 10_000,
      drawdownFromPeak: 0,
      // Legacy: cost cols default 0 (predate cost-column writer).
      createdAt: DAY0,
    })
    .run();
}

describe('materializePnlCells — idempotent per weekOf (DB)', () => {
  it('re-running for the same weekOf does NOT double pnl_cells; SUM(n) == #trades', () => {
    const db = freshDb();
    const weekOf = Date.UTC(2026, 5, 8); // a UTC Monday

    // 3 trades that fall into 2 distinct cells.
    insertTrade(db, { id: 't1', exitReason: 'take_profit', pnlPercent: 0.02 });
    insertTrade(db, { id: 't2', exitReason: 'take_profit', pnlPercent: 0.01 });
    insertTrade(db, { id: 't3', exitReason: 'stop_loss', pnlPercent: -0.015 });

    materializePnlCells(db, weekOf);
    const after1 = db.select().from(pnlCells).all();
    const count1 = after1.length;
    const sumN1 = after1.reduce((s, c) => s + (c.n ?? 0), 0);

    // Re-run the SAME weekOf — must be idempotent.
    materializePnlCells(db, weekOf);
    const after2 = db.select().from(pnlCells).all();

    expect(after2.length).toBe(count1); // no doubling
    const sumN2 = after2.reduce((s, c) => s + (c.n ?? 0), 0);
    expect(sumN2).toBe(sumN1);
    // SUM(n) equals the number of input trades, not a multiple.
    expect(sumN2).toBe(3);
  });

  it('reports REAL economics for legacy rows (nonzero sumNet from pnl_percent)', () => {
    const db = freshDb();
    const weekOf = Date.UTC(2026, 5, 8);
    insertTrade(db, { id: 'a', exitReason: 'take_profit', pnlPercent: 0.02 });
    insertTrade(db, { id: 'b', exitReason: 'take_profit', pnlPercent: 0.03 });

    materializePnlCells(db, weekOf);
    const cells = db.select().from(pnlCells).all();
    const cell = cells.find((c) => c.exitReason === 'take_profit')!;
    expect(cell.sumNet).toBeCloseTo(0.05, 12); // NOT 0
    expect(cell.winRate).toBe(1);
  });

  it('does NOT delete cells stamped to a DIFFERENT weekOf', () => {
    const db = freshDb();
    insertTrade(db, { id: 'x', pnlPercent: 0.02 });

    const weekA = Date.UTC(2026, 5, 1);
    const weekB = Date.UTC(2026, 5, 8);
    materializePnlCells(db, weekA);
    materializePnlCells(db, weekB);

    const all = db.select().from(pnlCells).all();
    const weeks = new Set(all.map((c) => c.weekOf));
    expect(weeks.has(weekA)).toBe(true);
    expect(weeks.has(weekB)).toBe(true);

    // Re-running weekB again leaves weekA untouched and weekB un-doubled.
    const weekACountBefore = all.filter((c) => c.weekOf === weekA).length;
    materializePnlCells(db, weekB);
    const all2 = db.select().from(pnlCells).all();
    expect(all2.filter((c) => c.weekOf === weekA).length).toBe(weekACountBefore);
  });
});

export { HOUR_MS };
