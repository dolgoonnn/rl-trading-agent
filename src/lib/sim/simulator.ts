import type { Candle } from '@/types/candle';
import { fundingReturn as calcFundingReturn } from '@/lib/cost/funding-ledger';
import type { FillModel } from './fill-model';
import type { BarFillRequest, FidelityTier, SimConfig, SimExitReason, SimPosition, SimTradeResult, SubBarProvider } from './types';

function pnlPercent(adjEntry: number, adjExit: number, dir: 'long' | 'short'): number {
  return dir === 'long' ? (adjExit - adjEntry) / adjEntry : (adjEntry - adjExit) / adjEntry;
}

function finishBlended(
  position: SimPosition,
  adjustedEntry: number,
  adjustedExit: number,
  exitReason: SimExitReason,
  exitTimestamp: number,
  tier: FidelityTier,
  rateAt: ((settlementMs: number) => number) | undefined,
  partialTaken: boolean,
  partialFraction: number,
  partialPnl: number,
): SimTradeResult {
  const remainderPnl = pnlPercent(adjustedEntry, adjustedExit, position.direction);
  const gross = partialTaken
    ? partialFraction * partialPnl + (1 - partialFraction) * remainderPnl
    : remainderPnl;
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
    strategyExit?: (position: SimPosition, bar: Candle, barsHeld: number) => SimExitReason | null;
  },
): SimTradeResult | null {
  const { fillModel, subBars, rateAt, config } = deps;
  const startCandle = candles[startIndex];
  if (!startCandle) return null;

  // Entry basis: signal close (position.entryPrice) or the start bar's open.
  const refEntry = config.entryTiming === 'next_open' ? startCandle.open : position.entryPrice;
  const adjustedEntry = fillModel.applyCost(refEntry, 'entry', position.direction, {});

  // Mutable stop-loss state (moved by partial TP to BE+buffer, or by trailing).
  let mutableSL = position.stopLoss;
  let partialTaken = false;
  let partialPnl = 0;
  let partialFraction = 0;
  const rawRisk =
    position.direction === 'long'
      ? position.entryPrice - position.stopLoss
      : position.stopLoss - position.entryPrice;

  for (let i = startIndex; i < candles.length; i++) {
    const bar = candles[i];
    if (!bar) continue;
    // barsHeld matches legacy simulatePositionSimple (i - entryIndex).
    // Precondition: position.entryIndex <= startIndex. Callers must not pass a
    // startIndex below entryIndex, or barsHeld would inflate and trip maxBars early.
    const barsHeld = i - position.entryIndex;

    // strategy exit hook (enhanced mode) takes priority
    const strat = deps.strategyExit?.(position, bar, barsHeld);
    if (strat) {
      const adjustedExit = fillModel.applyCost(bar.close, 'exit', position.direction, { exitSide: 'taker' });
      return finishBlended(position, adjustedEntry, adjustedExit, 'strategy', bar.timestamp, 'pessimistic', rateAt, partialTaken, partialFraction, partialPnl);
    }

    // partial TP: take a fraction at triggerR and move SL to BE+buffer (once)
    if (config.exitMode === 'partial_tp' && config.partialTP && !partialTaken && rawRisk > 0) {
      const unrealizedR =
        position.direction === 'long'
          ? (bar.close - position.entryPrice) / rawRisk
          : (position.entryPrice - bar.close) / rawRisk;
      if (unrealizedR >= config.partialTP.triggerR) {
        const adjPartialExit = fillModel.applyCost(bar.close, 'exit', position.direction, { exitSide: 'maker' });
        partialPnl = pnlPercent(adjustedEntry, adjPartialExit, position.direction);
        partialFraction = config.partialTP.fraction;
        partialTaken = true;
        if (config.partialTP.beBuffer >= 0) {
          const buf = rawRisk * config.partialTP.beBuffer;
          mutableSL =
            position.direction === 'long'
              ? Math.max(mutableSL, position.entryPrice + buf)
              : Math.min(mutableSL, position.entryPrice - buf);
        }
      }
    }

    // trailing: once past activationR, trail SL by distanceR * rawRisk from the bar extreme
    if (config.exitMode === 'trailing' && config.trailing && rawRisk > 0) {
      const extreme = position.direction === 'long' ? bar.high : bar.low;
      const unrealizedR =
        position.direction === 'long'
          ? (extreme - position.entryPrice) / rawRisk
          : (position.entryPrice - extreme) / rawRisk;
      if (unrealizedR >= config.trailing.activationR) {
        const trail = config.trailing.distanceR * rawRisk;
        mutableSL =
          position.direction === 'long'
            ? Math.max(mutableSL, extreme - trail)
            : Math.min(mutableSL, extreme + trail);
      }
    }

    const req: BarFillRequest = {
      levels: { direction: position.direction, stopLoss: mutableSL, takeProfit: position.takeProfit },
      bar,
      barsHeld,
      maxBars: config.maxBars,
      subBars: subBars?.subBarsFor(bar.timestamp, config.barMs),
    };
    const exit = fillModel.resolveExit(req);
    if (exit) {
      const exitSide = exit.exitReason === 'take_profit' ? 'maker' : 'taker';
      const adjustedExit = fillModel.applyCost(exit.exitPrice, 'exit', position.direction, { exitSide });
      return finishBlended(position, adjustedEntry, adjustedExit, exit.exitReason, exit.fillTimestamp, exit.tier, rateAt, partialTaken, partialFraction, partialPnl);
    }
  }

  // No exit triggered: close at last candle close (taker).
  const last = candles[candles.length - 1];
  if (!last) return null;
  const adjustedExit = fillModel.applyCost(last.close, 'exit', position.direction, { exitSide: 'taker' });
  return finishBlended(position, adjustedEntry, adjustedExit, 'max_bars', last.timestamp, 'pessimistic', rateAt, partialTaken, partialFraction, partialPnl);
}
