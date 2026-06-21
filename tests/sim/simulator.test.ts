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

describe('simulatePosition (partial_tp + breakeven)', () => {
  it('takes a partial at triggerR, moves SL to BE+buffer, blends pnl', () => {
    // Long entry 100, SL 90 (risk 10), TP 130. Partial 50% at 1R (price 110),
    // BE buffer 0.1 -> SL moves to 101. Then price falls and stops the remainder at 101.
    const pos: SimPosition = { direction: 'long' as const, entryPrice: 100, entryTimestamp: 0, entryIndex: 0, stopLoss: 90, takeProfit: 130, strategy: 'ob' };
    const candles = [
      c(0, 100, 101, 99, 100),
      c(3_600_000, 100, 111, 100, 110),     // hits 1R -> partial 50% at close 110 (+10%)
      c(7_200_000, 110, 110, 100, 101),     // falls; remainder stopped at new SL 101 (+1%)
    ];
    const r = simulatePosition(pos, candles, 1, {
      fillModel: fm,
      config: { entryTiming: 'signal_close', maxBars: 100, barMs: 3_600_000, exitMode: 'partial_tp',
                partialTP: { fraction: 0.5, triggerR: 1.0, beBuffer: 0.1 } },
    });
    // blended: 0.5 * 10% + 0.5 * 1% = 5.5%
    expect(r!.pnlPercent).toBeCloseTo(0.055, 6);
    expect(r!.exitReason).toBe('stop_loss');
  });
});

describe('simulatePosition (trailing)', () => {
  it('trails SL up, only tightens, and stops at the trailed level (not the original SL)', () => {
    // entry 100, original SL 90 (rawRisk 10), TP 200 (never hit). Trail: activate at 1R, 0.5R behind the high.
    const pos: SimPosition = { direction: 'long', entryPrice: 100, entryTimestamp: 0, entryIndex: 0, stopLoss: 90, takeProfit: 200, strategy: 'ob' };
    const candles = [
      c(0, 100, 100, 100, 100),
      c(3_600_000, 100, 115, 111, 114),  // high 115 -> trail SL to 115-5=110; low 111 > 110, no stop
      c(7_200_000, 114, 114, 105, 106),  // high 114 -> recompute 109 but Math.max keeps 110 (no loosen); low 105 <= 110 -> stop at 110
    ];
    const r = simulatePosition(pos, candles, 1, {
      fillModel: fm,
      config: { entryTiming: 'signal_close', maxBars: 100, barMs: 3_600_000, exitMode: 'trailing',
                trailing: { activationR: 1.0, distanceR: 0.5 } },
    });
    expect(r!.exitReason).toBe('stop_loss');
    expect(r!.exitPrice).toBe(110); // the trailed level, NOT the original SL of 90
    expect(r!.pnlPercent).toBeCloseTo(0.10, 9);
  });
});

describe('simulatePosition (strategyExit hook)', () => {
  it('exits with reason "strategy" at the bar the hook fires, at that bar close', () => {
    const pos: SimPosition = { direction: 'long', entryPrice: 100, entryTimestamp: 0, entryIndex: 0, stopLoss: 50, takeProfit: 200, strategy: 'ob' };
    const candles = [
      c(0, 100, 100, 100, 100),
      c(3_600_000, 100, 105, 98, 102),   // hook returns null here (SL/TP also untouched)
      c(7_200_000, 102, 106, 99, 104),   // hook fires here -> exit at close 104
    ];
    const r = simulatePosition(pos, candles, 1, {
      fillModel: fm,
      config: baseCfg, // simple mode; SL 50 / TP 200 never trigger
      strategyExit: (_pos, bar) => (bar.timestamp === 7_200_000 ? 'strategy' : null),
    });
    expect(r!.exitReason).toBe('strategy');
    expect(r!.exitPrice).toBe(104);
    expect(r!.exitTimestamp).toBe(7_200_000);
  });
});
