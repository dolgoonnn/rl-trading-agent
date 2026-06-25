import { describe, it, expect } from 'vitest';
import { diffTrades, reconcileReport } from '@/lib/sim/reconcile';
import type { SimTradeResult } from '@/lib/sim/types';

function sim(net: number, reason: SimTradeResult['exitReason']): SimTradeResult {
  return { entryTimestamp: 0, exitTimestamp: 1, direction: 'long', entryPrice: 100, exitPrice: 101,
           pnlPercent: net, strategy: 'ob', exitReason: reason, tier: 'pessimistic',
           grossReturn: net, fundingReturn: 0, netReturn: net };
}

describe('reconcile', () => {
  it('diffTrades computes signed net delta + match flags', () => {
    const d = diffTrades(sim(0.0102, 'take_profit'), { netReturn: 0.0100, exitReason: 'take_profit', barsHeld: 5 }, 'T1', 'BTCUSDT');
    expect(d.netDelta).toBeCloseTo(0.0002, 9);
    expect(d.reasonMatch).toBe(true);
  });

  it('reconcileReport passes within tolerance, fails outside', () => {
    const within = reconcileReport(
      [diffTrades(sim(0.0102, 'take_profit'), { netReturn: 0.0100, exitReason: 'take_profit', barsHeld: 5 }, 'T1', 'BTC')],
      { netBps: 5, reasonRate: 0.95, barsRate: 0.90 },
    );
    expect(within.pass).toBe(true);

    const outside = reconcileReport(
      [diffTrades(sim(0.05, 'stop_loss'), { netReturn: 0.0100, exitReason: 'take_profit', barsHeld: 5 }, 'T2', 'BTC')],
      { netBps: 5, reasonRate: 0.95, barsRate: 0.90 },
    );
    expect(outside.pass).toBe(false);
  });
});
