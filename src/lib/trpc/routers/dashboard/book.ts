import { z } from 'zod';
import path from 'node:path';
import { router, publicProcedure } from '../../init';
import {
  readAllSleeves, readOpenPositions, readRecentTrades, readEquityCurve,
  readFreshness, readGovernance,
} from '../../../bot/sleeve-readers';
import { combineSleeves } from '../../../bot/track-record';

function dataDir(): string {
  return process.env.BOT_DATA_DIR ?? path.resolve('data');
}

export const bookRouter = router({
  overview: publicProcedure.query(() => {
    const perSleeve = readAllSleeves(dataDir());
    const combined = combineSleeves(perSleeve);
    const totalEquity = perSleeve.reduce((a, s) => a + s.equity, 0);
    return {
      totalEquity,
      perSleeve,
      totalClosedTrades: combined.totalClosedTrades,
      totalOpenPositions: combined.totalOpenPositions,
      activeSleeves: combined.activeSleeves,
      idleSleeves: combined.idleSleeves,
      governance: readGovernance(dataDir()),
      freshness: readFreshness(dataDir()),
    };
  }),
  equityCurve: publicProcedure.query(() => readEquityCurve(dataDir())),
  positions: publicProcedure.query(() => readOpenPositions(dataDir())),
  trades: publicProcedure
    .input(z.object({ limit: z.number().int().positive().default(50) }).optional())
    .query(({ input }) => readRecentTrades(Math.min(input?.limit ?? 50, 200), dataDir())),
});
