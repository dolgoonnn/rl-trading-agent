/**
 * Consolidated paper track-record aggregation.
 *
 * The live forward record is fragmented across three stores — crypto in the
 * `bot_trades` table, the session/metals book in `data/metals-bot-state.json`,
 * and gold F2F in `data/gold-bot-state.json`. There is no single combined-book
 * equity curve, which is exactly what the charter review needs to evaluate.
 * These pure helpers fold each sleeve's per-trade PnL into a comparable summary
 * and combine them, so the reporter (scripts/track-record-status.ts) can print
 * one unified view. Kept pure (no I/O) so the aggregation is unit-testable.
 */

export interface SleeveSummary {
  label: string;
  closedTrades: number;
  cumPnlPct: number;
  winRate: number;
  openPositions: number;
  equity: number;
}

/** Fold a sleeve's closed-trade PnL% list into a comparable summary. */
export function summarizeSleeve(
  label: string,
  closedPnlPct: number[],
  openPositions: number,
  equity: number,
): SleeveSummary {
  const closedTrades = closedPnlPct.length;
  const cumPnlPct = closedPnlPct.reduce((a, p) => a + p, 0);
  const wins = closedPnlPct.filter((p) => p > 0).length;
  return {
    label,
    closedTrades,
    cumPnlPct,
    winRate: closedTrades > 0 ? wins / closedTrades : 0,
    openPositions,
    equity,
  };
}

export interface CombinedSummary {
  totalClosedTrades: number;
  totalOpenPositions: number;
  /** Sleeves that have booked at least one closed trade. */
  activeSleeves: number;
  /** Labels of sleeves with zero closed trades. */
  idleSleeves: string[];
}

export interface HoldPartition {
  strategyPnlPct: number;
  strategyCount: number;
  stalePnlPct: number;
  staleCount: number;
}

/**
 * Split trades into strategy vs downtime-stranded by hold duration.
 *
 * A session-based sleeve (e.g. the metals book) intends short holds — overnight
 * ~9h, weekend ~60-85h. When the bot is DOWN through a position's scheduled exit
 * window (a deploy gap, an outage), the position rides open until the bot
 * resumes, booking days of unmanaged drift as if it were a strategy trade. Any
 * hold beyond `capMs` (set above the longest legitimate hold, e.g. 120h) is such
 * an artifact — separating it keeps the live track record honest about
 * strategy-attributable PnL. Boundary is strict (> capMs), so a hold exactly at
 * the cap counts as strategy.
 */
export function partitionByHoldCap(
  trades: Array<{ holdMs: number; pnlPct: number }>,
  capMs: number,
): HoldPartition {
  const out: HoldPartition = { strategyPnlPct: 0, strategyCount: 0, stalePnlPct: 0, staleCount: 0 };
  for (const t of trades) {
    if (t.holdMs > capMs) {
      out.stalePnlPct += t.pnlPct;
      out.staleCount += 1;
    } else {
      out.strategyPnlPct += t.pnlPct;
      out.strategyCount += 1;
    }
  }
  return out;
}

/** Aggregate sleeve summaries into a combined-book view. */
export function combineSleeves(sleeves: SleeveSummary[]): CombinedSummary {
  return {
    totalClosedTrades: sleeves.reduce((a, s) => a + s.closedTrades, 0),
    totalOpenPositions: sleeves.reduce((a, s) => a + s.openPositions, 0),
    activeSleeves: sleeves.filter((s) => s.closedTrades > 0).length,
    idleSleeves: sleeves.filter((s) => s.closedTrades === 0).map((s) => s.label),
  };
}
