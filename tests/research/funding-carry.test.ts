/**
 * TDD for the non-trivial logic in the crypto funding-carry feasibility probe
 * (scripts/research-funding-carry.ts):
 *
 *   1. Funding HARVEST accrual for a delta-neutral cash-and-carry (long spot +
 *      SHORT perp). The short leg RECEIVES funding when the rate is positive, so
 *      the harvest over a hold = +Σ realized rate at each crossed 00/08/16 UTC
 *      settlement. This reuses the canonical funding-ledger sign rule
 *      (`+1 short`) so there is zero divergence from the live close path.
 *
 *   2. No-look-ahead signal lag: the threshold-gated variant must decide whether
 *      to be in-market at bar t using ONLY funding settled strictly BEFORE t.
 *      A signal that peeks at the rate settling AT t is a look-ahead bug.
 */
import { describe, it, expect } from 'vitest';
import {
  fundingReturn,
  fundingSettlementTimestamps,
} from '../../src/lib/cost/funding-ledger';
import {
  carryHarvest,
  lastSettledRateBefore,
} from '../../scripts/lib/funding-carry-core';

const ts = (iso: string) => new Date(iso).getTime();

describe('cash-and-carry funding harvest (short perp leg)', () => {
  it('a short collects POSITIVE funding (sign = +Σ rate), opposite of a long', () => {
    // Hold across exactly one 08:00 settlement with rate +10bps.
    const entry = ts('2024-01-01T05:00:00Z');
    const exit = ts('2024-01-01T09:00:00Z');
    const rateAt = (t: number) =>
      t === ts('2024-01-01T08:00:00Z') ? 0.0010 : 0;

    const short = fundingReturn({ entryMs: entry, exitMs: exit, direction: 'short', rateAt });
    const long = fundingReturn({ entryMs: entry, exitMs: exit, direction: 'long', rateAt });

    expect(short).toBeCloseTo(0.0010, 12); // short RECEIVES
    expect(long).toBeCloseTo(-0.0010, 12); // long PAYS
    expect(short).toBeCloseTo(-long, 12);
  });

  it('carryHarvest sums the realized rate at every crossed settlement (no proration)', () => {
    // 24h hold from 00:30 → next 00:30 crosses 08:00, 16:00, 00:00 (3 settlements).
    const entry = ts('2024-03-01T00:30:00Z');
    const exit = ts('2024-03-02T00:30:00Z');
    const rates: Record<number, number> = {
      [ts('2024-03-01T08:00:00Z')]: 0.0005,
      [ts('2024-03-01T16:00:00Z')]: 0.0003,
      [ts('2024-03-02T00:00:00Z')]: -0.0002, // funding flipped negative this window
    };
    const rateAt = (t: number) => rates[t] ?? 0;

    const crossed = fundingSettlementTimestamps(entry, exit);
    expect(crossed.length).toBe(3);

    // Harvest = +Σ rate (short receives positive, pays the negative one).
    expect(carryHarvest(entry, exit, rateAt)).toBeCloseTo(0.0005 + 0.0003 - 0.0002, 12);
  });

  it('a hold that crosses no settlement boundary harvests exactly zero', () => {
    const entry = ts('2024-01-01T09:00:00Z');
    const exit = ts('2024-01-01T15:00:00Z'); // between 08:00 and 16:00, crosses none
    expect(carryHarvest(entry, exit, () => 0.001)).toBe(0);
  });
});

describe('no-look-ahead signal lag', () => {
  // A tiny funding series on the canonical grid.
  const grid = [
    { t: ts('2024-01-01T00:00:00Z'), r: 0.0008 },
    { t: ts('2024-01-01T08:00:00Z'), r: 0.0006 },
    { t: ts('2024-01-01T16:00:00Z'), r: -0.0001 },
    { t: ts('2024-01-02T00:00:00Z'), r: 0.0004 },
  ];

  it('uses the most recent rate settled STRICTLY before the decision instant', () => {
    // Deciding exactly at the 08:00 settlement must NOT see the 08:00 rate yet
    // (it settles AT that instant); it sees the 00:00 rate.
    const at0800 = lastSettledRateBefore(grid, ts('2024-01-01T08:00:00Z'));
    expect(at0800).toBeCloseTo(0.0008, 12);

    // One hour later it has seen the 08:00 settlement.
    const at0900 = lastSettledRateBefore(grid, ts('2024-01-01T09:00:00Z'));
    expect(at0900).toBeCloseTo(0.0006, 12);
  });

  it('returns null before any settlement exists (cannot trade on unknown signal)', () => {
    expect(lastSettledRateBefore(grid, ts('2023-12-31T23:00:00Z'))).toBeNull();
  });
});
