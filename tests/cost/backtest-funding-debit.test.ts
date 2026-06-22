import { describe, it, expect } from 'vitest';
import {
  applyFundingToPnl,
  frictionForExitSide,
  type ExitSide,
  type MakerTakerConfig,
} from '@/lib/cost/trade-cost';

const HOUR_MS = 3_600_000;
// 2024-01-01T00:00:00.000Z — a clean UTC day start (also a 00:00 settlement instant).
const DAY0 = Date.UTC(2024, 0, 1, 0, 0, 0, 0);

/** ms offset within DAY0 for a given UTC hour/minute. */
function at(hour: number, minute = 0): number {
  return DAY0 + hour * HOUR_MS + minute * 60_000;
}

describe('applyFundingToPnl — netPnl = grossPnl + fundingReturn (realized rate at each crossed 00/08/16 settlement)', () => {
  // Constant positive funding fixture: every settlement instant resolves to +1bp.
  const RATE = 0.0001;
  const rateAt = (): number => RATE;

  it('LONG spanning 00:00 + 08:00 in positive funding LOSES the funding (net < gross)', () => {
    // entry 23:00 → exit next-day 09:00 crosses 00:00 and 08:00 (2 settlements).
    const grossPnl = 0.02;
    const net = applyFundingToPnl({
      grossPnlPercent: grossPnl,
      entryMs: at(23, 0),
      exitMs: at(24 + 9, 0),
      direction: 'long',
      rateAt,
    });
    // long pays: fundingReturn = -2 * RATE
    expect(net).toBeCloseTo(grossPnl - 2 * RATE, 12);
    expect(net).toBeLessThan(grossPnl);
  });

  it('SHORT over the SAME window RECEIVES the funding (sign flips: net > gross)', () => {
    const grossPnl = 0.02;
    const net = applyFundingToPnl({
      grossPnlPercent: grossPnl,
      entryMs: at(23, 0),
      exitMs: at(24 + 9, 0),
      direction: 'short',
      rateAt,
    });
    expect(net).toBeCloseTo(grossPnl + 2 * RATE, 12);
    expect(net).toBeGreaterThan(grossPnl);
  });

  it('long and short funding adjustments are equal and opposite for the same window', () => {
    const gross = 0.01;
    const longNet = applyFundingToPnl({
      grossPnlPercent: gross,
      entryMs: at(23, 0),
      exitMs: at(24 + 9, 0),
      direction: 'long',
      rateAt,
    });
    const shortNet = applyFundingToPnl({
      grossPnlPercent: gross,
      entryMs: at(23, 0),
      exitMs: at(24 + 9, 0),
      direction: 'short',
      rateAt,
    });
    expect(longNet - gross).toBeCloseTo(-(shortNet - gross), 12);
  });

  it('uses the REALIZED rate AT each crossed settlement (rates may differ per instant)', () => {
    const fixture = new Map<number, number>([
      [at(24, 0), 0.0003], // 00:00 next day
      [at(24 + 8, 0), -0.0001], // 08:00 next day
    ]);
    const lookup = (ms: number): number => fixture.get(ms) ?? 0;
    const gross = 0.05;
    const net = applyFundingToPnl({
      grossPnlPercent: gross,
      entryMs: at(23, 0),
      exitMs: at(24 + 9, 0),
      direction: 'long',
      rateAt: lookup,
    });
    // Σ rate = 0.0003 + (-0.0001) = 0.0002; long sign = -1 ⇒ fundingReturn = -0.0002
    expect(net).toBeCloseTo(gross - 0.0002, 12);
  });

  it('sub-8h trade crossing NO settlement boundary ⇒ funding 0, NO proration (net === gross)', () => {
    const gross = 0.013;
    const net = applyFundingToPnl({
      grossPnlPercent: gross,
      entryMs: at(8, 1), // 08:01
      exitMs: at(15, 59), // 15:59 same day — crosses no 00/08/16 instant
      direction: 'long',
      rateAt: () => 0.005, // huge rate, but it must NOT be prorated in
    });
    expect(net).toBe(gross);
  });

  it('a position opening EXACTLY at 08:00 does NOT pay that 08:00 settlement (half-open lower bound)', () => {
    const gross = 0.0;
    // (08:00, 15:59] crosses no settlement (16:00 not reached) ⇒ funding 0.
    const net = applyFundingToPnl({
      grossPnlPercent: gross,
      entryMs: at(8, 0),
      exitMs: at(15, 59),
      direction: 'long',
      rateAt: () => 0.001,
    });
    expect(net).toBe(0);
  });
});

describe('frictionForExitSide — maker/taker split (passive TP = maker, SL/timeout = taker)', () => {
  // Maker 2bps, taker 5.5bps (per-side fractions).
  const cfg: MakerTakerConfig = { makerBps: 2, takerBps: 5.5 };

  it('TP exit uses the MAKER leg', () => {
    expect(frictionForExitSide('maker', cfg)).toBeCloseTo(0.0002, 12);
  });

  it('SL exit uses the TAKER leg', () => {
    expect(frictionForExitSide('taker', cfg)).toBeCloseTo(0.00055, 12);
  });

  it('maker friction is strictly cheaper than taker friction', () => {
    expect(frictionForExitSide('maker', cfg)).toBeLessThan(frictionForExitSide('taker', cfg));
  });

  it('exhaustively maps both exit sides to their bps leg', () => {
    const sides: ExitSide[] = ['maker', 'taker'];
    const expected = [0.0002, 0.00055];
    sides.forEach((side, idx) => {
      expect(frictionForExitSide(side, cfg)).toBeCloseTo(expected[idx]!, 12);
    });
  });
});
