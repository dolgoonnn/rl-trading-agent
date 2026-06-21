import type { Candle } from '@/types/candle';
import { fundingReturn as calcFundingReturn } from '@/lib/cost/funding-ledger';
import type { FillModel } from './fill-model';
import type { BarFillRequest, SimConfig, SimExitReason, SimPosition, SimTradeResult, SubBarProvider, FidelityTier } from './types';

function pnlPercent(adjEntry: number, adjExit: number, dir: 'long' | 'short'): number {
  return dir === 'long' ? (adjExit - adjEntry) / adjEntry : (adjEntry - adjExit) / adjEntry;
}

function finish(
  position: SimPosition,
  adjustedEntry: number,
  adjustedExit: number,
  exitReason: SimExitReason,
  exitTimestamp: number,
  tier: FidelityTier,
  rateAt?: (settlementMs: number) => number,
): SimTradeResult {
  const gross = pnlPercent(adjustedEntry, adjustedExit, position.direction);
  const funding = rateAt
    ? calcFundingReturn({ entryMs: position.entryTimestamp, exitMs: exitTimestamp, direction: position.direction, rateAt })
    : 0;
  return {
    entryTimestamp: position.entryTimestamp,
    exitTimestamp,
    direction: position.direction,
    entryPrice: adjustedEntry,
    exitPrice: adjustedExit,
    pnlPercent: gross,
    strategy: position.strategy,
    exitReason,
    tier,
    grossReturn: gross,
    fundingReturn: funding,
    netReturn: gross + funding,
  };
}

export function simulatePosition(
  position: SimPosition,
  candles: Candle[],
  startIndex: number,
  deps: {
    fillModel: FillModel;
    subBars?: SubBarProvider;
    rateAt?: (settlementMs: number) => number;
    config: SimConfig;
  },
): SimTradeResult | null {
  const { fillModel, subBars, rateAt, config } = deps;
  const startCandle = candles[startIndex];
  if (!startCandle) return null;

  // Entry basis: signal close (position.entryPrice) or the start bar's open.
  const refEntry = config.entryTiming === 'next_open' ? startCandle.open : position.entryPrice;
  const adjustedEntry = fillModel.applyCost(refEntry, 'entry', position.direction, {});

  for (let i = startIndex; i < candles.length; i++) {
    const bar = candles[i];
    if (!bar) continue;
    // barsHeld matches legacy simulatePositionSimple (i - entryIndex).
    // Precondition: position.entryIndex <= startIndex. Callers must not pass a
    // startIndex below entryIndex, or barsHeld would inflate and trip maxBars early.
    const barsHeld = i - position.entryIndex;

    const req: BarFillRequest = {
      levels: { direction: position.direction, stopLoss: position.stopLoss, takeProfit: position.takeProfit },
      bar,
      barsHeld,
      maxBars: config.maxBars,
      subBars: subBars?.subBarsFor(bar.timestamp, config.barMs),
    };
    const exit = fillModel.resolveExit(req);
    if (exit) {
      const exitSide = exit.exitReason === 'take_profit' ? 'maker' : 'taker';
      const adjustedExit = fillModel.applyCost(exit.exitPrice, 'exit', position.direction, { exitSide });
      return finish(position, adjustedEntry, adjustedExit, exit.exitReason, exit.fillTimestamp, exit.tier, rateAt);
    }
  }

  // No exit triggered: close at last candle close (taker).
  const last = candles[candles.length - 1];
  if (!last) return null;
  const adjustedExit = fillModel.applyCost(last.close, 'exit', position.direction, { exitSide: 'taker' });
  return finish(position, adjustedEntry, adjustedExit, 'max_bars', last.timestamp, 'pessimistic', rateAt);
}
