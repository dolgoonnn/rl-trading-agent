#!/usr/bin/env npx tsx
/**
 * Iteration 3: Threshold & Weight Calibration
 *
 * Optimizes confluence scorer weights and threshold without overfitting.
 * Uses walk-forward cross-validation with a maximin objective:
 *   max(min(window_sharpe)) -- maximize worst-case window performance.
 *
 * Phase 1: Grid search over threshold values [3.0, 3.5, 4.0, 4.5, 5.0]
 *   - For each threshold, run full walk-forward validation
 *   - Select threshold that maximizes min(window_sharpe) across ALL windows
 *
 * Phase 2: Weight sensitivity analysis on the best threshold
 *   - For each of the 10 weights, test +/- 0.5
 *   - Flag any weight whose change causes > 20% shift in min_sharpe
 *   - Highly sensitive weights = system fragility
 *
 * Usage:
 *   npx tsx scripts/calibrate-confluence.ts
 *   npx tsx scripts/calibrate-confluence.ts --symbols BTCUSDT,ETHUSDT
 *   npx tsx scripts/calibrate-confluence.ts --json
 *   npx tsx scripts/calibrate-confluence.ts --skip-sensitivity
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import {
  ConfluenceScorer,
  DEFAULT_WEIGHTS,
  DEFAULT_CONFLUENCE_CONFIG,
  PRODUCTION_STRATEGY_CONFIG,
  DEFAULT_REGIME_FILTER,
  DEFAULT_MTF_BIAS,
  type ConfluenceWeights,
  type ScoredSignal,
  type RegimeFilterConfig,
  type MTFBiasConfig,
} from '../src/lib/rl/strategies/confluence-scorer';
import { ICTStrategyManager, type StrategyName, type SLPlacementMode } from '../src/lib/rl/strategies/ict-strategies';
import {
  runWalkForward,
  calculateSharpe,
  calculateMaxDrawdown,
  type WalkForwardStrategyRunner,
  type TradeResult,
  type WalkForwardResult,
  type WalkForwardConfig,
} from './walk-forward-validate';

// ============================================
// Configuration
// ============================================

const THRESHOLD_GRID = [3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0];
const WEIGHT_DELTA = 0.5;
const SENSITIVITY_ALERT_THRESHOLD = 0.20; // 20% change in min_sharpe is "fragile"
const MAX_BARS_IN_POSITION = 72; // 3 days max hold on hourly bars

/** Combined friction per side: commission + slippage (overridable via --friction) */
let FRICTION_PER_SIDE = 0.0015; // 0.15% per side default (0.1% commission + 0.05% slippage)

/** All 10 weight factor keys in the ConfluenceWeights interface */
const WEIGHT_KEYS: (keyof ConfluenceWeights)[] = [
  'structureAlignment',
  'killZoneActive',
  'liquiditySweep',
  'obProximity',
  'fvgAtCE',
  'recentBOS',
  'rrRatio',
  'oteZone',
  'breakerConfluence',
  'obFvgConfluence',
];

// ============================================
// Types
// ============================================

interface ThresholdSearchResult {
  threshold: number;
  allWindowSharpes: number[];
  minSharpe: number;
  avgSharpe: number;
  stdSharpe: number;
  passRate: number;
  windowsPassed: number;
  totalWindows: number;
  totalTrades: number;
}

interface WeightSensitivityResult {
  weightKey: keyof ConfluenceWeights;
  baseValue: number;
  plusDeltaMinSharpe: number;
  minusDeltaMinSharpe: number;
  sensitivity: number;
  isFragile: boolean;
}

interface CalibrationResult {
  timestamp: string;
  symbols: string[];
  phase1: {
    results: ThresholdSearchResult[];
    bestThreshold: number;
    bestMinSharpe: number;
    bestAvgSharpe: number;
    reasoning: string;
  };
  phase2: WeightSensitivityResult[] | null;
  stabilityAssessment: string;
  overallDecision: string;
}

// ============================================
// Position Simulation (self-contained)
// ============================================

interface SimulatedPosition {
  direction: 'long' | 'short';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  entryIndex: number;
  entryTimestamp: number;
  strategy: string;
}

/**
 * Apply friction (commission + slippage) to entry/exit prices.
 */
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

/**
 * Simulate a position through subsequent candles.
 * Returns a TradeResult when the position exits via SL, TP, or max bars.
 * Returns null if the position is still open at the end of the candle array.
 */
