import { describe, it, expect } from 'vitest';
import { simulatePosition } from '@/lib/sim/simulator';
import { DefaultFillModel } from '@/lib/sim/fill-model';
import { FlatFrictionCostModel } from '@/lib/sim/cost-model';
import type { SimConfig, SimPosition } from '@/lib/sim/types';
import type { Candle } from '@/types/candle';

const fm = new DefaultFillModel(new FlatFrictionCostModel(0)); // zero cost for clean math
const baseCfg: SimConfig = { entryTiming: 'signal_close', maxBars: 100, barMs: 3_600_000, exitMode: 'simple' };

function c(ts: number, o: number, h: number, l: number, cl: number): Candle {
  return { timestamp: ts, open: o, high: h, low: l, close: cl, volume: 1 };
}

describe('simulatePosition (simple mode)', () => {
  it('long hits TP -> positive pnl at TP', () => {
    const pos: SimPosition = { direction: 'long', entryPrice: 100, entryTimestamp: 0, entryIndex: 0, stopLoss: 95, takeProfit: 110, strategy: 'ob' };
    const candles = [c(0, 100, 101, 99, 100), c(3_600_000, 100, 112, 100, 111)];
    const r = simulatePosition(pos, candles, 1, { fillModel: fm, config: baseCfg });
    expect(r!.exitReason).toBe('take_profit');
    expect(r!.exitPrice).toBe(110);
    expect(r!.pnlPercent).toBeCloseTo(0.10, 9);
  });

  it('entryTiming next_open enters at the next bar open, not the signal close', () => {
    const pos: SimPosition = { direction: 'long', entryPrice: 100, entryTimestamp: 0, entryIndex: 0, stopLoss: 90, takeProfit: 130, strategy: 'ob' };
    // signal bar close = 100; next bar opens at 105. With next_open, entry basis = 105.
    const candles = [c(0, 98, 101, 97, 100), c(3_600_000, 105, 131, 104, 130)];
    const r = simulatePosition(pos, candles, 1, { fillModel: fm, config: { ...baseCfg, entryTiming: 'next_open' } });
    expect(r!.entryPrice).toBe(105);
    expect(r!.pnlPercent).toBeCloseTo((130 - 105) / 105, 9);
  });

  it('funding is composed over crossed settlements (long pays positive rate)', () => {
    // entry at 0 UTC+1h, exit crosses the 08:00 UTC settlement once.
    const entryMs = 3_600_000;                 // 01:00 UTC
    const exitMs = 9 * 3_600_000;              // 09:00 UTC -> crosses 08:00
    const pos: SimPosition = { direction: 'long', entryPrice: 100, entryTimestamp: entryMs, entryIndex: 0, stopLoss: 95, takeProfit: 110, strategy: 'ob' };
    const candles = [c(entryMs, 100, 101, 99, 100), c(exitMs, 100, 112, 100, 111)];
    const r = simulatePosition(pos, candles, 1, {
      fillModel: fm, config: baseCfg,
      rateAt: (ms) => (ms === 8 * 3_600_000 ? 0.0001 : 0), // 1bp at 08:00
    });
    expect(r!.grossReturn).toBeCloseTo(0.10, 9);
    expect(r!.fundingReturn).toBeCloseTo(-0.0001, 9); // long pays
    expect(r!.netReturn).toBeCloseTo(0.10 - 0.0001, 9);
  });
});
