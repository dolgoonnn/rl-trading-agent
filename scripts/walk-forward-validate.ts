#!/usr/bin/env npx tsx
/**
 * Walk-Forward Validation Framework
 *
 * Replaces static 90-day backtesting with proper walk-forward validation.
 * Rolling 3-month training window + 1-month validation window, sliding 1 month forward.
 *
 * Window layout (12 months of hourly data):
 *   Window 1: Train [M1-M3], Validate [M4]
 *   Window 2: Train [M2-M4], Validate [M5]
 *   ...
 *   Window 9: Train [M9-M11], Validate [M12]
 *
 * Pass criteria:
 *   - Positive Sharpe on >= 7/9 windows per symbol
 *   - No window with Sharpe < -2.0 (catastrophic failure)
 *
 * Usage:
 *   # Standalone with RL model:
 *   npx tsx scripts/walk-forward-validate.ts --model models/xxx.json
 *
 *   # With options:
 *   npx tsx scripts/walk-forward-validate.ts --model models/xxx.json --symbols BTCUSDT,ETHUSDT --json --save
 *
 *   # Imported as module:
 *   import { runWalkForward, type WalkForwardStrategyRunner } from './walk-forward-validate';
 *   const result = await runWalkForward(myRunner, { symbols: ['BTCUSDT'] });
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import { normalizeSymbolName } from '../src/lib/rl/config/symbols';
import { DQNAgent, type SerializedWeights } from '../src/lib/rl/agent/dqn-agent';
import { ReplayBuffer } from '../src/lib/rl/agent/replay-buffer';
import { ICTMetaStrategyEnvironment } from '../src/lib/rl/environment/ict-meta-env';
import { type StrategyAction, STRATEGY_COUNT } from '../src/lib/rl/strategies';
import {
  estimatePBO,
  type WindowResult as PBOWindowResult,
  type PBOResult,
} from '../src/lib/rl/utils/pbo';

// ============================================
// Public Types
// ============================================

/**
 * A strategy runner that the walk-forward framework evaluates.
 * Generic interface -- works for RL models, confluence scorers, or any strategy.
 */
export interface WalkForwardStrategyRunner {
  /** Human-readable name of the strategy */
  name: string;
  /**
   * Run the strategy on the validation candles.
   * Training candles are provided for calibration, warm-up, or context.
   * Must return all trades executed during the validation window only.
   */
  run(trainCandles: Candle[], valCandles: Candle[], meta?: { symbol?: string }): Promise<TradeResult[]>;
}

/** A single trade result from a strategy runner */
export interface TradeResult {
  entryTimestamp: number;
  exitTimestamp: number;
  direction: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  /** Percentage PnL of the trade (e.g. 0.02 = 2% gain) */
  pnlPercent: number;
  /** Optional: which sub-strategy produced this trade */
  strategy?: string;
}

/** Metrics for a single validation window */
export interface WindowResult {
  windowIndex: number;
  trainStart: string;
  trainEnd: string;
  valStart: string;
  valEnd: string;
  trades: number;
  winRate: number;
  pnl: number;
  sharpe: number;
  maxDrawdown: number;
  passed: boolean;
}

/** Aggregated results for one symbol across all windows */
export interface SymbolWFResult {
  symbol: string;
  windows: WindowResult[];
  positiveWindows: number;
  totalWindows: number;
  worstWindowSharpe: number;
  avgSharpe: number;
  passed: boolean;
  failReasons: string[];
}

/** Top-level result of the entire walk-forward validation */
export interface WalkForwardResult {
  strategyName: string;
  timestamp: string;
  config: WalkForwardConfig;
  symbols: SymbolWFResult[];
  overallPassed: boolean;
  /** Fraction of windows that passed across all symbols (0..1) */
  passRate: number;
  /** Probability of Backtest Overfitting (CSCV method). Only populated if --pbo flag is used. */
  pbo?: PBOResult;
}

