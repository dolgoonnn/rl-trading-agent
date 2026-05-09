import { describe, it, expect } from 'vitest';
import { arbTradesToMcTrades } from '@/lib/funding-arb-validation/trade-adapter';
import type { ArbTrade } from '../../scripts/backtest-funding-arb';

function fakeTrade(netPnl: number): ArbTrade {
  return {
    symbol: 'BTCUSDT',
    direction: 'short_perp',
    entryTimestamp: 0,
    exitTimestamp: 1000,
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

describe('arbTradesToMcTrades', () => {
  it('converts each trade to {pnlPercent: netPnl/positionSize}', () => {
    const trades = [fakeTrade(20), fakeTrade(-5), fakeTrade(0)];
    const mc = arbTradesToMcTrades(trades, 2000);
    expect(mc).toEqual([
      { pnlPercent: 0.01 },
      { pnlPercent: -0.0025 },
      { pnlPercent: 0 },
    ]);
  });

  it('throws on zero positionSize (invalid input)', () => {
    expect(() => arbTradesToMcTrades([fakeTrade(20)], 0)).toThrow();
  });
});
