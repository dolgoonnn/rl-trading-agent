/**
 * reconcile-partial.test.ts — TDD for replayLiveRow (Cycles 2+3)
 *
 * Cycle 2: partial-TP blend parity — replayLiveRow produces the correct blended
 *          netReturn when replaying an order_block trade with partial TP.
 * Cycle 3: barsHeld parity — simBarsHeld resolves to the FINAL exit bar index.
 *
 * Synthetic scenario (long, friction=0):
 *   entry=100, stopLoss=99 (rawRisk=1.0), takeProfit=110
 *   candle[0] = entry bar (not checked for exits)
 *   candle[1] = partial-TP trigger: close=101.50 (unrealizedR=1.50 > triggerR=1.41);
 *               Note: using 101.50 instead of 101.41 to avoid floating-point boundary
 *               issues with the exact >= comparison (JS: 101.41-100=1.4099...966 < 1.41).
 *               low=100.5, high=109 — SL/TP NOT hit on the bar OHLC first
 *               (low > 99, high < 110), so pessimistic fill does NOT exit on SL/TP.
 *   candle[2] = remainder SL exit: low=100.10 (<= BE stop 100.20) so mutableSL 100.20
 *               is crossed; high=105, close=104 — close > BE stop so pessimistic close
 *               does not trigger. The exit is at mutableSL=100.20 via resolveExit(bar).
 *
 * Derived expected blend (friction=0):
 *   partialPnl     = (101.50 - 100) / 100 = 0.0150
 *   remainderPnl   = (100.20 - 100) / 100 = 0.002       (BE stop = adjustedEntry + rawRisk*0.20)
 *   expected       = 0.5 * 0.0150 + 0.5 * 0.002 = 0.0085 (funding=0)
 *
 * CONTRAST: simple exit config replays the same scenario and produces a different
 *   netReturn (>50 bps divergence), documenting the pre-fix bug.
 */

import { describe, it, expect } from 'vitest';
import { replayLiveRow, replayTrade } from '@/lib/sim/reconcile';
import { DefaultFillModel } from '@/lib/sim/fill-model';
import { FlatFrictionCostModel } from '@/lib/sim/cost-model';
import type { BotTradeRow } from '@/lib/data/schema';
import type { Candle } from '@/types/candle';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCandle(overrides: Partial<Candle> & { timestamp: number; close: number }): Candle {
  return {
    open: overrides.close,
    high: overrides.high ?? overrides.close,
    low: overrides.low ?? overrides.close,
    volume: 1000,
    ...overrides,
  };
}

/**
 * Factory for BotTradeRow — fills every required schema field with typed dummy
 * values. Provide only the fields relevant to the test scenario.
 * NO `as any` — every field is explicitly typed.
 */
function makeRow(overrides: Partial<BotTradeRow> & Pick<BotTradeRow, 'entryTimestamp' | 'exitTimestamp' | 'direction' | 'entryPrice' | 'stopLoss' | 'takeProfit' | 'strategy'>): BotTradeRow {
  const base: BotTradeRow = {
    id: 'test-trade-1',
    symbol: 'BTCUSDT',
    direction: overrides.direction,
    entryPrice: overrides.entryPrice,
    exitPrice: overrides.exitPrice ?? overrides.takeProfit,
    entryTimestamp: overrides.entryTimestamp,
    exitTimestamp: overrides.exitTimestamp,
    stopLoss: overrides.stopLoss,
    takeProfit: overrides.takeProfit,
    positionSizeUSDT: 1000,
    riskAmountUSDT: 10,
    strategy: overrides.strategy,
    confluenceScore: 5.0,
    factorBreakdown: '{}',
    regime: 'uptrend+normal',
    exitReason: 'stop_loss',
    barsHeld: 2,
    pnlPercent: 0,
    pnlUSDT: 0,
    equityAfter: 1000,
    drawdownFromPeak: 0,
    grossReturn: 0,
    frictionReturn: 0,
    fundingReturn: 0,
    netReturn: 0,
    fundingPaidUsdt: 0,
    createdAt: Date.now(),
  };
  return { ...base, ...overrides };
}

// ─── Synthetic scenario constants ─────────────────────────────────────────────