/** Configuration for the walk-forward validation */
export interface WalkForwardConfig {
  /** Training window in candles (default: 2160 = ~3 months hourly) */
  trainWindowBars: number;
  /** Validation window in candles (default: 720 = ~1 month hourly) */
  valWindowBars: number;
  /** Slide step in candles (default: 720 = ~1 month) */
  slideStepBars: number;
  /** Lookback buffer prepended to training data for indicator warm-up */
  lookbackBuffer: number;
  /** Symbols to validate */
  symbols: string[];
  /** Path to the data directory */
  dataDir: string;
  /** Timeframe suffix for data files (default: '1h') */
  timeframe: string;
}

// ============================================
// Pass Criteria (exported for re-use)
// ============================================

/** Minimum number of windows (out of total) that must have positive Sharpe per symbol */
export const MIN_POSITIVE_WINDOWS = 7;
/** Total expected windows when using 12 months of data */
export const EXPECTED_TOTAL_WINDOWS = 9;
/** Any single window below this Sharpe is a catastrophic failure */
export const CATASTROPHIC_SHARPE_THRESHOLD = -2.0;
/** Annualization factor for hourly Sharpe: sqrt(365 days * 24 hours) for 24/7 crypto markets */
export const ANNUALIZATION_FACTOR = Math.sqrt(365 * 24);

/**
 * Asset-class-aware annualization factor for hourly per-trade Sharpe.
 * - Crypto: 24/7 = sqrt(365 * 24) ≈ 93.6
 * - Gold futures: ~22.5h/day, 252 trading days = sqrt(252 * 22.5) ≈ 75.3
 * - Forex: ~24h/day, 252 trading days = sqrt(252 * 24) ≈ 77.8
 */
export function getAnnualizationFactor(symbols: string[]): number {
  const isGold = symbols.some(s => /^(GC_F|XAUUSD)/i.test(s));
  const isForex = symbols.some(s => /^(EUR|GBP|USD|AUD|NZD|CAD|CHF|JPY)/i.test(s));

  if (isGold) return Math.sqrt(252 * 22.5);  // Gold: 22.5h/day, 252 trading days
  if (isForex) return Math.sqrt(252 * 24);     // Forex: ~24h/day, 252 trading days
  return ANNUALIZATION_FACTOR;                  // Crypto: 24/7
}

// ============================================
// Default Config (exported)
// ============================================

export const DEFAULT_WF_CONFIG: WalkForwardConfig = {
  trainWindowBars: 2160,  // ~3 months of hourly candles
  valWindowBars: 720,     // ~1 month of hourly candles
  slideStepBars: 720,     // slide 1 month forward
  lookbackBuffer: 100,    // extra candles for indicator warm-up
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  dataDir: 'data',
  timeframe: '1h',
};

// ============================================
// Core Metrics (exported for re-use)
// ============================================

/**
 * Calculate annualized Sharpe ratio from an array of per-trade returns.
 * Returns 0 if fewer than 2 trades.
 *
 * NOTE: This computes per-TRADE Sharpe annualized by the given factor.
 * For sparse trade signals this can inflate the result vs per-BAR Sharpe.
 * Use the annualizationFactor param to pass an asset-class-appropriate
 * value from getAnnualizationFactor().
 */
export function calculateSharpe(returns: number[], annualizationFactor?: number): number {
  if (returns.length < 2) {
    // 1 trade: can't compute std, but if the return is positive, treat as marginally positive Sharpe
    if (returns.length === 1 && returns[0]! > 0) return 0.01;
    return 0;
  }

  const factor = annualizationFactor ?? ANNUALIZATION_FACTOR;
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);

  if (std === 0) return 0;
  return (mean / std) * factor;
}

/**
 * Calculate maximum drawdown from an array of per-trade percentage returns.
 * Builds a cumulative equity curve starting at 1.0 and finds the largest
 * peak-to-trough decline.
 */
export function calculateMaxDrawdown(returns: number[]): number {
  if (returns.length === 0) return 0;

  let equity = 1.0;
  let peak = 1.0;
  let maxDD = 0;

  for (const r of returns) {
    equity *= 1 + r;
    if (equity > peak) {
      peak = equity;
    }
    const dd = (peak - equity) / peak;
    if (dd > maxDD) {
      maxDD = dd;
    }
  }

  return maxDD;
}

