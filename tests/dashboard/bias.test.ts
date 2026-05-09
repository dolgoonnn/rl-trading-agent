import { describe, it, expect } from 'vitest';
import { resampleCandles } from '@/lib/trpc/routers/dashboard/bias';
import type { Candle } from '@/types';

function c(ts: number, o: number, h: number, l: number, cl: number, v = 1): Candle {
  return { timestamp: ts, open: o, high: h, low: l, close: cl, volume: v };
}

const HOUR = 3_600_000;

describe('resampleCandles', () => {
  it('aggregates 4 hourly candles into one 4H candle', () => {
    const hourly: Candle[] = [
      c(0, 100, 105, 98, 102),
      c(HOUR, 102, 110, 101, 108),
      c(2 * HOUR, 108, 112, 105, 109),
      c(3 * HOUR, 109, 115, 107, 114),
    ];
    const out = resampleCandles(hourly, '4H');
    expect(out).toHaveLength(1);
    expect(out[0]!.open).toBe(100);
    expect(out[0]!.close).toBe(114);
    expect(out[0]!.high).toBe(115);
    expect(out[0]!.low).toBe(98);
    expect(out[0]!.volume).toBe(4);
  });

  it('passes 1H through unchanged', () => {
    const hourly: Candle[] = [c(0, 1, 2, 0, 1.5), c(HOUR, 1.5, 2.5, 1, 2)];
    expect(resampleCandles(hourly, '1H')).toEqual(hourly);
  });

  it('drops incomplete trailing bucket', () => {
    const hourly: Candle[] = [c(0, 1, 2, 0, 1), c(HOUR, 1, 2, 0, 1), c(2 * HOUR, 1, 2, 0, 1)];
    expect(resampleCandles(hourly, '4H')).toEqual([]);
  });
});
