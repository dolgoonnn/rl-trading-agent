import { describe, it, expect } from 'vitest';
import { noTradeBand } from '@/lib/risk/sizing';

/**
 * No-trade band: rebalance ONLY when the leverage gap exceeds the band
 * `max(absTol, relTol*targetLev)`; otherwise HOLD the current leverage. This
 * suppresses churn → less funding/fee bleed from chasing tiny target moves.
 */

describe('noTradeBand — rebalance only when |cur-tgt| > max(absTol, relTol*tgt)', () => {
  it('WITHIN band ⇒ hold (rebalance:false, newLev = currentLev)', () => {
    // band = max(0.10, 0.20*2.0) = 0.40; gap = 0.30 < 0.40 ⇒ hold
    const r = noTradeBand({ currentLev: 2.0, targetLev: 2.3, absTol: 0.1, relTol: 0.2 });
    expect(r.rebalance).toBe(false);
    expect(r.newLev).toBe(2.0); // held at CURRENT, not target
  });

  it('OUTSIDE band ⇒ rebalance to target', () => {
    // band = max(0.10, 0.20*2.6) = 0.52; gap = |2.0-2.6| = 0.60 > 0.52 ⇒ rebalance
    const r = noTradeBand({ currentLev: 2.0, targetLev: 2.6, absTol: 0.1, relTol: 0.2 });
    expect(r.rebalance).toBe(true);
    expect(r.newLev).toBe(2.6);
  });

  it('absTol dominates for small target leverage', () => {
    // tgt=0.2 ⇒ band = max(0.10, 0.04) = 0.10; gap = 0.15 > 0.10 ⇒ rebalance
    const r = noTradeBand({ currentLev: 0.05, targetLev: 0.2, absTol: 0.1, relTol: 0.2 });
    expect(r.rebalance).toBe(true);
    expect(r.newLev).toBe(0.2);
  });

  it('BOUNDARY: gap exactly at the band edge ⇒ HOLD (strict > triggers)', () => {
    // Hold target fixed (band = max(0.10, 0.20*2.0) = 0.40) and place current
    // exactly 0.40 away ⇒ gap == band ⇒ NOT > band ⇒ hold.
    const r = noTradeBand({ currentLev: 2.4, targetLev: 2.0, absTol: 0.1, relTol: 0.2 });
    expect(r.rebalance).toBe(false);
    expect(r.newLev).toBe(2.4);
  });

  it('BOUNDARY: gap one epsilon past the edge ⇒ rebalance', () => {
    // Same fixed target (band 0.40); current 0.40+1e-9 away ⇒ gap > band ⇒ rebalance.
    const r = noTradeBand({ currentLev: 2.4 + 1e-9, targetLev: 2.0, absTol: 0.1, relTol: 0.2 });
    expect(r.rebalance).toBe(true);
    expect(r.newLev).toBe(2.0);
  });

  it('PROTECTIVE STAND-DOWN: targetLev=0 ALWAYS rebalances to flat (band never swallows it)', () => {
    // Kelly stand-down (deflatedSharpe<=0) sets targetLev=0. A small current
    // leverage inside the band must NOT be held — going flat is protective and
    // must bypass the band. band = max(0.10, 0.20*0) = 0.10; gap = 0.08 < band,
    // so the ordinary band would HOLD — but a 0 target must override.
    const r = noTradeBand({ currentLev: 0.08, targetLev: 0, absTol: 0.1, relTol: 0.2 });
    expect(r.rebalance).toBe(true);
    expect(r.newLev).toBe(0);
  });

  it('PROTECTIVE STAND-DOWN: targetLev=0 from a larger current also goes flat', () => {
    const r = noTradeBand({ currentLev: 2.0, targetLev: 0, absTol: 0.1, relTol: 0.2 });
    expect(r.rebalance).toBe(true);
    expect(r.newLev).toBe(0);
  });

  it('TURNOVER: banded rebalancing turns over far less than unconditional over a wiggly target path', () => {
    // A noisy target oscillating around 2.0 — unconditional rebalances every step;
    // the band holds through the small wiggles and only acts on real moves.
    const targets = [2.0, 2.05, 1.98, 2.1, 1.95, 2.6, 2.55, 2.0, 2.02, 1.5];
    const absTol = 0.1;
    const relTol = 0.2;

    // Unconditional: turnover = sum of |target_t - target_{t-1}| (rebalance every step)
    let unconditionalTurnover = 0;
    for (let i = 1; i < targets.length; i++) {
      unconditionalTurnover += Math.abs(targets[i]! - targets[i - 1]!);
    }

    // Banded: only move when outside the band; turnover = sum of actual lev changes
    let bandedTurnover = 0;
    let rebalanceCount = 0;
    let cur = targets[0]!;
    for (let i = 1; i < targets.length; i++) {
      const res = noTradeBand({ currentLev: cur, targetLev: targets[i]!, absTol, relTol });
      if (res.rebalance) {
        bandedTurnover += Math.abs(res.newLev - cur);
        rebalanceCount++;
      }
      cur = res.newLev;
    }

    expect(bandedTurnover).toBeLessThan(unconditionalTurnover);
    expect(rebalanceCount).toBeLessThan(targets.length - 1);
  });
});
