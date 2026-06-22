import { describe, it, expect } from 'vitest';
import type { Candle } from '@/types/candle';
import { SweepChochStrategy } from '@/lib/scalp/strategies/sweep-choch';

const ONE_MINUTE_MS = 60_000;
/** Wednesday 08:00 UTC — inside the 07-21 UTC session window */
const BASE_TS = Date.UTC(2024, 0, 10, 8, 0, 0);

function candle(i: number, o: number, h: number, l: number, c: number): Candle {
  return { timestamp: BASE_TS + i * ONE_MINUTE_MS, open: o, high: h, low: l, close: c, volume: 1 };
}

/** Flat baseline bar with a small range so ATR stays positive */
function flatBar(i: number, price = 100): Candle {
  return candle(i, price, price + 0.1, price - 0.1, price);
}

/**
 * 220 bars: flat at 100, a confirmed swing low at index 205 (price 98.8),
 * then bar 219 configurable as the sweep bar.
 */
function buildSweepLowSeries(opts?: {
  finalClose?: number;
  touchLevelAtIndex?: number;
}): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < 219; i++) candles.push(flatBar(i));

  // Carve the swing low: descending lows into 205, ascending after
  candles[202] = candle(202, 100, 100.1, 99.5, 99.9);
  candles[203] = candle(203, 99.9, 100.0, 99.3, 99.8);
  candles[204] = candle(204, 99.8, 99.9, 99.1, 99.7);
  candles[205] = candle(205, 99.7, 99.8, 98.8, 99.6); // swing low @ 98.8
  candles[206] = candle(206, 99.6, 99.8, 99.2, 99.7);
  candles[207] = candle(207, 99.7, 99.9, 99.4, 99.8);
  candles[208] = candle(208, 99.8, 100.0, 99.6, 99.9);

  if (opts?.touchLevelAtIndex !== undefined) {
    const j = opts.touchLevelAtIndex;
    candles[j] = candle(j, 100, 100.1, 98.7, 99.9); // trades through 98.8 before the sweep bar
  }

  const finalClose = opts?.finalClose ?? 99.9;
  candles.push(candle(219, 100, 100.2, 98.5, finalClose));
  return candles;
}

/**
 * Bearish zigzag: 17 segments of (8 bars down 0.3, 4 bars up 0.3) from 110,
 * confirmed lower lows/lower highs, then a final bar sweeping the last
 * segment bottom. Returns the series and the swept level.
 */
function buildDowntrendSweepSeries(): { candles: Candle[]; bottom: number } {
  const candles: Candle[] = [];
  let price = 110;
  let i = 0;
  let bottom = price;

  for (let seg = 0; seg < 17; seg++) {
    for (let d = 0; d < 8; d++) {
      const close = price - 0.3;
      // high capped at open so segment tops stay strict pivots
      candles.push(candle(i++, price, price, close - 0.05, close));
      price = close;
    }
    bottom = price;
    for (let u = 0; u < 4; u++) {
      const close = price + 0.3;
      // low capped at open so segment bottoms stay strict pivots
      candles.push(candle(i++, price, close + 0.05, price, close));
      price = close;
    }
  }

  // Step down off the top, then flat padding to confirm the final swing high
  const padLevel = bottom + 0.5;
  candles.push(candle(i++, price, price + 0.05, padLevel - 0.05, padLevel));
  for (let p = 0; p < 6; p++) {
    candles.push(candle(i++, padLevel, padLevel + 0.05, padLevel - 0.05, padLevel));
  }

  // Sweep bar: wick below the segment bottom, close back above it
  candles.push(candle(i++, padLevel, padLevel + 0.05, bottom - 0.3, bottom + 0.2));
  return { candles, bottom };
}

const noBias = { biasMode: 'none' as const };

describe('SweepChochStrategy', () => {
  it('signals long on wick-through + close-back above a swing low', () => {
    const candles = buildSweepLowSeries();
    const strategy = new SweepChochStrategy(noBias);
    const signal = strategy.detectEntry(candles, 219);

    expect(signal).not.toBeNull();
    expect(signal!.direction).toBe('long');
    expect(signal!.entryPrice).toBe(99.9);
    // SL must sit below the sweep wick (98.5), not just below the level
    expect(signal!.stopLoss).toBeLessThan(98.5);
  });

  it('does not signal when the candle CLOSES through the level', () => {
    const candles = buildSweepLowSeries({ finalClose: 98.6 }); // close below 98.8
    const strategy = new SweepChochStrategy(noBias);
    expect(strategy.detectEntry(candles, 219)).toBeNull();
  });

  it('does not re-trigger on an already-swept level', () => {
    // Bar 217 trades through 98.8 first (too late to form its own pivot)
    const candles = buildSweepLowSeries({ touchLevelAtIndex: 217 });
    const strategy = new SweepChochStrategy(noBias);
    expect(strategy.detectEntry(candles, 219)).toBeNull();
  });

  it('places TP at exactly targetR times the risk distance', () => {
    const candles = buildSweepLowSeries();
    const strategy = new SweepChochStrategy({ ...noBias, targetR: 4 });
    const signal = strategy.detectEntry(candles, 219)!;

    const risk = signal.entryPrice - signal.stopLoss;
    expect(risk).toBeGreaterThan(0);
    expect(signal.takeProfit - signal.entryPrice).toBeCloseTo(4 * risk, 10);
    expect(signal.riskReward).toBe(4);
  });

  it('respects the vendor TP1 level: 1.5R sits between entry and TP', () => {
    // The 1.5R partial is taken by the harness; verify the geometry holds
    const candles = buildSweepLowSeries();
    const strategy = new SweepChochStrategy(noBias);
    const signal = strategy.detectEntry(candles, 219)!;

    const risk = signal.entryPrice - signal.stopLoss;
    const tp1 = signal.entryPrice + 1.5 * risk;
    expect(tp1).toBeGreaterThan(signal.entryPrice);
    expect(tp1).toBeLessThan(signal.takeProfit);
  });

  it('blocks counter-trend sweeps in choch bias mode but allows them in none mode', () => {
    const { candles, bottom } = buildDowntrendSweepSeries();
    const last = candles.length - 1;

    const filtered = new SweepChochStrategy({ biasMode: 'choch' });
    expect(filtered.detectEntry(candles, last)).toBeNull();

    const unfiltered = new SweepChochStrategy({ biasMode: 'none' });
    const signal = unfiltered.detectEntry(candles, last);
    expect(signal).not.toBeNull();
    expect(signal!.direction).toBe('long');
    expect(signal!.stopLoss).toBeLessThan(bottom - 0.3);
  });

  it('suppresses signals outside the London/NY session when sessionFilter is on', () => {
    const candles = buildSweepLowSeries().map((c) => ({
      ...c,
      // Shift everything +14h: final bar lands ~01:39 UTC (Asian session)
      timestamp: c.timestamp + 14 * 60 * ONE_MINUTE_MS,
    }));

    const filtered = new SweepChochStrategy({ ...noBias, sessionFilter: true });
    expect(filtered.detectEntry(candles, 219)).toBeNull();

    const unfiltered = new SweepChochStrategy({ ...noBias, sessionFilter: false });
    expect(unfiltered.detectEntry(candles, 219)).not.toBeNull();
  });

  it('returns null without enough history', () => {
    const candles = buildSweepLowSeries().slice(0, 150);
    const strategy = new SweepChochStrategy(noBias);
    expect(strategy.detectEntry(candles, 149)).toBeNull();
  });
});
