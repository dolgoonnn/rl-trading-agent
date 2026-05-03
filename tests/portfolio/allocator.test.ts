import { describe, it, expect } from 'vitest';
import { computeInverseVolWeights } from '@/lib/portfolio/allocator';

describe('computeInverseVolWeights', () => {
  it('gives equal weight when vols are equal', () => {
    const series = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    const inputs = [
      { strategy: 'ict-3sym' as const, dailyReturns: series },
      { strategy: 'f2f-gold' as const, dailyReturns: series },
    ];
    const r = computeInverseVolWeights(inputs);
    expect(r.allocations).toHaveLength(2);
    expect(r.allocations[0]!.weight).toBeCloseTo(0.5, 6);
    expect(r.allocations[1]!.weight).toBeCloseTo(0.5, 6);
    expect(r.warnings).toEqual([]);
  });

  it('underweights the higher-vol strategy', () => {
    const lowVol = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.001 : -0.001));
    const highVol = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    const r = computeInverseVolWeights([
      { strategy: 'ict-3sym', dailyReturns: highVol },
      { strategy: 'f2f-gold', dailyReturns: lowVol },
    ]);
    const crypto = r.allocations.find((a) => a.strategy === 'ict-3sym')!;
    const gold = r.allocations.find((a) => a.strategy === 'f2f-gold')!;
    expect(gold.weight).toBeGreaterThan(crypto.weight);
    expect(crypto.weight + gold.weight).toBeCloseTo(1, 6);
  });

  it('excludes a strategy with fewer than 30 returns and warns', () => {
    const r = computeInverseVolWeights([
      { strategy: 'ict-3sym', dailyReturns: Array(50).fill(0).map((_, i) => (i % 2 ? 0.005 : -0.005)) },
      { strategy: 'f2f-gold', dailyReturns: [0.01, -0.01, 0.01] }, // cold start
    ]);
    expect(r.allocations.find((a) => a.strategy === 'ict-3sym')!.weight).toBeCloseTo(1, 6);
    const gold = r.allocations.find((a) => a.strategy === 'f2f-gold')!;
    expect(gold.excluded?.reason).toMatch(/insufficient/i);
    expect(gold.weight).toBe(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('returns annualized vol on each allocation', () => {
    const constantVol = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    const r = computeInverseVolWeights([
      { strategy: 'ict-3sym', dailyReturns: constantVol },
    ]);
    // stdev of [0.01, -0.01, 0.01, -0.01, ...] is 0.01; annualized = 0.01 * sqrt(252) ≈ 0.1587
    expect(r.allocations[0]!.annualizedVol).toBeCloseTo(0.01 * Math.sqrt(252), 2);
  });
});
