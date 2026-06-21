import { describe, it, expect } from 'vitest';
import { DefaultFillModel } from '@/lib/sim/fill-model';
import { FlatFrictionCostModel } from '@/lib/sim/cost-model';
import type { BarFillRequest } from '@/lib/sim/types';
import type { Candle } from '@/types/candle';

const cost = new FlatFrictionCostModel(0.001);
const straddle: BarFillRequest = {
  levels: { direction: 'long', stopLoss: 95, takeProfit: 110 },
  bar: { timestamp: 0, open: 100, high: 111, low: 94, close: 96, volume: 2 },
  barsHeld: 1, maxBars: 100,
};

describe('DefaultFillModel.resolveExit tier selection', () => {
  it('uses subbar_1m when subBars present', () => {
    const subBars: Candle[] = [
      { timestamp: 10, open: 100, high: 111, low: 100, close: 110, volume: 1 },
      { timestamp: 70, open: 110, high: 110, low: 94, close: 96, volume: 1 },
    ];
    const fm = new DefaultFillModel(cost);
    const r = fm.resolveExit({ ...straddle, subBars });
    expect(r!.tier).toBe('subbar_1m');
    expect(r!.exitReason).toBe('take_profit');
  });

  it('uses ohlc_heuristic when no subBars and heuristic allowed', () => {
    const fm = new DefaultFillModel(cost, { allowHeuristic: true });
    expect(fm.resolveExit(straddle)!.tier).toBe('ohlc_heuristic');
  });

  it('falls to pessimistic floor when heuristic disallowed', () => {
    const fm = new DefaultFillModel(cost, { allowHeuristic: false });
    const r = fm.resolveExit(straddle);
    expect(r!.tier).toBe('pessimistic');
    expect(r!.exitReason).toBe('stop_loss');
  });
});

describe('DefaultFillModel.applyCost', () => {
  it('delegates to the cost model', () => {
    const fm = new DefaultFillModel(cost);
    expect(fm.applyCost(100, 'entry', 'long', {})).toBeCloseTo(100 * 1.001, 9);
  });
});
