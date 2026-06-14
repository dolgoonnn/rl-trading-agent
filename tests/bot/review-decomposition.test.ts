import { describe, it, expect } from 'vitest';
import {
  bucketConfluence,
  decomposePnlCells,
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

export { HOUR_MS };
