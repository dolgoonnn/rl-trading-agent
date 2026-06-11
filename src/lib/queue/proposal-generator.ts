import { randomUUID } from 'node:crypto';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { ConfluenceScorer } from '@/lib/rl/strategies/confluence-scorer';
import { detectRegime } from '@/lib/ict/regime-detector';
import { isGoldSymbol } from '@/lib/gold-workflow/types';
import { resampleCandles, type Timeframe } from '@/lib/trpc/routers/dashboard/bias';
import { readRecentCandles } from '@/lib/trpc/routers/dashboard/candles';
import type { Candle } from '@/types';

export interface ProposalReasoning {
  topFactors: Array<{ factor: string; value: number }>;
  factorBreakdown: Record<string, number>;
  bucketStats?: { bucket: string; n: number; winRate: number; meanPnlPct: number };
  fullReasoning: string[];
}

const RUN20_THRESHOLD = 4.048;
const SYMBOLS_DEFAULT = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XAUUSD'];

interface ScoreBucketRow {
  n: number;
  wins: number;
  pnl_sum: number;
}

function getBucketStats(
  db: BetterSqlite3Database,
  strategyKey: string,
  score: number,
  windowDays: number,
): { bucket: string; n: number; winRate: number; meanPnlPct: number } | undefined {
  const lo = Math.floor(score);
  const hi = lo + 1;
  const cutoff = Date.now() - windowDays * 86_400_000;
  try {
    // Try strategy-specific first; fall back to all-strategy aggregate.
    // Score signal is largely strategy-agnostic in the ICT framework, and live
    // bot_trades may only have one strategy populated (e.g. order_block).
    let r = db
      .prepare(
        `SELECT COUNT(*) AS n,
                SUM(CASE WHEN pnl_usdt > 0 THEN 1 ELSE 0 END) AS wins,
                COALESCE(SUM(pnl_percent), 0) AS pnl_sum
         FROM bot_trades
         WHERE strategy = ? AND created_at >= ?
           AND confluence_score >= ? AND confluence_score < ?`,
      )
      .get(strategyKey, cutoff, lo, hi) as ScoreBucketRow | undefined;
    if (!r || r.n === 0) {
      r = db
        .prepare(
          `SELECT COUNT(*) AS n,
                  SUM(CASE WHEN pnl_usdt > 0 THEN 1 ELSE 0 END) AS wins,
                  COALESCE(SUM(pnl_percent), 0) AS pnl_sum
           FROM bot_trades
           WHERE created_at >= ?
             AND confluence_score >= ? AND confluence_score < ?`,
        )
        .get(cutoff, lo, hi) as ScoreBucketRow | undefined;
    }
    if (!r || r.n === 0) return undefined;
    return {
      bucket: `${lo}-${hi}`,
      n: r.n,
      winRate: r.wins / r.n,
      meanPnlPct: r.pnl_sum / r.n,
    };
  } catch {
    return undefined;
  }
}

/**
 * Build caveats and contextual notes from regime + score-bucket data.
 *
 * Score-bucket findings from 431 paper trades (May 2026 analysis,
 * see scripts/score-band-backtest.ts):
 *   <4   : +0.78% avg, 38 trades — below threshold
 *   4-5  : +0.92% avg, 72 trades — sweet zone
 *   5-6  : +0.75% avg, 93 trades — good
 *   6-7  : +0.28% avg, 185 trades — dead zone (most volume, worst return)
 *   7+   : +0.12% avg, 43 trades — dead zone (overfit signal)
 *
 * The dead-zone flag is the killer warning: high score correlates with
 * worse live outcomes. Surface it loudly.
 */
function buildCaveats(
  score: number,
  regime: string,
  bucket: { n: number; winRate: number; meanPnlPct: number } | undefined,
): string[] {
  const out: string[] = [];

  if (/ranging\+(normal|high)|downtrend\+high/.test(regime)) {
    out.push(`regime ${regime} is on Run 20 suppress list`);
  }

  // Dead-zone warning — empirical, not theoretical
  if (score >= 6) {
    if (bucket && bucket.meanPnlPct < 0.005) {
      out.push(
        `⚠ score ${score.toFixed(2)} is in 6+ DEAD ZONE: ${(bucket.meanPnlPct * 100).toFixed(2)}% avg pnl (n=${bucket.n}) — historically worse than 4-5 band`,
      );
    } else {
      out.push(
        `score ${score.toFixed(2)} is in 6+ dead zone — these underperform 4-5 band in your live data`,
      );
    }
  }

  // Sweet zone confirmation — positive caveat keeps the user honest about taking it
  if (score >= 4 && score < 5.5 && bucket && bucket.n >= 30 && bucket.meanPnlPct > 0.008) {
    out.push(
      `✓ score ${score.toFixed(2)} is in 4-5.5 sweet zone: ${(bucket.winRate * 100).toFixed(1)}% WR, ${(bucket.meanPnlPct * 100).toFixed(2)}% avg (n=${bucket.n})`,
    );
  }

  if (bucket && bucket.n < 10 && bucket.n > 0) {
    out.push(`only ${bucket.n} similar-scored trades in last 90d — wide uncertainty`);
  }
  if (!bucket) {
    out.push('no live history for this score bucket');
  }
  return out;
}

