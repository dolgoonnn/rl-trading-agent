import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { router, publicProcedure } from '../../init';
import { SignalEngine } from '@/lib/bot/signal-engine';
import type { BotSymbol } from '@/types/bot';
import type { Candle } from '@/types';
import { readRecentCandles } from './candles';

export const setupsRouter = router({
  live: publicProcedure
    .input(
      z.object({
        symbol: z.string(),
        candleCount: z.number().int().min(100).max(2000).default(500),
      }),
    )
    .query(({ input }) => {
      const dbPath = path.resolve('data/app.db');
      if (!fs.existsSync(dbPath)) {
        return {
          available: false as const,
          signal: null,
          allScored: [],
          regime: 'unknown',
          reasoning: [] as string[],
        };
      }
      const db = new Database(dbPath, { readonly: true });
      try {
        const candles = readRecentCandles(db, input.symbol, input.candleCount) as Candle[];
        if (candles.length < 50) {
          return {
            available: true as const,
            signal: null,
            allScored: [],
            regime: 'unknown',
            reasoning: ['Insufficient candle history'],
          };
        }
        const engine = new SignalEngine();
        const result = engine.evaluate(candles, input.symbol as BotSymbol);
        return {
          available: true as const,
          signal: result.signal,
          allScored: result.allScored,
          regime: result.regime,
          reasoning: result.reasoning,
        };
      } finally {
        db.close();
      }
    }),
});