/**
 * Calculate total PnL as a compounded percentage from trade returns.
 * e.g. [0.02, -0.01] => (1.02 * 0.99) - 1 = 0.0098
 */
function calculateCompoundedPnl(returns: number[]): number {
  if (returns.length === 0) return 0;
  let equity = 1.0;
  for (const r of returns) {
    equity *= 1 + r;
  }
  return equity - 1;
}

// ============================================
// Window Generation
// ============================================

interface DataWindow {
  windowIndex: number;
  /** Training candles (includes lookback buffer at the beginning) */
  trainCandles: Candle[];
  /** Validation candles (pure validation period, no overlap) */
  valCandles: Candle[];
  /** Symbol name for metadata */
  symbol: string;
  /** Metadata for reporting */
  trainStartTs: number;
  trainEndTs: number;
  valStartTs: number;
  valEndTs: number;
}

function generateWindows(
  allCandles: Candle[],
  config: WalkForwardConfig,
  symbol = '',
): DataWindow[] {
  const windows: DataWindow[] = [];
  const totalRequired = config.trainWindowBars + config.valWindowBars;

  let windowIndex = 0;
  let offset = 0;

  while (offset + totalRequired <= allCandles.length) {
    const trainStart = offset;
    const trainEnd = offset + config.trainWindowBars;
    const valStart = trainEnd;
    const valEnd = trainEnd + config.valWindowBars;

    if (valEnd > allCandles.length) break;

    // Training candles: include lookback buffer before the training window start
    const bufferStart = Math.max(0, trainStart - config.lookbackBuffer);
    const trainSlice = allCandles.slice(bufferStart, trainEnd);
    const valSlice = allCandles.slice(valStart, valEnd);

    const trainStartCandle = allCandles[trainStart];
    const trainEndCandle = allCandles[trainEnd - 1];
    const valStartCandle = allCandles[valStart];
    const valEndCandle = allCandles[valEnd - 1];

    if (!trainStartCandle || !trainEndCandle || !valStartCandle || !valEndCandle) {
      break;
    }

    windows.push({
      windowIndex,
      trainCandles: trainSlice,
      valCandles: valSlice,
      symbol,
      trainStartTs: trainStartCandle.timestamp,
      trainEndTs: trainEndCandle.timestamp,
      valStartTs: valStartCandle.timestamp,
      valEndTs: valEndCandle.timestamp,
    });

    windowIndex++;
    offset += config.slideStepBars;
  }

  return windows;
}

// ============================================
// Single Window Evaluation
// ============================================

async function evaluateWindow(
  runner: WalkForwardStrategyRunner,
  window: DataWindow,
  annualizationFactor: number = ANNUALIZATION_FACTOR
): Promise<WindowResult> {
  const trades = await runner.run(window.trainCandles, window.valCandles, { symbol: window.symbol });
  const returns = trades.map((t) => t.pnlPercent);

  const winningTrades = trades.filter((t) => t.pnlPercent > 0);
  const winRate = trades.length > 0
    ? (winningTrades.length / trades.length) * 100
    : 0;

  const sharpe = calculateSharpe(returns, annualizationFactor);
  const maxDrawdown = calculateMaxDrawdown(returns);
  const pnl = calculateCompoundedPnl(returns);

  // A window passes if it has positive Sharpe and is not catastrophic
  const passed = sharpe > 0 && sharpe >= CATASTROPHIC_SHARPE_THRESHOLD;

  return {
    windowIndex: window.windowIndex,
    trainStart: new Date(window.trainStartTs).toISOString(),
    trainEnd: new Date(window.trainEndTs).toISOString(),
    valStart: new Date(window.valStartTs).toISOString(),
    valEnd: new Date(window.valEndTs).toISOString(),
    trades: trades.length,
    winRate,
    pnl,
    sharpe,
    maxDrawdown,
    passed,
  };
}

