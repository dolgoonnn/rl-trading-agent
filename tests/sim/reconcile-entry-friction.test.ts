/**
 * reconcile-entry-friction.test.ts — TDD for entry-friction double-count fix (Cycle 4)
 *
 * Root cause: bot_trades.entry_price stores the already-slipped fill
 * (e.g. long at raw 100 with f=0.0007 → stored as 100.07). The old
 * replayLiveRow passed that directly as position.entryPrice, causing
 * simulatePosition to apply entry friction AGAIN: 100.07 * (1+f) = 100.1400...
 * instead of 100.07. That systematic +7 bps error is what this fix eliminates.
 *
 * Fix: replayLiveRow now accepts frictionPerSide and un-slips entry_price
 * before handing it to replayTrade so the sim reproduces the correct fill:
 *   long:  rawEntry = row.entryPrice / (1 + f)
 *   short: rawEntry = row.entryPrice / (1 - f)
 * The sim then re-applies entry friction → entry fill = row.entryPrice. ✓
 *
 * Scenario (long, f=0.0007, order_block strategy → partial_tp config):
 *   rawEntry   = 100           (what we pass to sim after un-slip)
 *   entryFill  = 100.07        (what row.entryPrice stores; the bot's actual fill)
 *   SL=99, TP=110 (RAW levels)
 *
 *   candle[0] = entry bar, skipped for exit checking
 *   candle[1] = SL hit: low=98.5 (<= SL 99), high=101, close=100
 *               (SL/TP check runs first in simulator, before partial TP;
 *                low=98.5 is well below SL=99 → pessimistic exits at SL=99)
 *
 * Expected net (FIXED — entry fill = 100.07, NOT 100.07*(1+f)):
 *   adjustedEntry   = 100.07
 *   adjExit         = 99 * (1 - f) = 99 * 0.9993 = 98.9307  (taker)
 *   netReturn       = (98.9307 - 100.07) / 100.07
 *
 * GUARD (OLD behavior — entry fill = 100.07*(1+f) — double-counted):
 *   adjustedEntry   = 100.07 * (1+f) = 100.1400...
 *   adjExit         = same (98.9307)
 *   netReturn       = (98.9307 - 100.1400...) / 100.1400...
 *   delta from fixed ≈ 6.9 bps (f ≈ 7 bps systematic over-charge)
 */

import { describe, it, expect } from 'vitest';
import { replayLiveRow, replayTrade } from '@/lib/sim/reconcile';
import { DefaultFillModel } from '@/lib/sim/fill-model';
import { FlatFrictionCostModel } from '@/lib/sim/cost-model';
import { resolveSimConfig } from '@/lib/sim/resolve-config';
import type { BotTradeRow } from '@/lib/data/schema';
import type { Candle } from '@/types/candle';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCandle(overrides: Partial<Candle> & { timestamp: number; close: number }): Candle {
  return {
    open: overrides.open ?? overrides.close,
    high: overrides.high ?? overrides.close,
    low: overrides.low ?? overrides.close,
    volume: 1000,
    ...overrides,
  };
}

function makeRow(
  overrides: Partial<BotTradeRow> & Pick<BotTradeRow, 'entryTimestamp' | 'exitTimestamp' | 'direction' | 'entryPrice' | 'stopLoss' | 'takeProfit' | 'strategy'>,
): BotTradeRow {
  const base: BotTradeRow = {
    id: 'friction-test-1',
    symbol: 'BTCUSDT',
    direction: overrides.direction,
    entryPrice: overrides.entryPrice,
    exitPrice: overrides.exitPrice ?? overrides.entryPrice,
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
    barsHeld: 1,
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

// ─── Constants ───────────────────────────────────────────────────────────────

const F = 0.0007;  // frictionPerSide — matches bot deployed value

// The bot stored entryPrice = rawEntry * (1+F) for a long
const RAW_ENTRY = 100;
const STORED_ENTRY = RAW_ENTRY * (1 + F);  // = 100.07 — what's in bot_trades.entry_price

const STOP_LOSS = 99;      // raw level
const TAKE_PROFIT = 110;   // raw level

// FIXED expected net (first principles, entry fill = 100.07):
//   adjustedEntry = 100.07 (the sim re-applies friction on rawEntry=100 → same 100.07)
//   adjExit = 99 * (1 - F) = 98.9307 (taker exit friction on SL hit)
//   netReturn = (adjExit - adjustedEntry) / adjustedEntry
const ADJUSTED_ENTRY = RAW_ENTRY * (1 + F);                      // 100.07
const ADJ_EXIT = STOP_LOSS * (1 - F);                            // 98.9307
const EXPECTED_NET = (ADJ_EXIT - ADJUSTED_ENTRY) / ADJUSTED_ENTRY; // ≈ -0.01138...

// candle[0]: entry bar (timestamp 0, not checked for exits)
// candle[1]: SL hit — low=98.5 (<= SL 99), sim exits pessimistically at SL=99
//            high=101 and close=100 are well within SL/TP range to avoid ambiguity
const candles: Candle[] = [
  makeCandle({ timestamp: 0, open: 100, high: 101, low: 99.5, close: 100 }),
  makeCandle({ timestamp: 3_600_000, open: 100.5, high: 101, low: 98.5, close: 100 }),
];

// Row: strategy=order_block (partial_tp config); entryPrice is the ALREADY-SLIPPED fill
const row: BotTradeRow = makeRow({
  direction: 'long',
  entryPrice: STORED_ENTRY,  // 100.07 — as written by order-manager.ts:155
  stopLoss: STOP_LOSS,
  takeProfit: TAKE_PROFIT,
  strategy: 'order_block',   // resolveSimConfig → partial_tp config
  entryTimestamp: 0,
  exitTimestamp: 3_600_000,
});

const fillModel = new DefaultFillModel(new FlatFrictionCostModel(F));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('reconcile-entry-friction: un-slip recorded entry fill (Cycle 4)', () => {
  it('FIXED: replayLiveRow(row, candles, fillModel, frictionPerSide) produces expectedNet within 1e-9', () => {
    const result = replayLiveRow(row, candles, fillModel, F);
    expect(result).not.toBeNull();
    // First-principles expected: entry fill=100.07, exit fill=99*(1-F)=98.9307
    expect(result!.netReturn).toBeCloseTo(EXPECTED_NET, 9);
  });

  it('GUARD: old behavior (no un-slip) diverges from expectedNet by ≈ frictionPerSide (~7 bps)', () => {
    // Simulate OLD behavior: call replayTrade directly with the un-corrected row
    // (position.entryPrice = STORED_ENTRY = 100.07). The sim applies friction again:
    // adjustedEntry = 100.07 * (1+F) = 100.1400... → double-counted entry friction.
    const oldResult = replayTrade(row, candles, fillModel, resolveSimConfig('order_block'));
    expect(oldResult).not.toBeNull();

    const delta = Math.abs(oldResult!.netReturn - EXPECTED_NET);
    // The systematic error ≈ frictionPerSide (7 bps). Bounds: 3–15 bps to be robust to
    // blended-position math, while ruling out accidental pass (< 1 bp).
    expect(delta).toBeGreaterThan(0.0003);   // must diverge by at least 3 bps
    expect(delta).toBeLessThan(0.0015);      // but not explode beyond 15 bps
  });

  it('exitReason is stop_loss (candles are designed for unambiguous SL exit)', () => {
    const result = replayLiveRow(row, candles, fillModel, F);
    expect(result).not.toBeNull();
    expect(result!.exitReason).toBe('stop_loss');
  });
});
