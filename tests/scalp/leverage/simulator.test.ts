// tests/scalp/leverage/simulator.test.ts
import { describe, it, expect } from 'vitest';
import { simulateLeverage, ruinProbability } from '@/lib/scalp/leverage/simulator';
import type { Candle } from '@/types/candle';
import type { TradeTapeEntry, LeverageConfig } from '@/lib/scalp/leverage/types';

const M = 60_000;
function c(ts: number, o: number, h: number, l: number, cl: number): Candle {
  return { timestamp: ts, open: o, high: h, low: l, close: cl, volume: 1 };
}
function cfg(over: Partial<LeverageConfig>): LeverageConfig {
  return { leverage: 1, marginFraction: 1, mmr: 0.005, slippageBps: 0, fundingRate8h: 0, ruinThreshold: 0.1, mcIterations: 2000, ...over };
}

describe('simulateLeverage', () => {
  it('L=1, marginFraction=1: each multiplier equals 1 + pnlPercent1x (exact reconciliation)', () => {
    // Two winners that never approach P_liq (which at L=1 is ~entry*0.005).
    const tape: TradeTapeEntry[] = [
      { symbol: 'X', direction: 'long', entryPrice: 100, stopLoss: 90, takeProfit: 110, entryTimestamp: 0, exitTimestamp: M, pnlPercent1x: 0.10 },
      { symbol: 'X', direction: 'long', entryPrice: 100, stopLoss: 90, takeProfit: 110, entryTimestamp: 2 * M, exitTimestamp: 3 * M, pnlPercent1x: -0.05 },
    ];
    const candles = [c(0, 100, 100, 100, 100), c(M, 100, 110, 99, 110), c(2 * M, 100, 100, 100, 100), c(3 * M, 100, 100, 99, 95)];
    const r = simulateLeverage(tape, new Map([['X', candles]]), cfg({}));
    expect(r.liquidations).toBe(0);
    // equity: 1 * 1.10 * 0.95 = 1.045
    expect(r.totalReturn).toBeCloseTo(0.045, 9);
    expect(r.tradeCount).toBe(2);
  });

  it('throws on missing candle data for a symbol', () => {
    const tape: TradeTapeEntry[] = [
      { symbol: 'MISSING', direction: 'long', entryPrice: 100, stopLoss: 90, takeProfit: 110, entryTimestamp: 0, exitTimestamp: M, pnlPercent1x: 0.1 },
    ];
    expect(() => simulateLeverage(tape, new Map(), cfg({}))).toThrow(/MISSING/);
  });
});

describe('ruinProbability', () => {
  it('all-positive multipliers never ruin', () => {
    expect(ruinProbability([1.1, 1.1, 1.1], 0.1, 1000)).toBe(0);
  });
  it('a single zero multiplier (full-margin liquidation) always ruins', () => {
    expect(ruinProbability([1.5, 0, 1.5], 0.1, 1000)).toBe(1);
  });
});

describe('synthetic Kelly check', () => {
  it('p=0.6 win +1% / lose -1%, marginFraction=1: growth-maximizing L is ~20', () => {
    // Build 1000 trades that NEVER liquidate (lows only 1% from entry, P_liq far at these L).
    const tape: TradeTapeEntry[] = [];
    const candlesBySym = new Map<string, Candle[]>();
    const cs: Candle[] = [];
    for (let i = 0; i < 1000; i++) {
      const win = i % 5 < 3; // exactly 60%
      const t0 = i * 2 * M;
      const pnl = win ? 0.01 : -0.01;
      tape.push({ symbol: 'K', direction: 'long', entryPrice: 100, stopLoss: 90, takeProfit: 105, entryTimestamp: t0, exitTimestamp: t0 + M, pnlPercent1x: pnl });
      cs.push(c(t0, 100, 100, 100, 100));
      cs.push(c(t0 + M, 100, 101, 99, win ? 101 : 99)); // low 99 = 1% drop, far above any P_liq for L<=25
    }
    candlesBySym.set('K', cs);

    let bestL = 0, bestG = -Infinity;
    for (const L of [1, 5, 10, 15, 18, 20, 22, 25]) {
      const r = simulateLeverage(tape, candlesBySym, cfg({ leverage: L }));
      if (r.meanLogGrowthPerTrade > bestG) { bestG = r.meanLogGrowthPerTrade; bestL = L; }
    }
    // Analytic optimum is L=20 for ±1%, p=0.6.
    expect(bestL).toBeGreaterThanOrEqual(18);
    expect(bestL).toBeLessThanOrEqual(22);
  });
});
