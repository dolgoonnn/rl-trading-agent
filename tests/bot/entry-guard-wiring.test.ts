import { describe, it, expect } from 'vitest';
import { OrderManager } from '@/lib/bot/order-manager';
import { RUN20_STRATEGY_CONFIG, SAFETY_GATE_CONFIG } from '@/lib/bot/config';
import type { ScoredSignal } from '@/lib/rl/strategies/confluence-scorer';
import type { BotSymbol, OrderbookSnapshot, RejectReason } from '@/types/bot';

/**
 * Entry-guard WIRING — proves checkPreTradeGuards (mark collar + stale-candle +
 * crossed-candle) and the L2 tradeability gate ACTUALLY RUN inside
 * OrderManager.openPosition when the LIVE path supplies the extra inputs.
 *
 * Guard inputs are OPTIONAL: backtest/paper callers that omit `markGuard` and
 * `orderbook` are unaffected (the Run-20 edge measurement is unchanged). The
 * LIVE tick (run-bot processSymbol) fetches mark + orderbook + clock and passes
 * them, so the guards mechanically refuse pathological orders before they reach
 * the exchange.
 */

interface SkipRecord {
  symbol: BotSymbol;
  reason: RejectReason;
  signalEntry: number;
  score: number;
  detail?: unknown;
}

const SYMBOL: BotSymbol = 'BTCUSDT';
const ENTRY = 50_000;

function makeSignal(entry = ENTRY): ScoredSignal {
  // Long signal with a sane stop so computePositionSize itself passes; the
  // pre-trade / L2 guards are the only thing that can reject in these tests.
  return {
    signal: {
      strategy: 'order_block',
      direction: 'long',
      entryPrice: entry,
      stopLoss: entry * 0.99,
      takeProfit: entry * 1.03,
      riskReward: 3,
      confidence: 0.7,
      reasoning: [],
    },
    totalScore: 6.4,
    factorBreakdown: {},
  } as ScoredSignal;
}

/** A deep, tight book so L2 always passes; only the mark guard can reject. */
function goodBook(): OrderbookSnapshot {
  return {
    bid: ENTRY - 1,
    ask: ENTRY + 1,
    spreadBps: 1,
    bidDepthUsdt: 1_000_000,
    askDepthUsdt: 1_000_000,
  };
}

/** A healthy candle aligned with the mark/entry, fresh as of `nowMs`. */
function makeMarkGuard(overrides: Partial<{
  markPrice: number;
  candleHigh: number;
  candleLow: number;
  candleClose: number;
  candleCloseMs: number;
  nowMs: number;
}> = {}) {
  const nowMs = overrides.nowMs ?? 1_700_000_000_000;
  return {
    markPrice: overrides.markPrice ?? ENTRY,
    candleHigh: overrides.candleHigh ?? ENTRY + 100,
    candleLow: overrides.candleLow ?? ENTRY - 100,
    candleClose: overrides.candleClose ?? ENTRY,
    candleCloseMs: overrides.candleCloseMs ?? nowMs,
    nowMs,
  };
}

