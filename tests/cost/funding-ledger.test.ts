import { describe, it, expect, vi } from 'vitest';
import {
  countFundingSettlements,
  fundingSettlementTimestamps,
  fundingReturn,
  decomposeReturn,
} from '@/lib/cost/funding-ledger';

const HOUR_MS = 3_600_000;
// 2024-01-01T00:00:00.000Z — a clean UTC day start (also a 00:00 settlement instant).
const DAY0 = Date.UTC(2024, 0, 1, 0, 0, 0, 0);

/** ms offset within DAY0 for a given UTC hour/minute. */
function at(hour: number, minute = 0): number {
  return DAY0 + hour * HOUR_MS + minute * 60_000;
}

describe('countFundingSettlements — half-open (entry, exit], no proration', () => {
  it('entry 07:59 → exit 08:30 UTC counts the 08:00 settlement (=1)', () => {
    expect(countFundingSettlements(at(7, 59), at(8, 30))).toBe(1);
  });

  it('entry 08:01 → exit 15:59 same day crosses no settlement (=0)', () => {
    expect(countFundingSettlements(at(8, 1), at(15, 59))).toBe(0);
  });

  it('entry 23:00 → next-day 09:00 crosses 00:00 + 08:00 (=2)', () => {
    expect(countFundingSettlements(at(23, 0), at(24 + 9, 0))).toBe(2);
  });

  it('entry EXACTLY at 08:00:00.000 is NOT double-counted (half-open lower bound)', () => {
    // (08:00, 16:30] crosses ONLY the 16:00 settlement — the 08:00 entry
    // instant is excluded because the lower bound is open.
    const entry = at(8, 0); // exactly 08:00:00.000
    const exit = at(16, 30);
    const ts = fundingSettlementTimestamps(entry, exit);
    expect(countFundingSettlements(entry, exit)).toBe(1);
    expect(ts).toEqual([at(16, 0)]);
    expect(ts).not.toContain(entry); // 08:00 entry instant excluded
  });

  it('exit EXACTLY on a settlement instant IS counted (inclusive upper bound)', () => {
    // (07:59, 08:00] — the 08:00 settlement at the exit instant is included.
    expect(countFundingSettlements(at(7, 59), at(8, 0))).toBe(1);
  });

  it('returns 0 for a zero-length interval', () => {
    expect(countFundingSettlements(at(8, 0), at(8, 0))).toBe(0);
  });
});

describe('fundingSettlementTimestamps — the crossed instants', () => {
  it('lists 00:00 + 08:00 for an overnight 23:00 → 09:00 hold', () => {
    const ts = fundingSettlementTimestamps(at(23, 0), at(24 + 9, 0));
    expect(ts).toEqual([at(24, 0), at(24 + 8, 0)]);
  });

  it('count matches the length of the timestamp list', () => {
    const entry = at(1, 0);
    const exit = at(24 + 17, 0);
    expect(fundingSettlementTimestamps(entry, exit)).toHaveLength(
      countFundingSettlements(entry, exit),
    );
  });
});

describe('fundingReturn — sign convention (long pays positive funding)', () => {
  // 23:00 → 09:00 crosses 00:00 and 08:00. Constant positive rate fixture.
  const entryMs = at(23, 0);
  const exitMs = at(24 + 9, 0);
  const RATE = 0.0001; // +1bp per settlement
  // Constant-rate fixture: every settlement instant resolves to the same rate.
  const rates = new Map<number, number>();
  const rateAt = (settlementMs: number): number => rates.get(settlementMs) ?? RATE;
  const crossed = 2;

  it('LONG with all-positive funding ⇒ fundingReturn < 0 (long pays)', () => {
    const r = fundingReturn({ entryMs, exitMs, direction: 'long', rateAt });
    expect(r).toBeLessThan(0);
    expect(r).toBeCloseTo(-RATE * crossed, 12);
  });

  it('SHORT with the same funding ⇒ fundingReturn > 0 (short receives)', () => {
    const r = fundingReturn({ entryMs, exitMs, direction: 'short', rateAt });
    expect(r).toBeGreaterThan(0);
    expect(r).toBeCloseTo(RATE * crossed, 12);
  });

  it('long and short magnitudes are equal and opposite', () => {
    const long = fundingReturn({ entryMs, exitMs, direction: 'long', rateAt });
    const short = fundingReturn({ entryMs, exitMs, direction: 'short', rateAt });
    expect(long).toBeCloseTo(-short, 12);
  });

  it('sums the realized rate AT each crossed settlement (rate may vary)', () => {
    // Distinct rate per settlement: look it up by instant from a fixture map.
    const fixture = new Map<number, number>([
      [at(24, 0), 0.0002],
      [at(24 + 8, 0), -0.0005],
    ]);
    const lookup = (ms: number): number => fixture.get(ms) ?? 0;
    const longR = fundingReturn({ entryMs, exitMs, direction: 'long', rateAt: lookup });
    // sign = -1 for long; Σ rate = 0.0002 + (-0.0005) = -0.0003 ⇒ long return = +0.0003
    expect(longR).toBeCloseTo(0.0003, 12);
  });

  it('returns 0 when no settlement is crossed', () => {
    const r = fundingReturn({
      entryMs: at(8, 1),
      exitMs: at(15, 59),
      direction: 'long',
      rateAt: () => 0.001,
    });
    expect(r).toBe(0);
  });
});

