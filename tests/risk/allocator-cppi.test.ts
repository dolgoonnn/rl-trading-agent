import { describe, it, expect } from 'vitest';
import { liveBookDrawdown } from '../../scripts/run-allocator';
import { cppiExposureMultiplier } from '@/lib/risk/sizing';
import { expectedMaxDD, hardKillDD } from '@/lib/bot/retirement';

/**
 * FIX 1 — run-allocator CPPI must cut off the LIVE book equity drawdown, not a
 * fixed historical number from the backtest curve. `liveBookDrawdown` is the
 * pure helper that turns a live `bot_equity_snapshots` series into the trailing-
 * peak drawdown = 1 - latestEquity/max(historicalPeak, latestEquity), which is
 * then fed into the SAME cppi taper the retirement layer uses.
 */

// Frozen retirement bounds (same as the allocator uses via RETIREMENT_CONFIG).
const eMaxDD = expectedMaxDD({ sigmaAnnual: 0.12, sharpe: 2, horizonYears: 0.75 }); // ≈0.194
const hardDD = hardKillDD({ eMaxDD, bootstrapP5DD: 0.1 }); // ≈0.291

describe('liveBookDrawdown — trailing-peak drawdown of the LIVE equity series', () => {
  it('returns 0 with no snapshots (graceful fallback ⇒ CPPI mult 1.0)', () => {
    expect(liveBookDrawdown([])).toBe(0);
    const mult = cppiExposureMultiplier({ drawdown: liveBookDrawdown([]), eMaxDD, hardKillDD: hardDD });
    expect(mult).toBe(1);
  });

  it('a live history AT/ABOVE peak ⇒ drawdown 0 ⇒ CPPI mult == 1 (no cut)', () => {
    // monotone-up live equity: latest IS the peak.
    const snaps = [
      { timestamp: 1, equity: 100 },
      { timestamp: 2, equity: 105 },
      { timestamp: 3, equity: 110 },
    ];
    expect(liveBookDrawdown(snaps)).toBe(0);
    const mult = cppiExposureMultiplier({ drawdown: liveBookDrawdown(snaps), eMaxDD, hardKillDD: hardDD });
    expect(mult).toBe(1);
  });

  it('a DEEP live drawdown in the taper band ⇒ CPPI mult < 1 (cuts)', () => {
    // peak 100, latest 75 ⇒ DD = 0.25, which is inside [eMaxDD≈0.194, hardDD≈0.291).
    const snaps = [
      { timestamp: 1, equity: 80 },
      { timestamp: 2, equity: 100 }, // historical peak
      { timestamp: 3, equity: 90 },
      { timestamp: 4, equity: 75 }, // latest (deep DD)
    ];
    const dd = liveBookDrawdown(snaps);
    expect(dd).toBeCloseTo(0.25, 9);
    expect(dd).toBeGreaterThan(eMaxDD);
    expect(dd).toBeLessThan(hardDD);
    const mult = cppiExposureMultiplier({ drawdown: dd, eMaxDD, hardKillDD: hardDD });
    expect(mult).toBeLessThan(1); // CPPI cuts on a live drawdown
    expect(mult).toBeGreaterThan(0);
  });

  it('a drawdown at/below eMaxDD ⇒ no cut (mult == 1)', () => {
    // peak 100, latest 95 ⇒ DD = 0.05 < eMaxDD ⇒ full exposure.
    const snaps = [
      { timestamp: 1, equity: 100 },
      { timestamp: 2, equity: 95 },
    ];
    expect(liveBookDrawdown(snaps)).toBeCloseTo(0.05, 9);
    const mult = cppiExposureMultiplier({ drawdown: liveBookDrawdown(snaps), eMaxDD, hardKillDD: hardDD });
    expect(mult).toBe(1);
  });

  it('peak is HISTORICAL: an interim higher equity sets the peak even if latest is lower', () => {
    // The drawdown is anchored to the running historical peak, not just the last
    // two points. peak=130 (interim), latest=100 ⇒ DD = 1 - 100/130 ≈ 0.2308.
    const snaps = [
      { timestamp: 1, equity: 100 },
      { timestamp: 2, equity: 130 }, // historical peak
      { timestamp: 3, equity: 100 }, // latest
    ];
    expect(liveBookDrawdown(snaps)).toBeCloseTo(1 - 100 / 130, 9);
  });

  it('snapshots are ordered by timestamp before taking the latest', () => {
    // Out-of-order input: latest by timestamp is equity 70 (deep), not the last array element.
    const snaps = [
      { timestamp: 3, equity: 70 }, // latest chronologically
      { timestamp: 1, equity: 100 }, // peak
      { timestamp: 2, equity: 90 },
    ];
    expect(liveBookDrawdown(snaps)).toBeCloseTo(0.3, 9);
  });
});