function simulatePosition(
  position: SimulatedPosition,
  candles: Candle[],
  startIndex: number,
  maxBars: number,
): TradeResult | null {
  const adjustedEntry = applyEntryFriction(position.entryPrice, position.direction);

  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;

    const barsHeld = i - position.entryIndex;

    // Check stop loss
    let hitSL = false;
    let hitTP = false;

    if (position.direction === 'long') {
      hitSL = candle.low <= position.stopLoss;
      hitTP = candle.high >= position.takeProfit;
    } else {
      hitSL = candle.high >= position.stopLoss;
      hitTP = candle.low <= position.takeProfit;
    }

    // Check max bars
    const maxBarsReached = barsHeld >= maxBars;

    if (hitSL || hitTP || maxBarsReached) {
      let exitPrice: number;

      if (hitSL && hitTP) {
        // Both hit in same bar -- assume SL hit first (conservative)
        exitPrice = position.stopLoss;
      } else if (hitSL) {
        exitPrice = position.stopLoss;
      } else if (hitTP) {
        exitPrice = position.takeProfit;
      } else {
        exitPrice = candle.close;
      }

      const adjustedExit = applyExitFriction(exitPrice, position.direction);

      // Calculate PnL from friction-adjusted prices
      const pnlPercent = position.direction === 'long'
        ? (adjustedExit - adjustedEntry) / adjustedEntry
        : (adjustedEntry - adjustedExit) / adjustedEntry;

      return {
        entryTimestamp: position.entryTimestamp,
        exitTimestamp: candle.timestamp,
        direction: position.direction,
        entryPrice: adjustedEntry,
        exitPrice: adjustedExit,
        pnlPercent,
        strategy: position.strategy,
      };
    }
  }

  return null;
}

// ============================================
// Confluence Runner Factory
// ============================================

/**
 * Creates a WalkForwardStrategyRunner that uses the ConfluenceScorer
 * to generate signals and simulates trades with SL/TP/max bars.
 */
function createConfluenceRunner(
  scorer: ConfluenceScorer,
  maxBarsInPosition: number,
  label: string,
): WalkForwardStrategyRunner {
  return {
    name: label,

    async run(trainCandles: Candle[], valCandles: Candle[]): Promise<TradeResult[]> {
      const trades: TradeResult[] = [];

      // Reset cooldowns between walk-forward windows
      scorer.resetCooldowns();

      // Concatenate for lookback context during validation
      const allCandles = [...trainCandles, ...valCandles];
      const valStartIndex = trainCandles.length;

      let currentPosition: SimulatedPosition | null = null;

      for (let i = valStartIndex; i < allCandles.length; i++) {
        const candle = allCandles[i];
        if (!candle) continue;

        // If in position, check for exit
        if (currentPosition) {
          const result = simulatePosition(
            currentPosition,
            allCandles,
            i,
            maxBarsInPosition,
          );

          if (result) {
            trades.push(result);
            currentPosition = null;
            // Skip to the exit bar to avoid re-entering immediately
            const exitBarIndex = allCandles.findIndex(
              (c) => c.timestamp === result.exitTimestamp,
            );
            if (exitBarIndex > i) {
              i = exitBarIndex;
            }
          }
          continue;
        }

        // Not in position -- evaluate confluence scorer
        const evaluation = scorer.evaluate(allCandles, i);

        if (evaluation.action === 'trade' && evaluation.selectedSignal) {
          const signal = evaluation.selectedSignal.signal;

          currentPosition = {
            direction: signal.direction,
            entryPrice: signal.entryPrice,
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit,
            entryIndex: i,
            entryTimestamp: candle.timestamp,
            strategy: signal.strategy,
          };
        }
      }

      return trades;
    },
  };
}

// ============================================
// Phase 1: Threshold Grid Search
// ============================================