const STRATEGY_TO_BOT_KEY: Record<string, string> = {
  ict_3sym: 'order_block',
  order_block: 'order_block',
  fvg: 'fvg',
  bos_continuation: 'bos_continuation',
  choch_reversal: 'choch_reversal',
  asian_range_gold: 'asian_range_gold',
};

export interface GenerateOptions {
  symbols?: string[];
  threshold?: number;
  /** How many recent bars to scan per symbol; the latest hit is kept. */
  scanBars?: number;
}

export interface GenerateResult {
  inserted: number;
  evaluated: number;
  skipped: Array<{ symbol: string; reason: string }>;
}

/**
 * Run the confluence scorer once per symbol and insert any candidate that
 * passes the threshold + isn't already a duplicate of a recent pending row.
 * Idempotent on (symbol, side, score band, hour) — re-running won't dupe.
 */
export function generateProposals(
  db: BetterSqlite3Database,
  opts: GenerateOptions = {},
): GenerateResult {
  const symbols = opts.symbols ?? SYMBOLS_DEFAULT;
  const threshold = opts.threshold ?? RUN20_THRESHOLD;
  const scanBars = opts.scanBars ?? 30;
  const now = Date.now();
  const recentWindowMs = 60 * 60_000; // 1h dedup window

  let inserted = 0;
  let evaluated = 0;
  const skipped: GenerateResult['skipped'] = [];

  const insertStmt = db.prepare(
    `INSERT INTO proposals
       (id, created_at, symbol, strategy, side, entry, stop_loss, take_profit,
        score, threshold, rr_ratio, regime, reasoning, caveats, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  );
  const dupCheckStmt = db.prepare(
    `SELECT 1 FROM proposals
     WHERE symbol = ? AND side = ? AND status = 'pending'
       AND created_at >= ? AND ABS(score - ?) < 0.5
     LIMIT 1`,
  );

  for (const symbol of symbols) {
    const candles = readRecentCandles(db, symbol, 500) as Candle[];
    if (candles.length < 100) {
      skipped.push({ symbol, reason: 'insufficient candles' });
      continue;
    }
    const tf: Timeframe = isGoldSymbol(symbol) ? '4H' : '1H';
    const bars = tf === '1H' ? candles : resampleCandles(candles, tf);
    if (bars.length < 100) {
      skipped.push({ symbol, reason: 'insufficient resampled bars' });
      continue;
    }
    // Scan the last N bars and pick the most recent qualifying signal.
    // This matches how a trader checks "what fired recently?" — not just the
    // current bar, which is silent ~99% of the time.
    const scorer = new ConfluenceScorer();
    let best: typeof result.allScored[0] | undefined;
    let regimeLabel = 'unknown';
    let result: ReturnType<typeof scorer.evaluate> = {
      action: 'wait',
      allScored: [],
      reasoning: [],
      selectedSignal: null,
    };
    const startIdx = Math.max(100, bars.length - scanBars);
    for (let idx = bars.length - 1; idx >= startIdx; idx--) {
      evaluated++;
      result = scorer.evaluate(bars, idx);
      const top = result.allScored[0];
      if (top && top.totalScore >= threshold) {
        best = top;
        const regime = detectRegime(bars, idx);
        regimeLabel = `${regime.trend}+${regime.volatility}`;
        break;
      }
    }
    if (!best) {
      skipped.push({ symbol, reason: `no qualifying signal in last ${scanBars} bars` });
      continue;
    }

    const dup = dupCheckStmt.get(symbol, best.signal.direction, now - recentWindowMs, best.totalScore);
    if (dup) {
      skipped.push({ symbol, reason: 'duplicate within 1h window' });
      continue;
    }

    const risk = Math.abs(best.signal.entryPrice - best.signal.stopLoss);
    const reward = Math.abs(best.signal.takeProfit - best.signal.entryPrice);
    const rr = risk > 0 ? reward / risk : 0;

    const strategyKey = STRATEGY_TO_BOT_KEY[best.signal.strategy] ?? best.signal.strategy;
    const bucket = getBucketStats(db, strategyKey, best.totalScore, 90);
    const caveats = buildCaveats(best.totalScore, regimeLabel, bucket);

    const topFactors = Object.entries(best.factorBreakdown)
      .filter(([, v]) => v > 0)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([factor, value]) => ({ factor, value }));

    const reasoning: ProposalReasoning = {
      topFactors,
      factorBreakdown: best.factorBreakdown,
      bucketStats: bucket,
      fullReasoning: result.reasoning,
    };

    insertStmt.run(
      randomUUID(),
      now,
      symbol,
      best.signal.strategy,
      best.signal.direction,
      best.signal.entryPrice,
      best.signal.stopLoss,
      best.signal.takeProfit,
      best.totalScore,
      threshold,
      rr,
      regimeLabel,
      JSON.stringify(reasoning),
      JSON.stringify(caveats),
    );
    inserted++;
  }

  return { inserted, evaluated, skipped };
}
