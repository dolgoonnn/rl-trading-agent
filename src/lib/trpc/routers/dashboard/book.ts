import { z } from 'zod';
import path from 'node:path';
import { router, publicProcedure } from '../../init';
import {
  readAllSleeves, readOpenPositions, readRecentTrades, readEquityCurve,
  readFreshness, readGovernance,
  readTradeDetail, readAllTradesForStats, readDrawdownCurve, readCosts,
  readLegAttribution, summariseAttribution, readBookEquityCurve, readTradeChart,
} from '../../../bot/sleeve-readers';
import { combineSleeves } from '../../../bot/track-record';
import { computePerfStats, groupBy, confluenceBucket, MIN_TRADES_FOR_STATS } from '../../../bot/trade-analytics';
import { calculateSharpeRatio, calculateSortinoRatio } from '../../../rl/utils/gt-score';

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

  /** Candles around a trade plus its markers — see the market, not just the number. */
  tradeChart: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(({ input }) => readTradeChart(input.id, dataDir())),

  stats: publicProcedure.query(() => {
    const trades = readAllTradesForStats(dataDir());
    // pnlPct is already a FRACTION (bot_trades.pnl_percent) — do not divide again.
    const returns = trades.map((t) => t.pnlPct);
    // maxDrawdown must come from real equity snapshots, not per-trade notional
    // returns — pnlPct is return on POSITION NOTIONAL, not account equity, so
    // compounding it as if it were an equity-return series overstates drawdown.
    const ddCurve = readDrawdownCurve(dataDir());
    const maxDrawdown = ddCurve.reduce((m, p) => (p.drawdown > m ? p.drawdown : m), 0);
    return {
      ...computePerfStats(trades),
      // Per-trade (not annualized): annualizationFactor=1, targetReturn=0.
      maxDrawdown,
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

  /**
   * "What moved the number" — per-leg decomposition plus the headline story.
   * The page states the story; the tables below it carry the detail.
   */
  attribution: publicProcedure.query(() => {
    const legs = readLegAttribution(dataDir());
    return { legs, summary: summariseAttribution(legs) };
  }),

  /**
   * Book-level equity through time, rebuilt from every sleeve's closed trades.
   * `equityCurve` remains the crypto-snapshot series for the sleeve view; this is
   * what the headline chart plots, so the chart and the headline agree.
   */
  bookEquityCurve: publicProcedure.query(() => readBookEquityCurve(dataDir())),

  drawdownCurve: publicProcedure.query(() => readDrawdownCurve(dataDir())),
});
