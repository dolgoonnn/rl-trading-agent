import { describe, it, expect } from 'vitest';
import {
  deflatedSharpePerObs,
  annualizedToPerObs,
  HOURLY_ANNUALIZATION_FACTOR,
} from '../../src/lib/rl/utils/deflated-sharpe';

describe('annualizedToPerObs — undo the annualization for honest deflation', () => {
  it('divides by the annualization factor', () => {
    expect(annualizedToPerObs(9.36, HOURLY_ANNUALIZATION_FACTOR)).toBeCloseTo(0.1, 3);
  });

  it('round-trips: perObs * factor / factor', () => {
    const perObs = 0.0817;
    const annualized = perObs * HOURLY_ANNUALIZATION_FACTOR;
    expect(annualizedToPerObs(annualized, HOURLY_ANNUALIZATION_FACTOR)).toBeCloseTo(perObs, 6);
  });

  it('HOURLY_ANNUALIZATION_FACTOR equals sqrt(365*24)', () => {
    expect(HOURLY_ANNUALIZATION_FACTOR).toBeCloseTo(Math.sqrt(365 * 24), 6);
  });
});

describe('deflatedSharpePerObs — honest DSR on the per-observation frequency', () => {
  it('deflates a per-trade Sharpe with per-trade T (not the annualized one)', () => {
    // The deployed 3-symbol book: annualized SR 8.772, 555 trades, 238 trials,
    // skew 0.6118, kurt 2.9856. Honest per-trade SR ≈ 8.772 / 93.59 = 0.0937.
    const perObsSharpe = annualizedToPerObs(8.772073619351088, HOURLY_ANNUALIZATION_FACTOR);
    const r = deflatedSharpePerObs({
      perObsSharpe,
      numObservations: 555,
      numTrials: 238,
      skewness: 0.611826495858526,
      kurtosis: 2.9856276851319072,
    });
    // The honest per-obs DSR is dramatically smaller than the annualized 7.58 —
    // in fact it does NOT clear zero at an honest trial count.
    expect(r.deflatedSharpe).toBeLessThan(0.1);
    expect(r.deflatedSharpe).toBeLessThan(r.perObsSharpe);
    expect(r.isSignificant).toBe(r.deflatedSharpe > 0);
  });

  it('a genuinely strong per-obs Sharpe still passes', () => {
    // A per-trade SR of 0.5 over 500 trades, 10 trials — real edge survives.
    const r = deflatedSharpePerObs({
      perObsSharpe: 0.5,
      numObservations: 500,
      numTrials: 10,
    });
    expect(r.deflatedSharpe).toBeGreaterThan(0);
    expect(r.isSignificant).toBe(true);
  });

  it('haircut grows with trial count (winner-curse correction)', () => {
    const few = deflatedSharpePerObs({ perObsSharpe: 0.2, numObservations: 500, numTrials: 5 });
    const many = deflatedSharpePerObs({ perObsSharpe: 0.2, numObservations: 500, numTrials: 500 });
    expect(many.haircut).toBeGreaterThan(few.haircut);
  });

  it('haircut shrinks with more observations (tighter SR estimate)', () => {
    const short = deflatedSharpePerObs({ perObsSharpe: 0.2, numObservations: 100, numTrials: 50 });
    const long = deflatedSharpePerObs({ perObsSharpe: 0.2, numObservations: 5000, numTrials: 50 });
    expect(long.haircut).toBeLessThan(short.haircut);
  });

  it('exposes the inflation: annualized-into-per-obs-T overstates DSR by ~50x here', () => {
    // Same book, deflated the WRONG way (annualized SR, per-trade T) vs the right way.
    const wrong = deflatedSharpePerObs({
      perObsSharpe: 8.772073619351088, // annualized number fed in as if per-obs — the bug
      numObservations: 555,
      numTrials: 238,
      skewness: 0.611826495858526,
      kurtosis: 2.9856276851319072,
    });
    const right = deflatedSharpePerObs({
      perObsSharpe: annualizedToPerObs(8.772073619351088, HOURLY_ANNUALIZATION_FACTOR),
      numObservations: 555,
      numTrials: 238,
      skewness: 0.611826495858526,
      kurtosis: 2.9856276851319072,
    });
    expect(wrong.deflatedSharpe).toBeGreaterThan(7); // reproduces the reported ~7.58
    expect(right.deflatedSharpe).toBeLessThan(0.2); // honest reality
  });
});
