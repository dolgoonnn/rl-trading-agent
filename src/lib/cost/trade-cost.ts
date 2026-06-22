/**
 * Trade-cost helpers for the funding-charged backtest (Task 8 PROBE).
 *
 * PURE and fully dependency-injected — no `Date.now()`, no `fetch`, no DB.
 * Wraps the funding-ledger keystone so the SAME signed-funding rule used by the
 * live `closePosition` path also charges funding inside `backtest-confluence.ts`.
 * That guarantees zero sim/live mismatch when we re-confirm the Run-20 edge
 * net-of-funding.
 *
 * Funding mechanism (Bybit/Binance USDT perpetuals, web-verified 2026-06-14):
 *   - Funding settles 3×/day at 00:00, 08:00, 16:00 UTC.
 *   - A position pays/receives funding ONLY if it is open AT the settlement
 *     instant. We count the crossed instants in the half-open `(entry, exit]`
 *     (no proration) via the funding-ledger.
 *   - When the funding rate is POSITIVE, LONGS pay shorts → a long's funding
 *     return contribution is NEGATIVE. `fundingReturn` already applies the
 *     `sign = -1 long / +1 short` convention.
 */

import { fundingReturn, type Direction } from './funding-ledger';

/** Which side of the book the EXIT fill is. TP exits rest passively (maker); SL/timeout cross the book (taker). */
export type ExitSide = 'maker' | 'taker';

/** Split of the single blended friction into a maker leg and a taker leg, in basis points (per side). */
export interface MakerTakerConfig {
  /** Maker fee + slippage per side, in bps (e.g. 2 = 0.02%). Passive TP exits. */
  makerBps: number;
  /** Taker fee + slippage per side, in bps (e.g. 5.5 = 0.055%). Entry + SL/timeout exits. */
  takerBps: number;
}

/**
 * Per-side friction fraction for a given exit side under a maker/taker split.
 * A passive TP exit pays the maker leg; an SL/timeout/strategy exit crosses the
 * book and pays the taker leg. Returns a fraction (bps / 1e4).
 */
export function frictionForExitSide(side: ExitSide, cfg: MakerTakerConfig): number {
  const bps = side === 'maker' ? cfg.makerBps : cfg.takerBps;
  return bps / 1e4;
}

/**
 * Charge funding onto a completed trade's gross PnL.
 *
 * `netPnlPercent = grossPnlPercent + fundingReturn`, where `fundingReturn` is the
 * signed sum of the REALIZED funding rate at EACH crossed 00/08/16 settlement
 * (looked up by timestamp from the loaded funding series), with the
 * `-1 long / +1 short` sign and NO proration. A sub-8h trade that crosses no
 * settlement boundary is unchanged (`net === gross`).
 */
export function applyFundingToPnl(args: {
  grossPnlPercent: number;
  entryMs: number;
  exitMs: number;
  direction: Direction;
  /** Realized funding rate (fraction) that settled at a given UTC settlement instant. 0 if unknown. */
  rateAt: (settlementMs: number) => number;
}): number {
  const { grossPnlPercent, entryMs, exitMs, direction, rateAt } = args;
  const funding = fundingReturn({ entryMs, exitMs, direction, rateAt });
  return grossPnlPercent + funding;
}
