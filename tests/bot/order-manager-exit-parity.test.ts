/**
 * Characterization tests for OrderManager.checkPositionExit.
 *
 * These tests encode the CURRENT live exit behavior before the refactor that
 * delegates SL/TP resolution to DefaultFillModel. They must pass against the
 * unchanged code AND against the refactored code — any regression means the
 * delegation changed behavior.
 *
 * Cases:
 *   1. Long SL hit  (candle.low <= currentSL)          → stop_loss
 *   2. Short SL hit (candle.high >= currentSL)         → stop_loss
 *   3. Long TP hit  (candle.high >= takeProfit)        → take_profit
 *   4. Short TP hit (candle.low <= takeProfit)         → take_profit
 *   5. Straddle     (both SL and TP in bar range)      → stop_loss (SL wins — pessimistic floor)
 *   6. Max bars     (barsHeld >= maxBars, no SL/TP)    → max_bars
 *   7. No exit      (quiet bar, below maxBars)         → null
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OrderManager } from '@/lib/bot/order-manager';
import { RUN20_STRATEGY_CONFIG } from '@/lib/bot/config';
import { makeLongSignal } from '@/lib/bot/__fixtures__/candles';
import type { BotPosition, BotSymbol, ExitReason } from '@/types/bot';
import type { ScoredSignal } from '@/lib/rl/strategies/confluence-scorer';

const BASE_MS = 1_704_067_200_000; // 2024-01-01T00:00:00Z
const SYMBOL: BotSymbol = 'BTCUSDT';

/** Build a minimal candle. */
function bar(
  opts: { open?: number; high: number; low: number; close?: number },
  ts = BASE_MS + 3_600_000,
) {
  return {
    timestamp: ts,
    open: opts.open ?? (opts.high + opts.low) / 2,
    high: opts.high,
    low: opts.low,
    close: opts.close ?? (opts.high + opts.low) / 2,
    volume: 1_000,
  };
}

/** Create an open long position with known levels and no friction (live mode). */
function makeLongPosition(
  om: OrderManager,
  params: { entry: number; sl: number; tp: number; entryBarIndex?: number },
): BotPosition {
  const signal = makeLongSignal({
    entryPrice: params.entry,
    stopLoss: params.sl,
    takeProfit: params.tp,
  });
  // live mode: no slippage adjustments so position.entryPrice === params.entry
  const position = om.openPosition(
    signal as unknown as ScoredSignal,
    SYMBOL,
    10_000,
    0.003,
    params.entryBarIndex ?? 0,
  );
  if (!position) throw new Error('openPosition returned null — check test params');
  return position;
}

/** Create an open short position using a mirrored signal. */
function makeShortPosition(
  om: OrderManager,
  params: { entry: number; sl: number; tp: number; entryBarIndex?: number },
): BotPosition {
  // Wrap a short signal manually — same shape as makeLongSignal but direction='short'
  const signal = {
    signal: {
      direction: 'short' as const,
      entryPrice: params.entry,
      stopLoss: params.sl,
      takeProfit: params.tp,
      strategy: 'order_block',
    },
    totalScore: 6.5,
    factorBreakdown: { obProximity: 2.7, recentBOS: 2.2 },
  };
  const position = om.openPosition(
    signal as unknown as ScoredSignal,
    SYMBOL,
    10_000,
    0.003,
    params.entryBarIndex ?? 0,
  );
  if (!position) throw new Error('openPosition returned null — check short test params');
  return position;
}

