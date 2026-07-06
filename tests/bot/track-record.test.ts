import { describe, it, expect } from 'vitest';
import { summarizeSleeve, combineSleeves, type SleeveSummary } from '../../src/lib/bot/track-record';

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
