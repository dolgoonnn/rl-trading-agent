import { describe, it, expect } from 'vitest';
import { resampleToUtcDaily } from '@/lib/portfolio/equity-source';
import type { EquityPoint } from '@/lib/portfolio/types';

const D = (utc: string) => new Date(utc).getTime();

describe('resampleToUtcDaily', () => {
  it('keeps the last point at-or-before each UTC midnight', () => {
    const points: EquityPoint[] = [
      { timestamp: D('2026-01-01T05:00:00Z'), equity: 1000 },
      { timestamp: D('2026-01-01T18:00:00Z'), equity: 1010 },
      { timestamp: D('2026-01-02T03:00:00Z'), equity: 1020 },
      { timestamp: D('2026-01-02T20:00:00Z'), equity: 1015 },
      { timestamp: D('2026-01-03T01:00:00Z'), equity: 1030 },
    ];
    const out = resampleToUtcDaily(points);
    expect(out).toEqual([
      { timestamp: D('2026-01-01T00:00:00Z'), equity: 1010 },
      { timestamp: D('2026-01-02T00:00:00Z'), equity: 1015 },
      { timestamp: D('2026-01-03T00:00:00Z'), equity: 1030 },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(resampleToUtcDaily([])).toEqual([]);
  });

  it('drops days with no samples (gap)', () => {
    const points: EquityPoint[] = [
      { timestamp: D('2026-01-01T12:00:00Z'), equity: 1000 },
      { timestamp: D('2026-01-04T12:00:00Z'), equity: 1100 },
    ];
    const out = resampleToUtcDaily(points);
    expect(out.map((p) => new Date(p.timestamp).toISOString())).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-04T00:00:00.000Z',
    ]);
  });
});