async function runThresholdSearch(
  symbols: string[],
  quiet: boolean,
  regimeFilter?: RegimeFilterConfig,
  activeStrategies?: StrategyName[],
  suppressedRegimes?: string[],
  mtfBias?: MTFBiasConfig,
  slPlacementMode?: SLPlacementMode,
): Promise<ThresholdSearchResult[]> {
  const results: ThresholdSearchResult[] = [];

  for (const threshold of THRESHOLD_GRID) {
    if (!quiet) {
      log(`\n--- Testing threshold: ${threshold.toFixed(1)} ---`);
    }

    const strategyConfig = {
      ...PRODUCTION_STRATEGY_CONFIG,
      ...(slPlacementMode ? { slPlacementMode } : {}),
    };

    const scorer = new ConfluenceScorer({
      ...DEFAULT_CONFLUENCE_CONFIG,
      minThreshold: threshold,
      weights: { ...DEFAULT_WEIGHTS },
      strategyConfig,
      ...(regimeFilter ? { regimeFilter } : {}),
      ...(activeStrategies ? { activeStrategies } : {}),
      ...(suppressedRegimes && suppressedRegimes.length > 0 ? { suppressedRegimes } : {}),
      ...(mtfBias ? { mtfBias } : {}),
    });

    const runner = createConfluenceRunner(
      scorer,
      MAX_BARS_IN_POSITION,
      `Confluence(threshold=${threshold})`,
    );

    const wfResult = await runWalkForward(runner, { symbols }, { quiet: true });

    // Collect window sharpes across all symbols — skip 0-trade windows
    const allWindowSharpes: number[] = [];
    const eligibleWindowSharpes: number[] = [];
    let totalTrades = 0;
    let skippedWindows = 0;

    for (const symbolResult of wfResult.symbols) {
      for (const window of symbolResult.windows) {
        allWindowSharpes.push(window.sharpe);
        totalTrades += window.trades;
        if (window.trades > 0) {
          eligibleWindowSharpes.push(window.sharpe);
        } else {
          skippedWindows++;
        }
      }
    }

    const minSharpe = eligibleWindowSharpes.length > 0
      ? Math.min(...eligibleWindowSharpes)
      : 0;
    const avgSharpe = eligibleWindowSharpes.length > 0
      ? eligibleWindowSharpes.reduce((a, b) => a + b, 0) / eligibleWindowSharpes.length
      : 0;

    const mean = avgSharpe;
    const variance = eligibleWindowSharpes.length > 0
      ? eligibleWindowSharpes.reduce((sum, s) => sum + (s - mean) ** 2, 0) / eligibleWindowSharpes.length
      : 0;
    const stdSharpe = Math.sqrt(variance);

    const windowsPassed = eligibleWindowSharpes.filter((s) => s > 0).length;
    const eligibleCount = eligibleWindowSharpes.length;
    const passRate = eligibleCount > 0
      ? windowsPassed / eligibleCount
      : 0;

    const result: ThresholdSearchResult = {
      threshold,
      allWindowSharpes,
      minSharpe,
      avgSharpe,
      stdSharpe,
      passRate,
      windowsPassed,
      totalWindows: eligibleCount,
      totalTrades,
    };

    results.push(result);

    if (!quiet) {
      log(
        `  Threshold ${threshold.toFixed(1)}: ` +
        `min_sharpe=${minSharpe.toFixed(2)}, ` +
        `avg_sharpe=${avgSharpe.toFixed(2)}, ` +
        `std=${stdSharpe.toFixed(2)}, ` +
        `pass_rate=${(passRate * 100).toFixed(1)}%, ` +
        `${windowsPassed}/${eligibleCount} windows${skippedWindows > 0 ? ` (${skippedWindows} skipped)` : ''}, ` +
        `${totalTrades} trades`,
      );
    }
  }

  return results;
}

/**
 * Select the best threshold using maximin objective.
 * Returns the threshold that maximizes min(window_sharpe).
 */
function selectBestThreshold(results: ThresholdSearchResult[]): {
  bestResult: ThresholdSearchResult;
  reasoning: string;
} {
  // Sort by min_sharpe descending (primary), then avg_sharpe descending (tiebreak)
  const sorted = [...results].sort((a, b) => {
    if (a.minSharpe !== b.minSharpe) return b.minSharpe - a.minSharpe;
    return b.avgSharpe - a.avgSharpe;
  });

  const best = sorted[0];
  if (!best) {
    throw new Error('No threshold search results available');
  }

  // Build reasoning
  const reasonParts: string[] = [];

  reasonParts.push(
    `Selected threshold ${best.threshold.toFixed(1)} with maximin objective.`,
  );
  reasonParts.push(
    `Worst-case window Sharpe: ${best.minSharpe.toFixed(2)} (highest among all candidates).`,
  );

  // Check if any other threshold had a higher avg but lower min
  const higherAvg = results.filter(
    (r) => r.avgSharpe > best.avgSharpe && r.minSharpe < best.minSharpe,
  );
  if (higherAvg.length > 0) {
    reasonParts.push(
      `Note: ${higherAvg.length} threshold(s) had higher average Sharpe but worse worst-case. ` +
      `Maximin prevents trading off bad windows for good ones.`,
    );
  }

  // Check if the best threshold has zero or very few trades
  if (best.totalTrades === 0) {
    reasonParts.push(
      'WARNING: Best threshold produced zero trades. ' +
      'The threshold may be too high for the confluence scorer to generate signals.',
    );
  } else if (best.totalTrades < best.totalWindows * 5) {
    reasonParts.push(
      `Low trade count (${best.totalTrades} across ${best.totalWindows} windows). ` +
      `Results may be noisy due to small sample size.`,
    );
  }

  return {
    bestResult: best,
    reasoning: reasonParts.join(' '),
  };
}

// ============================================
// Phase 2: Weight Sensitivity Analysis
// ============================================

