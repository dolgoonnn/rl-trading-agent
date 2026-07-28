import { z } from 'zod';
import path from 'node:path';
import { router, publicProcedure } from '../../init';
import {
  readAllSleeves, readOpenPositions, readRecentTrades, readEquityCurve,
  readFreshness, readGovernance,
  readTradeDetail, readAllTradesForStats, readDrawdownCurve, readCosts,
} from '../../../bot/sleeve-readers';
import { combineSleeves } from '../../../bot/track-record';
import { computePerfStats, groupBy, confluenceBucket, MIN_TRADES_FOR_STATS } from '../../../bot/trade-analytics';
import { calculateMaxDrawdown, calculateSharpeRatio, calculateSortinoRatio } from '../../../rl/utils/gt-score';

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

  tradeDetail: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(({ input }) => readTradeDetail(input.id, dataDir())),

  stats: publicProcedure.query(() => {
    const trades = readAllTradesForStats(dataDir());
    const returns = trades.map((t) => t.pnlPct / 100);
    return {
      ...computePerfStats(trades),
      // Per-trade (not annualized): annualizationFactor=1, targetReturn=0.
      maxDrawdown: calculateMaxDrawdown(returns),
      sharpe: calculateSharpeRatio(returns, 1),
      sortino: calculateSortinoRatio(returns, 0, 1),
      minTradesForStats: MIN_TRADES_FOR_STATS,
    };
  }),

  breakdowns: publicProcedure.query(() => {
    const trades = readAllTradesForStats(dataDir());
    return {
      byExitReason: groupBy(trades, (t) => t.exitReason ?? 'unknown'),
      byRegime: groupBy(trades, (t) => t.regime ?? 'unknown'),
      bySymbol: groupBy(trades, (t) => t.symbol),
      byConfluence: groupBy(trades, (t) => confluenceBucket(t.confluenceScore)),
    };
  }),

  costs: publicProcedure.query(() => readCosts(dataDir())),

  drawdownCurve: publicProcedure.query(() => readDrawdownCurve(dataDir())),
});
