import { describe, it, expect } from 'vitest';
import {
  cppiExposureMultiplier,
  trailingPeakDrawdown,
  annualizedVol,
  volTargetLeverage,
  BARS_PER_YEAR_1H,
} from '@/lib/risk/sizing';
import { expectedMaxDD, hardKillDD } from '@/lib/bot/retirement';
import { getCppiExposureMultiplier } from '@/lib/bot/risk-engine';

/**
 * CPPI continuous drawdown cut, anchored to retirement.ts E[MaxDD]/hardKillDD:
 *   mult = clamp(1 - (DD - eMaxDD)/(hardKillDD - eMaxDD), 0, 1)
 * DD<=eMaxDD ⇒ 1.0; DD>=hardKillDD ⇒ 0.0; linear between. Floor input is a
 * TRAILING PEAK so the cushion resets (rises) on new equity highs. CRITICAL:
 * this is RECOVERABLE (rises as DD recovers) — it is NOT the latched kill.
 */

// Bounds from the frozen retirement config (reused, not re-derived).
const eMaxDD = expectedMaxDD({ sigmaAnnual: 0.12, sharpe: 2, horizonYears: 0.75 }); // ≈0.194
const hardDD = hardKillDD({ eMaxDD, bootstrapP5DD: 0.1 }); // ≈0.291

describe('cppiExposureMultiplier — clamp(1-(DD-eMaxDD)/(hardKillDD-eMaxDD),0,1)', () => {
  it('DD below eMaxDD ⇒ full exposure 1.0', () => {
    expect(cppiExposureMultiplier({ drawdown: 0, eMaxDD, hardKillDD: hardDD })).toBe(1);
    expect(cppiExposureMultiplier({ drawdown: 0.1, eMaxDD, hardKillDD: hardDD })).toBe(1);
    expect(cppiExposureMultiplier({ drawdown: eMaxDD, eMaxDD, hardKillDD: hardDD })).toBe(1);
  });

  it('DD at the midpoint ⇒ ~0.5 (linear taper)', () => {
    const mid = (eMaxDD + hardDD) / 2;
    expect(cppiExposureMultiplier({ drawdown: mid, eMaxDD, hardKillDD: hardDD })).toBeCloseTo(0.5, 9);
  });

  it('DD at/above hardKillDD ⇒ 0.0 exposure', () => {
    expect(cppiExposureMultiplier({ drawdown: hardDD, eMaxDD, hardKillDD: hardDD })).toBe(0);
    expect(cppiExposureMultiplier({ drawdown: hardDD + 0.05, eMaxDD, hardKillDD: hardDD })).toBe(0);
  });

  it('is monotonically non-increasing in drawdown', () => {
    let prev = Infinity;
    for (let dd = 0; dd <= 0.4; dd += 0.01) {
      const m = cppiExposureMultiplier({ drawdown: dd, eMaxDD, hardKillDD: hardDD });
      expect(m).toBeLessThanOrEqual(prev + 1e-12);
      prev = m;
    }
  });

  it('RECOVERABLE: as drawdown recovers, the multiplier rises back to 1.0 (NOT latched)', () => {
    const deep = cppiExposureMultiplier({ drawdown: hardDD - 0.001, eMaxDD, hardKillDD: hardDD });
    const recovered = cppiExposureMultiplier({ drawdown: 0.05, eMaxDD, hardKillDD: hardDD });
    expect(deep).toBeLessThan(0.05);
    expect(recovered).toBe(1); // unlike the kill-switch, CPPI un-cuts on recovery
  });
});