async function runWeightSensitivity(
  bestThreshold: number,
  symbols: string[],
  quiet: boolean,
  regimeFilter?: RegimeFilterConfig,
  activeStrategies?: StrategyName[],
  suppressedRegimes?: string[],
  mtfBias?: MTFBiasConfig,
  slPlacementMode?: SLPlacementMode,
): Promise<WeightSensitivityResult[]> {
  const results: WeightSensitivityResult[] = [];

  // First, get baseline min_sharpe at the best threshold with default weights
  if (!quiet) {
    log('\n--- Running baseline with default weights ---');
  }

  const baseMinSharpe = await getMinSharpeForConfig(
    bestThreshold,
    { ...DEFAULT_WEIGHTS },
    symbols,
    regimeFilter,
    activeStrategies,
    suppressedRegimes,
    mtfBias,
    slPlacementMode,
  );

  if (!quiet) {
    log(`  Baseline min_sharpe: ${baseMinSharpe.toFixed(4)}`);
  }

  for (const weightKey of WEIGHT_KEYS) {
    if (!quiet) {
      log(`\n--- Sensitivity: ${weightKey} (base=${DEFAULT_WEIGHTS[weightKey].toFixed(1)}) ---`);
    }

    const baseValue = DEFAULT_WEIGHTS[weightKey];

    // Test +delta
    const plusWeights: ConfluenceWeights = { ...DEFAULT_WEIGHTS };
    plusWeights[weightKey] = Math.max(0, baseValue + WEIGHT_DELTA);
    const plusMinSharpe = await getMinSharpeForConfig(
      bestThreshold,
      plusWeights,
      symbols,
      regimeFilter,
      activeStrategies,
      suppressedRegimes,
      mtfBias,
      slPlacementMode,
    );

    // Test -delta
    const minusWeights: ConfluenceWeights = { ...DEFAULT_WEIGHTS };
    minusWeights[weightKey] = Math.max(0, baseValue - WEIGHT_DELTA);
    const minusMinSharpe = await getMinSharpeForConfig(
      bestThreshold,
      minusWeights,
      symbols,
      regimeFilter,
      activeStrategies,
      suppressedRegimes,
      mtfBias,
      slPlacementMode,
    );

    // Sensitivity = max absolute change relative to baseline
    // Use absolute min_sharpe difference to avoid division by zero
    const maxChange = Math.max(
      Math.abs(plusMinSharpe - baseMinSharpe),
      Math.abs(minusMinSharpe - baseMinSharpe),
    );

    // Relative sensitivity: how much does min_sharpe change as a fraction of baseline?
    // Guard against baseMinSharpe near zero
    const relativeSensitivity = Math.abs(baseMinSharpe) > 0.01
      ? maxChange / Math.abs(baseMinSharpe)
      : maxChange; // If baseline is near zero, use absolute change

    const isFragile = relativeSensitivity > SENSITIVITY_ALERT_THRESHOLD;

    const result: WeightSensitivityResult = {
      weightKey,
      baseValue,
      plusDeltaMinSharpe: plusMinSharpe,
      minusDeltaMinSharpe: minusMinSharpe,
      sensitivity: relativeSensitivity,
      isFragile,
    };

    results.push(result);

    if (!quiet) {
      const fragileTag = isFragile ? ' [FRAGILE]' : '';
      log(
        `  +${WEIGHT_DELTA}: min_sharpe=${plusMinSharpe.toFixed(4)}, ` +
        `-${WEIGHT_DELTA}: min_sharpe=${minusMinSharpe.toFixed(4)}, ` +
        `sensitivity=${(relativeSensitivity * 100).toFixed(1)}%${fragileTag}`,
      );
    }
  }

  return results;
}

/**
 * Run walk-forward with a specific threshold + weights and return the global min_sharpe.
 */
async function getMinSharpeForConfig(
  threshold: number,
  weights: ConfluenceWeights,
  symbols: string[],
  regimeFilter?: RegimeFilterConfig,
  activeStrategies?: StrategyName[],
  suppressedRegimes?: string[],
  mtfBias?: MTFBiasConfig,
  slPlacementMode?: SLPlacementMode,
): Promise<number> {
  const strategyConfig = {
    ...PRODUCTION_STRATEGY_CONFIG,
    ...(slPlacementMode ? { slPlacementMode } : {}),
  };

  const scorer = new ConfluenceScorer({
    ...DEFAULT_CONFLUENCE_CONFIG,
    minThreshold: threshold,
    weights,
    strategyConfig,
    ...(regimeFilter ? { regimeFilter } : {}),
    ...(activeStrategies ? { activeStrategies } : {}),
    ...(suppressedRegimes && suppressedRegimes.length > 0 ? { suppressedRegimes } : {}),
    ...(mtfBias ? { mtfBias } : {}),
  });

  const runner = createConfluenceRunner(
    scorer,
    MAX_BARS_IN_POSITION,
    `Confluence(t=${threshold},custom_weights)`,
  );

  const wfResult = await runWalkForward(runner, { symbols }, { quiet: true });

  const allSharpes: number[] = [];
  for (const symbolResult of wfResult.symbols) {
    for (const window of symbolResult.windows) {
      allSharpes.push(window.sharpe);
    }
  }

  return allSharpes.length > 0 ? Math.min(...allSharpes) : 0;
}

// ============================================
// Output Formatting
// ============================================

