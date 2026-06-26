/**
 * TDD: Task 5 — leverage sweep core
 *
 * Synthetic fixture: 3 symbols, price paths crafted so:
 *   - At L=1 nothing liquidates (liqAdverseMove = 1/1 - mmr ~ 0.995, essentially infinite buffer)
 *   - At L=50 (liqAdverseMove = 1/50 - 0.005 = 0.015) an early adverse bar pierces the
 *     liq price for at least one position.
 *
 * Asserts:
 *   1. liqRate is NON-DECREASING as L increases.
 *   2. At the lowest L, liqRate === 0 and terminalWealth reflects non-liquidated compounding.
 *   3. At a high enough L, at least one position liquidates (liqRate > 0) and blown/maxDD behave.
 *   4. Each row's trades count equals the resolvable position count (3 here).
 */
import { describe, it, expect } from 'vitest';
import type { Candle } from '@/types/candle';
import type { SimPosition } from '@/lib/sim/types';
import { sweepLeverage } from '@/lib/sim/leverage-sweep-core';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function c(ts: number, o: number, h: number, l: number, cl: number): Candle {
  return { timestamp: ts, open: o, high: h, low: l, close: cl, volume: 1 };
}

const BAR_MS = 3_600_000;

/**
 * Build a position that:
 *   - Is a LONG entry at `entry`
 *   - Has SL at `entry * (1 - 0.03)` (3% stop, well outside liq at moderate L)
 *   - Has TP at `entry * 1.06` (6%, 2R)
 *   - entryTimestamp = ts0, entryIndex = 0
 */
function makeLongPosition(entry: number, ts0: number): SimPosition {
  return {
    direction: 'long',
    entryPrice: entry,
    entryTimestamp: ts0,
    entryIndex: 0,
    stopLoss: entry * 0.97,
    takeProfit: entry * 1.06,
    strategy: 'ob',
  };
}

/**
 * Build a candle array for a position that:
 *   - Bar 0 (entry bar, ts = ts0): neutral — low stays above liq at L=50 (d=0.015).
 *     low = entry * 0.986  (inside liq at L=50: liq = entry*(1-0.015) = entry*0.985)
 *     → at L=50 this bar will NOT trigger liquidation.
 *   - Bar 1 (ts = ts0 + BAR_MS): adverse — low = entry * 0.984.
 *     → at L=50 liq = entry*0.985 > entry*0.984 → LIQUIDATES.
 *     → at L=1  liq ≈ entry*0.005 (way below) → DOES NOT liquidate.
 *   - Bar 2 onward: price recovers and hits TP for non-liquidated positions.
 */
function makeCandlesForLiqTest(entry: number, ts0: number): Candle[] {
  return [
    // bar 0: entry bar, low above liq@L50 (entry*0.985)
    c(ts0, entry, entry * 1.005, entry * 0.986, entry * 1.001),
    // bar 1: adverse — low = entry*0.984, below liq@L50 (0.985) but above SL (0.97)
    c(ts0 + BAR_MS, entry, entry * 1.002, entry * 0.984, entry * 0.999),
    // bar 2: recovers — close at TP target
    c(ts0 + 2 * BAR_MS, entry * 1.0, entry * 1.07, entry * 0.99, entry * 1.06),
    // bar 3: extra bar to avoid run-out
    c(ts0 + 3 * BAR_MS, entry * 1.06, entry * 1.08, entry * 1.05, entry * 1.065),
  ];
}

// ---------------------------------------------------------------------------
// Shared sweep opts
// ---------------------------------------------------------------------------
const SWEEP_OPTS = {
  f: 0.1,
  mmr: 0.005,
  liqFeeFrac: 0.005,
  friction: 0.0,          // zero friction for predictable math
  partialTP: { fraction: 0.50, triggerR: 1.41, beBuffer: 0.20 },
  maxBars: 160,
} as const;

// 3 synthetic symbols, each with one position
const TS0 = 1_700_000_000_000; // arbitrary Unix ms
const ENTRIES = [100, 200, 50] as const;

const FIXTURE = ENTRIES.map((entry, i) => ({
  symbol: `SYM${i}`,
  position: makeLongPosition(entry, TS0),
  candles: makeCandlesForLiqTest(entry, TS0),
}));

