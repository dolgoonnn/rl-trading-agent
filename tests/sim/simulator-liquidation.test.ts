/**
 * TDD: Task 2 — liquidation flag in simulatePosition
 *
 * When config.leverage is set, the liquidation price competes as the adverse
 * stop. If liqPrice is CLOSER to entry than the strategy stop, the position
 * liquidates first. When config.leverage is UNSET, behavior is byte-identical
 * to today.
 */
import { describe, it, expect } from 'vitest';
import { simulatePosition } from '@/lib/sim/simulator';
import { DefaultFillModel } from '@/lib/sim/fill-model';
import { FlatFrictionCostModel } from '@/lib/sim/cost-model';
import type { SimConfig, SimPosition } from '@/lib/sim/types';
import type { Candle } from '@/types/candle';

const fm = new DefaultFillModel(new FlatFrictionCostModel(0));
const baseCfg: SimConfig = {
  entryTiming: 'signal_close',
  maxBars: 100,
  barMs: 3_600_000,
  exitMode: 'simple',
};

function c(ts: number, o: number, h: number, l: number, cl: number): Candle {
  return { timestamp: ts, open: o, high: h, low: l, close: cl, volume: 1 };
}

describe('simulatePosition — liquidation', () => {
  /**
   * Test 1: Liquidation BEFORE stop (high leverage).
   * long entry=100, stopLoss=99 (1% stop), TP=110.
   * leverage=100, mmr=0.005 -> d = 1/100 - 0.005 = 0.01 - 0.005 = 0.005
   * liqPrice = 100 * (1 - 0.005) = 99.5  (ABOVE the stop 99, i.e., closer to entry)
   * A bar whose low pierces 99.5 but not 99 would normally have continued.
   * With liqPrice as effectiveStop it should be caught and liquidated.
   */
  it('long: liquidation fires before stop when liqPrice is above the strategy stop', () => {
    const pos: SimPosition = {
      direction: 'long',
      entryPrice: 100,
      entryTimestamp: 0,
      entryIndex: 0,
      stopLoss: 99,
      takeProfit: 110,
      strategy: 'ob',
    };
    // bar 1: normal (open 100, high 101, low 99.8, close 100) — no touch
    // bar 2: low = 99.4, which is below liqPrice=99.5 but above stopLoss=99
    const candles = [
      c(0, 100, 101, 99.8, 100),
      c(3_600_000, 100, 101, 99.4, 100),
    ];
    const r = simulatePosition(pos, candles, 1, {
      fillModel: fm,
      config: { ...baseCfg, leverage: 100, mmr: 0.005 },
    });
    expect(r).not.toBeNull();
    expect(r!.liquidated).toBe(true);
    expect(r!.exitReason).toBe('liquidation');
    // exit price is liqPrice = 99.5 (zero friction)
    expect(r!.exitPrice).toBeCloseTo(99.5, 9);
  });

  /**
   * Test 2: Stop fires BEFORE liquidation (low leverage).
   * Same trade, leverage=20, mmr=0.005 -> d = 1/20 - 0.005 = 0.05 - 0.005 = 0.045
   * liqPrice = 100 * (1 - 0.045) = 95.5  (BELOW stop 99, i.e., farther from entry)
   * Bar low 99 hits the strategy stop — liquidation is not binding.
   */
  it('long: normal stop fires when liqPrice is below the strategy stop (low leverage)', () => {
    const pos: SimPosition = {
      direction: 'long',
      entryPrice: 100,
      entryTimestamp: 0,
      entryIndex: 0,
      stopLoss: 99,
      takeProfit: 110,
      strategy: 'ob',
    };
    // bar 1: low exactly hits 99 = strategy stop
    const candles = [
      c(0, 100, 101, 99.8, 100),
      c(3_600_000, 100, 101, 99, 100),
    ];
    const r = simulatePosition(pos, candles, 1, {
      fillModel: fm,
      config: { ...baseCfg, leverage: 20, mmr: 0.005 },
    });
    expect(r).not.toBeNull();
    expect(r!.liquidated).toBe(false);
    expect(r!.exitReason).toBe('stop_loss');
    expect(r!.exitPrice).toBeCloseTo(99, 9);
  });

  /**
   * Test 3: Short — symmetric liquidation.
   * entry=100, stopLoss=101 (1% stop), TP=90.
   * leverage=100, mmr=0.005 -> d = 0.005
   * liqPrice = 100 * (1 + 0.005) = 100.5  (BELOW stop 101, i.e., closer to entry for short)
   * Bar high 100.6 pierces liqPrice 100.5 but not stopLoss 101 -> liquidated.
   */
  it('short: liquidation fires before stop when liqPrice is below the strategy stop', () => {
    const pos: SimPosition = {
      direction: 'short',
      entryPrice: 100,
      entryTimestamp: 0,
      entryIndex: 0,
      stopLoss: 101,
      takeProfit: 90,
      strategy: 'ob',
    };
    // bar 1: normal — high 100.4, does not touch liqPrice=100.5
    // bar 2: high 100.6, which is above liqPrice=100.5 but below stop 101
    const candles = [
      c(0, 100, 100.4, 99.5, 100),
      c(3_600_000, 100, 100.6, 99.5, 100),
    ];
    const r = simulatePosition(pos, candles, 1, {
      fillModel: fm,
      config: { ...baseCfg, leverage: 100, mmr: 0.005 },
    });
    expect(r).not.toBeNull();
    expect(r!.liquidated).toBe(true);
    expect(r!.exitReason).toBe('liquidation');
    // exit price is liqPrice = 100.5 (zero friction)
    expect(r!.exitPrice).toBeCloseTo(100.5, 9);
  });

  /**
   * Test 4: Regression — no leverage configured.
   * Must produce byte-identical result to current behavior (same exitReason,
   * exit price, netReturn, and liquidated=false).
   */
  it('regression: no leverage → liquidated=false, same exit as before', () => {
    const pos: SimPosition = {
      direction: 'long',
      entryPrice: 100,
      entryTimestamp: 0,
      entryIndex: 0,
      stopLoss: 95,
      takeProfit: 120,
      strategy: 'ob',
    };
    // bar 1: low 94 hits stop at 95
    const candles = [
      c(0, 100, 101, 99, 100),
      c(3_600_000, 100, 101, 94, 100),
    ];
    const r = simulatePosition(pos, candles, 1, {
      fillModel: fm,
      config: baseCfg, // no leverage field
    });
    expect(r).not.toBeNull();
    expect(r!.liquidated).toBe(false);
    expect(r!.exitReason).toBe('stop_loss');
    expect(r!.exitPrice).toBeCloseTo(95, 9);
    expect(r!.netReturn).toBeCloseTo((95 - 100) / 100, 9); // -5%
  });
});