function printPhase1Table(results: ThresholdSearchResult[]): void {
  log('');
  log('PHASE 1: THRESHOLD GRID SEARCH');
  log('Objective: max(min(window_sharpe)) -- maximin');
  log('');
  log('| Threshold | Min Sharpe | Avg Sharpe | Std Sharpe | Pass Rate | Windows | Trades |');
  log('|-----------|------------|------------|------------|-----------|---------|--------|');

  for (const r of results) {
    const passRateStr = `${(r.passRate * 100).toFixed(1)}%`;
    const windowsStr = `${r.windowsPassed}/${r.totalWindows}`;
    log(
      `| ${r.threshold.toFixed(1).padStart(9)} ` +
      `| ${r.minSharpe.toFixed(2).padStart(10)} ` +
      `| ${r.avgSharpe.toFixed(2).padStart(10)} ` +
      `| ${r.stdSharpe.toFixed(2).padStart(10)} ` +
      `| ${passRateStr.padStart(9)} ` +
      `| ${windowsStr.padStart(7)} ` +
      `| ${String(r.totalTrades).padStart(6)} |`,
    );
  }

  log('');
}

function printPhase2Table(
  results: WeightSensitivityResult[],
  baseMinSharpe: number,
): void {
  log('');
  log('PHASE 2: WEIGHT SENSITIVITY ANALYSIS');
  log(`Baseline min_sharpe: ${baseMinSharpe.toFixed(4)}`);
  log(`Delta: +/- ${WEIGHT_DELTA}`);
  log(`Alert threshold: > ${(SENSITIVITY_ALERT_THRESHOLD * 100).toFixed(0)}% change`);
  log('');
  log('| Weight Factor        | Base | +0.5 Min Sharpe | -0.5 Min Sharpe | Sensitivity | Status  |');
  log('|----------------------|------|-----------------|-----------------|-------------|---------|');

  for (const r of results) {
    const status = r.isFragile ? '\x1b[31mFRAGILE\x1b[0m' : '\x1b[32m STABLE\x1b[0m';
    log(
      `| ${r.weightKey.padEnd(20)} ` +
      `| ${r.baseValue.toFixed(1).padStart(4)} ` +
      `| ${r.plusDeltaMinSharpe.toFixed(4).padStart(15)} ` +
      `| ${r.minusDeltaMinSharpe.toFixed(4).padStart(15)} ` +
      `| ${(r.sensitivity * 100).toFixed(1).padStart(10)}% ` +
      `| ${status} |`,
    );
  }

  log('');
}

function buildStabilityAssessment(
  phase2Results: WeightSensitivityResult[] | null,
  bestResult: ThresholdSearchResult,
): string {
  const parts: string[] = [];

  // Threshold assessment
  if (bestResult.totalTrades === 0) {
    parts.push(
      'CRITICAL: The best threshold produced zero trades. ' +
      'The confluence scorer may need lower thresholds or strategy tuning before calibration is meaningful.',
    );
  } else if (bestResult.minSharpe > 0) {
    parts.push(
      `POSITIVE: Best threshold (${bestResult.threshold}) achieved positive worst-case Sharpe ` +
      `(${bestResult.minSharpe.toFixed(2)}). The system has a baseline edge even in worst windows.`,
    );
  } else {
    parts.push(
      `NEGATIVE: Best threshold (${bestResult.threshold}) has negative worst-case Sharpe ` +
      `(${bestResult.minSharpe.toFixed(2)}). No threshold configuration fully prevents losing windows.`,
    );
  }

  // Weight sensitivity assessment
  if (phase2Results) {
    const fragileWeights = phase2Results.filter((r) => r.isFragile);
    const stableWeights = phase2Results.filter((r) => !r.isFragile);

    if (fragileWeights.length === 0) {
      parts.push(
        `ROBUST: All ${stableWeights.length} weight factors are stable. ` +
        `Small perturbations (+/- ${WEIGHT_DELTA}) do not significantly change worst-case performance. ` +
        'The system is not sensitive to exact weight values.',
      );
    } else if (fragileWeights.length <= 2) {
      parts.push(
        `PARTIALLY FRAGILE: ${fragileWeights.length} weight(s) showed > ${(SENSITIVITY_ALERT_THRESHOLD * 100).toFixed(0)}% sensitivity: ` +
        `${fragileWeights.map((w) => w.weightKey).join(', ')}. ` +
        'These weights are load-bearing -- small changes meaningfully affect performance. ' +
        'Consider whether this reflects genuine market structure importance or overfitting.',
      );
    } else {
      parts.push(
        `FRAGILE: ${fragileWeights.length}/${phase2Results.length} weights are highly sensitive: ` +
        `${fragileWeights.map((w) => w.weightKey).join(', ')}. ` +
        'The system is brittle -- exact weight values matter too much. ' +
        'This pattern is similar to the RL epsilon problem. ' +
        'Consider simplifying the scoring or reducing the number of active factors.',
      );
    }
  }

  return parts.join('\n\n');
}

