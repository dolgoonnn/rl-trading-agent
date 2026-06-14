/**
 * Core, testable primitives for the crypto funding-carry feasibility probe.
 *
 * Kept tiny and PURE so the non-trivial bits (signed harvest accrual, no
 * look-ahead signal lag) can be unit-tested in isolation. The harvest reuses
 * the canonical funding-ledger (`src/lib/cost/funding-ledger.ts`) so the
 * settlement-counting rule is byte-identical to the live close path.
 */
import { fundingReturn } from '../../src/lib/cost/funding-ledger';

/**
 * Funding harvested by a delta-neutral cash-and-carry over `(entryMs, exitMs]`.
 * The position is LONG spot + SHORT perp; the spot leg pays/earns no funding, so
 * the whole funding flow is the SHORT perp's: `+Σ realized rate` at each crossed
 * 00/08/16 UTC settlement (no proration). Positive funding ⇒ short receives ⇒
 * positive harvest.
 */
export function carryHarvest(
  entryMs: number,
  exitMs: number,
  rateAt: (settlementMs: number) => number,
): number {
  return fundingReturn({ entryMs, exitMs, direction: 'short', rateAt });
}

export interface FundingPoint {
  /** UTC settlement instant (ms). */
  t: number;
  /** Realized funding rate (fraction, e.g. 0.0001 = 1bp) that settled at `t`. */
  r: number;
}

/**
 * The most recent funding rate that settled STRICTLY before `decisionMs`.
 * Returns `null` if no settlement has occurred yet (cannot act on an unknown
 * signal). `points` must be ascending in `t`. This is the anti-look-ahead guard
 * for the threshold-gated variant: a decision at instant t may only use funding
 * that has already settled (< t), never the rate settling AT t.
 */
export function lastSettledRateBefore(
  points: readonly FundingPoint[],
  decisionMs: number,
): number | null {
  let lastR: number | null = null;
  for (const p of points) {
    if (p.t < decisionMs) lastR = p.r;
    else break;
  }
  return lastR;
}
