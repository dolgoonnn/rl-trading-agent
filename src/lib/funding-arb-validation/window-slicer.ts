import type { ArbTrade } from '../../../scripts/backtest-funding-arb';

export function tradesInWindow(
  trades: ArbTrade[],
  startMs: number,
  endMs: number,
): ArbTrade[] {
  return trades.filter(
    (t: ArbTrade) => t.entryTimestamp >= startMs && t.entryTimestamp < endMs,
  );
}
