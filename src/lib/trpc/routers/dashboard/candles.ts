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

export function botCandlesTableExists(db: BetterSqlite3Database): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='bot_candles' LIMIT 1`)
    .get() as { name: string } | undefined;
  return !!row;
}

const JSON_FALLBACKS: Record<string, string> = {
  XAUUSD: 'data/GC_F_1h.json',
  XAUTUSDT: 'data/GC_F_1h.json',
  GC_F: 'data/GC_F_1h.json',
};

let jsonCache: Map<string, { mtimeMs: number; rows: CandleRow[] }> = new Map();

function readJsonFallback(symbol: string, n: number): CandleRow[] {
  const rel = JSON_FALLBACKS[symbol.toUpperCase()];
  if (!rel) return [];
  const abs = path.resolve(rel);
  if (!fs.existsSync(abs)) return [];
  const stat = fs.statSync(abs);
  let cached = jsonCache.get(abs);
  if (!cached || cached.mtimeMs !== stat.mtimeMs) {
    const raw = fs.readFileSync(abs, 'utf-8');
    const parsed = JSON.parse(raw) as CandleRow[];
    cached = { mtimeMs: stat.mtimeMs, rows: parsed };
    jsonCache.set(abs, cached);
  }
  return cached.rows.slice(-n);
}

export function readRecentCandles(
  db: BetterSqlite3Database,
  symbol: string,
  n: number,
): CandleRow[] {
  if (botCandlesTableExists(db)) {
    const rows = db
      .prepare(
        `SELECT timestamp, open, high, low, close, volume
         FROM bot_candles
         WHERE symbol = ?
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .all(symbol, n) as CandleRow[];
    if (rows.length > 0) return rows.reverse();
  }
  return readJsonFallback(symbol, n);
}

function openDb(): BetterSqlite3Database | null {
  const dbPath = path.resolve('data/ict-trading.db');
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