function buildOverallDecision(
  bestResult: ThresholdSearchResult,
  phase2Results: WeightSensitivityResult[] | null,
): string {
  if (bestResult.totalTrades === 0) {
    return 'PIVOT: No trades generated at any threshold. Investigate why confluence scorer produces no signals.';
  }

  const fragileCount = phase2Results
    ? phase2Results.filter((r) => r.isFragile).length
    : 0;

  if (bestResult.minSharpe > 0 && fragileCount <= 2) {
    return `CONTINUE: Best threshold ${bestResult.threshold} is viable with min_sharpe=${bestResult.minSharpe.toFixed(2)}. ` +
      'Proceed to Iteration 4 (Position Management Optimization).';
  }

  if (bestResult.minSharpe > 0 && fragileCount > 2) {
    return `ADJUST: Threshold ${bestResult.threshold} shows edge (min_sharpe=${bestResult.minSharpe.toFixed(2)}) ` +
      `but ${fragileCount} fragile weights indicate brittleness. ` +
      'Consider reducing weight count or using uniform weights before proceeding.';
  }

  if (bestResult.minSharpe <= 0 && bestResult.avgSharpe > 0) {
    return 'ADJUST: Average performance is positive but worst-case is negative. ' +
      'The system may need position management improvements (Iteration 4) to cap losses.';
  }

  return 'PIVOT: No threshold/weight combination yields reliable positive performance. ' +
    'Re-evaluate the confluence factors or underlying strategy signals.';
}

// ============================================
// Experiment Document Generation
// ============================================

function generateExperimentDoc(result: CalibrationResult): string {
  const lines: string[] = [];

  lines.push('# Iteration 3: Threshold & Weight Calibration');
  lines.push('');
  lines.push(`Run: ${result.timestamp}`);
  lines.push(`Symbols: ${result.symbols.join(', ')}`);
  lines.push('');
  lines.push('## Hypothesis');
  lines.push('');
  lines.push(
    'Weights and threshold can be tuned using walk-forward cross-validation ' +
    'with a maximin objective (maximize worst-case window Sharpe, not average).',
  );
  lines.push('');

  // Phase 1
  lines.push('## Phase 1: Threshold Search');
  lines.push('');
  lines.push('Objective: max(min(window_sharpe))');
  lines.push('');
  lines.push('| Threshold | Min Sharpe | Avg Sharpe | Std Sharpe | Pass Rate | Windows | Trades |');
  lines.push('|-----------|------------|------------|------------|-----------|---------|--------|');

  for (const r of result.phase1.results) {
    const passRateStr = `${(r.passRate * 100).toFixed(1)}%`;
    const windowsStr = `${r.windowsPassed}/${r.totalWindows}`;
    lines.push(
      `| ${r.threshold.toFixed(1)} ` +
      `| ${r.minSharpe.toFixed(2)} ` +
      `| ${r.avgSharpe.toFixed(2)} ` +
      `| ${r.stdSharpe.toFixed(2)} ` +
      `| ${passRateStr} ` +
      `| ${windowsStr} ` +
      `| ${r.totalTrades} |`,
    );
  }

  lines.push('');
  lines.push(`### Best Threshold: ${result.phase1.bestThreshold}`);
  lines.push('');
  lines.push(`- Min Sharpe: ${result.phase1.bestMinSharpe.toFixed(4)}`);
  lines.push(`- Avg Sharpe: ${result.phase1.bestAvgSharpe.toFixed(4)}`);
  lines.push(`- Reasoning: ${result.phase1.reasoning}`);
  lines.push('');

  // Phase 2
  if (result.phase2) {
    lines.push('## Phase 2: Weight Sensitivity');
    lines.push('');
    lines.push(`Delta: +/- ${WEIGHT_DELTA}`);
    lines.push(`Alert threshold: > ${(SENSITIVITY_ALERT_THRESHOLD * 100).toFixed(0)}% change in min_sharpe`);
    lines.push('');
    lines.push('| Weight Factor | Base | +0.5 Min Sharpe | -0.5 Min Sharpe | Sensitivity | Status |');
    lines.push('|---------------|------|-----------------|-----------------|-------------|--------|');

    for (const r of result.phase2) {
      const status = r.isFragile ? 'FRAGILE' : 'STABLE';
      lines.push(
        `| ${r.weightKey} ` +
        `| ${r.baseValue.toFixed(1)} ` +
        `| ${r.plusDeltaMinSharpe.toFixed(4)} ` +
        `| ${r.minusDeltaMinSharpe.toFixed(4)} ` +
        `| ${(r.sensitivity * 100).toFixed(1)}% ` +
        `| ${status} |`,
      );
    }

    lines.push('');
  } else {
    lines.push('## Phase 2: Weight Sensitivity');
    lines.push('');
    lines.push('_Skipped (--skip-sensitivity flag)_');
    lines.push('');
  }

  // Stability
  lines.push('## Stability Assessment');
  lines.push('');
  lines.push(result.stabilityAssessment);
  lines.push('');

  // Decision
  lines.push('## Decision');
  lines.push('');
  lines.push(result.overallDecision);
  lines.push('');

  // Key learnings placeholder
  lines.push('## Key Learnings');
  lines.push('');
  lines.push('_(Fill in after reviewing results)_');
  lines.push('');

  // Impact
  lines.push('## Impact on Next Iteration');
  lines.push('');
  lines.push('_(Fill in after reviewing results)_');
  lines.push('');

  return lines.join('\n');
}