describe('decomposeReturn — additive net', () => {
  it('net = gross + friction + funding and the sum holds', () => {
    const d = decomposeReturn({
      grossReturn: 0.02,
      frictionReturn: -0.0014,
      fundingReturn: -0.0006,
    });
    expect(d.grossReturn).toBe(0.02);
    expect(d.frictionReturn).toBe(-0.0014);
    expect(d.fundingReturn).toBe(-0.0006);
    expect(d.netReturn).toBeCloseTo(0.018, 12);
  });

  it('does not throw for components that sum cleanly (no expectedNet)', () => {
    expect(() =>
      decomposeReturn({ grossReturn: 0.05, frictionReturn: -0.0007, fundingReturn: 0 }),
    ).not.toThrow();
  });
});

describe('decomposeReturn — de-tautologized net reconciliation', () => {
  // The OLD invariant recomputed `net` from the same sum it asserted against, so
  // the residual was identically 0 and it could never catch a mis-decomposition.
  // The new check compares the additive sum against an INDEPENDENT `expectedNet`.

  it('passes when the additive sum agrees with the independent expectedNet', () => {
    // gross + friction + funding = 0.018; independent net derived as pnl+funding.
    const pnlPercent = 0.0194; // pnl already net-of-friction
    const funding = -0.0006;
    const grossReturn = pnlPercent - -0.0014; // gross = pnl − friction
    expect(() =>
      decomposeReturn({
        grossReturn,
        frictionReturn: -0.0014,
        fundingReturn: funding,
        expectedNet: pnlPercent + funding, // 0.0188
        strict: true,
      }),
    ).not.toThrow();
  });

  it('FLAGS a deliberately-inconsistent decomposition (strict ⇒ throws)', () => {
    // Mis-decomposition: gross is wrong by 0.01, so additiveNet (0.028) diverges
    // from the independent expectedNet (0.018). The OLD tautological check would
    // have PASSED here because it recomputed net from this same wrong sum.
    expect(() =>
      decomposeReturn({
        grossReturn: 0.03, // WRONG (inflated by 0.01)
        frictionReturn: -0.0014,
        fundingReturn: -0.0006,
        expectedNet: 0.018, // independently-known true net
        strict: true,
      }),
    ).toThrow(/net reconciliation failed/);
  });

  it('NON-strict (production) logs a warning instead of throwing on divergence', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() =>
      decomposeReturn({
        grossReturn: 0.03, // WRONG
        frictionReturn: -0.0014,
        fundingReturn: -0.0006,
        expectedNet: 0.018,
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('net reconciliation failed'));
    warn.mockRestore();
  });

  it('still returns the additive net even when divergence is only logged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = decomposeReturn({
      grossReturn: 0.03,
      frictionReturn: -0.0014,
      fundingReturn: -0.0006,
      expectedNet: 0.018,
    });
    // netReturn is the additive sum (0.028), NOT the expectedNet — the function
    // reports what the legs actually sum to so the drift is visible downstream.
    expect(d.netReturn).toBeCloseTo(0.028, 12);
    warn.mockRestore();
  });
});