describe('OrderManager.openPosition — pre-trade guard wiring', () => {
  it('(a) rejects when signal entry deviates beyond maxDeviationBps from mark', () => {
    const skips: SkipRecord[] = [];
    const om = new OrderManager('paper', RUN20_STRATEGY_CONFIG, (i) => skips.push(i as SkipRecord));

    // Mark far below entry: deviation = |entry - mark|/mark > 50 bps.
    // entry 50_000 vs mark 49_000 → ~204 bps deviation.
    const pos = om.openPosition(makeSignal(), SYMBOL, 10_000, 0.003, 100, {
      orderbook: goodBook(),
      markGuard: makeMarkGuard({ markPrice: 49_000 }),
    });

    expect(pos).toBeNull();
    expect(skips).toHaveLength(1);
    expect(skips[0]!.reason).toBe<RejectReason>('mark_deviation');
    expect(skips[0]!.symbol).toBe(SYMBOL);
  });

  it('(b) rejects a stale candle (closeMs older than maxCandleAgeMs)', () => {
    const skips: SkipRecord[] = [];
    const om = new OrderManager('paper', RUN20_STRATEGY_CONFIG, (i) => skips.push(i as SkipRecord));

    const nowMs = 1_700_000_000_000;
    const pos = om.openPosition(makeSignal(), SYMBOL, 10_000, 0.003, 100, {
      orderbook: goodBook(),
      markGuard: makeMarkGuard({
        nowMs,
        // Candle closed > maxCandleAgeMs ago.
        candleCloseMs: nowMs - (SAFETY_GATE_CONFIG.maxCandleAgeMs + 1),
      }),
    });

    expect(pos).toBeNull();
    expect(skips).toHaveLength(1);
    expect(skips[0]!.reason).toBe<RejectReason>('stale_candle');
  });

  it('(c) rejects a crossed candle (high < low)', () => {
    const skips: SkipRecord[] = [];
    const om = new OrderManager('paper', RUN20_STRATEGY_CONFIG, (i) => skips.push(i as SkipRecord));

    const pos = om.openPosition(makeSignal(), SYMBOL, 10_000, 0.003, 100, {
      orderbook: goodBook(),
      markGuard: makeMarkGuard({ candleHigh: ENTRY - 200, candleLow: ENTRY - 100 }),
    });

    expect(pos).toBeNull();
    expect(skips).toHaveLength(1);
    expect(skips[0]!.reason).toBe<RejectReason>('crossed_candle');
  });

  it('(d) rejects a poor L2 book (wide spread)', () => {
    const skips: SkipRecord[] = [];
    const om = new OrderManager('paper', RUN20_STRATEGY_CONFIG, (i) => skips.push(i as SkipRecord));

    const pos = om.openPosition(makeSignal(), SYMBOL, 10_000, 0.003, 100, {
      orderbook: {
        bid: ENTRY - 1,
        ask: ENTRY + 1,
        spreadBps: 50, // wide → untradeable
        bidDepthUsdt: 1_000_000,
        askDepthUsdt: 1_000_000,
      },
      markGuard: makeMarkGuard(),
    });

    expect(pos).toBeNull();
    expect(skips).toHaveLength(1);
    expect(skips[0]!.reason).toBe<RejectReason>('l2_tradeability');
  });

  it('(d2) rejects a thin L2 book (insufficient depth)', () => {
    const skips: SkipRecord[] = [];
    const om = new OrderManager('paper', RUN20_STRATEGY_CONFIG, (i) => skips.push(i as SkipRecord));

    const pos = om.openPosition(makeSignal(), SYMBOL, 10_000, 0.003, 100, {
      orderbook: {
        bid: ENTRY - 1,
        ask: ENTRY + 1,
        spreadBps: 1, // tight — only depth is bad
        bidDepthUsdt: 1, // far below depthMultiple * intended notional
        askDepthUsdt: 1,
      },
      markGuard: makeMarkGuard(),
    });

    expect(pos).toBeNull();
    expect(skips).toHaveLength(1);
    expect(skips[0]!.reason).toBe<RejectReason>('l2_tradeability');
  });

  it('(e) opens normally for a healthy signal with good mark/candle/orderbook', () => {
    const skips: SkipRecord[] = [];
    const om = new OrderManager('paper', RUN20_STRATEGY_CONFIG, (i) => skips.push(i as SkipRecord));

    const pos = om.openPosition(makeSignal(), SYMBOL, 10_000, 0.003, 100, {
      orderbook: goodBook(),
      markGuard: makeMarkGuard(),
    });

    expect(pos).not.toBeNull();
    expect(skips).toHaveLength(0);
  });

  it('pre-trade guards run BEFORE the L2 gate (mark_deviation wins over thin book)', () => {
    const skips: SkipRecord[] = [];
    const om = new OrderManager('paper', RUN20_STRATEGY_CONFIG, (i) => skips.push(i as SkipRecord));

    const pos = om.openPosition(makeSignal(), SYMBOL, 10_000, 0.003, 100, {
      orderbook: { bid: ENTRY - 1, ask: ENTRY + 1, spreadBps: 50, bidDepthUsdt: 1, askDepthUsdt: 1 },
      markGuard: makeMarkGuard({ markPrice: 49_000 }),
    });

    expect(pos).toBeNull();
    expect(skips).toHaveLength(1);
    expect(skips[0]!.reason).toBe<RejectReason>('mark_deviation');
  });
});

describe('OrderManager.openPosition — guards stay optional (backtest/paper unaffected)', () => {
  it('opens with NO guard inputs at all (legacy positional signature still works)', () => {
    const om = new OrderManager('paper', RUN20_STRATEGY_CONFIG);
    const pos = om.openPosition(makeSignal(), SYMBOL, 10_000, 0.003, 100);
    expect(pos).not.toBeNull();
  });
});