describe('trailingPeakDrawdown — peak floor rises with new equity highs', () => {
  it('drawdown is measured from the running peak', () => {
    // peak so far 120, equity 108 ⇒ DD = 1 - 108/120 = 0.10
    const r = trailingPeakDrawdown({ equity: 108, priorPeak: 120 });
    expect(r.drawdown).toBeCloseTo(0.1, 9);
    expect(r.peak).toBe(120);
  });

  it('a NEW equity high resets the peak and zeroes the drawdown', () => {
    const r = trailingPeakDrawdown({ equity: 130, priorPeak: 120 });
    expect(r.peak).toBe(130); // peak ratcheted up
    expect(r.drawdown).toBe(0);
  });

  it('composes: deeper trough after a higher peak gives a larger DD and thus lower CPPI mult', () => {
    const afterLowPeak = trailingPeakDrawdown({ equity: 100, priorPeak: 110 });
    const afterHighPeak = trailingPeakDrawdown({ equity: 100, priorPeak: 130 });
    expect(afterHighPeak.drawdown).toBeGreaterThan(afterLowPeak.drawdown);
    const mLow = cppiExposureMultiplier({ drawdown: afterLowPeak.drawdown, eMaxDD, hardKillDD: hardDD });
    const mHigh = cppiExposureMultiplier({ drawdown: afterHighPeak.drawdown, eMaxDD, hardKillDD: hardDD });
    expect(mHigh).toBeLessThanOrEqual(mLow);
  });
});

describe('CPPI composes with vol-target without going negative', () => {
  it('exposure = volTargetLeverage * cppiMult is bounded in [0, cap]', () => {
    const lev = volTargetLeverage({ realizedVol: 0.06, targetVol: 0.12, maxLeverage: 3 }); // 2x
    const dd = (eMaxDD + hardDD) / 2; // midpoint ⇒ ~0.5
    const mult = cppiExposureMultiplier({ drawdown: dd, eMaxDD, hardKillDD: hardDD });
    const exposure = lev * mult;
    expect(exposure).toBeGreaterThanOrEqual(0);
    expect(exposure).toBeLessThanOrEqual(3);
    expect(exposure).toBeCloseTo(2 * 0.5, 6);
  });
});

describe('risk-engine getCppiExposureMultiplier — exposed wrapper', () => {
  it('delegates to the pure CPPI math', () => {
    const mid = (eMaxDD + hardDD) / 2;
    expect(getCppiExposureMultiplier({ drawdown: mid, eMaxDD, hardKillDD: hardDD })).toBeCloseTo(0.5, 9);
    expect(getCppiExposureMultiplier({ drawdown: 0, eMaxDD, hardKillDD: hardDD })).toBe(1);
    expect(getCppiExposureMultiplier({ drawdown: hardDD, eMaxDD, hardKillDD: hardDD })).toBe(0);
  });
});

describe('ALL sizing must run on FUNDING-NET returns, never gross', () => {
  it('gross returns over-state vol-target leverage vs funding-net (gross over-levers)', () => {
    // Funding-net returns are the gross returns with the funding debit applied.
    // A consistently funding-paying long has SMALLER (more negative-shifted) net
    // returns → LOWER realized vol is NOT the point; the point is that sizing off
    // gross mis-states realized vol and thus leverage. Construct a case where the
    // gross series is calmer than the funding-net series, so gross → MORE leverage.
    const grossRets = [0.010, 0.011, 0.009, 0.010, 0.011, 0.009];
    // funding debit each bar is volatile (funding spikes), widening realized vol:
    const fundingDebit = [-0.001, -0.006, 0.004, -0.001, -0.007, 0.005];
    const netRets = grossRets.map((g, i) => g + fundingDebit[i]!);

    const grossVol = annualizedVol(grossRets, BARS_PER_YEAR_1H);
    const netVol = annualizedVol(netRets, BARS_PER_YEAR_1H);
    expect(netVol).toBeGreaterThan(grossVol); // funding noise widens realized vol

    const levGross = volTargetLeverage({ realizedVol: grossVol, targetVol: 0.12, maxLeverage: 10 });
    const levNet = volTargetLeverage({ realizedVol: netVol, targetVol: 0.12, maxLeverage: 10 });
    // Sizing off GROSS would over-lever (lower perceived vol ⇒ higher leverage).
    expect(levGross).toBeGreaterThan(levNet);
  });
});
