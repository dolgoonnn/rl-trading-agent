import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  resampleToUtcDaily,
  toDailyReturns,
  readCryptoEquityFromDb,
  readGoldDailyReturnsFromJson,
  getDailyReturnsForStrategy,
  type EquitySources,
} from '@/lib/portfolio/equity-source';
import type { EquityPoint } from '@/lib/portfolio/types';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

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
    expect(out.map((p: EquityPoint) => new Date(p.timestamp).toISOString())).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-04T00:00:00.000Z',
    ]);
  });
});

describe('toDailyReturns', () => {
  it('computes simple daily returns from a daily-resampled series', () => {
    const series: EquityPoint[] = [
      { timestamp: D('2026-01-01T00:00:00Z'), equity: 1000 },
      { timestamp: D('2026-01-02T00:00:00Z'), equity: 1010 },
      { timestamp: D('2026-01-03T00:00:00Z'), equity: 990 },
    ];
    const r = toDailyReturns(series);
    expect(r).toHaveLength(2);
    expect(r[0]).toBeCloseTo(0.01, 6);
    expect(r[1]).toBeCloseTo(-0.01980198, 6);
  });

  it('returns empty when fewer than 2 points', () => {
    expect(toDailyReturns([])).toEqual([]);
    expect(
      toDailyReturns([{ timestamp: 0, equity: 100 }]),
    ).toEqual([]);
  });
});

function makeFixtureDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE bot_equity_snapshots (
      id INTEGER PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      equity REAL NOT NULL,
      peak_equity REAL NOT NULL DEFAULT 0,
      drawdown REAL NOT NULL DEFAULT 0,
      open_positions INTEGER NOT NULL DEFAULT 0,
      daily_pnl REAL NOT NULL DEFAULT 0,
      cumulative_pnl REAL NOT NULL DEFAULT 0
    )
  `);
  const insert = db.prepare(
    'INSERT INTO bot_equity_snapshots (timestamp, equity) VALUES (?, ?)',
  );
  insert.run(D('2026-01-01T05:00:00Z'), 1000);
  insert.run(D('2026-01-01T18:00:00Z'), 1010);
  insert.run(D('2026-01-02T03:00:00Z'), 1020);
  return db;
}

describe('readCryptoEquityFromDb', () => {
  it('returns rows ordered by timestamp', () => {
    const db = makeFixtureDb();
    const rows = readCryptoEquityFromDb(db);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.equity).toBe(1000);
    expect(rows[2]!.equity).toBe(1020);
  });

  it('returns empty when table is empty', () => {
    const db = new Database(':memory:');
    db.exec(
      'CREATE TABLE bot_equity_snapshots (id INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL, equity REAL NOT NULL)',
    );
    expect(readCryptoEquityFromDb(db)).toEqual([]);
  });
});

function writeGoldFixture(state: object): string {
  const p = path.join(os.tmpdir(), `gold-fixture-${Date.now()}.json`);
  fs.writeFileSync(p, JSON.stringify(state));
  return p;
}

describe('readGoldDailyReturnsFromJson', () => {
  it('returns the rolling30dReturns array', () => {
    const p = writeGoldFixture({
      equity: 10500,
      initialCapital: 10000,
      rolling30dReturns: [0.01, -0.005, 0.02, 0],
    });
    expect(readGoldDailyReturnsFromJson(p)).toEqual([0.01, -0.005, 0.02, 0]);
  });

  it('returns empty when state is missing the field', () => {
    const p = writeGoldFixture({ equity: 10000 });
    expect(readGoldDailyReturnsFromJson(p)).toEqual([]);
  });

  it('returns empty when file does not exist', () => {
    expect(
      readGoldDailyReturnsFromJson('/tmp/definitely-not-real-12345.json'),
    ).toEqual([]);
  });
});

describe('getDailyReturnsForStrategy', () => {
  it('routes ict-3sym through the crypto reader and returns truncated tail', () => {
    const db = makeFixtureDb();
    // Add daily snapshots for 5 distinct UTC days
    const insert = db.prepare(
      'INSERT INTO bot_equity_snapshots (timestamp, equity) VALUES (?, ?)',
    );
    insert.run(D('2026-01-04T12:00:00Z'), 1030);
    insert.run(D('2026-01-05T12:00:00Z'), 1040);

    const sources: EquitySources = {
      cryptoDb: db,
      goldStatePath: '/tmp/missing.json',
    };
    const r = getDailyReturnsForStrategy('ict-3sym', 60, sources);
    // 4 distinct UTC days resampled → 3 daily returns
    expect(r).toHaveLength(3);
  });

  it('routes f2f-gold through the gold reader', () => {
    const p = writeGoldFixture({
      rolling30dReturns: Array(40).fill(0.001),
    });
    const sources: EquitySources = {
      cryptoDb: null,
      goldStatePath: p,
    };
    const r = getDailyReturnsForStrategy('f2f-gold', 30, sources);
    expect(r).toHaveLength(30); // last 30 of 40
  });
});
