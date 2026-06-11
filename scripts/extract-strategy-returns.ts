#!/usr/bin/env tsx
/**
 * Extract calendar-day return series for every validated strategy so they can
 * be combined at the portfolio level (scripts/combine-strategies.ts).
 *
 * Strategies:
 *   crypto    1H OB confluence, CMA-ES Run 20 (BTC/ETH/SOL) — OOS walk-forward
 *             trades only (train 2160 / val 720 / slide 720, val windows do not
 *             overlap). Each trade's log return is spread evenly over its
 *             holding days and divided by 3 (equal capital per symbol).
 *   sessionBook  Multi-leg session book (Au/Ag overnight, fix shorts, NFP-mom,
 *             US500 overnight, EUR session legs) — exact daily attribution,
 *             suitability rule (sign stable across 2015–19/2020–26 halves).
 *   f2f       Daily gold F2F, NON-overlapping walk-forward (slide 126 = val
 *             width), zscore50 filter, long-only — per-bar equity curve, so
 *             attribution is exact.
 *
 * All series are DAILY LOG RETURNS keyed by UTC date string.
 * Output: experiments/runs/strategy-daily-returns.json
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';
import {
  ConfluenceScorer,
  type ConfluenceConfig,
  type ConfluenceWeights,
} from '../src/lib/rl/strategies/confluence-scorer';
import type { StrategyName, SLPlacementMode } from '../src/lib/rl/strategies/ict-strategies';
import {
  runWalkForward,
  type WalkForwardStrategyRunner,
  type TradeResult,
} from './walk-forward-validate';
import { buildLegs, legWeight } from './analyze-combo-portfolio';
import { runWalkForwardOptimization } from '../src/lib/gold/optimizer';
import { generateSignals } from '../src/lib/gold/signals';
import { runF2FSimulation } from '../src/lib/gold/strategy';
import type { F2FOptimizedParams } from '../src/lib/gold/types';

// ============================================
// Crypto Run 20 (copied from validate-dsr.ts — that script runs on import)
// ============================================

const FRICTION_PER_SIDE = 0.0007;

const CONFIG_3SYM = {
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as string[],
  threshold: 4.048,
  atrExtension: 5.79,
  halfLife: 12,
  cooldown: 7,
  maxBars: 160,
  partialFraction: 0.50,
  partialTriggerR: 1.41,
  partialBeBuffer: 0.20,
  suppress: ['ranging+normal', 'ranging+high', 'downtrend+high'] as string[],
  regimeThresholds: {
    'uptrend+high': 3.14,
    'uptrend+normal': 5.74,
    'uptrend+low': 5.49,
    'downtrend+normal': 4.38,
    'downtrend+low': 6.50,
  } as Record<string, number>,
  weights: {
    structureAlignment: 0.1928,
    killZoneActive: 1.2658,
    liquiditySweep: 1.4896,
    obProximity: 2.7262,
    fvgAtCE: 2.3162,
    recentBOS: 2.2229,
    rrRatio: 0.5567,
    oteZone: 1.0621,
    obFvgConfluence: 1.0892,
    momentumConfirmation: 0,
  } as Partial<ConfluenceWeights>,
};

interface SimulatedPosition {
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  direction: 'long' | 'short';
  entryIndex: number;
  entryTimestamp: number;
  strategy: string;
}

function simulatePositionPartialTP(
  position: SimulatedPosition,
  candles: Candle[],
  startIndex: number,
  config: { partialFraction: number; partialTriggerR: number; partialBeBuffer: number; maxBars: number },
): TradeResult | null {
  const friction = FRICTION_PER_SIDE;
  const adjustedEntry = position.direction === 'long'
    ? position.entryPrice * (1 + friction)
    : position.entryPrice * (1 - friction);

  let currentSL = position.stopLoss;
  const riskDistance = position.direction === 'long'
    ? position.entryPrice - position.stopLoss
    : position.stopLoss - position.entryPrice;
  let partialTaken = false;
  let partialPnl = 0;

  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;
    const barsHeld = i - position.entryIndex;

    let exitPrice: number | null = null;
    if (position.direction === 'long') {
      if (candle.low <= currentSL) exitPrice = currentSL;
      else if (candle.high >= position.takeProfit) exitPrice = position.takeProfit;
    } else {
      if (candle.high >= currentSL) exitPrice = currentSL;
      else if (candle.low <= position.takeProfit) exitPrice = position.takeProfit;
    }

    if (exitPrice !== null) {
      const adjustedExit = position.direction === 'long'
        ? exitPrice * (1 - friction)
        : exitPrice * (1 + friction);
      const exitPnl = position.direction === 'long'
        ? (adjustedExit - adjustedEntry) / adjustedEntry
        : (adjustedEntry - adjustedExit) / adjustedEntry;
      const remainingFraction = 1 - config.partialFraction;
      const finalPnl = partialTaken
        ? config.partialFraction * partialPnl + remainingFraction * exitPnl
        : exitPnl;
      return {
        entryTimestamp: position.entryTimestamp,
        exitTimestamp: candle.timestamp,
        direction: position.direction,
        entryPrice: adjustedEntry,
        exitPrice: adjustedExit,
        pnlPercent: finalPnl,
        strategy: position.strategy,
      };
    }

    if (!partialTaken && riskDistance > 0) {
      const unrealizedR = position.direction === 'long'
        ? (candle.close - position.entryPrice) / riskDistance
        : (position.entryPrice - candle.close) / riskDistance;
      if (unrealizedR >= config.partialTriggerR) {
        partialTaken = true;
        const partialExit = position.direction === 'long'
          ? candle.close * (1 - friction)
          : candle.close * (1 + friction);
        partialPnl = position.direction === 'long'
          ? (partialExit - adjustedEntry) / adjustedEntry
          : (adjustedEntry - partialExit) / adjustedEntry;
        const buffer = riskDistance * config.partialBeBuffer;
        if (position.direction === 'long') {
          currentSL = Math.max(currentSL, position.entryPrice + buffer);
        } else {
          currentSL = Math.min(currentSL, position.entryPrice - buffer);
        }
      }
    }

    if (barsHeld >= config.maxBars) {
      const adjustedExit = position.direction === 'long'
        ? candle.close * (1 - friction)
        : candle.close * (1 + friction);
      const exitPnl = position.direction === 'long'
        ? (adjustedExit - adjustedEntry) / adjustedEntry
        : (adjustedEntry - adjustedExit) / adjustedEntry;
      const remainingFraction = 1 - config.partialFraction;
      const finalPnl = partialTaken
        ? config.partialFraction * partialPnl + remainingFraction * exitPnl
        : exitPnl;
      return {
        entryTimestamp: position.entryTimestamp,
        exitTimestamp: candle.timestamp,
        direction: position.direction,
        entryPrice: adjustedEntry,
        exitPrice: adjustedExit,
        pnlPercent: finalPnl,
        strategy: position.strategy,
      };
    }
  }

  return null;
}

function createCryptoRunner(collected: TradeResult[]): WalkForwardStrategyRunner {
  const cfg = CONFIG_3SYM;
  return {
    name: 'extract-run20',
    async run(trainCandles: Candle[], valCandles: Candle[]): Promise<TradeResult[]> {
      const scorerConfig: Partial<ConfluenceConfig> = {
        minThreshold: cfg.threshold,
        minSignalRR: 1.5,
        strategyConfig: { slPlacementMode: 'dynamic_rr' as SLPlacementMode },
        activeStrategies: ['order_block'] as StrategyName[],
        suppressedRegimes: [...cfg.suppress],
        atrExtensionBands: cfg.atrExtension,
        regimeThresholdOverrides: { ...cfg.regimeThresholds },
        obFreshnessHalfLife: cfg.halfLife,
        cooldownBars: cfg.cooldown,
        weights: cfg.weights as ConfluenceWeights,
      };
      const scorer = new ConfluenceScorer(scorerConfig);
      const allCandles = [...trainCandles, ...valCandles];
      const valStartIndex = trainCandles.length;
      const trades: TradeResult[] = [];
      let currentPosition: SimulatedPosition | null = null;
      let positionExitIndex = -1;

      for (let i = valStartIndex; i < allCandles.length; i++) {
        const candle = allCandles[i];
        if (!candle) continue;
        if (currentPosition !== null && i <= positionExitIndex) continue;
        currentPosition = null;

        const result = scorer.evaluate(allCandles, i);
        if (result.action === 'trade' && result.selectedSignal) {
          const signal = result.selectedSignal.signal;
          const position: SimulatedPosition = {
            entryPrice: signal.entryPrice,
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit,
            direction: signal.direction,
            entryIndex: i,
            entryTimestamp: candle.timestamp,
            strategy: signal.strategy,
          };

          const trade = simulatePositionPartialTP(position, allCandles, i + 1, cfg);
          if (trade) {
            trades.push(trade);
            let exitIdx = i + 1;
            for (let j = i + 1; j < allCandles.length; j++) {
              const c = allCandles[j];
              if (c && c.timestamp >= trade.exitTimestamp) {
                exitIdx = j;
                break;
              }
            }
            currentPosition = position;
            positionExitIndex = exitIdx;
          }
        }
      }
      collected.push(...trades);
      return trades;
    },
  };
}

/** Spread each trade's log return evenly over its holding days, 1/3 capital per symbol. */
function cryptoDailySeries(trades: TradeResult[]): Map<string, number> {
  const DAY = 86_400_000;
  const out = new Map<string, number>();
  for (const t of trades) {
    const days = Math.max(1, Math.ceil((t.exitTimestamp - t.entryTimestamp) / DAY));
    const perDay = Math.log(1 + t.pnlPercent / 3) / days;
    for (let d = 0; d < days; d++) {
      // attribute backwards from exit day so the final day is the exit date
      const date = new Date(t.exitTimestamp - d * DAY).toISOString().slice(0, 10);
      out.set(date, (out.get(date) ?? 0) + perDay);
    }
  }
  return out;
}

