import type { Database as BetterSqlite3Database } from 'better-sqlite3';
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

export function toDailyReturns(series: EquityPoint[]): number[] {
  if (series.length < 2) return [];
  const out: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]!.equity;
    const curr = series[i]!.equity;
    if (prev === 0) continue;
    out.push(curr / prev - 1);
  }
  return out;
}

interface EquityRow {
  timestamp: number;
  equity: number;
}

export function readCryptoEquityFromDb(
  db: BetterSqlite3Database,
): EquityPoint[] {
  const rows = db
    .prepare(
      'SELECT timestamp, equity FROM bot_equity_snapshots ORDER BY timestamp ASC',
    )
    .all() as EquityRow[];
  return rows.map((r: EquityRow) => ({ timestamp: r.timestamp, equity: r.equity }));
}
