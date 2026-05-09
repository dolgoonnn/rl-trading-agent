import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readRecentCandles } from '@/lib/trpc/routers/dashboard/candles';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE bot_candles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL
    )
  `);
  return db;
}

describe('readRecentCandles', () => {
  it('returns last N rows for symbol ordered ascending by timestamp', () => {
    const db = makeDb();
    const ins = db.prepare('INSERT INTO bot_candles (symbol, timestamp, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < 5; i++) {
      ins.run('BTCUSDT', i * 1000, 100 + i, 110 + i, 90 + i, 105 + i, 1000);
    }
    ins.run('ETHUSDT', 999, 50, 55, 45, 52, 1000);
    const rows = readRecentCandles(db, 'BTCUSDT', 3);
    expect(rows).toHaveLength(3);
    expect(rows.map((r: { timestamp: number }) => r.timestamp)).toEqual([2000, 3000, 4000]);
    expect(rows[0]!.close).toBe(107);
  });

  it('returns empty when symbol has no rows', () => {
    expect(readRecentCandles(makeDb(), 'BTCUSDT', 10)).toEqual([]);
  });
});