// ============================================
// Session book (suitable legs, fixed notional weights)
// ============================================

async function sessionBookDailySeries(): Promise<{ series: Map<string, number>; suitable: string[] }> {
  const legs = await buildLegs();
  const splitDate = '2020-01-01';
  const suitable: string[] = [];
  for (const [name, series] of legs) {
    const days = [...series.keys()];
    const h1 = days.filter((d) => d < splitDate).reduce((s, d) => s + series.get(d)!, 0);
    const h2 = days.filter((d) => d >= splitDate).reduce((s, d) => s + series.get(d)!, 0);
    if (h1 > 0 && h2 > 0) suitable.push(name);
  }
  const out = new Map<string, number>();
  for (const name of suitable) {
    const w = legWeight(name);
    for (const [date, r] of legs.get(name)!) {
      out.set(date, (out.get(date) ?? 0) + w * r);
    }
  }
  return { series: out, suitable };
}

// ============================================
// F2F daily gold (non-overlapping walk-forward, exact per-bar equity)
// ============================================

function f2fDailySeries(): Map<string, number> {
  const candles: Candle[] = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'data', 'GC_F_1d.json'), 'utf-8'),
  );
  const config = { trainBars: 2520, valBars: 126, slideBars: 126 };
  const friction = 0.0005;
  const result = runWalkForwardOptimization(candles, config, friction, undefined, 'long-only', 'zscore50');

  const out = new Map<string, number>();
  for (const w of result.windows) {
    const params: F2FOptimizedParams = { lambda: w.bestLambda, theta: w.bestTheta };
    const signals = generateSignals(candles, params, w.trainStart, w.trainEnd, w.valStart, w.valEnd, 'zscore50');
    const sim = runF2FSimulation(signals, friction, 'long-only');
    for (let i = 1; i < sim.equityCurve.length && i < signals.length; i++) {
      const prev = sim.equityCurve[i - 1]!;
      const cur = sim.equityCurve[i]!;
      if (prev > 0 && cur > 0) {
        const date = new Date(signals[i]!.timestamp).toISOString().slice(0, 10);
        out.set(date, Math.log(cur / prev));
      }
    }
  }
  return out;
}

