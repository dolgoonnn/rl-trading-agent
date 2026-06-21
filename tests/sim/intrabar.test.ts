import { describe, it, expect } from 'vitest';
import { pessimisticResolve, ohlcHeuristicResolve } from '@/lib/sim/intrabar';
import type { BarFillRequest } from '@/lib/sim/types';
import type { Candle } from '@/types/candle';

function bar(o: number, h: number, l: number, c: number, ts = 1_000): Candle {
  return { timestamp: ts, open: o, high: h, low: l, close: c, volume: 100 };
}

describe('pessimisticResolve', () => {
  it('long: when both SL and TP are inside the bar range, SL wins (pessimistic floor)', () => {
    const req: BarFillRequest = {
      levels: { direction: 'long', stopLoss: 95, takeProfit: 110 },
      bar: bar(100, 115, 90, 105, 7_000), barsHeld: 1, maxBars: 100,
    };
    const r = pessimisticResolve(req);
    expect(r).not.toBeNull();
    expect(r!.exitReason).toBe('stop_loss');
    expect(r!.exitPrice).toBe(95);
    expect(r!.tier).toBe('pessimistic');
    expect(r!.fillTimestamp).toBe(7_000);
  });

  it('long: TP only -> take_profit at TP level', () => {
    const r = pessimisticResolve({
      levels: { direction: 'long', stopLoss: 80, takeProfit: 110 },
      bar: bar(100, 115, 99, 112), barsHeld: 1, maxBars: 100,
    });
    expect(r!.exitReason).toBe('take_profit');
    expect(r!.exitPrice).toBe(110);
  });

  it('short: SL wins tie (SL above), at SL level', () => {
    const r = pessimisticResolve({
      levels: { direction: 'short', stopLoss: 110, takeProfit: 90 },
      bar: bar(100, 115, 85, 95), barsHeld: 1, maxBars: 100,
    });
    expect(r!.exitReason).toBe('stop_loss');
    expect(r!.exitPrice).toBe(110);
  });

  it('no level hit and under maxBars -> null', () => {
    const r = pessimisticResolve({
      levels: { direction: 'long', stopLoss: 80, takeProfit: 130 },
      bar: bar(100, 115, 99, 112), barsHeld: 1, maxBars: 100,
    });
    expect(r).toBeNull();
  });

  it('no level hit but maxBars reached -> max_bars at close', () => {
    const r = pessimisticResolve({
      levels: { direction: 'long', stopLoss: 80, takeProfit: 130 },
      bar: bar(100, 115, 99, 112, 9_000), barsHeld: 100, maxBars: 100,
    });
    expect(r!.exitReason).toBe('max_bars');
    expect(r!.exitPrice).toBe(112);
    expect(r!.fillTimestamp).toBe(9_000);
  });
});

describe('ohlcHeuristicResolve', () => {
  // Open near HIGH => assume path O->H->L->C. A long whose TP and SL both sit
  // in range should fill TP first (high reached before low).
  it('long, open near high: TP fills first on a straddle', () => {
    const r = ohlcHeuristicResolve({
      levels: { direction: 'long', stopLoss: 95, takeProfit: 110 },
      bar: { timestamp: 1, open: 113, high: 115, low: 90, close: 100, volume: 1 },
      barsHeld: 1, maxBars: 100,
    });
    expect(r!.exitReason).toBe('take_profit');
    expect(r!.tier).toBe('ohlc_heuristic');
  });

  // Open near LOW => assume path O->L->H->C. Same straddle now fills SL first.
  it('long, open near low: SL fills first on a straddle', () => {
    const r = ohlcHeuristicResolve({
      levels: { direction: 'long', stopLoss: 95, takeProfit: 110 },
      bar: { timestamp: 1, open: 92, high: 115, low: 90, close: 100, volume: 1 },
      barsHeld: 1, maxBars: 100,
    });
    expect(r!.exitReason).toBe('stop_loss');
  });
});
