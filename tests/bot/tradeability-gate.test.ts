import { describe, it, expect } from 'vitest';
import { checkTradeability } from '@/lib/bot/guards';
import type { RejectReason } from '@/types/bot';
import { TRADEABILITY_CONFIG } from '@/lib/bot/config';
import { OrderManager } from '@/lib/bot/order-manager';
import type { ScoredSignal } from '@/lib/rl/strategies/confluence-scorer';
import type { BotSymbol } from '@/types/bot';
import { RUN20_STRATEGY_CONFIG } from '@/lib/bot/config';

/**
 * Task 7 — L2 TRADEABILITY gate (sibling to Task 1 pre-trade guards).
 *
 * Contract (made explicit by these tests):
 *   - spreadBps    = (ask - bid) / mid * 1e4
 *   - depthUsdt    = USDT depth on the side we'd cross (sum of top-N level
 *                    size × price)
 *   - minDepthUsdt = a MULTIPLE of intended notional: require
 *                    depthUsdt >= depthMultiple * intendedNotionalUsdt
 *   Reject 'l2_tradeability' if spreadBps > maxSpreadBps OR depth too thin.
 */

const MAX_SPREAD_BPS = TRADEABILITY_CONFIG.maxSpreadBps; // 5
const DEPTH_MULTIPLE = TRADEABILITY_CONFIG.depthMultiple; // 2
const INTENDED_NOTIONAL = 10_000; // USDT

describe('checkTradeability — pure L2 gate', () => {
  it('accepts a tight spread + deep book (ok:true)', () => {
    const result = checkTradeability({
      spreadBps: 2, // < 5
      depthUsdt: 3 * INTENDED_NOTIONAL, // 3× intended >= 2× required
      intendedNotionalUsdt: INTENDED_NOTIONAL,
      maxSpreadBps: MAX_SPREAD_BPS,
      depthMultiple: DEPTH_MULTIPLE,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts spread exactly at maxSpreadBps and depth exactly at the required multiple (boundaries inclusive)', () => {
    const result = checkTradeability({
      spreadBps: MAX_SPREAD_BPS, // === limit → ok
      depthUsdt: DEPTH_MULTIPLE * INTENDED_NOTIONAL, // === required → ok
      intendedNotionalUsdt: INTENDED_NOTIONAL,
      maxSpreadBps: MAX_SPREAD_BPS,
      depthMultiple: DEPTH_MULTIPLE,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects when spreadBps > maxSpreadBps', () => {
    const result = checkTradeability({
      spreadBps: MAX_SPREAD_BPS + 0.01,
      depthUsdt: 5 * INTENDED_NOTIONAL, // deep enough — only spread is bad
      intendedNotionalUsdt: INTENDED_NOTIONAL,
      maxSpreadBps: MAX_SPREAD_BPS,
      depthMultiple: DEPTH_MULTIPLE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe<RejectReason>('l2_tradeability');
    }
  });

  it('rejects when depthUsdt < depthMultiple * intendedNotional', () => {
    const result = checkTradeability({
      spreadBps: 1, // tight — only depth is bad
      depthUsdt: DEPTH_MULTIPLE * INTENDED_NOTIONAL - 1, // 1 USDT short
      intendedNotionalUsdt: INTENDED_NOTIONAL,
      maxSpreadBps: MAX_SPREAD_BPS,
      depthMultiple: DEPTH_MULTIPLE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe<RejectReason>('l2_tradeability');
    }
  });

  it('rejects when BOTH spread and depth are bad', () => {
    const result = checkTradeability({
      spreadBps: MAX_SPREAD_BPS + 10,
      depthUsdt: 0,
      intendedNotionalUsdt: INTENDED_NOTIONAL,
      maxSpreadBps: MAX_SPREAD_BPS,
      depthMultiple: DEPTH_MULTIPLE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe<RejectReason>('l2_tradeability');
    }
  });
});

// ---------------------------------------------------------------------------
// Wiring: a rejected signal is logged as a skipped_signal via the onSkip seam.
// ---------------------------------------------------------------------------

interface SkipRecord {
  symbol: BotSymbol;
  reason: RejectReason;
  signalEntry: number;
  score: number;
  detail?: unknown;
}

function makeSignal(entry: number): ScoredSignal {
  // Long signal with a sane stop so sizing itself passes; only L2 should reject.
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

describe('OrderManager.openPosition — optional L2 tradeability gate', () => {
  const symbol: BotSymbol = 'BTCUSDT';
  const entry = 50_000;

  it('opens normally when NO orderbook snapshot is provided (gate is optional)', () => {
    const om = new OrderManager('paper', RUN20_STRATEGY_CONFIG);
    const pos = om.openPosition(makeSignal(entry), symbol, 10_000, 0.003, 100);
    expect(pos).not.toBeNull();
  });

  it('skips the trade and logs a skipped_signal when the orderbook is untradeable', () => {
    const skips: SkipRecord[] = [];
    const om = new OrderManager('paper', RUN20_STRATEGY_CONFIG, (info) => {
      skips.push(info as SkipRecord);
    });

    const pos = om.openPosition(makeSignal(entry), symbol, 10_000, 0.003, 100, {
      orderbook: {
        bid: entry - 1,
        ask: entry + 1,
        // wide spread → untradeable
        spreadBps: 50,
        bidDepthUsdt: 1_000_000,
        askDepthUsdt: 1_000_000,
      },
    });

    expect(pos).toBeNull();
    expect(skips).toHaveLength(1);
    expect(skips[0]!.reason).toBe<RejectReason>('l2_tradeability');
    expect(skips[0]!.symbol).toBe(symbol);
  });

  it('opens when the provided orderbook is tradeable', () => {
    const skips: SkipRecord[] = [];
    const om = new OrderManager('paper', RUN20_STRATEGY_CONFIG, (info) => {
      skips.push(info as SkipRecord);
    });

    const pos = om.openPosition(makeSignal(entry), symbol, 10_000, 0.003, 100, {
      orderbook: {
        bid: entry - 1,
        ask: entry + 1,
        spreadBps: 1,
        bidDepthUsdt: 1_000_000,
        askDepthUsdt: 1_000_000,
      },
    });

    expect(pos).not.toBeNull();
    expect(skips).toHaveLength(0);
  });
});
