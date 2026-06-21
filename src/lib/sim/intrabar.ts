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

/** First of {SL,TP} reached along an assumed ordered path of price extremes. */
function firstHitAlongPath(
  req: BarFillRequest, path: Array<'high' | 'low'>, tier: 'ohlc_heuristic',
): FillResult | null {
  const { levels, bar } = req;
  for (const leg of path) {
    if (levels.direction === 'long') {
      if (leg === 'low' && bar.low <= levels.stopLoss) {
        return { exitPrice: levels.stopLoss, exitReason: 'stop_loss', fillTimestamp: bar.timestamp, tier };
      }
      if (leg === 'high' && bar.high >= levels.takeProfit) {
        return { exitPrice: levels.takeProfit, exitReason: 'take_profit', fillTimestamp: bar.timestamp, tier };
      }
    } else {
      if (leg === 'high' && bar.high >= levels.stopLoss) {
        return { exitPrice: levels.stopLoss, exitReason: 'stop_loss', fillTimestamp: bar.timestamp, tier };
      }
      if (leg === 'low' && bar.low <= levels.takeProfit) {
        return { exitPrice: levels.takeProfit, exitReason: 'take_profit', fillTimestamp: bar.timestamp, tier };
      }
    }
  }
  return null;
}

/**
 * Open-proximity heuristic (~75-85% sequence accuracy, per TradingView/Nautilus):
 * if the open is closer to the high, assume O->H->L->C, else O->L->H->C. Then
 * resolve whichever of SL/TP the assumed path reaches first. Max-bars at close.
 */
export function ohlcHeuristicResolve(req: BarFillRequest): FillResult | null {
  const { bar, barsHeld, maxBars } = req;
  const nearHigh = Math.abs(bar.open - bar.high) <= Math.abs(bar.open - bar.low);
  const path: Array<'high' | 'low'> = nearHigh ? ['high', 'low'] : ['low', 'high'];
  const hit = firstHitAlongPath(req, path, 'ohlc_heuristic');
  if (hit) return hit;
  if (barsHeld >= maxBars) {
    return { exitPrice: bar.close, exitReason: 'max_bars', fillTimestamp: bar.timestamp, tier: 'ohlc_heuristic' };
  }
  return null;
}

/**
 * Walk the injected 1m candles in time order; the first 1m candle whose range
 * touches SL or TP determines the exit. A 1m candle that straddles BOTH levels
 * has no finer data to disambiguate, so we apply the pessimistic floor WITHIN
 * that candle (SL wins). Max-bars (checked at the exec-bar level) exits at the
 * exec bar close.
 */
export function subBarResolve(req: BarFillRequest): FillResult | null {
  const { levels, bar, barsHeld, maxBars, subBars } = req;
  if (!subBars || subBars.length === 0) return null;

  for (const sub of subBars) {
    const inner = pessimisticResolve({ levels, bar: sub, barsHeld: 0, maxBars: Number.POSITIVE_INFINITY });
    if (inner) {
      return { exitPrice: inner.exitPrice, exitReason: inner.exitReason, fillTimestamp: sub.timestamp, tier: 'subbar_1m' };
    }
  }

  if (barsHeld >= maxBars) {
    return { exitPrice: bar.close, exitReason: 'max_bars', fillTimestamp: bar.timestamp, tier: 'subbar_1m' };
  }
  return null;
}