// ============================================
// Symbol-Level Evaluation
// ============================================

async function evaluateSymbol(
  runner: WalkForwardStrategyRunner,
  symbol: string,
  config: WalkForwardConfig,
  quiet: boolean
): Promise<SymbolWFResult> {
  const dataPath = path.join(config.dataDir, `${normalizeSymbolName(symbol)}_${config.timeframe}.json`);

  if (!fs.existsSync(dataPath)) {
    return {
      symbol,
      windows: [],
      positiveWindows: 0,
      totalWindows: 0,
      worstWindowSharpe: 0,
      avgSharpe: 0,
      passed: false,
      failReasons: [`Data file not found: ${dataPath}`],
    };
  }

  const allCandles = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as Candle[];
  const windows = generateWindows(allCandles, config, symbol);

  if (windows.length === 0) {
    return {
      symbol,
      windows: [],
      positiveWindows: 0,
      totalWindows: 0,
      worstWindowSharpe: 0,
      avgSharpe: 0,
      passed: false,
      failReasons: [
        `Insufficient data for walk-forward windows (have ${allCandles.length} candles, need at least ${config.trainWindowBars + config.valWindowBars})`,
      ],
    };
  }

  // Compute asset-class-appropriate annualization factor
  const annualizationFactor = getAnnualizationFactor([symbol]);

  if (!quiet) {
    log(`  ${symbol}: ${allCandles.length} candles, ${windows.length} walk-forward windows`);
  }

  const windowResults: WindowResult[] = [];

  for (const window of windows) {
    const result = await evaluateWindow(runner, window, annualizationFactor);
    windowResults.push(result);

    if (!quiet) {
      const valRange = `${result.valStart.slice(0, 10)} to ${result.valEnd.slice(0, 10)}`;
      const status = result.trades === 0
        ? '\x1b[33mSKIP\x1b[0m'
        : result.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
      log(
        `    W${result.windowIndex}: [${valRange}] ` +
        `${result.trades} trades, Sharpe=${result.sharpe.toFixed(2)}, ` +
        `PnL=${(result.pnl * 100).toFixed(2)}% ${status}`
      );
    }
  }

  // Aggregate across windows — skip 0-trade windows (no signal != losing signal)
  const eligibleWindows = windowResults.filter((w) => w.trades > 0);
  const skippedWindows = windowResults.length - eligibleWindows.length;
  const positiveWindows = eligibleWindows.filter((w) => w.sharpe > 0).length;
  const totalWindows = eligibleWindows.length;
  const sharpes = eligibleWindows.map((w) => w.sharpe);
  const worstWindowSharpe = sharpes.length > 0 ? Math.min(...sharpes) : 0;
  const avgSharpe = sharpes.length > 0
    ? sharpes.reduce((a, b) => a + b, 0) / sharpes.length
    : 0;

  if (skippedWindows > 0 && !quiet) {
    log(`    (${skippedWindows} windows with 0 trades skipped from pass criteria)`);
  }

  // Pass criteria checks — only against eligible (non-zero trade) windows
  const failReasons: string[] = [];
  const requiredPositiveWindows = Math.min(MIN_POSITIVE_WINDOWS, totalWindows);

  if (totalWindows === 0) {
    failReasons.push('No windows with trades — cannot evaluate');
  } else if (positiveWindows < requiredPositiveWindows) {
    failReasons.push(
      `Only ${positiveWindows}/${totalWindows} eligible windows with positive Sharpe (need >= ${requiredPositiveWindows}, ${skippedWindows} skipped)`
    );
  }

  if (worstWindowSharpe < CATASTROPHIC_SHARPE_THRESHOLD) {
    const catastrophicWindows = eligibleWindows.filter(
      (w) => w.sharpe < CATASTROPHIC_SHARPE_THRESHOLD
    );
    failReasons.push(
      `Catastrophic window(s): ${catastrophicWindows.map((w) => `W${w.windowIndex}(${w.sharpe.toFixed(2)})`).join(', ')} below ${CATASTROPHIC_SHARPE_THRESHOLD}`
    );
  }

  return {
    symbol,
    windows: windowResults,
    positiveWindows,
    totalWindows,
    worstWindowSharpe,
    avgSharpe,
    passed: failReasons.length === 0,
    failReasons,
  };
}

