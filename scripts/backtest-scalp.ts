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
 * - Regime suppression via --suppress-regime flag
 * - Configurable kill zones, R:R, OB proximity
 *
 * Usage:
 *   npx tsx scripts/backtest-scalp.ts
 *   npx tsx scripts/backtest-scalp.ts --target-rr 1.5 --suppress-regime "ranging+normal,ranging+high"
 *   npx tsx scripts/backtest-scalp.ts --kill-zone-mode crypto --ob-proximity 0.003
 *   npx tsx scripts/backtest-scalp.ts --symbols BTCUSDT,ETHUSDT,SOLUSDT
 *   npx tsx scripts/backtest-scalp.ts --strategy mean_reversion --threshold 0
 *   npx tsx scripts/backtest-scalp.ts --partial-tp "0.5,0.85,0.05"
 *   npx tsx scripts/backtest-scalp.ts --json
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import { aggregate } from '../src/lib/scalp/data/aggregator';
import { ICT5mStrategy } from '../src/lib/scalp/strategies/ict-5m';
import { MeanReversionStrategy } from '../src/lib/scalp/strategies/mean-reversion';
import { BBSqueezeStrategy } from '../src/lib/scalp/strategies/bb-squeeze';
import { ATRBreakoutStrategy } from '../src/lib/scalp/strategies/atr-breakout';
import { SilverBulletStrategy } from '../src/lib/scalp/strategies/silver-bullet';
import { SessionRangeStrategy } from '../src/lib/scalp/strategies/session-range';
import type { ScalpStrategy, ScalpStrategyName, KillZoneMode, ICT5mConfig } from '../src/lib/scalp/strategies/types';
import { DEFAULT_SCALP_CONFIG, DEFAULT_ICT5M_CONFIG } from '../src/lib/scalp/strategies/types';
import { detectRegime, regimeLabel } from '../src/lib/ict/regime-detector';
import {
  runWalkForward,
  calculateSharpe,
  calculateMaxDrawdown,
  type WalkForwardStrategyRunner,
  type TradeResult,
  type WalkForwardResult,
} from './walk-forward-validate';

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
  symbols: string[];
  totalTrades: number;
  overallWinRate: number;
  overallPnl: number;
  avgPnl: number;
  maxDrawdown: number;
  sharpe: number;
  avgBarsHeld: number;
  regimeSuppressed: string[];
  strategyConfig: Record<string, unknown>;
}

// ============================================
// Friction Helpers (same pattern as 1H backtest)
// ============================================

function applyEntryFriction(price: number, direction: 'long' | 'short', friction: number): number {
  return direction === 'long'
    ? price * (1 + friction)
    : price * (1 - friction);
}

