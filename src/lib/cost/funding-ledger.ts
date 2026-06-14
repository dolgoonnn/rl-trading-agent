/**
 * Funding-cost ledger — the keystone for funding-cost honesty.
 *
 * PURE and fully dependency-injected: no `Date.now()`, no `fetch`, no DB access.
 * Every timestamp and every realized funding rate is passed in. This is shared
 * by BOTH the live close path (`position-tracker.closePosition`) and the
 * funding-charged backtest (Task 8) so there is ZERO sim/live mismatch.
 *
 * Settlement convention (Bybit/Binance perpetuals): funding settles at
 * 00:00, 08:00 and 16:00 UTC. A position pays/receives funding for each
 * settlement instant it is OPEN ACROSS. We count settlements in the
 * HALF-OPEN interval `(entryMs, exitMs]`:
 *   - exclusive of the entry instant (a position opened exactly at 08:00 has
 *     NOT held through that 08:00 settlement — it just entered),
 *   - inclusive of the exit instant (a position still open at the 08:00
 *     settlement and closing at/after it DOES owe that settlement).
 *
 * This is the canonical anti-overcount rule. NO proration of partial periods.
 *
 * Sign convention: a LONG pays funding when the funding rate is positive, so a
 * long's funding RETURN contribution is `-Σ rate`. A SHORT receives it, so its
 * contribution is `+Σ rate`. Hence `sign = -1 for long, +1 for short`.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Funding settlement hours (UTC). */
const SETTLEMENT_HOURS = [0, 8, 16] as const;

export type Direction = 'long' | 'short';

/**
 * A funding-rate source for a single symbol. `rateAt(settlementMs)` returns the
 * realized funding rate (as a fraction, e.g. 0.0001 = 1bp) that settled at the
 * given UTC settlement instant. Injected so the ledger stays pure — the caller
 * decides where rates come from (futures_1h.json, exchange API, fixture map).
 */
export interface FundingSettlementSeries {
  rateAt: (settlementMs: number) => number;
}

export interface ReturnDecomposition {
  grossReturn: number;
  frictionReturn: number;
  fundingReturn: number;
  netReturn: number;
}

/** Float epsilon for the additive audit invariant. */
const AUDIT_EPSILON = 1e-9;

/**
 * The funding settlement instants (UTC ms) crossed in the half-open interval
 * `(entryMs, exitMs]`. Returned in ascending order so callers can look up the
 * realized rate at each.
 */
export function fundingSettlementTimestamps(entryMs: number, exitMs: number): number[] {
  if (!(exitMs > entryMs)) return [];

  const out: number[] = [];
  // Start scanning from the UTC midnight of the entry day, then walk forward
  // through every settlement instant until we pass exitMs.
  let dayStart = Math.floor(entryMs / DAY_MS) * DAY_MS;

  // Guard against pathological inputs (should never spin in practice).
  while (dayStart <= exitMs) {
    for (const h of SETTLEMENT_HOURS) {
      const t = dayStart + h * HOUR_MS;
      // Half-open (entryMs, exitMs]: exclude entry instant, include exit instant.
      if (t > entryMs && t <= exitMs) out.push(t);
    }
    dayStart += DAY_MS;
  }

  return out;
}

/**
 * Count of 00:00 / 08:00 / 16:00 UTC funding settlements in the HALF-OPEN
 * interval `(entryMs, exitMs]`. No proration. This is the canonical
 * anti-overcount rule reused by live close and backtest alike.
 */
export function countFundingSettlements(entryMs: number, exitMs: number): number {
  return fundingSettlementTimestamps(entryMs, exitMs).length;
}

/**
 * Signed funding return contribution for a held position.
 *
 * `Σ` over the crossed settlements of the realized rate at each, times the
 * direction sign (`-1` long, `+1` short). A long in persistently positive
 * funding gets a NEGATIVE return contribution (it pays).
 */
export function fundingReturn(args: {
  entryMs: number;
  exitMs: number;
  direction: Direction;
  rateAt: (settlementMs: number) => number;
}): number {
  const { entryMs, exitMs, direction, rateAt } = args;
  const sign = direction === 'long' ? -1 : 1;

  let sumRate = 0;
  for (const t of fundingSettlementTimestamps(entryMs, exitMs)) {
    sumRate += rateAt(t);
  }

  // `+ 0` normalizes a potential `-0` (e.g. sign=-1 × sumRate=0) to `+0` so
  // downstream consumers and DB rows never store a negative zero.
  return sign * sumRate + 0;
}

/**
 * Combine the three return components and assert the additive audit invariant
 * `netReturn === grossReturn + frictionReturn + fundingReturn` (within a float
 * epsilon). Throws if the invariant is violated — that can only happen from a
 * programming error since `netReturn` is computed here, but the assertion
 * documents and locks the contract for every downstream consumer.
 */
export function decomposeReturn(args: {
  grossReturn: number;
  frictionReturn: number;
  fundingReturn: number;
}): ReturnDecomposition {
  const { grossReturn, frictionReturn, fundingReturn: funding } = args;
  const netReturn = grossReturn + frictionReturn + funding;

  const residual = Math.abs(netReturn - (grossReturn + frictionReturn + funding));
  if (residual > AUDIT_EPSILON) {
    throw new Error(
      `funding-ledger: additive audit invariant violated (residual=${residual}). ` +
        `gross=${grossReturn} friction=${frictionReturn} funding=${funding} net=${netReturn}`,
    );
  }

  return { grossReturn, frictionReturn, fundingReturn: funding, netReturn };
}
