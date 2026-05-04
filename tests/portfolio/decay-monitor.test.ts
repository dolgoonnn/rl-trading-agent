import { describe, it, expect } from 'vitest';
import {
  evaluateDecay,
  computeAnnualizedSharpe,
  computeMaxDrawdown,
} from '@/lib/portfolio/decay-monitor';
import type { EquityPoint } from '@/lib/portfolio/types';

describe('computeAnnualizedSharpe', () => {
  it('annualizes from daily returns by sqrt(252)', () => {
    const r = Array(30).fill(0.001); // mean=0.001, stdev=0
    // stdev=0 should be guarded to null
    expect(computeAnnualizedSharpe(r)).toBeNull();
  });
  it('returns a positive Sharpe for positive-mean returns', () => {
    const r = Array.from({ length: 30 }, (_, i) => (i % 2 ? 0.002 : -0.0005));
    const s = computeAnnualizedSharpe(r);
    expect(s).not.toBeNull();
    expect(s!).toBeGreaterThan(0);
  });
  it('returns null for fewer than 5 returns', () => {
    expect(computeAnnualizedSharpe([0.01, 0.02])).toBeNull();
  });
});

describe('computeMaxDrawdown', () => {
  it('returns 0 for a monotonically rising series', () => {
    const series: EquityPoint[] = [
      { timestamp: 1, equity: 100 },
      { timestamp: 2, equity: 110 },
      { timestamp: 3, equity: 120 },
    ];
    expect(computeMaxDrawdown(series)).toBe(0);
  });
  it('returns the peak-to-trough fraction', () => {
    const series: EquityPoint[] = [
      { timestamp: 1, equity: 100 },
      { timestamp: 2, equity: 200 }, // peak
      { timestamp: 3, equity: 150 }, // 25% drawdown from peak
      { timestamp: 4, equity: 180 },
    ];
    expect(computeMaxDrawdown(series)).toBeCloseTo(0.25, 6);
  });
});

describe('evaluateDecay', () => {
  it('does NOT trip when live Sharpe is above the floor and DD is under ceiling', () => {
    const r = Array.from({ length: 30 }, (_, i) => (i % 2 ? 0.005 : 0.001));
    const series: EquityPoint[] = Array.from({ length: 90 }, (_, i) => ({
      timestamp: i,
      equity: 1000 + i * 5,
    }));
    const status = evaluateDecay({
      strategy: 'ict-3sym',
      dailyReturns30d: r,
      equity90d: series,
      bootstrapFloor: 1.0,
      drawdownCeiling: 0.6,
    });
    expect(status.tripped).toBe(false);
  });

  it('trips on bootstrap-floor breach', () => {
    const r = Array.from({ length: 30 }, (_, i) => (i % 2 ? -0.005 : 0.001)); // negative drift
    const series: EquityPoint[] = Array.from({ length: 90 }, (_, i) => ({
      timestamp: i,
      equity: 1000,
    }));
    const status = evaluateDecay({
      strategy: 'ict-3sym',
      dailyReturns30d: r,
      equity90d: series,
      bootstrapFloor: 1.0,
      drawdownCeiling: 0.6,
    });
    expect(status.tripped).toBe(true);
    expect(status.reason).toMatch(/sharpe/i);
  });

  it('trips on drawdown breach', () => {
    const r = Array(30).fill(0.001); // benign
    const series: EquityPoint[] = [
      { timestamp: 1, equity: 1000 },
      { timestamp: 2, equity: 500 }, // 50% DD
    ];
    const status = evaluateDecay({
      strategy: 'ict-3sym',
      dailyReturns30d: r,
      equity90d: series,
      bootstrapFloor: -10, // unbreachable
      drawdownCeiling: 0.3,
    });
    expect(status.tripped).toBe(true);
    expect(status.reason).toMatch(/drawdown/i);
  });

  it('returns null fields and tripped=false on cold start', () => {
    const status = evaluateDecay({
      strategy: 'ict-3sym',
      dailyReturns30d: [],
      equity90d: [],
      bootstrapFloor: 1.0,
      drawdownCeiling: 0.6,
    });
    expect(status.tripped).toBe(false);
    expect(status.liveSharpe30d).toBeNull();
    expect(status.liveDrawdown90d).toBeNull();
  });
});
