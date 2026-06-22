/**
 * Pre-Trade Safety Gate — pure reject + sizing math (LIVE/PAPER bot only)
 *
 * Hard REJECTS, no clamping. Modeled on SEC 15c3-5 pre-trade risk controls
 * and the Knight Capital lesson: a deployed order path must mechanically
 * refuse pathological orders, with no human in the loop per-order.
 *
 * Every function here is PURE: the clock (`nowMs`), the mark price, and all
 * candle timestamps are passed in as arguments. Nothing calls `Date.now()`
 * or `fetch`, so the rules are fully deterministic under unit test.
 *
 * Do NOT import this from backtest-confluence.ts — these guards are live-only
 * and must not shift the Run-20 edge measurement.
 */

import type { GuardResult, RejectReason } from '@/types/bot';

// ============================================
// Sizing with notional cap + stop floor
// ============================================

export interface ComputePositionSizeArgs {
  /** Current account equity (USDT) */
  equity: number;
  /** Risk fraction per trade (e.g. 0.003 = 0.3%) */
  riskPerTrade: number;
  /** Symbol allocation weight (e.g. 0.40) */
  symbolAlloc: number;
  /** Raw risk distance in price units (|entry - stop|) */
  riskDistance: number;
  /** Entry price (price units) — used for notional + stop floor */
  entryPrice: number;
  /** Max notional as a multiple of equity (defense-in-depth cap) */
  maxNotionalPctEquity: number;
  /** Minimum stop distance as a fraction of entry price */
  minStopPct: number;
}

/**
 * Risk-based position sizing with TWO independent safety layers:
 *   1. Floor riskDistance at `max(minStopPct*entryPrice, riskDistance)` so a
 *      degenerate (near-zero) stop can't explode the size.
 *   2. Cap notional at `maxNotionalPctEquity * equity` and REJECT otherwise.
 *
 * Both are required — defense in depth against the unbounded-size bug where
 * `positionSize = riskAmount / riskDistance` blows up as riskDistance → 0.
 */
export function computePositionSize(args: ComputePositionSizeArgs): GuardResult {
  const {
    equity,
    riskPerTrade,
    symbolAlloc,
    riskDistance,
    entryPrice,
    maxNotionalPctEquity,
    minStopPct,
  } = args;

  // Layer 1: floor the risk distance so size can't run away on a tiny stop.
  const flooredRiskDistance = Math.max(minStopPct * entryPrice, riskDistance);

  const riskAmount = equity * riskPerTrade * symbolAlloc;
  const size = riskAmount / flooredRiskDistance;
  const notionalUsdt = size * entryPrice;

  // Layer 2: hard cap on notional.
  if (notionalUsdt > maxNotionalPctEquity * equity) {
    const reason: RejectReason = 'max_notional';
    return { ok: false, reason };
  }

  return { ok: true, size, notionalUsdt };
}

// ============================================
// Pre-trade guards (mark collar, staleness, candle sanity)
// ============================================

export interface CheckPreTradeGuardsArgs {
  /** Entry price implied by the signal */
  signalEntry: number;
  /** Current mark price (Bybit dual-price / liquidation reference) */
  markPrice: number;
  /** High of the signal candle */
  candleHigh: number;
  /** Low of the signal candle */
  candleLow: number;
  /** Close of the signal candle */
  candleClose: number;
  /** Close timestamp of the signal candle (ms) */
  candleCloseMs: number;
  /** Current time (ms) — injected for determinism */
  nowMs: number;
  /** Max allowed mark deviation in basis points */
  maxDeviationBps: number;
  /** Max allowed candle age in milliseconds */
  maxCandleAgeMs: number;
}

export type PreTradeGuardResult =
  | { ok: true }
  | { ok: false; reason: RejectReason };

/**
 * Reject an order before it reaches the exchange if any structural guard trips.
 * Boundary semantics are inclusive-OK: `=== threshold` passes, `+epsilon` fails.
 *
 * Checks (in order):
 *   1. crossed_candle — OHLC sanity (high>=low>0, low<=close<=high).
 *   2. stale_candle   — candle older than maxCandleAgeMs.
 *   3. mark_deviation — signal entry too far from the MARK price (collar).
 */
export function checkPreTradeGuards(args: CheckPreTradeGuardsArgs): PreTradeGuardResult {
  const {
    signalEntry,
    markPrice,
    candleHigh,
    candleLow,
    candleClose,
    candleCloseMs,
    nowMs,
    maxDeviationBps,
    maxCandleAgeMs,
  } = args;

  // 1. Candle OHLC sanity (crossed / zero-volume artifacts).
  const candleSane =
    candleHigh >= candleLow &&
    candleLow > 0 &&
    candleLow <= candleClose &&
    candleClose <= candleHigh;
  if (!candleSane) {
    return { ok: false, reason: 'crossed_candle' };
  }

  // 2. Staleness — collar against acting on an old bar.
  if (nowMs - candleCloseMs > maxCandleAgeMs) {
    return { ok: false, reason: 'stale_candle' };
  }

  // 3. Mark-price collar (against mark, not last — Bybit liquidation mechanic).
  const deviationBps = (Math.abs(signalEntry - markPrice) / markPrice) * 1e4;
  if (deviationBps > maxDeviationBps) {
    return { ok: false, reason: 'mark_deviation' };
  }

  return { ok: true };
}

// ============================================
// L2 tradeability gate (spread + depth)
// ============================================

export interface CheckTradeabilityArgs {
  /** Current spread in basis points: (ask - bid) / mid * 1e4. */
  spreadBps: number;
  /** USDT depth resting on the side we'd cross (sum of top-N levels × price). */
  depthUsdt: number;
  /** Intended position notional in USDT. */
  intendedNotionalUsdt: number;
  /** Max allowed spread in basis points (reject if `spreadBps >` this). */
  maxSpreadBps: number;
  /**
   * Required depth as a MULTIPLE of intended notional. We require
   * `depthUsdt >= depthMultiple * intendedNotionalUsdt` of resting liquidity.
   */
  depthMultiple: number;
}

export type TradeabilityResult =
  | { ok: true }
  | { ok: false; reason: RejectReason };

/**
 * Pure L2 tradeability check — sibling to `checkPreTradeGuards`, but keyed on
 * the live order book rather than the candle. Reject `l2_tradeability` when the
 * book is too illiquid for the intended order:
 *
 *   - spread too wide:  `spreadBps > maxSpreadBps`, OR
 *   - book too thin:    `depthUsdt < depthMultiple * intendedNotionalUsdt`.
 *
 * Boundaries are inclusive-OK: `spreadBps === maxSpreadBps` passes, and
 * `depthUsdt === depthMultiple * intendedNotionalUsdt` passes. This keeps the
 * bot from crossing a book where the fill would slip badly or move price.
 */
export function checkTradeability(args: CheckTradeabilityArgs): TradeabilityResult {
  const { spreadBps, depthUsdt, intendedNotionalUsdt, maxSpreadBps, depthMultiple } = args;

  const requiredDepthUsdt = depthMultiple * intendedNotionalUsdt;

  if (spreadBps > maxSpreadBps || depthUsdt < requiredDepthUsdt) {
    const reason: RejectReason = 'l2_tradeability';
    return { ok: false, reason };
  }

  return { ok: true };
}
