import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { router, publicProcedure } from '../../init';

export interface ScoreBucket {
  bucket: string;
  lo: number;
  hi: number;
  n: number;
  winRate: number;
  winRateStderr: number;
  meanPnlPct: number;
  meanPnlPctStderr: number;
  meanBarsHeld: number;
}

export interface LiveStatsResult {
  available: boolean;
  totalTrades: number;
  windowDays: number;
  buckets: ScoreBucket[];
  matchedBucket: ScoreBucket | null;
}

interface TradeRow {
  pnl_pct: number;
  bars_held: number;
  confluence_score: number;
}

const BUCKET_EDGES = [
  { bucket: '<4', lo: -Infinity, hi: 4 },
  { bucket: '4-5', lo: 4, hi: 5 },
  { bucket: '5-6', lo: 5, hi: 6 },
  { bucket: '6-7', lo: 6, hi: 7 },
  { bucket: '7+', lo: 7, hi: Infinity },
];

function findBucket(score: number) {
  return BUCKET_EDGES.find((b) => score >= b.lo && score < b.hi) ?? BUCKET_EDGES[BUCKET_EDGES.length - 1]!;
}

function bucketStats(rows: TradeRow[], lo: number, hi: number, label: string): ScoreBucket {
  const inBucket = rows.filter((r) => r.confluence_score >= lo && r.confluence_score < hi);
  const n = inBucket.length;
  if (n === 0) {
    return {
      bucket: label,
      lo,
      hi,
      n: 0,
      winRate: 0,
      winRateStderr: 0,
      meanPnlPct: 0,
      meanPnlPctStderr: 0,
      meanBarsHeld: 0,
    };
  }
  const wins = inBucket.filter((r) => r.pnl_pct > 0).length;
  const winRate = wins / n;
  const winRateStderr = Math.sqrt((winRate * (1 - winRate)) / n);
  const meanPnl = inBucket.reduce((s, r) => s + r.pnl_pct, 0) / n;
  const variance = inBucket.reduce((s, r) => s + (r.pnl_pct - meanPnl) ** 2, 0) / Math.max(1, n - 1);
  const meanPnlStderr = Math.sqrt(variance / n);
  const meanBars = inBucket.reduce((s, r) => s + r.bars_held, 0) / n;
  return {
    bucket: label,
    lo,
    hi,
    n,
    winRate,
    winRateStderr,
    meanPnlPct: meanPnl,
    meanPnlPctStderr: meanPnlStderr,
    meanBarsHeld: meanBars,
  };
}

export const liveStatsRouter = router({
  byScoreBucket: publicProcedure
    .input(
      z.object({
        strategy: z.string(),
        symbol: z.string().optional(),
        score: z.number().optional(),
        windowDays: z.number().int().positive().max(365).default(90),
      }),
    )
    .query(({ input }): LiveStatsResult => {
      const dbPath = path.resolve('data/ict-trading.db');
      if (!fs.existsSync(dbPath)) {
        return { available: false, totalTrades: 0, windowDays: input.windowDays, buckets: [], matchedBucket: null };
      }
      const db = new Database(dbPath, { readonly: true });
      try {
        const cutoff = Date.now() - input.windowDays * 86_400_000;
        const params: Array<string | number> = [input.strategy, cutoff];
        let where = `strategy = ? AND created_at >= ?`;
        if (input.symbol) {
          where += ` AND symbol = ?`;
          params.push(input.symbol);
        }
        const rows = db
          .prepare(`SELECT pnl_percent AS pnl_pct, bars_held, confluence_score FROM bot_trades WHERE ${where}`)
          .all(...params) as TradeRow[];
        const buckets = BUCKET_EDGES.map((b) => bucketStats(rows, b.lo, b.hi, b.bucket));
        const matched = input.score != null ? bucketStats(rows, findBucket(input.score).lo, findBucket(input.score).hi, findBucket(input.score).bucket) : null;
        return {
          available: true,
          totalTrades: rows.length,
          windowDays: input.windowDays,
          buckets,
          matchedBucket: matched,
        };
      } finally {
        db.close();
      }
    }),
});
