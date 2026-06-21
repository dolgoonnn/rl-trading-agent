import type { BarFillRequest, FillResult } from './types';

/**
 * The parity FLOOR: SL is checked before TP within a single candle, so on a
 * straddle the SL fills (worst case). Byte-for-byte the current behavior of
 * `checkSLTPMaxBars` in scripts/backtest-confluence.ts and the live
 * OrderManager.checkPositionExit. Max-bars exits at close.
 */
export function pessimisticResolve(req: BarFillRequest): FillResult | null {
  const { levels, bar, barsHeld, maxBars } = req;
  if (levels.direction === 'long') {
    if (bar.low <= levels.stopLoss) {
      return { exitPrice: levels.stopLoss, exitReason: 'stop_loss', fillTimestamp: bar.timestamp, tier: 'pessimistic' };
    }
    if (bar.high >= levels.takeProfit) {
      return { exitPrice: levels.takeProfit, exitReason: 'take_profit', fillTimestamp: bar.timestamp, tier: 'pessimistic' };
    }
  } else {
    if (bar.high >= levels.stopLoss) {
      return { exitPrice: levels.stopLoss, exitReason: 'stop_loss', fillTimestamp: bar.timestamp, tier: 'pessimistic' };
    }
    if (bar.low <= levels.takeProfit) {
      return { exitPrice: levels.takeProfit, exitReason: 'take_profit', fillTimestamp: bar.timestamp, tier: 'pessimistic' };
    }
  }
  if (barsHeld >= maxBars) {
    return { exitPrice: bar.close, exitReason: 'max_bars', fillTimestamp: bar.timestamp, tier: 'pessimistic' };
  }
  return null;
}
