import { describe, it, expect } from 'vitest';
import {
  computePerfStats, groupBy, confluenceBucket, MIN_TRADES_FOR_STATS,
  type AnalyticsTrade,
} from '../../src/lib/bot/trade-analytics';

function t(over: Partial<AnalyticsTrade> = {}): AnalyticsTrade {
  return { pnlPct: 0, pnlUsdt: null, riskAmountUsdt: null, exitReason: null, regime: null, symbol: 'BTCUSDT', confluenceScore: null, ...over };
}

describe('computePerfStats', () => {
  it('computes profit factor, expectancy, averages and win rate', () => {
    const s = computePerfStats([t({ pnlPct: 2 }), t({ pnlPct: 1 }), t({ pnlPct: -1 })]);
    expect(s.n).toBe(3);
    expect(s.profitFactor).toBeCloseTo(3);      // (2+1) / 1
    expect(s.expectancy).toBeCloseTo(2 / 3);    // (2+1-1)/3
    expect(s.avgWin).toBeCloseTo(1.5);
    expect(s.avgLoss).toBeCloseTo(-1);
    expect(s.winRate).toBeCloseTo(2 / 3);
  });

  it('returns null profit factor when there are no losses (no Infinity)', () => {
    expect(computePerfStats([t({ pnlPct: 1 })]).profitFactor).toBeNull();
  });

  it('handles the empty set without dividing by zero', () => {
    const s = computePerfStats([]);
    expect(s).toMatchObject({ n: 0, profitFactor: null, expectancy: 0, avgWin: 0, avgLoss: 0, avgR: null, winRate: 0 });
  });

  it('computes avgR only from trades carrying both pnlUsdt and risk', () => {
    const s = computePerfStats([
      t({ pnlUsdt: 10, riskAmountUsdt: 5 }),   // R = 2
      t({ pnlUsdt: -4, riskAmountUsdt: 4 }),   // R = -1
      t({ pnlUsdt: 99, riskAmountUsdt: null }), // ignored
      t({ pnlUsdt: 5, riskAmountUsdt: 0 }),     // ignored (zero risk)
    ]);
    expect(s.avgR).toBeCloseTo(0.5);
  });

  it('exposes the honesty threshold', () => {
    expect(MIN_TRADES_FOR_STATS).toBe(20);
  });
});

describe('groupBy + confluenceBucket', () => {
  it('groups with counts, net pnl and win rate, sorted by count desc', () => {
    const rows = groupBy(
      [t({ exitReason: 'stop_loss', pnlPct: -1 }), t({ exitReason: 'take_profit', pnlPct: 2 }), t({ exitReason: 'stop_loss', pnlPct: -2 })],
      (x) => x.exitReason ?? 'unknown',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.key).toBe('stop_loss');
    expect(rows[0]?.n).toBe(2);
    expect(rows[0]?.netPnlPct).toBeCloseTo(-3);
    expect(rows[0]?.winRate).toBeCloseTo(0);
    expect(rows[1]?.key).toBe('take_profit');
  });

  it('buckets confluence scores', () => {
    expect(confluenceBucket(null)).toBe('unknown');
    expect(confluenceBucket(2.9)).toBe('<3');
    expect(confluenceBucket(3)).toBe('3-4');
    expect(confluenceBucket(4.31)).toBe('4-5');
    expect(confluenceBucket(5.82)).toBe('5-6');
    expect(confluenceBucket(7)).toBe('6+');
  });
});
