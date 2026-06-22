import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { router, publicProcedure } from '../../init';
import { detectRegime, regimeLabel } from '@/lib/ict/regime-detector';
import type { Candle } from '@/types';
import { readRecentCandles } from './candles';

const HOUR_MS = 3_600_000;

export type Timeframe = '1H' | '4H' | '1D';

const BUCKET_HOURS: Record<Timeframe, number> = { '1H': 1, '4H': 4, '1D': 24 };

export function resampleCandles(hourly: Candle[], tf: Timeframe): Candle[] {
  if (tf === '1H') return hourly;
  const bucket = BUCKET_HOURS[tf];
  const bucketMs = bucket * HOUR_MS;
  const out: Candle[] = [];
  for (let i = 0; i + bucket <= hourly.length; i += bucket) {
    const slice = hourly.slice(i, i + bucket);
    const first = slice[0]!;
    const last = slice[slice.length - 1]!;
    if (last.timestamp - first.timestamp !== bucketMs - HOUR_MS) {
      continue;
    }
    out.push({
      timestamp: first.timestamp,
      open: first.open,
      high: Math.max(...slice.map((s: Candle) => s.high)),
      low: Math.min(...slice.map((s: Candle) => s.low)),
      close: last.close,
      volume: slice.reduce((s: number, x: Candle) => s + x.volume, 0),
    });
  }
  return out;
}

export const biasRouter = router({
  scan: publicProcedure
    .input(
      z.object({
        symbols: z.array(z.string()).min(1),
        timeframes: z.array(z.enum(['1H', '4H', '1D'])).min(1),
      }),
    )
    .query(({ input }) => {
      const dbPath = path.resolve('data/ict-trading.db');
      if (!fs.existsSync(dbPath)) {
        return {
          available: false as const,
          cells: [] as Array<{
            symbol: string;
            timeframe: Timeframe;
            regime: string;
            volRegime: string;
            confidence: number;
            lastUpdated: number;
          }>,
        };
      }
      const db = new Database(dbPath, { readonly: true });
      const cells: Array<{
        symbol: string;
        timeframe: Timeframe;
        regime: string;
        volRegime: string;
        confidence: number;
        lastUpdated: number;
      }> = [];
      try {
        for (const symbol of input.symbols) {
          const hourly = readRecentCandles(db, symbol, 4800) as Candle[];
          for (const tf of input.timeframes as Timeframe[]) {
            const bars = resampleCandles(hourly, tf);
            if (bars.length < 20) {
              cells.push({
                symbol,
                timeframe: tf,
                regime: 'unknown',
                volRegime: 'normal',
                confidence: 0,
                lastUpdated: bars[bars.length - 1]?.timestamp ?? 0,
              });
              continue;
            }
            const r = detectRegime(bars, bars.length - 1);
            cells.push({
              symbol,
              timeframe: tf,
              regime: r.trend,
              volRegime: r.volatility,
              confidence: r.confidence,
              lastUpdated: bars[bars.length - 1]!.timestamp,
            });
          }
        }
      } finally {
        db.close();
      }
      return { available: true as const, cells };
    }),
});

export { regimeLabel };