// ============================================
// CLI Helpers
// ============================================

let jsonOutputMode = false;

function log(message: string): void {
  if (!jsonOutputMode) {
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
  }
}

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
// Strategy Shorthand Parser
// ============================================

/** Map CLI shorthand to StrategyName: ob -> order_block, fvg -> fvg */
const STRATEGY_SHORTHAND: Record<string, StrategyName> = {
  ob: 'order_block',
  order_block: 'order_block',
  fvg: 'fvg',
  bos: 'bos_continuation',
  bos_continuation: 'bos_continuation',
  choch: 'choch_reversal',
  choch_reversal: 'choch_reversal',
};

function parseStrategyArg(arg: string): StrategyName[] {
  return arg.split(',').map((s) => {
    const key = s.trim().toLowerCase();
    const mapped = STRATEGY_SHORTHAND[key];
    if (!mapped) {
      throw new Error(`Unknown strategy shorthand: "${key}". Valid: ${Object.keys(STRATEGY_SHORTHAND).join(', ')}`);
    }
    return mapped;
  });
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
  const symbolsArg = getArg('symbols');
  const skipSensitivity = hasFlag('skip-sensitivity');
  const useRegime = hasFlag('regime');
  const minEffArg = getArg('min-efficiency');
  const minTrendArg = getArg('min-trend-strength');
  const strategyArg = getArg('strategy');
  const suppressRegimeArg = getArg('suppress-regime');
  const useMTF = hasFlag('mtf');
  const frictionArg = getArg('friction');
  const slModeArg = getArg('sl-mode');
  jsonOutputMode = hasFlag('json');

  // Apply friction override
  if (frictionArg) {
    FRICTION_PER_SIDE = parseFloat(frictionArg);
    if (Number.isNaN(FRICTION_PER_SIDE) || FRICTION_PER_SIDE < 0) {
      console.error('Error: --friction must be a non-negative number (per-side fraction, e.g., 0.0007)');
      process.exit(1);
    }
  }

  // Parse SL placement mode
  const slPlacementMode: SLPlacementMode | undefined =
    (['ob_based', 'entry_based', 'dynamic_rr'] as const).includes(slModeArg as SLPlacementMode)
      ? (slModeArg as SLPlacementMode)
      : undefined;

  const symbols = symbolsArg
    ? symbolsArg.split(',').map((s) => s.trim())
    : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

  // Parse active strategies
  const activeStrategies: StrategyName[] | undefined = strategyArg
    ? parseStrategyArg(strategyArg)
    : undefined;

  // Parse suppressed regimes
  const suppressedRegimes: string[] = suppressRegimeArg
    ? suppressRegimeArg.split(',').map((s) => s.trim())
    : [];

  // Build MTF bias config
  const mtfBias: MTFBiasConfig | undefined = useMTF
    ? { ...DEFAULT_MTF_BIAS, enabled: true }
    : undefined;

  // Build regime filter config
  let regimeFilter: RegimeFilterConfig | undefined;
  if (useRegime) {
    regimeFilter = {
      ...DEFAULT_REGIME_FILTER,
      enabled: true,
      minEfficiency: minEffArg ? parseFloat(minEffArg) : DEFAULT_REGIME_FILTER.minEfficiency,
      minTrendStrength: minTrendArg ? parseFloat(minTrendArg) : DEFAULT_REGIME_FILTER.minTrendStrength,
    };
  }

  if (!jsonOutputMode) {
    log('============================================================');
    log('ITERATION 7: THRESHOLD & WEIGHT CALIBRATION');
    log('============================================================');
    log('');
    log(`Symbols:            ${symbols.join(', ')}`);
    log(`Active strategies:  ${activeStrategies ? activeStrategies.join(', ') : 'default (order_block, fvg)'}`);
    log(`Threshold grid:     ${THRESHOLD_GRID.join(', ')}`);
    log(`Objective:          max(min(window_sharpe)) -- maximin`);
    log(`Friction:           ${(FRICTION_PER_SIDE * 100).toFixed(3)}% per side (${(FRICTION_PER_SIDE * 2 * 100).toFixed(3)}% RT)`);
    log(`SL mode:            ${slPlacementMode ?? 'default (ob_based)'}`);
    log(`Max bars in pos:    ${MAX_BARS_IN_POSITION}`);
    log(`Skip sensitivity:   ${skipSensitivity}`);
    log(`Suppress regimes:   ${suppressedRegimes.length > 0 ? suppressedRegimes.join(', ') : 'none'}`);
    log(`MTF bias:           ${useMTF ? 'ENABLED (4H)' : 'disabled'}`);
    log(`Regime filtering:   ${useRegime ? 'ENABLED' : 'disabled'}`);
    if (regimeFilter) {
      log(`  Min efficiency:   ${regimeFilter.minEfficiency}`);
      log(`  Min trend str:    ${regimeFilter.minTrendStrength}`);
      log(`  Max vol %ile:     ${regimeFilter.maxVolatilityPercentile}`);
      log(`  Min vol %ile:     ${regimeFilter.minVolatilityPercentile}`);
    }
    log('');
  }

  // ------------------------------------------
  // Phase 1: Threshold Grid Search
  // ------------------------------------------
  if (!jsonOutputMode) {
    log('============================================================');
    log('PHASE 1: THRESHOLD GRID SEARCH');
    log('============================================================');
  }

  const phase1Results = await runThresholdSearch(symbols, jsonOutputMode, regimeFilter, activeStrategies, suppressedRegimes, mtfBias, slPlacementMode);

  if (!jsonOutputMode) {
    printPhase1Table(phase1Results);
  }

  const { bestResult, reasoning } = selectBestThreshold(phase1Results);

  if (!jsonOutputMode) {
    log(`Best threshold: ${bestResult.threshold.toFixed(1)}`);
    log(`  Min Sharpe:   ${bestResult.minSharpe.toFixed(4)}`);
    log(`  Avg Sharpe:   ${bestResult.avgSharpe.toFixed(4)}`);
    log(`  Pass Rate:    ${(bestResult.passRate * 100).toFixed(1)}%`);
    log(`  Total Trades: ${bestResult.totalTrades}`);
    log('');
    log(`Reasoning: ${reasoning}`);
  }

  // ------------------------------------------
  // Phase 2: Weight Sensitivity Analysis
  // ------------------------------------------
  let phase2Results: WeightSensitivityResult[] | null = null;

  if (!skipSensitivity) {
    if (!jsonOutputMode) {
      log('');
      log('============================================================');
      log('PHASE 2: WEIGHT SENSITIVITY ANALYSIS');
      log('============================================================');
    }

    phase2Results = await runWeightSensitivity(
      bestResult.threshold,
      symbols,
      jsonOutputMode,
      regimeFilter,
      activeStrategies,
      suppressedRegimes,
      mtfBias,
      slPlacementMode,
    );

    if (!jsonOutputMode) {
      printPhase2Table(phase2Results, bestResult.minSharpe);
    }
  }

  // ------------------------------------------
  // Stability Assessment
  // ------------------------------------------
  const stability = buildStabilityAssessment(phase2Results, bestResult);
  const decision = buildOverallDecision(bestResult, phase2Results);

  if (!jsonOutputMode) {
    log('============================================================');
    log('STABILITY ASSESSMENT');
    log('============================================================');
    log('');
    log(stability);
    log('');
    log('============================================================');
    log('DECISION');
    log('============================================================');
    log('');
    log(decision);
  }

  // ------------------------------------------
  // Build Calibration Result
  // ------------------------------------------
  const calibrationResult: CalibrationResult = {
    timestamp: new Date().toISOString(),
    symbols,
    phase1: {
      results: phase1Results.map((r) => ({
        ...r,
        // Strip the raw sharpes array from the serialized output to keep it clean
        allWindowSharpes: r.allWindowSharpes,
      })),
      bestThreshold: bestResult.threshold,
      bestMinSharpe: bestResult.minSharpe,
      bestAvgSharpe: bestResult.avgSharpe,
      reasoning,
    },
    phase2: phase2Results,
    stabilityAssessment: stability,
    overallDecision: decision,
  };

  // ------------------------------------------
  // Output
  // ------------------------------------------
  if (jsonOutputMode) {
    console.log(JSON.stringify(calibrationResult, null, 2));
  }

  // Save experiment document
  const experimentsDir = path.resolve('experiments');
  if (!fs.existsSync(experimentsDir)) {
    fs.mkdirSync(experimentsDir, { recursive: true });
  }

  const experimentDoc = generateExperimentDoc(calibrationResult);
  const regimeSuffix = useRegime ? '-regime' : '';
  const strategySuffix = activeStrategies ? `-${strategyArg}` : '';
  const suppressSuffix = suppressedRegimes.length > 0 ? '-suppress' : '';
  const mtfSuffix = useMTF ? '-mtf' : '';
  const slSuffix = slPlacementMode ? `-${slPlacementMode}` : '';
  const frictionSuffix = frictionArg ? '-maker' : '';
  const suffix = `${strategySuffix}${regimeSuffix}${suppressSuffix}${mtfSuffix}${slSuffix}${frictionSuffix}`;
  const docPath = path.join(experimentsDir, `iteration-7-calibration${suffix}.md`);
  fs.writeFileSync(docPath, experimentDoc);

  // Also save raw JSON result
  const jsonPath = path.join(experimentsDir, `iteration-7-calibration${suffix}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(calibrationResult, null, 2));

  if (!jsonOutputMode) {
    log('');
    log(`Experiment doc saved to: ${docPath}`);
    log(`Raw results saved to:    ${jsonPath}`);
  }
}

// ============================================
// Run
// ============================================

const isDirectRun =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('calibrate-confluence.ts') ||
    process.argv[1].endsWith('calibrate-confluence'));

if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error('Calibration failed:', err);
    process.exit(1);
  });
}
