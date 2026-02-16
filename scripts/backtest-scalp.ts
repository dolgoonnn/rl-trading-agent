#!/usr/bin/env npx tsx
/**
 * Scalp Backtest Engine — Multi-Timeframe (5m + 1H Bias)
 *
 * Adapts the proven 1H backtest framework for scalp strategies.
 * Core differences:
 * - Loads 1m data, aggregates to 5m for strategy, 1H for bias
 * - Higher friction (0.05% per side default)
 * - Scalp-tuned walk-forward windows (15-day train, 5-day val)
 * - Strategy selection via --strategy flag
 *
 * Usage:
 *   npx tsx scripts/backtest-scalp.ts
 *   npx tsx scripts/backtest-scalp.ts --threshold 3.5 --friction 0.0005
 *   npx tsx scripts/backtest-scalp.ts --max-bars 48 --cooldown-bars 6
 *   npx tsx scripts/backtest-scalp.ts --partial-tp "0.5,0.85,0.05"
 *   npx tsx scripts/backtest-scalp.ts --json
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import { aggregate } from '../src/lib/scalp/data/aggregator';
import { ICT5mStrategy } from '../src/lib/scalp/strategies/ict-5m';
import type { ScalpStrategy } from '../src/lib/scalp/strategies/types';
import { DEFAULT_SCALP_CONFIG } from '../src/lib/scalp/strategies/types';
import {
  runWalkForward,
  calculateSharpe,
  calculateMaxDrawdown,
  type WalkForwardStrategyRunner,
  type TradeResult,
  type WalkForwardResult,
} from './walk-forward-validate';

// ============================================
// Constants (overridable via CLI)
// ============================================

let MAX_POSITION_BARS = DEFAULT_SCALP_CONFIG.maxBars;
let FRICTION_PER_SIDE = DEFAULT_SCALP_CONFIG.frictionPerSide;
let COOLDOWN_BARS = DEFAULT_SCALP_CONFIG.cooldownBars;
let THRESHOLD = DEFAULT_SCALP_CONFIG.threshold;
let jsonOutputMode = false;

// ============================================
// Types
// ============================================

interface SimulatedPosition {
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  direction: 'long' | 'short';
  entryIndex: number;
  entryTimestamp: number;
  strategy: string;
}

interface PartialTPConfig {
  fraction: number;
  triggerR: number;
  beBuffer: number;
}

interface ScalpBacktestResult {
  walkForwardResult: WalkForwardResult;
  threshold: number;
  symbol: string;
  totalTrades: number;
  overallWinRate: number;
  overallPnl: number;
  avgPnl: number;
  maxDrawdown: number;
  sharpe: number;
  avgBarsHeld: number;
}

// ============================================
// Friction Helpers (same pattern as 1H backtest)
// ============================================

function applyEntryFriction(price: number, direction: 'long' | 'short'): number {
  return direction === 'long'
    ? price * (1 + FRICTION_PER_SIDE)
    : price * (1 - FRICTION_PER_SIDE);
}

function applyExitFriction(price: number, direction: 'long' | 'short'): number {
  return direction === 'long'
    ? price * (1 - FRICTION_PER_SIDE)
    : price * (1 + FRICTION_PER_SIDE);
}

function calculatePnlPercent(
  adjustedEntry: number,
  adjustedExit: number,
  direction: 'long' | 'short',
): number {
  return direction === 'long'
    ? (adjustedExit - adjustedEntry) / adjustedEntry
    : (adjustedEntry - adjustedExit) / adjustedEntry;
}

// ============================================
// Position Simulation
// ============================================

function simulatePositionSimple(
  position: SimulatedPosition,
  candles: Candle[],
  startIndex: number,
): TradeResult | null {
  const adjustedEntry = applyEntryFriction(position.entryPrice, position.direction);

  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;

    const barsHeld = i - position.entryIndex;

    // Check SL/TP
    const exitPrice = checkSLTPMaxBars(position, candle, barsHeld);
    if (exitPrice !== null) {
      const adjustedExit = applyExitFriction(exitPrice, position.direction);
      return {
        entryTimestamp: position.entryTimestamp,
        exitTimestamp: candle.timestamp,
        direction: position.direction,
        entryPrice: adjustedEntry,
        exitPrice: adjustedExit,
        pnlPercent: calculatePnlPercent(adjustedEntry, adjustedExit, position.direction),
        strategy: position.strategy,
      };
    }
  }

  return closeAtEnd(position, candles, adjustedEntry);
}

function simulatePositionPartialTP(
  position: SimulatedPosition,
  candles: Candle[],
  startIndex: number,
  config: PartialTPConfig,
): TradeResult | null {
  const adjustedEntry = applyEntryFriction(position.entryPrice, position.direction);
  const riskDistance = position.direction === 'long'
    ? position.entryPrice - position.stopLoss
    : position.stopLoss - position.entryPrice;

  const triggerPrice = position.direction === 'long'
    ? position.entryPrice + riskDistance * config.triggerR
    : position.entryPrice - riskDistance * config.triggerR;

  let partialTaken = false;
  let currentSL = position.stopLoss;
  let realizedPnl = 0;
  const remainingFraction = 1 - config.fraction;

  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;

    const barsHeld = i - position.entryIndex;

    // Check SL first
    if (position.direction === 'long') {
      if (candle.low <= currentSL) {
        const exitPrice = applyExitFriction(currentSL, position.direction);
        const exitPnl = partialTaken
          ? calculatePnlPercent(adjustedEntry, exitPrice, position.direction) * remainingFraction + realizedPnl
          : calculatePnlPercent(adjustedEntry, exitPrice, position.direction);
        return {
          entryTimestamp: position.entryTimestamp,
          exitTimestamp: candle.timestamp,
          direction: position.direction,
          entryPrice: adjustedEntry,
          exitPrice,
          pnlPercent: exitPnl,
          strategy: position.strategy,
        };
      }

      // Check partial TP trigger
      if (!partialTaken && candle.high >= triggerPrice) {
        partialTaken = true;
        const partialExit = applyExitFriction(triggerPrice, position.direction);
        realizedPnl = calculatePnlPercent(adjustedEntry, partialExit, position.direction) * config.fraction;

        // Move SL to breakeven + buffer
        if (config.beBuffer >= 0) {
          currentSL = position.entryPrice + riskDistance * config.beBuffer;
        }
      }

      // Check full TP
      if (candle.high >= position.takeProfit) {
        const exitPrice = applyExitFriction(position.takeProfit, position.direction);
        const exitPnl = partialTaken
          ? calculatePnlPercent(adjustedEntry, exitPrice, position.direction) * remainingFraction + realizedPnl
          : calculatePnlPercent(adjustedEntry, exitPrice, position.direction);
        return {
          entryTimestamp: position.entryTimestamp,
          exitTimestamp: candle.timestamp,
          direction: position.direction,
          entryPrice: adjustedEntry,
          exitPrice,
          pnlPercent: exitPnl,
          strategy: position.strategy,
        };
      }
    } else {
      // Short
      if (candle.high >= currentSL) {
        const exitPrice = applyExitFriction(currentSL, position.direction);
        const exitPnl = partialTaken
          ? calculatePnlPercent(adjustedEntry, exitPrice, position.direction) * remainingFraction + realizedPnl
          : calculatePnlPercent(adjustedEntry, exitPrice, position.direction);
        return {
          entryTimestamp: position.entryTimestamp,
          exitTimestamp: candle.timestamp,
          direction: position.direction,
          entryPrice: adjustedEntry,
          exitPrice,
          pnlPercent: exitPnl,
          strategy: position.strategy,
        };
      }

      if (!partialTaken && candle.low <= triggerPrice) {
        partialTaken = true;
        const partialExit = applyExitFriction(triggerPrice, position.direction);
        realizedPnl = calculatePnlPercent(adjustedEntry, partialExit, position.direction) * config.fraction;
        if (config.beBuffer >= 0) {
          currentSL = position.entryPrice - riskDistance * config.beBuffer;
        }
      }

      if (candle.low <= position.takeProfit) {
        const exitPrice = applyExitFriction(position.takeProfit, position.direction);
        const exitPnl = partialTaken
          ? calculatePnlPercent(adjustedEntry, exitPrice, position.direction) * remainingFraction + realizedPnl
          : calculatePnlPercent(adjustedEntry, exitPrice, position.direction);
        return {
          entryTimestamp: position.entryTimestamp,
          exitTimestamp: candle.timestamp,
          direction: position.direction,
          entryPrice: adjustedEntry,
          exitPrice,
          pnlPercent: exitPnl,
          strategy: position.strategy,
        };
      }
    }

    // Max bars
    if (barsHeld >= MAX_POSITION_BARS) {
      const exitPrice = applyExitFriction(candle.close, position.direction);
      const exitPnl = partialTaken
        ? calculatePnlPercent(adjustedEntry, exitPrice, position.direction) * remainingFraction + realizedPnl
        : calculatePnlPercent(adjustedEntry, exitPrice, position.direction);
      return {
        entryTimestamp: position.entryTimestamp,
        exitTimestamp: candle.timestamp,
        direction: position.direction,
        entryPrice: adjustedEntry,
        exitPrice,
        pnlPercent: exitPnl,
        strategy: position.strategy,
      };
    }
  }

  return closeAtEnd(position, candles, adjustedEntry);
}

function checkSLTPMaxBars(
  position: SimulatedPosition,
  candle: Candle,
  barsHeld: number,
): number | null {
  if (position.direction === 'long') {
    if (candle.low <= position.stopLoss) return position.stopLoss;
    if (candle.high >= position.takeProfit) return position.takeProfit;
  } else {
    if (candle.high >= position.stopLoss) return position.stopLoss;
    if (candle.low <= position.takeProfit) return position.takeProfit;
  }
  if (barsHeld >= MAX_POSITION_BARS) return candle.close;
  return null;
}

function closeAtEnd(
  position: SimulatedPosition,
  candles: Candle[],
  adjustedEntry: number,
): TradeResult | null {
  const lastCandle = candles[candles.length - 1];
  if (!lastCandle) return null;
  const adjustedExit = applyExitFriction(lastCandle.close, position.direction);
  return {
    entryTimestamp: position.entryTimestamp,
    exitTimestamp: lastCandle.timestamp,
    direction: position.direction,
    entryPrice: adjustedEntry,
    exitPrice: adjustedExit,
    pnlPercent: calculatePnlPercent(adjustedEntry, adjustedExit, position.direction),
    strategy: position.strategy,
  };
}

// ============================================
// Strategy Runner Factory
// ============================================

function createScalpRunner(
  strategy: ScalpStrategy,
  threshold: number,
  exitMode: 'simple' | 'partial_tp',
  partialTP?: PartialTPConfig,
): { runner: WalkForwardStrategyRunner; allTrades: TradeResult[] } {
  const allTrades: TradeResult[] = [];

  const runner: WalkForwardStrategyRunner = {
    name: `scalp-${strategy.name}`,
    async run(trainCandles5m: Candle[], valCandles5m: Candle[], _meta?: { symbol?: string }): Promise<TradeResult[]> {
      // The WF framework passes 5m candles (we load from 1m data)
      // We need to aggregate to 1H for bias
      const all5m = [...trainCandles5m, ...valCandles5m];
      const all1h = aggregate(all5m, 12); // 12 × 5m = 1H

      const valStartIndex = trainCandles5m.length;
      const windowTrades: TradeResult[] = [];
      let currentPosition: SimulatedPosition | null = null;
      let positionExitIndex = -1;
      let lastSignalBar = -COOLDOWN_BARS - 1; // Allow first signal

      for (let i = valStartIndex; i < all5m.length; i++) {
        const candle = all5m[i];
        if (!candle) continue;

        // Skip while position is open
        if (currentPosition !== null && i <= positionExitIndex) continue;
        currentPosition = null;

        // Cooldown between signals
        if (i - lastSignalBar < COOLDOWN_BARS) continue;

        // Find corresponding 1H index
        const htfIndex = findHTFIndex(all1h, candle.timestamp);
        if (htfIndex < 30) continue; // Need enough 1H history

        // Run strategy
        const signal = strategy.detectEntry(all5m, i, all1h, htfIndex);

        if (signal && signal.confidence * 10 >= threshold) {
          lastSignalBar = i;

          const position: SimulatedPosition = {
            entryPrice: signal.entryPrice,
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit,
            direction: signal.direction,
            entryIndex: i,
            entryTimestamp: candle.timestamp,
            strategy: signal.strategy,
          };

          let trade: TradeResult | null;
          if (exitMode === 'partial_tp' && partialTP) {
            trade = simulatePositionPartialTP(position, all5m, i + 1, partialTP);
          } else {
            trade = simulatePositionSimple(position, all5m, i + 1);
          }

          if (trade) {
            windowTrades.push(trade);
            allTrades.push(trade);

            // Find exit bar index
            let exitIdx = i + 1;
            for (let j = i + 1; j < all5m.length; j++) {
              const c = all5m[j];
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

      return windowTrades;
    },
  };

  return { runner, allTrades };
}

/**
 * Find the most recent 1H candle index for a given 5m timestamp.
 */
