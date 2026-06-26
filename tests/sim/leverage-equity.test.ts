import { describe, it, expect } from 'vitest';
import { buildLeverageEquityCurve } from '../../src/lib/sim/leverage-equity';

const OPTS = { leverage: 10, f: 0.1, mmr: 0.005, liqFeeFrac: 0.005 };

describe('buildLeverageEquityCurve', () => {
  it('empty trades → identity result', () => {
    const result = buildLeverageEquityCurve([], OPTS);
    expect(result.leverage).toBe(10);
    expect(result.terminalWealth).toBe(1);
    expect(result.liqRate).toBe(0);
    expect(result.maxDD).toBe(0);
    expect(result.blown).toBe(false);
    expect(result.equityCurve).toEqual([1]);
    expect(result.stepReturns).toEqual([]);
  });

  it('3-trade fixture: normal → liquidated → normal loss', () => {
    // f=0.1, leverage=10, liqFeeFrac=0.005
    // t1: non-liq, netReturn=+0.02 → E = 1*(1 + 10*0.1*0.02) = 1*(1+0.02) = 1.02
    // t2: liquidated → E = 1.02*(1−0.1−0.005) = 1.02*0.895 = 0.9129
    // t3: non-liq, netReturn=−0.01 → E = 0.9129*(1 + 10*0.1*(−0.01)) = 0.9129*(1−0.01) = 0.9129*0.99 = 0.903771
    const trades = [
      { netReturn: 0.02, liquidated: false },
      { netReturn: 0, liquidated: true },
      { netReturn: -0.01, liquidated: false },
    ];
    const result = buildLeverageEquityCurve(trades, OPTS);

    expect(result.terminalWealth).toBeCloseTo(0.903771, 6);
    expect(result.liqRate).toBeCloseTo(1 / 3, 6);
    // maxDD = max peak-to-trough; peak after t1 = 1.02, trough after t2 = 0.9129
    // DD at t2 = (1.02 - 0.9129) / 1.02 = 0.1071 / 1.02
    // DD at t3 = (1.02 - 0.903771) / 1.02 = 0.116229 / 1.02 ← deepest
    const expectedMaxDD = (1.02 - 0.903771) / 1.02;
    expect(result.maxDD).toBeCloseTo(expectedMaxDD, 6);
    expect(result.blown).toBe(false);
    expect(result.equityCurve.length).toBe(4); // [1.0, 1.02, 0.9129, 0.903771]
    expect(result.equityCurve[0]).toBe(1);
    expect(result.equityCurve[1]).toBeCloseTo(1.02, 6);
    expect(result.equityCurve[2]).toBeCloseTo(0.9129, 6);
    expect(result.equityCurve[3]).toBeCloseTo(0.903771, 6);
  });

  it('ruin case: non-liq trade wipes equity, subsequent trade does not recover', () => {
    // f=0.5, leverage=10, liqFeeFrac=0.005
    // t1: non-liq, netReturn=−0.25 → E = 1*(1 + 10*0.5*(−0.25)) = 1*(1−1.25) = −0.25 → clamped to 0
    // t2: non-liq, whatever → already blown, stays 0
    const ruinOpts = { leverage: 10, f: 0.5, mmr: 0.005, liqFeeFrac: 0.005 };
    const trades = [
      { netReturn: -0.25, liquidated: false },
      { netReturn: 0.5, liquidated: false },
    ];
    const result = buildLeverageEquityCurve(trades, ruinOpts);

    expect(result.blown).toBe(true);
    expect(result.terminalWealth).toBe(0);
    expect(result.equityCurve[1]).toBe(0); // clamped after t1
    expect(result.equityCurve[2]).toBe(0); // stays 0 after t2
    expect(result.stepReturns[1]).toBe(0); // step return from already-0 state
  });

  it('leverage field is reflected in result', () => {
    const result = buildLeverageEquityCurve([], { ...OPTS, leverage: 5 });
    expect(result.leverage).toBe(5);
  });
});