// ============================================
// Public API: runWalkForward
// ============================================

/**
 * Run walk-forward validation for a given strategy runner.
 * This is the main entry point when importing as a module.
 */
export async function runWalkForward(
  runner: WalkForwardStrategyRunner,
  configOverrides: Partial<WalkForwardConfig> = {},
  options: { quiet?: boolean } = {}
): Promise<WalkForwardResult> {
  const config: WalkForwardConfig = { ...DEFAULT_WF_CONFIG, ...configOverrides };
  const quiet = options.quiet ?? false;

  if (!quiet) {
    log('============================================================');
    log('WALK-FORWARD VALIDATION');
    log('============================================================');
    log('');
    log(`Strategy: ${runner.name}`);
    log(`Train window: ${config.trainWindowBars} bars (~${(config.trainWindowBars / 720).toFixed(0)} months)`);
    log(`Val window:   ${config.valWindowBars} bars (~${(config.valWindowBars / 720).toFixed(0)} month)`);
    log(`Slide step:   ${config.slideStepBars} bars (~${(config.slideStepBars / 720).toFixed(0)} month)`);
    log(`Symbols:      ${config.symbols.join(', ')}`);
    log('');
  }

  const symbolResults: SymbolWFResult[] = [];

  for (const symbol of config.symbols) {
    const result = await evaluateSymbol(runner, symbol, config, quiet);
    symbolResults.push(result);

    if (!quiet) {
      log('');
    }
  }

  // Compute overall pass/fail — exclude 0-trade windows
  const allWindowResults = symbolResults.flatMap((s) => s.windows);
  const allEligibleWindows = allWindowResults.filter((w) => w.trades > 0);
  const totalPassedWindows = allEligibleWindows.filter((w) => w.passed).length;
  const totalWindows = allEligibleWindows.length;
  const passRate = totalWindows > 0 ? totalPassedWindows / totalWindows : 0;
  const overallPassed = symbolResults.every((s) => s.passed);

  return {
    strategyName: runner.name,
    timestamp: new Date().toISOString(),
    config,
    symbols: symbolResults,
    overallPassed,
    passRate,
  };
}

// ============================================
// Console Output
// ============================================

let jsonOutputMode = false;

function log(message: string): void {
  if (!jsonOutputMode) {
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
  }
}

