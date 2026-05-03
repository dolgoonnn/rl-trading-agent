import type { EquityPoint } from './types';

const MS_PER_DAY = 86_400_000;

function utcMidnightFloor(ts: number): number {
  return Math.floor(ts / MS_PER_DAY) * MS_PER_DAY;
}

export function resampleToUtcDaily(points: EquityPoint[]): EquityPoint[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a.timestamp - b.timestamp);
  const byDay = new Map<number, EquityPoint>();
  for (const p of sorted) {
    const day = utcMidnightFloor(p.timestamp);
    byDay.set(day, { timestamp: day, equity: p.equity });
  }
  return [...byDay.values()].sort((a, b) => a.timestamp - b.timestamp);
}