// Sweep at three leverage levels: 1, 5, 50
const LEVERAGES = [1, 5, 50];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sweepLeverage — pure core', () => {
  let rows: ReturnType<typeof sweepLeverage>;

  it('returns one row per leverage level', () => {
    rows = sweepLeverage(FIXTURE, { leverages: LEVERAGES, ...SWEEP_OPTS });
    expect(rows).toHaveLength(LEVERAGES.length);
  });

  it('rows are in the same order as the input leverage array', () => {
    rows = sweepLeverage(FIXTURE, { leverages: LEVERAGES, ...SWEEP_OPTS });
    expect(rows.map((r) => r.leverage)).toEqual(LEVERAGES);
  });

  it('each row.trades equals the number of resolvable positions (3)', () => {
    rows = sweepLeverage(FIXTURE, { leverages: LEVERAGES, ...SWEEP_OPTS });
    for (const row of rows) {
      expect(row.trades).toBe(3);
    }
  });

  it('at L=1, liqRate === 0 (liquidation buffer is ~99.5%)', () => {
    rows = sweepLeverage(FIXTURE, { leverages: LEVERAGES, ...SWEEP_OPTS });
    const l1 = rows.find((r) => r.leverage === 1);
    expect(l1).toBeDefined();
    expect(l1!.liqRate).toBe(0);
  });

  it('at L=1, terminalWealth > 1 (positions recover and hit TP)', () => {
    rows = sweepLeverage(FIXTURE, { leverages: LEVERAGES, ...SWEEP_OPTS });
    const l1 = rows.find((r) => r.leverage === 1);
    expect(l1!.terminalWealth).toBeGreaterThan(1);
  });

  it('at L=50, at least one position liquidates (liqRate > 0)', () => {
    rows = sweepLeverage(FIXTURE, { leverages: LEVERAGES, ...SWEEP_OPTS });
    const l50 = rows.find((r) => r.leverage === 50);
    expect(l50).toBeDefined();
    expect(l50!.liqRate).toBeGreaterThan(0);
  });

  it('liqRate is NON-DECREASING as L increases', () => {
    rows = sweepLeverage(FIXTURE, { leverages: LEVERAGES, ...SWEEP_OPTS });
    for (let i = 0; i < rows.length - 1; i++) {
      expect(rows[i + 1]!.liqRate).toBeGreaterThanOrEqual(rows[i]!.liqRate);
    }
  });

  it('maxDD at L=50 >= maxDD at L=1 (more leverage → at least as much drawdown)', () => {
    rows = sweepLeverage(FIXTURE, { leverages: LEVERAGES, ...SWEEP_OPTS });
    const l1 = rows.find((r) => r.leverage === 1)!;
    const l50 = rows.find((r) => r.leverage === 50)!;
    expect(l50.maxDD).toBeGreaterThanOrEqual(l1.maxDD);
  });

  it('blown is false at L=1 (no ruin)', () => {
    rows = sweepLeverage(FIXTURE, { leverages: LEVERAGES, ...SWEEP_OPTS });
    const l1 = rows.find((r) => r.leverage === 1)!;
    expect(l1.blown).toBe(false);
  });

  it('sharpe is a finite number for each row', () => {
    rows = sweepLeverage(FIXTURE, { leverages: LEVERAGES, ...SWEEP_OPTS });
    for (const row of rows) {
      expect(Number.isFinite(row.sharpe)).toBe(true);
    }
  });

  it('L=1 terminalWealth matches hand-computed non-levered compounding', () => {
    /**
     * At L=1 (zero friction):
     *   Each position is long, entry at `entry`, TP at entry*1.06.
     *   Bar 1 low = entry*0.984 > SL (entry*0.97) AND above liqPrice@L=1 (tiny).
     *   Bar 2 close = entry*1.06 → hits TP exactly.
     *   grossReturn for each position (no partial_tp trigger in 2 bars with triggerR=1.41):
     *     actually bar 2 close IS the TP, so we exit at TP.
     *   exitReason = take_profit, exitPrice = entry*1.06 (zero friction).
     *   grossReturn = (entry*1.06 - entry) / entry = 0.06
     *   netReturn = 0.06 (no funding in test).
     *
     * With buildLeverageEquityCurve(trades, {leverage:1, f:0.1, mmr:0.005, liqFeeFrac:0.005}):
     *   eNext = E * (1 + 1 * 0.1 * 0.06) = E * 1.006  for each of 3 trades.
     *   terminalWealth = 1 * 1.006^3
     *
     * NOTE: partialTP trigger is at 1.41R. The candles only have 3 bars and the position
     * exits on bar 2 at TP (close=entry*1.06, which is 2R). The check is at bar close
     * BEFORE SL/TP, so partial may fire if unrealizedR ≥ 1.41R at close of bar 2.
     * But bar 2 close = 1.06 which IS exactly TP, so SL/TP check fires FIRST (before
     * the partial branch which checks the same bar close). The result is take_profit
     * with the full position.
     *
     * Actually: looking at simulator.ts order — SL/TP check FIRST, then partial.
     * Bar 2 (startIndex=1, loop starts i=1):
     *   i=1: bar1 — low=0.984*entry. SL check: low=0.984*entry vs effectiveStop=0.97*entry → NOT hit.
     *        TP check via resolveExit: low/high... pessimistic: high=entry*1.002, low=0.984*entry.
     *        TP=entry*1.06 is NOT inside [low, high] of bar1 → no fill.
     *        Partial: unrealizedR at bar1.close=0.999*entry relative to entry, rawRisk=0.03*entry.
     *        unrealizedR = (0.999*entry - entry) / (0.03*entry) = -0.001/0.03 = -0.033 < 1.41 → no partial.
     *   i=2: bar2 — open=entry, high=entry*1.07, low=entry*0.99, close=entry*1.06.
     *        SL check: low=0.99*entry > effectiveStop=0.97*entry → SL not hit.
     *        TP check (pessimistic): high=1.07*entry ≥ TP=1.06*entry → FILLED at TP.
     *        exitReason = take_profit, exitPrice = 1.06*entry (zero friction).
     *        grossReturn = 0.06, netReturn=0.06.
     *        Returns before partial branch.
     *
     * So each trade: netReturn=0.06, liquidated=false.
     * terminalWealth = 1.006^3
     */
    rows = sweepLeverage(FIXTURE, { leverages: [1], ...SWEEP_OPTS });
    const l1 = rows[0]!;
    const expected = Math.pow(1 + 1 * SWEEP_OPTS.f * 0.06, 3);
    expect(l1.terminalWealth).toBeCloseTo(expected, 6);
  });
});