function applyExitFriction(price: number, direction: 'long' | 'short', friction: number): number {
  return direction === 'long'
    ? price * (1 - friction)
    : price * (1 + friction);
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
  maxBars: number,
  friction: number,
): TradeResult | null {
  const adjustedEntry = applyEntryFriction(position.entryPrice, position.direction, friction);

  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;

    const barsHeld = i - position.entryIndex;

    const exitPrice = checkSLTPMaxBars(position, candle, barsHeld, maxBars);
    if (exitPrice !== null) {
      const adjustedExit = applyExitFriction(exitPrice, position.direction, friction);
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

  return closeAtEnd(position, candles, adjustedEntry, friction);
}

function simulatePositionPartialTP(
  position: SimulatedPosition,
  candles: Candle[],
  startIndex: number,
  config: PartialTPConfig,
  maxBars: number,
  friction: number,
): TradeResult | null {
  const adjustedEntry = applyEntryFriction(position.entryPrice, position.direction, friction);
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

    if (position.direction === 'long') {
      if (candle.low <= currentSL) {
        const exitPrice = applyExitFriction(currentSL, position.direction, friction);
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

      if (!partialTaken && candle.high >= triggerPrice) {
        partialTaken = true;
        const partialExit = applyExitFriction(triggerPrice, position.direction, friction);
        realizedPnl = calculatePnlPercent(adjustedEntry, partialExit, position.direction) * config.fraction;
        if (config.beBuffer >= 0) {
          currentSL = position.entryPrice + riskDistance * config.beBuffer;
        }
      }

      if (candle.high >= position.takeProfit) {
        const exitPrice = applyExitFriction(position.takeProfit, position.direction, friction);
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
      if (candle.high >= currentSL) {
        const exitPrice = applyExitFriction(currentSL, position.direction, friction);
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
        const partialExit = applyExitFriction(triggerPrice, position.direction, friction);
        realizedPnl = calculatePnlPercent(adjustedEntry, partialExit, position.direction) * config.fraction;
        if (config.beBuffer >= 0) {
          currentSL = position.entryPrice - riskDistance * config.beBuffer;
        }
      }

      if (candle.low <= position.takeProfit) {
        const exitPrice = applyExitFriction(position.takeProfit, position.direction, friction);
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

    if (barsHeld >= maxBars) {
      const exitPrice = applyExitFriction(candle.close, position.direction, friction);
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

  return closeAtEnd(position, candles, adjustedEntry, friction);
}

function checkSLTPMaxBars(
  position: SimulatedPosition,
  candle: Candle,
  barsHeld: number,
  maxBars: number,
): number | null {
  if (position.direction === 'long') {
    if (candle.low <= position.stopLoss) return position.stopLoss;
    if (candle.high >= position.takeProfit) return position.takeProfit;
  } else {
    if (candle.high >= position.stopLoss) return position.stopLoss;
    if (candle.low <= position.takeProfit) return position.takeProfit;
  }
  if (barsHeld >= maxBars) return candle.close;
  return null;
}

function closeAtEnd(
  position: SimulatedPosition,
  candles: Candle[],
  adjustedEntry: number,
  friction: number,
): TradeResult | null {
  const lastCandle = candles[candles.length - 1];
  if (!lastCandle) return null;
  const adjustedExit = applyExitFriction(lastCandle.close, position.direction, friction);
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
// Strategy Factory
// ============================================

interface ATRBreakoutConfig {
  atrExpansionMultiple?: number;
  momentumBars?: number;
  targetRR?: number;
}

function createStrategy(
  name: ScalpStrategyName,
  ict5mConfig: ICT5mConfig,
  atrConfig?: ATRBreakoutConfig,
): ScalpStrategy {
  switch (name) {
    case 'ict_5m':
      return new ICT5mStrategy(ict5mConfig);
    case 'mean_reversion':
      return new MeanReversionStrategy();
    case 'bb_squeeze':
      return new BBSqueezeStrategy();
    case 'atr_breakout':
      return new ATRBreakoutStrategy(atrConfig);
    case 'silver_bullet':
      return new SilverBulletStrategy();
    case 'session_range':
      return new SessionRangeStrategy();
    default:
      throw new Error(`Unknown scalp strategy: ${name}. Available: ict_5m, mean_reversion, bb_squeeze, atr_breakout, silver_bullet, session_range`);
  }
}

// ============================================
// Strategy Runner Factory
// ============================================

function createScalpRunner(
  strategy: ScalpStrategy,
  threshold: number,
  exitMode: 'simple' | 'partial_tp',
  maxBars: number,
  cooldownBars: number,
  friction: number,
  suppressRegimes: string[],
  partialTP?: PartialTPConfig,
): { runner: WalkForwardStrategyRunner; allTrades: TradeResult[] } {
  const allTrades: TradeResult[] = [];

  const runner: WalkForwardStrategyRunner = {
    name: `scalp-${strategy.name}`,
    async run(trainCandles5m: Candle[], valCandles5m: Candle[], _meta?: { symbol?: string }): Promise<TradeResult[]> {
      const all5m = [...trainCandles5m, ...valCandles5m];
      const all1h = aggregate(all5m, 60); // 60 minutes = 1H

      const valStartIndex = trainCandles5m.length;
      const windowTrades: TradeResult[] = [];
      let currentPosition: SimulatedPosition | null = null;
      let positionExitIndex = -1;
      let lastSignalBar = -cooldownBars - 1;

      for (let i = valStartIndex; i < all5m.length; i++) {
        const candle = all5m[i];
        if (!candle) continue;

        // Skip while position is open
        if (currentPosition !== null && i <= positionExitIndex) continue;
        currentPosition = null;

        // Cooldown between signals
        if (i - lastSignalBar < cooldownBars) continue;

        // Regime suppression: check on 1H candles
        if (suppressRegimes.length > 0) {
          const htfIdx = findHTFIndex(all1h, candle.timestamp);
          if (htfIdx >= 20) {
            const regime = detectRegime(all1h, htfIdx);
            const label = regimeLabel(regime);
            if (suppressRegimes.includes(label)) continue;
          }
        }

        // Find corresponding 1H index
        const htfIndex = findHTFIndex(all1h, candle.timestamp);
        if (htfIndex < 30) continue;

        // Run strategy
        const signal = strategy.detectEntry(all5m, i, all1h, htfIndex);

        if (signal && signal.confidence * 10 >= threshold) {
          lastSignalBar = i;

          // Bug fix: enter at next bar's open, not signal bar's close
          const nextBar = all5m[i + 1];
          if (!nextBar) continue; // No next bar available
          const actualEntry = nextBar.open;

          // Recalculate SL/TP preserving same risk distance
          const originalRisk = Math.abs(signal.entryPrice - signal.stopLoss);
          const originalReward = Math.abs(signal.takeProfit - signal.entryPrice);

          const stopLoss = signal.direction === 'long'
            ? actualEntry - originalRisk
            : actualEntry + originalRisk;
          const takeProfit = signal.direction === 'long'
            ? actualEntry + originalReward
            : actualEntry - originalReward;

          const position: SimulatedPosition = {
            entryPrice: actualEntry,
            stopLoss,
            takeProfit,
            direction: signal.direction,
            entryIndex: i + 1,
            entryTimestamp: nextBar.timestamp,
            strategy: signal.strategy,
          };

          let trade: TradeResult | null;
          if (exitMode === 'partial_tp' && partialTP) {
            trade = simulatePositionPartialTP(position, all5m, i + 1, partialTP, maxBars, friction);
          } else {
            trade = simulatePositionSimple(position, all5m, i + 1, maxBars, friction);
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

  // Use only COMPLETED 1H candles — avoid look-ahead
  if (best >= 0) {
    const candleEnd = candles1h[best]!.timestamp + 60 * 60_000; // 1H = 3600s
    if (candleEnd > timestamp) {
      best = best - 1; // Current candle not yet closed, use previous
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
  // Parse CLI args
  const symbolArg = getArg('symbol');
  const symbolsArg = getArg('symbols');
  const strategyArg = getArg('strategy') as ScalpStrategyName | undefined;
  const thresholdArg = getArg('threshold');
  const frictionArg = getArg('friction');
  const maxBarsArg = getArg('max-bars');
  const cooldownBarsArg = getArg('cooldown-bars');
  const partialTpArg = getArg('partial-tp');
  const trainBarsArg = getArg('train-bars');
  const valBarsArg = getArg('val-bars');
  const slideBarsArg = getArg('slide-bars');
  const suppressRegimeArg = getArg('suppress-regime');
  const targetRRArg = getArg('target-rr');
  const killZoneModeArg = getArg('kill-zone-mode') as KillZoneMode | undefined;
  const obProximityArg = getArg('ob-proximity');
  const atrExpansionArg = getArg('atr-expansion');
  const momentumBarsArg = getArg('momentum-bars');
  const atrTargetRRArg = getArg('atr-target-rr');
  const jsonOutputMode = hasFlag('json');

  // Determine symbols
  const symbols = symbolsArg
    ? symbolsArg.split(',').map((s) => s.trim())
    : [symbolArg ?? 'BTCUSDT'];

  // Parse config
  const strategyName = strategyArg ?? DEFAULT_SCALP_CONFIG.strategy;
  const threshold = thresholdArg ? parseFloat(thresholdArg) : DEFAULT_SCALP_CONFIG.threshold;
  const friction = frictionArg ? parseFloat(frictionArg) : DEFAULT_SCALP_CONFIG.frictionPerSide;
  const maxBars = maxBarsArg ? parseInt(maxBarsArg, 10) : DEFAULT_SCALP_CONFIG.maxBars;
  const cooldownBars = cooldownBarsArg ? parseInt(cooldownBarsArg, 10) : DEFAULT_SCALP_CONFIG.cooldownBars;
  const trainBars = trainBarsArg ? parseInt(trainBarsArg, 10) : DEFAULT_SCALP_CONFIG.trainBars;
  const valBars = valBarsArg ? parseInt(valBarsArg, 10) : DEFAULT_SCALP_CONFIG.valBars;
  const slideBars = slideBarsArg ? parseInt(slideBarsArg, 10) : DEFAULT_SCALP_CONFIG.slideBars;

  // Parse suppress-regime
  const suppressRegimes = suppressRegimeArg
    ? suppressRegimeArg.split(',').map((s) => s.trim())
    : [];

  // Parse ICT 5m config
  const ict5mConfig: ICT5mConfig = {
    ...DEFAULT_ICT5M_CONFIG,
    ...(targetRRArg && { targetRR: parseFloat(targetRRArg) }),
    ...(killZoneModeArg && { killZoneMode: killZoneModeArg }),
    ...(obProximityArg && { obProximity: parseFloat(obProximityArg) }),
  };
  // Ensure minRR stays below targetRR
  if (ict5mConfig.targetRR < ict5mConfig.minRR) {
    ict5mConfig.minRR = ict5mConfig.targetRR * 0.8;
  }

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

  // Verify data exists for all symbols
  const tempDataDir = path.resolve(__dirname, '..', 'data', '.scalp-temp');
  if (!fs.existsSync(tempDataDir)) fs.mkdirSync(tempDataDir, { recursive: true });

  const validSymbols: string[] = [];
  for (const sym of symbols) {
    const dataPath = path.resolve(__dirname, '..', 'data', `${sym}_1m.json`);
    if (!fs.existsSync(dataPath)) {
      console.error(`Warning: No 1m data for ${sym} at ${dataPath}. Skipping.`);
      continue;
    }

    if (!jsonOutputMode) console.log(`Loading ${sym} 1m data...`);
    const candles1m: Candle[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    if (!jsonOutputMode) console.log(`  ${candles1m.length.toLocaleString()} 1m candles loaded`);

    // Aggregate to 5m
    const candles5m = aggregate(candles1m, 5);
    if (!jsonOutputMode) console.log(`  ${candles5m.length.toLocaleString()} 5m candles aggregated`);

    // Write temp 5m data for WF framework
    const temp5mPath = path.resolve(tempDataDir, `${sym}_5m.json`);
    fs.writeFileSync(temp5mPath, JSON.stringify(candles5m));
    validSymbols.push(sym);
  }

  if (validSymbols.length === 0) {
    console.error('Error: No valid symbol data found.');
    console.error('Run: npx tsx scripts/download-scalp-data.ts --symbol BTCUSDT');
    process.exit(1);
  }

  // Build ATR breakout config
  const atrConfig: ATRBreakoutConfig = {
    ...(atrExpansionArg && { atrExpansionMultiple: parseFloat(atrExpansionArg) }),
    ...(momentumBarsArg && { momentumBars: parseInt(momentumBarsArg, 10) }),
    ...(atrTargetRRArg && { targetRR: parseFloat(atrTargetRRArg) }),
  };

  if (!jsonOutputMode) {
    console.log(`\n=== Scalp Backtest Config ===`);
    console.log(`  Strategy: ${strategyName}`);
    console.log(`  Symbols: ${validSymbols.join(', ')}`);
    console.log(`  Threshold: ${threshold}`);
    console.log(`  Friction/side: ${(friction * 100).toFixed(3)}%`);
    console.log(`  Max bars: ${maxBars} (${(maxBars * 5 / 60).toFixed(1)} hours)`);
    console.log(`  Cooldown: ${cooldownBars} bars (${cooldownBars * 5} min)`);
    console.log(`  Exit mode: ${exitMode}${partialTP ? ` (${(partialTP.fraction * 100).toFixed(0)}%@${partialTP.triggerR}R, BE buffer=${partialTP.beBuffer})` : ''}`);
    console.log(`  WF windows: train=${trainBars} (${(trainBars * 5 / 60 / 24).toFixed(1)}d) val=${valBars} (${(valBars * 5 / 60 / 24).toFixed(1)}d) slide=${slideBars}`);
    if (suppressRegimes.length > 0) {
      console.log(`  Suppress regimes: ${suppressRegimes.join(', ')}`);
    }
    if (strategyName === 'ict_5m') {
      console.log(`  Target R:R: ${ict5mConfig.targetRR} (min: ${ict5mConfig.minRR.toFixed(2)})`);
      console.log(`  Kill zone mode: ${ict5mConfig.killZoneMode}`);
      console.log(`  OB proximity: ${(ict5mConfig.obProximity * 100).toFixed(2)}%`);
    }
    if (strategyName === 'atr_breakout') {
      console.log(`  ATR expansion multiple: ${atrConfig.atrExpansionMultiple ?? 1.5}`);
      console.log(`  Momentum bars: ${atrConfig.momentumBars ?? 3}`);
      console.log(`  ATR target R:R: ${atrConfig.targetRR ?? 1.5}`);
    }
    console.log('');
  }

  // Create strategy and runner
  const strategy = createStrategy(strategyName, ict5mConfig, atrConfig);
  const { runner, allTrades } = createScalpRunner(
    strategy, threshold, exitMode, maxBars, cooldownBars, friction, suppressRegimes, partialTP,
  );

  // Run walk-forward validation on 5m candles
  const walkForwardResult = await runWalkForward(runner, {
    symbols: validSymbols,
    trainWindowBars: trainBars,
    valWindowBars: valBars,
    slideStepBars: slideBars,
    lookbackBuffer: 100,
    dataDir: tempDataDir,
    timeframe: '5m',
  }, { quiet: jsonOutputMode });

  // Clean up temp data
  for (const sym of validSymbols) {
    try { fs.unlinkSync(path.resolve(tempDataDir, `${sym}_5m.json`)); } catch { /* ignore */ }
  }
  try { fs.rmdirSync(tempDataDir); } catch { /* ignore */ }

  // Compute summary metrics
  const wins = allTrades.filter((t) => t.pnlPercent > 0).length;
  const winRate = allTrades.length > 0 ? wins / allTrades.length : 0;
  const totalPnl = allTrades.reduce((s, t) => s + t.pnlPercent, 0);
  const avgPnl = allTrades.length > 0 ? totalPnl / allTrades.length : 0;
  const sharpe = calculateSharpe(allTrades.map((t) => t.pnlPercent));
  const maxDD = calculateMaxDrawdown(allTrades.map((t) => t.pnlPercent));

  // Avg bars held
  const fiveMinMs = 5 * 60_000;
  const avgBarsHeld = allTrades.length > 0
    ? allTrades.reduce((s, t) => s + (t.exitTimestamp - t.entryTimestamp) / fiveMinMs, 0) / allTrades.length
    : 0;

  const result: ScalpBacktestResult = {
    walkForwardResult,
    threshold,
    symbols: validSymbols,
    totalTrades: allTrades.length,
    overallWinRate: winRate,
    overallPnl: totalPnl,
    avgPnl,
    maxDrawdown: maxDD,
    sharpe,
    avgBarsHeld,
    regimeSuppressed: suppressRegimes,
    strategyConfig: strategyName === 'ict_5m' ? { ...ict5mConfig } : {},
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

    // Print per-symbol per-window results
    for (const sym of walkForwardResult.symbols) {
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
      `--strategy ${strategyName}`,
      validSymbols.length > 1 ? `--symbols ${validSymbols.join(',')}` : `--symbol ${validSymbols[0]}`,
      `--threshold ${threshold}`,
      `--friction ${friction}`,
      `--max-bars ${maxBars}`,
      `--cooldown-bars ${cooldownBars}`,
    ];
    if (suppressRegimes.length > 0) {
      cmd.push(`--suppress-regime "${suppressRegimes.join(',')}"`);
    }
    if (strategyName === 'ict_5m') {
      cmd.push(`--target-rr ${ict5mConfig.targetRR}`);
      cmd.push(`--kill-zone-mode ${ict5mConfig.killZoneMode}`);
      cmd.push(`--ob-proximity ${ict5mConfig.obProximity}`);
    }
    if (strategyName === 'atr_breakout') {
      if (atrConfig.atrExpansionMultiple) cmd.push(`--atr-expansion ${atrConfig.atrExpansionMultiple}`);
      if (atrConfig.momentumBars) cmd.push(`--momentum-bars ${atrConfig.momentumBars}`);
      if (atrConfig.targetRR) cmd.push(`--atr-target-rr ${atrConfig.targetRR}`);
    }
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