describe('OrderManager.checkPositionExit — characterization (parity)', () => {
  let om: OrderManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_MS);
    // 'live' mode: no slippage so entry/exit prices are deterministic
    om = new OrderManager('live', RUN20_STRATEGY_CONFIG);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Case 1: Long SL hit ───────────────────────────────────────────────────
  it('LONG — SL hit (candle.low <= currentSL) → stop_loss at currentSL', () => {
    // entry=100, sl=95, tp=110
    const pos = makeLongPosition(om, { entry: 100, sl: 95, tp: 110 });
    // bar whose low touches the SL exactly
    const slBar = bar({ high: 99, low: 95 });

    const result = om.checkPositionExit(pos, slBar, 1);
    expect(result).not.toBeNull();
    expect(result!.exitReason).toBe<ExitReason>('stop_loss');
    expect(result!.position.exitPrice).toBe(95);
    expect(result!.position.status).toBe('closed');
  });

  it('LONG — SL hit (candle.low < currentSL) → stop_loss', () => {
    const pos = makeLongPosition(om, { entry: 100, sl: 95, tp: 110 });
    // bar whose low goes below the SL
    const slBar = bar({ high: 99, low: 90 });

    const result = om.checkPositionExit(pos, slBar, 1);
    expect(result).not.toBeNull();
    expect(result!.exitReason).toBe<ExitReason>('stop_loss');
  });

  // ─── Case 2: Short SL hit ─────────────────────────────────────────────────
  it('SHORT — SL hit (candle.high >= currentSL) → stop_loss at currentSL', () => {
    // entry=100, sl=105, tp=90
    const pos = makeShortPosition(om, { entry: 100, sl: 105, tp: 90 });
    // bar whose high touches the SL exactly
    const slBar = bar({ high: 105, low: 101 });

    const result = om.checkPositionExit(pos, slBar, 1);
    expect(result).not.toBeNull();
    expect(result!.exitReason).toBe<ExitReason>('stop_loss');
    expect(result!.position.exitPrice).toBe(105);
    expect(result!.position.status).toBe('closed');
  });

  it('SHORT — SL hit (candle.high > currentSL) → stop_loss', () => {
    const pos = makeShortPosition(om, { entry: 100, sl: 105, tp: 90 });
    const slBar = bar({ high: 110, low: 101 });

    const result = om.checkPositionExit(pos, slBar, 1);
    expect(result).not.toBeNull();
    expect(result!.exitReason).toBe<ExitReason>('stop_loss');
  });

  // ─── Case 3: Long TP hit ──────────────────────────────────────────────────
  it('LONG — TP hit (candle.high >= takeProfit) → take_profit at takeProfit', () => {
    const pos = makeLongPosition(om, { entry: 100, sl: 95, tp: 110 });
    const tpBar = bar({ high: 110, low: 101 });

    const result = om.checkPositionExit(pos, tpBar, 1);
    expect(result).not.toBeNull();
    expect(result!.exitReason).toBe<ExitReason>('take_profit');
    expect(result!.position.exitPrice).toBe(110);
    expect(result!.position.status).toBe('closed');
  });

  it('LONG — TP hit (candle.high > takeProfit) → take_profit', () => {
    const pos = makeLongPosition(om, { entry: 100, sl: 95, tp: 110 });
    const tpBar = bar({ high: 115, low: 101 });

    const result = om.checkPositionExit(pos, tpBar, 1);
    expect(result).not.toBeNull();
    expect(result!.exitReason).toBe<ExitReason>('take_profit');
  });

  // ─── Case 4: Short TP hit ─────────────────────────────────────────────────
  it('SHORT — TP hit (candle.low <= takeProfit) → take_profit at takeProfit', () => {
    const pos = makeShortPosition(om, { entry: 100, sl: 105, tp: 90 });
    const tpBar = bar({ high: 99, low: 90 });

    const result = om.checkPositionExit(pos, tpBar, 1);
    expect(result).not.toBeNull();
    expect(result!.exitReason).toBe<ExitReason>('take_profit');
    expect(result!.position.exitPrice).toBe(90);
    expect(result!.position.status).toBe('closed');
  });

  it('SHORT — TP hit (candle.low < takeProfit) → take_profit', () => {
    const pos = makeShortPosition(om, { entry: 100, sl: 105, tp: 90 });
    const tpBar = bar({ high: 99, low: 85 });

    const result = om.checkPositionExit(pos, tpBar, 1);
    expect(result).not.toBeNull();
    expect(result!.exitReason).toBe<ExitReason>('take_profit');
  });

  // ─── Case 5: Straddle — SL wins (pessimistic floor) ──────────────────────
  it('LONG — straddle (both SL and TP in bar range) → stop_loss wins', () => {
    // entry=100, sl=95, tp=110; bar goes from 90 to 115 — hits both levels
    const pos = makeLongPosition(om, { entry: 100, sl: 95, tp: 110 });
    const straddleBar = bar({ high: 115, low: 90 });

    const result = om.checkPositionExit(pos, straddleBar, 1);
    expect(result).not.toBeNull();
    expect(result!.exitReason).toBe<ExitReason>('stop_loss');
    expect(result!.position.exitPrice).toBe(95); // SL level, not TP
  });

  it('SHORT — straddle (both SL and TP in bar range) → stop_loss wins', () => {
    // entry=100, sl=105, tp=90; bar from 85 to 110 — hits both
    const pos = makeShortPosition(om, { entry: 100, sl: 105, tp: 90 });
    const straddleBar = bar({ high: 110, low: 85 });

    const result = om.checkPositionExit(pos, straddleBar, 1);
    expect(result).not.toBeNull();
    expect(result!.exitReason).toBe<ExitReason>('stop_loss');
    expect(result!.position.exitPrice).toBe(105); // SL level, not TP
  });

  // ─── Case 6: Max bars time exit ───────────────────────────────────────────
  it('LONG — maxBars reached, no SL/TP hit → max_bars at close', () => {
    const maxBars = RUN20_STRATEGY_CONFIG.maxBars; // typically 160
    const pos = makeLongPosition(om, {
      entry: 100,
      sl: 90,
      tp: 120,
      entryBarIndex: 0,
    });
    // quiet bar — no SL/TP
    const quietBar = bar({ high: 101, low: 99, close: 100.5 });

    const result = om.checkPositionExit(pos, quietBar, maxBars);
    expect(result).not.toBeNull();
    expect(result!.exitReason).toBe<ExitReason>('max_bars');
    expect(result!.position.exitPrice).toBe(100.5); // exit at close
  });

  it('SHORT — maxBars reached, no SL/TP hit → max_bars at close', () => {
    const maxBars = RUN20_STRATEGY_CONFIG.maxBars;
    const pos = makeShortPosition(om, {
      entry: 100,
      sl: 110,
      tp: 80,
      entryBarIndex: 0,
    });
    const quietBar = bar({ high: 101, low: 99, close: 100.5 });

    const result = om.checkPositionExit(pos, quietBar, maxBars);
    expect(result).not.toBeNull();
    expect(result!.exitReason).toBe<ExitReason>('max_bars');
  });

  // ─── Case 7: No exit ──────────────────────────────────────────────────────
  it('LONG — quiet bar, below maxBars → null (position remains open)', () => {
    const pos = makeLongPosition(om, { entry: 100, sl: 90, tp: 120 });
    // bar that touches neither SL nor TP
    const quietBar = bar({ high: 105, low: 96 });

    const result = om.checkPositionExit(pos, quietBar, 1);
    expect(result).toBeNull();
  });

  it('SHORT — quiet bar, below maxBars → null (position remains open)', () => {
    const pos = makeShortPosition(om, { entry: 100, sl: 110, tp: 80 });
    const quietBar = bar({ high: 105, low: 95 });

    const result = om.checkPositionExit(pos, quietBar, 1);
    expect(result).toBeNull();
  });

  // ─── Case 8: SL NOT hit (bar.low just above SL for long) ─────────────────
  it('LONG — bar.low just above SL → no exit (boundary: low > SL)', () => {
    const pos = makeLongPosition(om, { entry: 100, sl: 95, tp: 110 });
    // low = 95.01 — just above SL, should NOT trigger
    const nearMissBar = bar({ high: 99, low: 95.01 });

    const result = om.checkPositionExit(pos, nearMissBar, 1);
    expect(result).toBeNull();
  });

  it('SHORT — bar.high just below SL → no exit (boundary: high < SL)', () => {
    const pos = makeShortPosition(om, { entry: 100, sl: 105, tp: 90 });
    // high = 104.99 — just below SL, should NOT trigger
    const nearMissBar = bar({ high: 104.99, low: 101 });

    const result = om.checkPositionExit(pos, nearMissBar, 1);
    expect(result).toBeNull();
  });

  // ─── Case 9: maxBars - 1 should NOT exit ─────────────────────────────────
  it('LONG — barsHeld one below maxBars, quiet bar → null', () => {
    const maxBars = RUN20_STRATEGY_CONFIG.maxBars;
    const pos = makeLongPosition(om, { entry: 100, sl: 90, tp: 120, entryBarIndex: 0 });
    const quietBar = bar({ high: 101, low: 99 });

    // currentBarIndex = maxBars - 1 → barsHeld = maxBars - 1 (not yet at limit)
    const result = om.checkPositionExit(pos, quietBar, maxBars - 1);
    expect(result).toBeNull();
  });
});
