import { describe, it, expect } from 'vitest';
import { computeAnnualizedSharpeFromReturns } from '@/lib/funding-arb-validation/sharpe';

describe('computeAnnualizedSharpeFromReturns', () => {
  it('returns null for fewer than 5 returns', () => {
    expect(computeAnnualizedSharpeFromReturns([0.01, 0.02], 50)).toBeNull();
  });

  it('returns null for zero stdev', () => {
    expect(
      computeAnnualizedSharpeFromReturns(Array(30).fill(0.001), 50),
    ).toBeNull();
  });

  it('annualizes positive-mean returns by sqrt(tradesPerYear)', () => {
    const returns = Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0 ? 0.005 : -0.001,
    );
    const s = computeAnnualizedSharpeFromReturns(returns, 50);
    expect(s).not.toBeNull();
    expect(s!).toBeGreaterThan(3);
    expect(s!).toBeLessThan(7);
  });
});
