import { describe, it, expect } from 'vitest';
import { tradesInWindow } from '@/lib/funding-arb-validation/window-slicer';
import type { ArbTrade } from '../../scripts/backtest-funding-arb';

const D = (utc: string) => new Date(utc).getTime();

function fakeTrade(entryUtc: string, netPnl: number): ArbTrade {
  return {
    symbol: 'BTCUSDT',
    direction: 'short_perp',
    entryTimestamp: D(entryUtc),
    exitTimestamp: D(entryUtc) + 1000,
    entryFundingRate: 0.0003,
    holdTimeHours: 8,
    fundingPayments: 1,
    totalFundingCollected: netPnl + 1,
    spreadCost: 1,
    netPnl,
    annualizedAPY: 0.2,
    exitReason: 'rate_below',
  };
}

describe('tradesInWindow', () => {
  it('keeps trades whose entryTimestamp falls inside [startMs, endMs)', () => {
    const trades: ArbTrade[] = [
      fakeTrade('2026-01-01T00:00:00Z', 1),
      fakeTrade('2026-01-15T00:00:00Z', 2),
      fakeTrade('2026-02-01T00:00:00Z', 3), // exclusive end → excluded
      fakeTrade('2026-02-15T00:00:00Z', 4),
    ];
    const result = tradesInWindow(
      trades,
      D('2026-01-01T00:00:00Z'),
      D('2026-02-01T00:00:00Z'),
    );
    expect(result.map((t: ArbTrade) => t.netPnl)).toEqual([1, 2]);
  });

  it('returns empty when no trades fall in window', () => {
    const trades: ArbTrade[] = [fakeTrade('2026-03-01T00:00:00Z', 5)];
    expect(
      tradesInWindow(trades, D('2026-01-01T00:00:00Z'), D('2026-02-01T00:00:00Z')),
    ).toEqual([]);
  });

  it('handles empty input', () => {
    expect(
      tradesInWindow([], D('2026-01-01T00:00:00Z'), D('2026-02-01T00:00:00Z')),
    ).toEqual([]);
  });
});
