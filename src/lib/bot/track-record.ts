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

/** Aggregate sleeve summaries into a combined-book view. */
export function combineSleeves(sleeves: SleeveSummary[]): CombinedSummary {
  return {
    totalClosedTrades: sleeves.reduce((a, s) => a + s.closedTrades, 0),
    totalOpenPositions: sleeves.reduce((a, s) => a + s.openPositions, 0),
    activeSleeves: sleeves.filter((s) => s.closedTrades > 0).length,
    idleSleeves: sleeves.filter((s) => s.closedTrades === 0).map((s) => s.label),
  };
}
