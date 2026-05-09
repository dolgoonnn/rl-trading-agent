import type { MCTradeResult } from '@/lib/rl/utils/monte-carlo';
import type { ArbTrade } from '../../../scripts/backtest-funding-arb';

export function arbTradesToMcTrades(
  trades: ArbTrade[],
  positionSizeUsdt: number,
): MCTradeResult[] {
  if (positionSizeUsdt <= 0) {
    throw new Error(
      `arbTradesToMcTrades: positionSizeUsdt must be > 0, got ${positionSizeUsdt}`,
    );
  }
  return trades.map((t: ArbTrade) => ({ pnlPercent: t.netPnl / positionSizeUsdt }));
}
