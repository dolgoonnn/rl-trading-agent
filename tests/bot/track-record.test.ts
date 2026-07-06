import { describe, it, expect } from 'vitest';
import {
  summarizeSleeve,
  combineSleeves,
  partitionByHoldCap,
  type SleeveSummary,
} from '../../src/lib/bot/track-record';

const H = 3_600_000; // ms per hour

describe('partitionByHoldCap — separate downtime-stranded trades from strategy', () => {
  it('classifies trades held beyond the cap as stale, keeps the rest as strategy', () => {
    const p = partitionByHoldCap(
      [
        { holdMs: 9 * H, pnlPct: 0.5 }, // normal overnight
        { holdMs: 296 * H, pnlPct: -8.9 }, // stranded 12 days
        { holdMs: 60 * H, pnlPct: 1.0 }, // normal weekend
        { holdMs: 226 * H, pnlPct: 4.8 }, // stranded ~9 days
      ],
      120 * H,
    );
    expect(p.staleCount).toBe(2);
    expect(p.strategyCount).toBe(2);
    expect(p.stalePnlPct).toBeCloseTo(-4.1, 6); // -8.9 + 4.8
    expect(p.strategyPnlPct).toBeCloseTo(1.5, 6); // 0.5 + 1.0
  });

  it('all-normal holds → zero stale, strategy == total', () => {
    const p = partitionByHoldCap([{ holdMs: 9 * H, pnlPct: -0.5 }, { holdMs: 12 * H, pnlPct: 0.3 }], 120 * H);
    expect(p.staleCount).toBe(0);
    expect(p.strategyPnlPct).toBeCloseTo(-0.2, 6);
  });

  it('boundary: hold exactly at cap is NOT stale (strictly greater)', () => {
    const p = partitionByHoldCap([{ holdMs: 120 * H, pnlPct: 1.0 }], 120 * H);
    expect(p.staleCount).toBe(0);
  });
});

describe('summarizeSleeve', () => {
  it('summarizes closed trades: count, cumulative PnL, win rate', () => {
    const s = summarizeSleeve('crypto', [1.5, -0.5, 2.0, -1.0], 0, 10000);
    expect(s.label).toBe('crypto');
    expect(s.closedTrades).toBe(4);
    expect(s.cumPnlPct).toBeCloseTo(2.0, 6); // 1.5 - 0.5 + 2.0 - 1.0
    expect(s.winRate).toBeCloseTo(0.5, 6); // 2 of 4 positive
    expect(s.openPositions).toBe(0);
  });

  it('handles an empty sleeve (no trades yet) as flat, not NaN', () => {
    const s = summarizeSleeve('gold', [], 0, 10000);
    expect(s.closedTrades).toBe(0);
    expect(s.cumPnlPct).toBe(0);
    expect(s.winRate).toBe(0);
  });

  it('counts open positions separately from closed trades', () => {
    const s = summarizeSleeve('metals', [0.5, -0.1], 3, 9000);
    expect(s.closedTrades).toBe(2);
    expect(s.openPositions).toBe(3);
    expect(s.equity).toBe(9000);
  });
});

describe('combineSleeves', () => {
  it('aggregates across sleeves: total trades, open positions, and equity-weighted PnL', () => {
    const sleeves: SleeveSummary[] = [
      summarizeSleeve('crypto', [], 0, 10000), // flat
      summarizeSleeve('metals', [-14.45], 3, 8555), // one big loss
      summarizeSleeve('gold', [], 0, 10000), // flat
    ];
    const c = combineSleeves(sleeves);
    expect(c.totalClosedTrades).toBe(1);
    expect(c.totalOpenPositions).toBe(3);
    expect(c.activeSleeves).toBe(1); // only metals has traded
    expect(c.idleSleeves).toEqual(['crypto', 'gold']);
  });

  it('flags when no sleeve has traded (empty track record)', () => {
    const c = combineSleeves([
      summarizeSleeve('crypto', [], 0, 10000),
      summarizeSleeve('gold', [], 0, 10000),
    ]);
    expect(c.totalClosedTrades).toBe(0);
    expect(c.activeSleeves).toBe(0);
    expect(c.idleSleeves).toEqual(['crypto', 'gold']);
  });
});