function findHTFIndex(candles1h: Candle[], timestamp: number): number {
  let lo = 0;
  let hi = candles1h.length - 1;
  let best = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const c = candles1h[mid]!;
    if (c.timestamp <= timestamp) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return best;
}

// ============================================
// CLI Helpers
// ============================================

function getArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
  const symbolArg = getArg('symbol') ?? 'BTCUSDT';
  const thresholdArg = getArg('threshold');
  const frictionArg = getArg('friction');
  const maxBarsArg = getArg('max-bars');
  const cooldownBarsArg = getArg('cooldown-bars');
  const partialTpArg = getArg('partial-tp');
  const trainBarsArg = getArg('train-bars');
  const valBarsArg = getArg('val-bars');
  const slideBarsArg = getArg('slide-bars');
  jsonOutputMode = hasFlag('json');

  // Parse overrides
  if (thresholdArg) THRESHOLD = parseFloat(thresholdArg);
  if (frictionArg) FRICTION_PER_SIDE = parseFloat(frictionArg);
  if (maxBarsArg) MAX_POSITION_BARS = parseInt(maxBarsArg, 10);
  if (cooldownBarsArg) COOLDOWN_BARS = parseInt(cooldownBarsArg, 10);

  // Parse partial TP
  let partialTP: PartialTPConfig | undefined;
  let exitMode: 'simple' | 'partial_tp' = 'simple';
  if (partialTpArg) {
    const parts = partialTpArg.split(',');
    if (parts.length >= 2) {
      partialTP = {
        fraction: parseFloat(parts[0]!),
        triggerR: parseFloat(parts[1]!),
        beBuffer: parts.length >= 3 ? parseFloat(parts[2]!) : 0.1,
      };
      exitMode = 'partial_tp';
    }
  }

  // Load 1m data
  const dataPath = path.resolve(__dirname, '..', 'data', `${symbolArg}_1m.json`);
  if (!fs.existsSync(dataPath)) {
    console.error(`Error: No 1m data found at ${dataPath}`);
    console.error('Run: npx tsx scripts/download-scalp-data.ts first');
    process.exit(1);
  }

  console.log(`Loading ${symbolArg} 1m data...`);
  const candles1m: Candle[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  console.log(`  ${candles1m.length.toLocaleString()} 1m candles loaded`);

  // Aggregate to 5m
  const candles5m = aggregate(candles1m, 5);
  console.log(`  ${candles5m.length.toLocaleString()} 5m candles aggregated`);

  const trainBars = trainBarsArg ? parseInt(trainBarsArg, 10) : DEFAULT_SCALP_CONFIG.trainBars;
  const valBars = valBarsArg ? parseInt(valBarsArg, 10) : DEFAULT_SCALP_CONFIG.valBars;
  const slideBars = slideBarsArg ? parseInt(slideBarsArg, 10) : DEFAULT_SCALP_CONFIG.slideBars;

  console.log(`\n=== Scalp Backtest Config ===`);
  console.log(`  Strategy: ict_5m`);
  console.log(`  Symbol: ${symbolArg}`);
  console.log(`  Threshold: ${THRESHOLD}`);
  console.log(`  Friction/side: ${(FRICTION_PER_SIDE * 100).toFixed(3)}%`);
  console.log(`  Max bars: ${MAX_POSITION_BARS} (${(MAX_POSITION_BARS * 5 / 60).toFixed(1)} hours)`);
  console.log(`  Cooldown: ${COOLDOWN_BARS} bars (${COOLDOWN_BARS * 5} min)`);
  console.log(`  Exit mode: ${exitMode}${partialTP ? ` (${(partialTP.fraction * 100).toFixed(0)}%@${partialTP.triggerR}R, BE buffer=${partialTP.beBuffer})` : ''}`);
  console.log(`  WF windows: train=${trainBars} (${(trainBars * 5 / 60 / 24).toFixed(1)}d) val=${valBars} (${(valBars * 5 / 60 / 24).toFixed(1)}d) slide=${slideBars}`);
  console.log('');

  // Create strategy and runner
  const strategy = new ICT5mStrategy();
  const { runner, allTrades } = createScalpRunner(strategy, THRESHOLD, exitMode, partialTP);

  // Run walk-forward validation on 5m candles
  // We need to write 5m data to a temp file for the WF framework
  const tempDataDir = path.resolve(__dirname, '..', 'data', '.scalp-temp');
  if (!fs.existsSync(tempDataDir)) fs.mkdirSync(tempDataDir, { recursive: true });
  const temp5mPath = path.resolve(tempDataDir, `${symbolArg}_5m.json`);
  fs.writeFileSync(temp5mPath, JSON.stringify(candles5m));

  const walkForwardResult = await runWalkForward(runner, {
    symbols: [symbolArg],
    trainWindowBars: trainBars,
    valWindowBars: valBars,
    slideStepBars: slideBars,
    lookbackBuffer: 100,
    dataDir: tempDataDir,
    timeframe: '5m',
  }, { quiet: jsonOutputMode });

  // Clean up temp data
  try { fs.unlinkSync(temp5mPath); fs.rmdirSync(tempDataDir); } catch { /* ignore */ }

  // Compute summary metrics
  const wins = allTrades.filter((t) => t.pnlPercent > 0).length;
  const winRate = allTrades.length > 0 ? wins / allTrades.length : 0;
  const totalPnl = allTrades.reduce((s, t) => s + t.pnlPercent, 0);
  const avgPnl = allTrades.length > 0 ? totalPnl / allTrades.length : 0;
  const sharpe = calculateSharpe(allTrades.map((t) => t.pnlPercent));
  const maxDD = calculateMaxDrawdown(allTrades.map((t) => t.pnlPercent));

  // Avg bars held (approximate from timestamps)
  const fiveMinMs = 5 * 60_000;
  const avgBarsHeld = allTrades.length > 0
    ? allTrades.reduce((s, t) => s + (t.exitTimestamp - t.entryTimestamp) / fiveMinMs, 0) / allTrades.length
    : 0;

  const result: ScalpBacktestResult = {
    walkForwardResult,
    threshold: THRESHOLD,
    symbol: symbolArg,
    totalTrades: allTrades.length,
    overallWinRate: winRate,
    overallPnl: totalPnl,
    avgPnl,
    maxDrawdown: maxDD,
    sharpe,
    avgBarsHeld,
  };

  if (jsonOutputMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('\n=== Scalp Backtest Results ===');
    console.log(`  Total trades: ${allTrades.length}`);
    console.log(`  Win rate: ${(winRate * 100).toFixed(1)}%`);
    console.log(`  Total PnL: ${(totalPnl * 100).toFixed(1)}%`);
    console.log(`  Avg PnL/trade: ${(avgPnl * 100).toFixed(3)}%`);
    console.log(`  Sharpe: ${sharpe.toFixed(2)}`);
    console.log(`  Max Drawdown: ${(maxDD * 100).toFixed(1)}%`);
    console.log(`  Avg bars held: ${avgBarsHeld.toFixed(1)} (${(avgBarsHeld * 5 / 60).toFixed(1)} hours)`);
    console.log(`  WF pass rate: ${(walkForwardResult.passRate * 100).toFixed(1)}%`);

    // Print per-window results
    if (walkForwardResult.symbols.length > 0) {
      const sym = walkForwardResult.symbols[0]!;
      console.log(`\n=== Walk-Forward Windows (${sym.symbol}) ===`);
      for (const w of sym.windows) {
        const status = w.passed ? 'PASS' : 'FAIL';
        console.log(
          `  W${w.windowIndex}: ${w.valStart.slice(0, 10)} → ${w.valEnd.slice(0, 10)} | ` +
          `Trades: ${w.trades} | WR: ${(w.winRate * 100).toFixed(0)}% | ` +
          `PnL: ${(w.pnl * 100).toFixed(1)}% | Sharpe: ${w.sharpe.toFixed(2)} | ${status}`,
        );
      }
    }

    // Print reproduction command
    console.log('\n=== Reproduction Command ===');
    const cmd = [
      'npx tsx scripts/backtest-scalp.ts',
      `--symbol ${symbolArg}`,
      `--threshold ${THRESHOLD}`,
      `--friction ${FRICTION_PER_SIDE}`,
      `--max-bars ${MAX_POSITION_BARS}`,
      `--cooldown-bars ${COOLDOWN_BARS}`,
    ];
    if (partialTP) {
      cmd.push(`--partial-tp "${partialTP.fraction},${partialTP.triggerR},${partialTP.beBuffer}"`);
    }
    cmd.push(`--train-bars ${trainBars} --val-bars ${valBars} --slide-bars ${slideBars}`);
    console.log(`  ${cmd.join(' \\\n    ')}`);
  }
}

main().catch((err) => {
  console.error('Scalp backtest failed:', err);
  process.exit(1);
});