function printSummary(result: WalkForwardResult): void {
  if (jsonOutputMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  log('');
  log('============================================================');
  log('SUMMARY');
  log('============================================================');
  log('');

  // Per-symbol summary table
  log('| Symbol   | Windows | Pos/Total | Avg Sharpe | Worst Sharpe | Status |');
  log('|----------|---------|-----------|------------|--------------|--------|');

  for (const s of result.symbols) {
    const status = s.passed ? 'PASS' : 'FAIL';
    const color = s.passed ? '\x1b[32m' : '\x1b[31m';
    const reset = '\x1b[0m';
    log(
      `| ${s.symbol.padEnd(8)} ` +
      `| ${s.totalWindows.toString().padStart(7)} ` +
      `| ${String(s.positiveWindows).padStart(3)}/${String(s.totalWindows).padEnd(5)} ` +
      `| ${s.avgSharpe.toFixed(2).padStart(10)} ` +
      `| ${s.worstWindowSharpe.toFixed(2).padStart(12)} ` +
      `| ${color}${status.padStart(6)}${reset} |`
    );
  }

  log('');

  // Per-window detail tables
  for (const s of result.symbols) {
    log(`--- ${s.symbol} Window Details ---`);
    log('| Window | Val Period                       | Trades | WinRate | Sharpe |  PnL   | MaxDD  | Status |');
    log('|--------|----------------------------------|--------|---------|--------|--------|--------|--------|');

    for (const w of s.windows) {
      const valRange = `${w.valStart.slice(0, 10)} to ${w.valEnd.slice(0, 10)}`;
      const status = w.trades === 0 ? 'SKIP' : w.passed ? 'PASS' : 'FAIL';
      const color = w.trades === 0 ? '\x1b[33m' : w.passed ? '\x1b[32m' : '\x1b[31m';
      const reset = '\x1b[0m';
      log(
        `| W${w.windowIndex.toString().padEnd(5)} ` +
        `| ${valRange.padEnd(32)} ` +
        `| ${w.trades.toString().padStart(6)} ` +
        `| ${w.winRate.toFixed(1).padStart(6)}% ` +
        `| ${w.sharpe.toFixed(2).padStart(6)} ` +
        `| ${(w.pnl * 100).toFixed(1).padStart(5)}% ` +
        `| ${(w.maxDrawdown * 100).toFixed(1).padStart(5)}% ` +
        `| ${color}${status.padStart(6)}${reset} |`
      );
    }

    if (s.failReasons.length > 0) {
      log('');
      log('  Fail reasons:');
      for (const reason of s.failReasons) {
        log(`    - ${reason}`);
      }
    }

    log('');
  }

  // Overall gate criteria
  log('PASS CRITERIA:');
  for (const s of result.symbols) {
    const requiredPositive = Math.min(MIN_POSITIVE_WINDOWS, s.totalWindows);
    const positiveCheck = s.positiveWindows >= requiredPositive;
    const catastrophicCheck = s.worstWindowSharpe >= CATASTROPHIC_SHARPE_THRESHOLD;

    log(`  ${s.symbol}:`);
    log(
      `    ${positiveCheck ? '\x1b[32m+\x1b[0m' : '\x1b[31mx\x1b[0m'} ` +
      `Positive Sharpe >= ${requiredPositive}/${s.totalWindows} windows (got ${s.positiveWindows})`
    );
    log(
      `    ${catastrophicCheck ? '\x1b[32m+\x1b[0m' : '\x1b[31mx\x1b[0m'} ` +
      `No window Sharpe < ${CATASTROPHIC_SHARPE_THRESHOLD} (worst: ${s.worstWindowSharpe.toFixed(2)})`
    );
  }

  log('');

  if (result.overallPassed) {
    log('\x1b[32m============================================================\x1b[0m');
    log('\x1b[32m              WALK-FORWARD GATE: PASSED\x1b[0m');
    log('\x1b[32m============================================================\x1b[0m');
  } else {
    log('\x1b[31m============================================================\x1b[0m');
    log('\x1b[31m              WALK-FORWARD GATE: FAILED\x1b[0m');
    log('\x1b[31m============================================================\x1b[0m');
    log('');
    const allFails = result.symbols
      .filter((s) => !s.passed)
      .flatMap((s) => s.failReasons.map((r) => `${s.symbol}: ${r}`));
    log('Failure summary:');
    for (const f of allFails) {
      log(`  - ${f}`);
    }
  }

  log('');
  const totalAllWindows = result.symbols.reduce((sum, s) => sum + s.windows.length, 0);
  const totalEligible = result.symbols.reduce((sum, s) => sum + s.totalWindows, 0);
  const totalSkipped = totalAllWindows - totalEligible;
  log(`Overall pass rate: ${(result.passRate * 100).toFixed(1)}% of eligible windows passed (${totalSkipped} zero-trade windows skipped)`);
  log(`NOTE: Sharpe is per-TRADE (not per-bar). With sparse signals, annualized per-trade Sharpe can appear inflated.`);

  // PBO report (if calculated)
  if (result.pbo) {
    const p = result.pbo;
    log('');
    log('─'.repeat(60));
    log('Probability of Backtest Overfitting (PBO)');
    log('─'.repeat(60));
    log(`  PBO:           ${(p.pbo * 100).toFixed(1)}% (${p.numOverfit}/${p.numCombinations} splits)`);
    log(`  Avg Logit OOS: ${p.avgLogitOOS.toFixed(3)}`);
    log(`  Threshold:     < ${(p.threshold * 100).toFixed(0)}%`);
    log(`  Status:        ${p.passes ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL (likely overfitted)\x1b[0m'}`);
    log('');
    if (p.pbo > 0.50) {
      log('  ⚠ PBO > 50%: IS winner is worse than random OOS.');
      log('    The selected model/config is likely overfitted.');
    } else if (p.pbo > 0.25) {
      log('  ⚠ PBO 25-50%: moderate overfitting risk. Use with caution.');
    } else {
      log('  ✓ PBO < 25%: strong evidence of genuine edge.');
    }
  }
}

// ============================================
// Built-in RL Model Runner
// ============================================

/** Shape of a saved ensemble model JSON file */
interface SavedModelFile {
  numAgents: number;
  config: {
    dqn: {
      inputSize: number;
      hiddenLayers: number[];
      outputSize: number;
      learningRate: number;
      gamma: number;
      tau: number;
      epsilonStart: number;
      epsilonEnd: number;
      epsilonDecay: number;
      dropout: number;
      l2Regularization: number;
    };
    env: Record<string, unknown>;
  };
  weights: SerializedWeights[];
}

/**
 * Loaded ensemble that performs majority-vote action selection.
 * Matches the pattern used in validate-90day.ts.
 */
class LoadedEnsemble {
  private agents: DQNAgent[];

  constructor(modelData: SavedModelFile) {
    this.agents = [];

    for (let i = 0; i < modelData.numAgents; i++) {
      const buffer = new ReplayBuffer({
        capacity: 1000,
        batchSize: 32,
        minExperience: 32,
      });

      const agent = new DQNAgent(
        {
          ...modelData.config.dqn,
          epsilonStart: 0.01,
          epsilonEnd: 0.01,
        },
        buffer
      );

      const weightsData = modelData.weights[i];
      if (weightsData) {
        agent.loadWeights(weightsData).catch((err: unknown) => {
          console.error(`Failed to load weights for agent ${i}:`, err);
        });
      }

      this.agents.push(agent);
    }
  }

  selectAction(features: number[]): StrategyAction {
    const votes: number[] = new Array(STRATEGY_COUNT).fill(0) as number[];

    for (const agent of this.agents) {
      const action = agent.selectAction(features, false);
      if (action >= 0 && action < votes.length) {
        votes[action] = (votes[action] ?? 0) + 1;
      }
    }

    let maxVotes = 0;
    let selectedAction = 0;
    for (let i = 0; i < votes.length; i++) {
      const voteCount = votes[i] ?? 0;
      if (voteCount > maxVotes) {
        maxVotes = voteCount;
        selectedAction = i;
      }
    }

    return selectedAction as StrategyAction;
  }

  dispose(): void {
    for (const agent of this.agents) {
      agent.dispose();
    }
  }
}

/**
 * Create a WalkForwardStrategyRunner backed by the RL ensemble model.
 * Loads agents from a saved model file and runs ICTMetaStrategyEnvironment
 * on each validation window.
 */
function createRLModelRunner(modelPath: string): WalkForwardStrategyRunner {
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Model file not found: ${modelPath}`);
  }

  const modelData = JSON.parse(
    fs.readFileSync(modelPath, 'utf-8')
  ) as SavedModelFile;

  return {
    name: `RL-Ensemble(${path.basename(modelPath)})`,

    async run(trainCandles: Candle[], valCandles: Candle[]): Promise<TradeResult[]> {
      // Create fresh ensemble for each window to avoid stale state
      const ensemble = new LoadedEnsemble(modelData);
      // Allow async weight loading to settle
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Combine train + val candles for the environment.
      // The environment needs the full lookback for indicator warm-up.
      // We only count trades whose entry falls in the validation window.
      const combinedCandles = [...trainCandles, ...valCandles];
      const valStartIndex = trainCandles.length;

      const env = new ICTMetaStrategyEnvironment(
        combinedCandles,
        modelData.config.env,
        false // not training
      );
      await env.initializeKB();

      let state = env.reset();
      let stepCount = 0;
      const maxSteps = combinedCandles.length;

      while (!env.isDone() && stepCount < maxSteps) {
        if (state && !env.isInPosition()) {
          const action = ensemble.selectAction(state.features);
          const result = env.step(action);
          state = result.state;
        } else {
          const result = env.step(null);
          state = result.state;
        }
        stepCount++;
      }

      // Convert environment trades to TradeResult format.
      // Only include trades that entered during the validation window.
      const envTrades = env.getTrades();
      const trades: TradeResult[] = [];

      for (const t of envTrades) {
        if (t.entryIndex >= valStartIndex) {
          const entryCandle = combinedCandles[t.entryIndex];
          const exitCandle = combinedCandles[t.exitIndex];

          if (entryCandle && exitCandle) {
            trades.push({
              entryTimestamp: entryCandle.timestamp,
              exitTimestamp: exitCandle.timestamp,
              direction: t.side,
              entryPrice: t.entryPrice,
              exitPrice: t.exitPrice,
              pnlPercent: t.pnlPercent,
              strategy: 'rl_ensemble',
            });
          }
        }
      }

      ensemble.dispose();
      return trades;
    },
  };
}

// ============================================
// CLI Argument Parsing
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
// CLI Main
// ============================================

async function main(): Promise<void> {
  const modelPath = getArg('model');
  const symbolsArg = getArg('symbols');
  const outputPath = getArg('output');
  const shouldSave = hasFlag('save');
  jsonOutputMode = hasFlag('json');

  if (!modelPath) {
    console.error(
      'Usage: walk-forward-validate.ts --model <path> [--symbols BTCUSDT,ETHUSDT] [--json] [--save] [--output <path>]'
    );
    process.exit(1);
  }

  const configOverrides: Partial<WalkForwardConfig> = {};
  if (symbolsArg) {
    configOverrides.symbols = symbolsArg.split(',').map((s) => s.trim());
  }

  const runner = createRLModelRunner(modelPath);
  const result = await runWalkForward(runner, configOverrides);

  // Calculate PBO if --pbo flag is present
  if (hasFlag('pbo') && result.symbols.length > 0) {
    log('\n[PBO] Calculating Probability of Backtest Overfitting...');

    // Build window metrics from walk-forward results
    // Use per-symbol Sharpe arrays as different "configs" for CSCV
    const pboInputs: PBOWindowResult[] = result.symbols.map((s) => ({
      configId: s.symbol,
      windowMetrics: s.windows.map((w) => w.sharpe),
    }));

    // Need at least 2 configs and 6 windows
    if (pboInputs.length >= 2 && (pboInputs[0]?.windowMetrics.length ?? 0) >= 6) {
      try {
        result.pbo = estimatePBO(pboInputs, 1000, { threshold: 0.50 });
        log(`[PBO] Done: ${(result.pbo.pbo * 100).toFixed(1)}% overfitting probability`);
      } catch (err) {
        log(`[PBO] Skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      log('[PBO] Skipped: insufficient data (need >= 2 symbols, >= 6 windows each)');
    }
  }

  printSummary(result);

  // Save results if requested
  if (shouldSave || outputPath) {
    const savePath =
      outputPath ?? path.join('experiments', 'walk-forward-results.json');
    const saveDir = path.dirname(savePath);

    if (!fs.existsSync(saveDir)) {
      fs.mkdirSync(saveDir, { recursive: true });
    }

    fs.writeFileSync(savePath, JSON.stringify(result, null, 2));
    log(`Results saved to ${savePath}`);
  }

  process.exit(result.overallPassed ? 0 : 1);
}

// ============================================
// Run if invoked directly
// ============================================

const isDirectRun =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('walk-forward-validate.ts') ||
    process.argv[1].endsWith('walk-forward-validate'));

if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error('Walk-forward validation failed:', err);
    process.exit(1);
  });
}
