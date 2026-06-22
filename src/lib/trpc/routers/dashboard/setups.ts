import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { router, publicProcedure } from '../../init';
import { SignalEngine } from '@/lib/bot/signal-engine';
import type { BotSymbol } from '@/types/bot';
import type { Candle } from '@/types';
import type { ScoredSignal } from '@/lib/rl/strategies/confluence-scorer';
import { readRecentCandles } from './candles';

const LOOKBACK_BARS = 50;

export const setupsRouter = router({
  live: publicProcedure
    .input(
      z.object({
        symbol: z.string(),
        candleCount: z.number().int().min(100).max(2000).default(500),
      }),
    )
    .query(({ input }) => {
      const dbPath = path.resolve('data/ict-trading.db');
      if (!fs.existsSync(dbPath)) {
        return {
          available: false as const,
          signal: null,
          allScored: [] as ScoredSignal[],
          regime: 'unknown',
          reasoning: [] as string[],
          barOffset: 0,
          scannedBars: 0,
        };
      }
      const db = new Database(dbPath, { readonly: true });
      try {
        const candles = readRecentCandles(db, input.symbol, input.candleCount) as Candle[];
        if (candles.length < 50) {
          return {
            available: true as const,
            signal: null,
            allScored: [] as ScoredSignal[],
            regime: 'unknown',
            reasoning: ['Insufficient candle history'],
            barOffset: 0,
            scannedBars: 0,
          };
        }
        const engine = new SignalEngine();
        const lastIdx = candles.length - 1;
        const minIdx = Math.max(50, lastIdx - LOOKBACK_BARS + 1);

        // Walk backwards looking for the most recent bar that produced any candidates.
        let chosen = engine.evaluate(candles, input.symbol as BotSymbol, lastIdx);
        let chosenIdx = lastIdx;
        for (let i = lastIdx - 1; i >= minIdx && chosen.allScored.length === 0; i--) {
          const r = engine.evaluate(candles, input.symbol as BotSymbol, i);
          if (r.allScored.length > 0) {
            chosen = r;
            chosenIdx = i;
            break;
          }
        }
        return {
          available: true as const,
          signal: chosen.signal,
          allScored: chosen.allScored,
          regime: chosen.regime,
          reasoning: chosen.reasoning,
          barOffset: lastIdx - chosenIdx,
          scannedBars: lastIdx - minIdx + 1,
        };
      } finally {
        db.close();
      }
    }),
});