// ============================================
// Main
// ============================================

function seriesStats(series: Map<string, number>): { n: number; totalPct: number; sharpe: number; first: string; last: string } {
  const dates = [...series.keys()].sort();
  const xs = dates.map((d) => series.get(d)!);
  const m = xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, xs.length - 1));
  return {
    n: xs.length,
    totalPct: Math.round(xs.reduce((s, x) => s + x, 0) * 1000) / 10,
    sharpe: sd > 0 ? Math.round((m / sd) * Math.sqrt(252) * 100) / 100 : 0,
    first: dates[0] ?? '-',
    last: dates[dates.length - 1] ?? '-',
  };
}

async function main(): Promise<void> {
  console.log('=== 1/3 session book (fast) ===');
  const { series: book, suitable } = await sessionBookDailySeries();
  console.log(`  suitable legs: ${suitable.join(', ')}`);
  console.log(`  `, seriesStats(book));

  console.log('=== 2/3 F2F non-overlapping walk-forward ===');
  const f2f = f2fDailySeries();
  console.log(`  `, seriesStats(f2f));

  console.log('=== 3/3 crypto Run 20 walk-forward (slow) ===');
  const cryptoTrades: TradeResult[] = [];
  await runWalkForward(createCryptoRunner(cryptoTrades), { symbols: CONFIG_3SYM.symbols }, { quiet: true });
  console.log(`  ${cryptoTrades.length} OOS trades`);
  const crypto = cryptoDailySeries(cryptoTrades);
  console.log(`  `, seriesStats(crypto));

  const toObj = (m: Map<string, number>): Record<string, number> =>
    Object.fromEntries([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])));

  const outPath = path.resolve(__dirname, '..', 'experiments', 'runs', 'strategy-daily-returns.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    note: 'Daily LOG returns keyed by UTC date. crypto=Run20 OOS WF (pnl/3 per symbol, spread over holding days); sessionBook=suitable legs × notional weights; f2f=non-overlap WF slide 126, zscore50, long-only.',
    stats: { crypto: seriesStats(crypto), sessionBook: seriesStats(book), f2f: seriesStats(f2f) },
    suitableLegs: suitable,
    series: { crypto: toObj(crypto), sessionBook: toObj(book), f2f: toObj(f2f) },
  }, null, 2));
  console.log(`\nSaved → ${outPath}`);
}

main().catch((err) => { console.error('Extraction failed:', err); process.exit(1); });
