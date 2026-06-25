// tests/scalp/leverage/liquidation.test.ts
import { describe, it, expect } from 'vitest';
import {
  liquidationPrice,
  effectiveLiqTrigger,
  fundingCostFraction,
} from '@/lib/scalp/leverage/liquidation';
import { resolveTradeUnderLeverage } from '@/lib/scalp/leverage/liquidation';
import type { Candle } from '@/types/candle';
import type { TradeTapeEntry, LeverageConfig } from '@/lib/scalp/leverage/types';

describe('liquidationPrice', () => {
  it('long: entry 100, L=10, mmr=0.005 -> 90.5', () => {
    expect(liquidationPrice(100, 'long', 10, 0.005)).toBeCloseTo(90.5, 9);
  });
  it('short: entry 100, L=10, mmr=0.005 -> 109.5', () => {
    expect(liquidationPrice(100, 'short', 10, 0.005)).toBeCloseTo(109.5, 9);
  });
  it('long: L=100, mmr=0.005 -> 99.5 (0.5% from entry)', () => {
    expect(liquidationPrice(100, 'long', 100, 0.005)).toBeCloseTo(99.5, 9);
  });
});

describe('effectiveLiqTrigger', () => {
  it('long: slippage shifts trigger UP toward entry (earlier liquidation)', () => {
    const raw = liquidationPrice(100, 'long', 10, 0.005); // 90.5
    const trig = effectiveLiqTrigger(100, 'long', 10, 0.005, 10); // +0.10
    expect(trig).toBeGreaterThan(raw);
    expect(trig).toBeCloseTo(90.6, 9);
  });
  it('short: slippage shifts trigger DOWN toward entry', () => {
    const raw = liquidationPrice(100, 'short', 10, 0.005); // 109.5
    const trig = effectiveLiqTrigger(100, 'short', 10, 0.005, 10); // -0.10
    expect(trig).toBeLessThan(raw);
    expect(trig).toBeCloseTo(109.4, 9);
  });
});

describe('fundingCostFraction', () => {
  const H = 3_600_000;
  it('trade spanning exactly one 08:00 UTC boundary -> one charge', () => {
    // 1970-01-01 07:30 UTC .. 08:30 UTC crosses the 08:00 boundary once
    const entry = 7 * H + 30 * 60_000;
    const exit = 8 * H + 30 * 60_000;
    expect(fundingCostFraction(entry, exit, 0.0001)).toBeCloseTo(0.0001, 12);
  });
  it('trade within a single funding window -> zero', () => {
    const entry = 1 * H;       // 01:00
    const exit = 1 * H + 60_000; // 01:01
    expect(fundingCostFraction(entry, exit, 0.0001)).toBe(0);
  });
  it('trade spanning two boundaries (00:00 and 08:00) -> two charges', () => {
    const entry = 23 * H;          // day0 23:00
    const exit = 23 * H + 10 * H;  // day1 09:00 -> crosses day1 00:00 and 08:00
    expect(fundingCostFraction(entry, exit, 0.0001)).toBeCloseTo(0.0002, 12);
  });
});

function c(ts: number, o: number, h: number, l: number, cl: number): Candle {
  return { timestamp: ts, open: o, high: h, low: l, close: cl, volume: 1 };
}
const M = 60_000;
const baseCfg: LeverageConfig = {
  leverage: 10, marginFraction: 1, mmr: 0.005, slippageBps: 0,
  fundingRate8h: 0, ruinThreshold: 0.1, mcIterations: 100,
};
const longTrade: TradeTapeEntry = {
  symbol: 'X', direction: 'long', entryPrice: 100, stopLoss: 88, takeProfit: 130,
  entryTimestamp: 0, exitTimestamp: 3 * M, pnlPercent1x: 0.30,
};

describe('resolveTradeUnderLeverage', () => {
  it('no liquidation -> amplifies 1x pnl by marginFraction*L', () => {
    // L=10 long: P_liq = 90.5. Lows stay above 90.5 -> survives, resolves as 1x (+30%).
    const candles = [c(0, 100, 100, 100, 100), c(M, 100, 110, 95, 108), c(2 * M, 108, 132, 107, 130), c(3 * M, 130, 130, 129, 130)];
    const out = resolveTradeUnderLeverage(longTrade, candles, baseCfg);
    expect(out.liquidated).toBe(false);
    // 1 + 1 * 10 * 0.30 = 4.0
    expect(out.equityMultiplier).toBeCloseTo(4.0, 9);
  });

  it('liquidation when a 1m low pierces P_liq before exit -> lose full margin', () => {
    // bar at M dips to 90.0 < P_liq 90.5 -> liquidated even though 1x was a winner.
    const candles = [c(0, 100, 100, 100, 100), c(M, 100, 101, 90.0, 99), c(2 * M, 99, 132, 99, 130), c(3 * M, 130, 130, 129, 130)];
    const out = resolveTradeUnderLeverage(longTrade, candles, baseCfg);
    expect(out.liquidated).toBe(true);
    expect(out.equityMultiplier).toBeCloseTo(0, 9); // 1 - marginFraction(=1)
  });

  it('pessimistic: a bar spanning both stop and P_liq liquidates (does not stop out)', () => {
    // bar low 85 reaches both stopLoss 88 and P_liq 90.5 -> liquidation wins.
    const candles = [c(0, 100, 100, 100, 100), c(M, 100, 101, 85, 95), c(2 * M, 95, 96, 94, 95), c(3 * M, 95, 95, 94, 95)];
    const out = resolveTradeUnderLeverage(longTrade, candles, baseCfg);
    expect(out.liquidated).toBe(true);
  });

  it('low leverage: P_liq far away -> survives even on a losing 1x trade', () => {
    // L=2 long: P_liq = 100*(1-0.5+0.005)=50.5. A normal stop-out (1x = -12%) survives.
    const cfg: LeverageConfig = { ...baseCfg, leverage: 2 };
    const loser: TradeTapeEntry = { ...longTrade, pnlPercent1x: -0.12 };
    const candles = [c(0, 100, 100, 100, 100), c(M, 100, 100, 88, 88), c(2 * M, 88, 89, 87, 88), c(3 * M, 88, 88, 87, 88)];
    const out = resolveTradeUnderLeverage(loser, candles, cfg);
    expect(out.liquidated).toBe(false);
    // 1 + 1 * 2 * (-0.12) = 0.76
    expect(out.equityMultiplier).toBeCloseTo(0.76, 9);
  });

  it('funding reduces the surviving multiplier', () => {
    const cfg: LeverageConfig = { ...baseCfg, fundingRate8h: 0.01 };
    // entryTs 7.5h, exitTs 8.5h -> crosses 08:00 once -> funding 0.01 of notional.
    const H = 3_600_000;
    const t: TradeTapeEntry = { ...longTrade, entryTimestamp: 7 * H + 30 * M, exitTimestamp: 8 * H + 30 * M };
    const candles = [c(t.entryTimestamp, 100, 100, 100, 100), c(t.exitTimestamp, 100, 132, 99, 130)];
    const out = resolveTradeUnderLeverage(t, candles, cfg);
    // 1 + 1*10*(0.30 - 0.01) = 3.9
    expect(out.equityMultiplier).toBeCloseTo(3.9, 9);
  });
});
