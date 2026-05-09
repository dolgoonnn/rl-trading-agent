import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { z } from 'zod';
import { router, publicProcedure } from '../../init';

interface CandleRow {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function readRecentCandles(
  db: BetterSqlite3Database,
  symbol: string,
  n: number,
): CandleRow[] {
  const rows = db
    .prepare(
      `SELECT timestamp, open, high, low, close, volume
       FROM bot_candles
       WHERE symbol = ?
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(symbol, n) as CandleRow[];
  return rows.reverse();
}

function openDb(): BetterSqlite3Database | null {
  const dbPath = path.resolve('data/app.db');
  if (!fs.existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true });
}

export const candlesRouter = router({
  recent: publicProcedure
    .input(z.object({ symbol: z.string(), n: z.number().int().positive().max(2000) }))
    .query(({ input }) => {
      const db = openDb();
      if (!db) return { available: false as const, candles: [] };
      try {
        const candles = readRecentCandles(db, input.symbol, input.n);
        return { available: true as const, candles };
      } finally {
        db.close();
      }
    }),
});