const ENTRY_PRICE = 100;
const STOP_LOSS = 99;    // rawRisk = 1.0
const TAKE_PROFIT = 110;

// BE stop after partial: adjustedEntry (friction=0 → 100) + rawRisk * beBuffer = 100 + 1.0 * 0.20 = 100.20
const BE_STOP = 100.20;

// candle[0] = entry bar (timestamp 0), irrelevant to exit checking (startIndex+1 skips it)
// candle[1] = partial trigger: close=101.50 (unrealizedR=1.50 > 1.41), low=100.5 (> SL 99), high=109 (< TP 110)
// candle[2] = BE stop hit: low=100.10 (< BE_STOP 100.20), high=105, close=104
const candles: Candle[] = [
  makeCandle({ timestamp: 0, open: 100, high: 101, low: 99.5, close: 100, volume: 1000 }),
  makeCandle({ timestamp: 3_600_000, open: 100.5, high: 109, low: 100.5, close: 101.50, volume: 1000 }),
  makeCandle({ timestamp: 7_200_000, open: 102, high: 105, low: 100.10, close: 104, volume: 1000 }),
];

// The row: strategy=order_block so resolveSimConfig returns the partial_tp config.
// entryTimestamp=0 so findIndex finds candle[0] (startIndex=0); simulation starts at startIndex+1.
const row: BotTradeRow = makeRow({
  direction: 'long',
  entryPrice: ENTRY_PRICE,
  stopLoss: STOP_LOSS,
  takeProfit: TAKE_PROFIT,
  strategy: 'order_block',
  entryTimestamp: 0,
  exitTimestamp: 7_200_000,
});

const fillModel = new DefaultFillModel(new FlatFrictionCostModel(0));

// ─── Derived expected values ──────────────────────────────────────────────────

// partialPnl: at candle[1] close=101.50, friction=0 → adjEntry=100, adjPartialExit=101.50
// Note: close=101.50 chosen strictly above triggerR=1.41 to avoid fp boundary issues
const partialClose = 101.50;
const partialPnl = (partialClose - ENTRY_PRICE) / ENTRY_PRICE; // 0.0150

// remainderPnl: SL moved to BE_STOP=100.20; candle[2] low=100.10 < 100.20 → pessimistic exits at 100.20
const remainderPnl = (BE_STOP - ENTRY_PRICE) / ENTRY_PRICE;   // 0.002

// blended: fraction=0.50
const EXPECTED_NET = 0.5 * partialPnl + 0.5 * remainderPnl;   // 0.0085

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('reconcile-partial: replayLiveRow (Cycles 2+3)', () => {
  describe('Cycle 2 — partial-TP blend parity', () => {
    it('replayLiveRow returns blended netReturn matching first-principles derivation (within 1e-9)', () => {
      const result = replayLiveRow(row, candles, fillModel);
      expect(result).not.toBeNull();
      expect(result!.netReturn).toBeCloseTo(EXPECTED_NET, 9);
    });

    it('CONTRAST: replayTrade with simple config diverges by >50 bps (documents pre-fix bug)', () => {
      const simpleConfig = {
        entryTiming: 'signal_close' as const,
        maxBars: 160,
        barMs: 3_600_000,
        exitMode: 'simple' as const,
      };
      const simpleResult = replayTrade(row, candles, fillModel, simpleConfig);
      expect(simpleResult).not.toBeNull();
      // The simple config does not blend partial TP — the diff must be >50bps
      expect(Math.abs(simpleResult!.netReturn - EXPECTED_NET)).toBeGreaterThan(0.005);
    });
  });

  describe('Cycle 3 — barsHeld parity', () => {
    it('simBarsHeld derived from timestamps equals the bar index of the final (remainder) exit', () => {
      const result = replayLiveRow(row, candles, fillModel);
      expect(result).not.toBeNull();

      const barMs = 3_600_000;
      const simBarsHeld = Math.round((result!.exitTimestamp - result!.entryTimestamp) / barMs);

      // The remainder exits at candle[2] (index 2 in the candles array, bar #2 from entry).
      // entryTimestamp=0, exitTimestamp=7_200_000, barMs=3_600_000 → barsHeld = 2
      expect(simBarsHeld).toBe(2);
    });
  });
});
