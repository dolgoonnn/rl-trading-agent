#!/usr/bin/env npx tsx
/**
 * Iteration 5: Regime-Performance Diagnostic
 *
 * Before implementing suppression, measure the correlation between market regime
 * and walk-forward window performance. This tells us:
 * 1. Which regimes are profitable (should trade)
 * 2. Which regimes are losing (should suppress)
 * 3. How much pass rate improves if we suppress losing regimes
 *
 * For each walk-forward validation window:
 * - Detect regime at window start, middle, and end
 * - Tag with regime classification
 * - Cross-reference with window Sharpe
 * - Output a regime x performance matrix
 *
 * Usage:
 *   npx tsx scripts/analyze-regime-windows.ts
 *   npx tsx scripts/analyze-regime-windows.ts --symbols BTCUSDT,ETHUSDT
 *   npx tsx scripts/analyze-regime-windows.ts --json
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import {
  ConfluenceScorer,
  DEFAULT_CONFLUENCE_CONFIG,
  PRODUCTION_STRATEGY_CONFIG,
  DEFAULT_WEIGHTS,
} from '../src/lib/rl/strategies/confluence-scorer';
import {
  detectRegime,
  regimeLabel,
  type MarketRegime,
} from '../src/lib/ict/regime-detector';
import {
  runWalkForward,
  calculateSharpe,
  type WalkForwardStrategyRunner,
  type TradeResult,
} from './walk-forward-validate';

// ============================================
// Configuration
// ============================================

const DEFAULT_THRESHOLD = 4.5;
const DEFAULT_COMMISSION = 0.001;
const DEFAULT_SLIPPAGE = 0.0005;
const MAX_BARS_IN_POSITION = 72;

// ============================================
// Types
// ============================================

interface RegimeWindowData {
  symbol: string;
  windowIndex: number;
  valStart: string;
  valEnd: string;
  /** Regime at window midpoint (most representative) */
  regime: MarketRegime;
  regimeLabel: string;
  /** Performance metrics from walk-forward */
  sharpe: number;
  trades: number;
  winRate: number;
  pnl: number;
  passed: boolean;
}

interface RegimeBucket {
  label: string;
  windows: number;
  avgSharpe: number;
  medianSharpe: number;
  avgWinRate: number;
  avgTrades: number;
  passRate: number;
  windowsPassed: number;
  totalPnl: number;
}

interface AnalysisResult {
  timestamp: string;
  symbols: string[];
  threshold: number;
  totalWindows: number;
  regimeBuckets: RegimeBucket[];
  windowData: RegimeWindowData[];
  /** If we suppress these regime labels, what's the projected pass rate? */
  suppressionAnalysis: {
    suppressedRegimes: string[];
    remainingWindows: number;
    remainingPassRate: number;
    baselinePassRate: number;
    improvement: number;
    tradeLoss: number;
  }[];
}

// ============================================
// Position Simulation (reused from calibrate-confluence.ts)
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

function simulatePosition(
  position: SimulatedPosition,
  candles: Candle[],
  startIndex: number,
  maxBars: number,
  commission: number,
  slippage: number,
): TradeResult | null {
  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;

    const barsHeld = i - position.entryIndex;
    let hitSL = false;
    let hitTP = false;

    if (position.direction === 'long') {
      hitSL = candle.low <= position.stopLoss;
      hitTP = candle.high >= position.takeProfit;
    } else {
      hitSL = candle.high >= position.stopLoss;
      hitTP = candle.low <= position.takeProfit;
    }

    const maxBarsReached = barsHeld >= maxBars;

    if (hitSL || hitTP || maxBarsReached) {
      let exitPrice: number;

      if (hitSL && hitTP) {
        exitPrice = position.stopLoss; // Conservative
      } else if (hitSL) {
        exitPrice = position.stopLoss;
      } else if (hitTP) {
        exitPrice = position.takeProfit;
      } else {
        exitPrice = candle.close;
      }

      // Apply slippage
      if (position.direction === 'long') {
        exitPrice *= (1 - slippage);
      } else {
        exitPrice *= (1 + slippage);
      }

      let rawPnl: number;
      if (position.direction === 'long') {
        rawPnl = (exitPrice - position.entryPrice) / position.entryPrice;
      } else {
        rawPnl = (position.entryPrice - exitPrice) / position.entryPrice;
      }

      const pnlPercent = rawPnl - 2 * commission;

      return {
        entryTimestamp: position.entryTimestamp,
        exitTimestamp: candle.timestamp,
        direction: position.direction,
        entryPrice: position.entryPrice,
        exitPrice,
        pnlPercent,
        strategy: position.strategy,
      };
    }
  }

  return null;
}

// ============================================
// Create Runner with Regime Tagging
// ============================================

/**
 * Enhanced runner that also detects regime for each window.
 * We detect regime on the VALIDATION candles (not training) since
 * that's the period where trades actually happen.
 */
function createRunnerWithRegimeDetection(
  scorer: ConfluenceScorer,
  regimeData: RegimeWindowData[],
): WalkForwardStrategyRunner {
  let windowCounter = 0;

  return {
    name: `RegimeAnalysis(threshold=${scorer.getConfig().minThreshold})`,

    async run(trainCandles: Candle[], valCandles: Candle[]): Promise<TradeResult[]> {
      const trades: TradeResult[] = [];
      scorer.resetCooldowns();

      const combined = [...trainCandles, ...valCandles];
      const valStartIndex = trainCandles.length;

      // Detect regime at validation midpoint
      const valMidIndex = valStartIndex + Math.floor(valCandles.length / 2);
      const regime = detectRegime(combined, valMidIndex);

      let currentPosition: SimulatedPosition | null = null;

      for (let i = valStartIndex; i < combined.length; i++) {
        const candle = combined[i];
        if (!candle) continue;

        if (currentPosition) {
          const result = simulatePosition(
            currentPosition,
            combined,
            i,
            MAX_BARS_IN_POSITION,
            DEFAULT_COMMISSION,
            DEFAULT_SLIPPAGE,
          );

          if (result) {
            trades.push(result);
            currentPosition = null;
            const exitBarIndex = combined.findIndex(
              (c) => c.timestamp === result.exitTimestamp,
            );
            if (exitBarIndex > i) {
              i = exitBarIndex;
            }
          }
          continue;
        }

        const evaluation = scorer.evaluate(combined, i);

        if (evaluation.action === 'trade' && evaluation.selectedSignal) {
          const signal = evaluation.selectedSignal.signal;

          let entryPrice = signal.entryPrice;
          if (signal.direction === 'long') {
            entryPrice *= (1 + DEFAULT_SLIPPAGE);
          } else {
            entryPrice *= (1 - DEFAULT_SLIPPAGE);
          }

          currentPosition = {
            direction: signal.direction,
            entryPrice,
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit,
            entryIndex: i,
            entryTimestamp: candle.timestamp,
            strategy: signal.strategy,
          };
        }
      }

      // Store regime data for this window (will be enriched with sharpe later)
      const valStartCandle = valCandles[0];
      const valEndCandle = valCandles[valCandles.length - 1];

      const returns = trades.map((t) => t.pnlPercent);
      const sharpe = calculateSharpe(returns);
      const winningTrades = trades.filter((t) => t.pnlPercent > 0);
      const winRate = trades.length > 0 ? (winningTrades.length / trades.length) * 100 : 0;
      const pnl = returns.length > 0
        ? returns.reduce((equity, r) => equity * (1 + r), 1.0) - 1.0
        : 0;

      regimeData.push({
        symbol: '', // Will be set by caller
        windowIndex: windowCounter++,
        valStart: valStartCandle ? new Date(valStartCandle.timestamp).toISOString() : '',
        valEnd: valEndCandle ? new Date(valEndCandle.timestamp).toISOString() : '',
        regime,
        regimeLabel: regimeLabel(regime),
        sharpe,
        trades: trades.length,
        winRate,
        pnl,
        passed: sharpe > 0,
      });

      return trades;
    },
  };
}

// ============================================
// Analysis Functions
// ============================================

function bucketByRegime(windows: RegimeWindowData[]): RegimeBucket[] {
  const bucketMap = new Map<string, RegimeWindowData[]>();

  for (const w of windows) {
    const label = w.regimeLabel;
    const existing = bucketMap.get(label) ?? [];
    existing.push(w);
    bucketMap.set(label, existing);
  }

  const buckets: RegimeBucket[] = [];

  for (const [label, data] of bucketMap.entries()) {
    const sharpes = data.map((d) => d.sharpe);
    const sortedSharpes = [...sharpes].sort((a, b) => a - b);
    const medianIdx = Math.floor(sortedSharpes.length / 2);
    const medianSharpe = sortedSharpes.length % 2 === 1
      ? (sortedSharpes[medianIdx] ?? 0)
      : ((sortedSharpes[medianIdx - 1] ?? 0) + (sortedSharpes[medianIdx] ?? 0)) / 2;

    const passedWindows = data.filter((d) => d.passed);
    const avgTrades = data.length > 0
      ? data.reduce((sum, d) => sum + d.trades, 0) / data.length
      : 0;
    const totalPnl = data.reduce((sum, d) => sum + d.pnl, 0);

    buckets.push({
      label,
      windows: data.length,
      avgSharpe: sharpes.length > 0 ? sharpes.reduce((a, b) => a + b, 0) / sharpes.length : 0,
      medianSharpe,
      avgWinRate: data.length > 0
        ? data.reduce((sum, d) => sum + d.winRate, 0) / data.length
        : 0,
      avgTrades,
      passRate: data.length > 0 ? passedWindows.length / data.length : 0,
      windowsPassed: passedWindows.length,
      totalPnl,
    });
  }

  // Sort by pass rate descending
  buckets.sort((a, b) => b.passRate - a.passRate);
  return buckets;
}

/**
 * Simulate suppressing different regime combinations and project pass rates.
 */
function analyzeSuppressionOptions(
  windows: RegimeWindowData[],
  buckets: RegimeBucket[],
): AnalysisResult['suppressionAnalysis'] {
  const baselinePassRate = windows.length > 0
    ? windows.filter((w) => w.passed).length / windows.length
    : 0;

  const results: AnalysisResult['suppressionAnalysis'] = [];

  // Find losing regimes (avg Sharpe < 0)
  const losingRegimes = buckets.filter((b) => b.avgSharpe < 0).map((b) => b.label);
  const severeLosers = buckets.filter((b) => b.avgSharpe < -5).map((b) => b.label);

  // Strategy 1: Suppress all losing regimes
  if (losingRegimes.length > 0) {
    const remaining = windows.filter((w) => !losingRegimes.includes(w.regimeLabel));
    const remainingPassed = remaining.filter((w) => w.passed).length;
    // Windows that are suppressed count as "not losing" — they produce 0 Sharpe (neutral)
    const totalSuppressed = windows.filter((w) => losingRegimes.includes(w.regimeLabel)).length;
    const effectivePassRate = (remainingPassed + totalSuppressed) / windows.length;

    results.push({
      suppressedRegimes: losingRegimes,
      remainingWindows: remaining.length,
      remainingPassRate: effectivePassRate,
      baselinePassRate,
      improvement: effectivePassRate - baselinePassRate,
      tradeLoss: 1 - (remaining.length > 0
        ? remaining.reduce((sum, w) => sum + w.trades, 0) /
          windows.reduce((sum, w) => sum + w.trades, 0)
        : 0),
    });
  }

  // Strategy 2: Suppress only severe losers
  if (severeLosers.length > 0 && severeLosers.length < losingRegimes.length) {
    const remaining = windows.filter((w) => !severeLosers.includes(w.regimeLabel));
    const remainingPassed = remaining.filter((w) => w.passed).length;
    const totalSuppressed = windows.filter((w) => severeLosers.includes(w.regimeLabel)).length;
    const effectivePassRate = (remainingPassed + totalSuppressed) / windows.length;

    results.push({
      suppressedRegimes: severeLosers,
      remainingWindows: remaining.length,
      remainingPassRate: effectivePassRate,
      baselinePassRate,
      improvement: effectivePassRate - baselinePassRate,
      tradeLoss: 1 - (remaining.length > 0
        ? remaining.reduce((sum, w) => sum + w.trades, 0) /
          windows.reduce((sum, w) => sum + w.trades, 0)
        : 0),
    });
  }

  // Strategy 3: Suppress "ranging" regimes only
  const rangingRegimes = buckets
    .filter((b) => b.label.startsWith('ranging'))
    .map((b) => b.label);

  if (rangingRegimes.length > 0) {
    const remaining = windows.filter((w) => !rangingRegimes.includes(w.regimeLabel));
    const remainingPassed = remaining.filter((w) => w.passed).length;
    const totalSuppressed = windows.filter((w) => rangingRegimes.includes(w.regimeLabel)).length;
    const effectivePassRate = (remainingPassed + totalSuppressed) / windows.length;

    results.push({
      suppressedRegimes: rangingRegimes,
      remainingWindows: remaining.length,
      remainingPassRate: effectivePassRate,
      baselinePassRate,
      improvement: effectivePassRate - baselinePassRate,
      tradeLoss: 1 - (remaining.length > 0
        ? remaining.reduce((sum, w) => sum + w.trades, 0) /
          windows.reduce((sum, w) => sum + w.trades, 0)
        : 0),
    });
  }

  return results;
}

// ============================================
// Output Formatting
// ============================================

function printRegimeMatrix(buckets: RegimeBucket[]): void {
  log('');
  log('REGIME x PERFORMANCE MATRIX');
  log('');
  log('| Regime           | Windows | Avg Sharpe | Med Sharpe | Win Rate | Avg Trades | Pass Rate | Total PnL |');
  log('|------------------|---------|------------|------------|----------|------------|-----------|-----------|');

  for (const b of buckets) {
    log(
      `| ${b.label.padEnd(16)} ` +
      `| ${b.windows.toString().padStart(7)} ` +
      `| ${b.avgSharpe.toFixed(2).padStart(10)} ` +
      `| ${b.medianSharpe.toFixed(2).padStart(10)} ` +
      `| ${b.avgWinRate.toFixed(1).padStart(7)}% ` +
      `| ${b.avgTrades.toFixed(1).padStart(10)} ` +
      `| ${(b.passRate * 100).toFixed(1).padStart(8)}% ` +
      `| ${(b.totalPnl * 100).toFixed(2).padStart(8)}% |`,
    );
  }
  log('');
}

function printSuppressionAnalysis(analysis: AnalysisResult['suppressionAnalysis']): void {
  log('');
  log('SUPPRESSION PROJECTIONS');
  log('');

  for (const a of analysis) {
    log(`Strategy: Suppress [${a.suppressedRegimes.join(', ')}]`);
    log(`  Remaining windows:   ${a.remainingWindows}`);
    log(`  Baseline pass rate:  ${(a.baselinePassRate * 100).toFixed(1)}%`);
    log(`  Projected pass rate: ${(a.remainingPassRate * 100).toFixed(1)}%`);
    log(`  Improvement:         +${(a.improvement * 100).toFixed(1)}pp`);
    log(`  Trade volume loss:   ${(a.tradeLoss * 100).toFixed(1)}%`);
    log('');
  }
}

function printPerWindowDetails(windows: RegimeWindowData[]): void {
  log('');
  log('PER-WINDOW DETAIL');
  log('');
  log('| Symbol   | Window | Regime           | Eff  | TrStr | ATR%  | Sharpe  | Trades | WR   | Pass |');
  log('|----------|--------|------------------|------|-------|-------|---------|--------|------|------|');

  for (const w of windows) {
    const passStr = w.passed ? ' YES' : '  NO';
    log(
      `| ${w.symbol.padEnd(8)} ` +
      `| ${w.windowIndex.toString().padStart(6)} ` +
      `| ${w.regimeLabel.padEnd(16)} ` +
      `| ${w.regime.efficiency.toFixed(2).padStart(4)} ` +
      `| ${w.regime.trendStrength.toFixed(2).padStart(5)} ` +
      `| ${w.regime.atrPercentile.toFixed(2).padStart(5)} ` +
      `| ${w.sharpe.toFixed(2).padStart(7)} ` +
      `| ${w.trades.toString().padStart(6)} ` +
      `| ${w.winRate.toFixed(0).padStart(3)}% ` +
      `| ${passStr} |`,
    );
  }
  log('');
}

// ============================================
// CLI
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
// Main
// ============================================

async function main(): Promise<void> {
  const symbolsArg = getArg('symbols');
  const thresholdArg = getArg('threshold');
  jsonOutputMode = hasFlag('json');

  const symbols = symbolsArg
    ? symbolsArg.split(',').map((s) => s.trim())
    : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

  const threshold = thresholdArg ? parseFloat(thresholdArg) : DEFAULT_THRESHOLD;

  if (!jsonOutputMode) {
    log('============================================================');
    log('ITERATION 5: REGIME-PERFORMANCE DIAGNOSTIC');
    log('============================================================');
    log('');
    log(`Symbols:    ${symbols.join(', ')}`);
    log(`Threshold:  ${threshold}`);
    log('');
  }

  // Validate data files exist
  for (const symbol of symbols) {
    const filePath = path.join('data', `${symbol}_1h.json`);
    if (!fs.existsSync(filePath)) {
      console.error(`Data file not found: ${filePath}`);
      process.exit(1);
    }
    if (!jsonOutputMode) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const candles = JSON.parse(raw) as Candle[];
      log(`Validated ${candles.length} candles for ${symbol}`);
    }
  }

  // Collect regime data across all windows
  const allRegimeData: RegimeWindowData[] = [];

  // Run walk-forward for each symbol, collecting regime data
  for (const symbol of symbols) {
    if (!jsonOutputMode) {
      log(`\n--- ${symbol} ---`);
    }

    const regimeData: RegimeWindowData[] = [];

    const scorer = new ConfluenceScorer({
      ...DEFAULT_CONFLUENCE_CONFIG,
      minThreshold: threshold,
      weights: { ...DEFAULT_WEIGHTS },
      strategyConfig: PRODUCTION_STRATEGY_CONFIG,
    });

    const runner = createRunnerWithRegimeDetection(scorer, regimeData);
    await runWalkForward(runner, { symbols: [symbol] }, { quiet: true });

    // Tag regime data with symbol
    for (const rd of regimeData) {
      rd.symbol = symbol;
      allRegimeData.push(rd);
    }
  }

  if (!jsonOutputMode) {
    log(`\nTotal windows analyzed: ${allRegimeData.length}`);
  }

  // Bucket by regime
  const buckets = bucketByRegime(allRegimeData);
  const suppressionAnalysis = analyzeSuppressionOptions(allRegimeData, buckets);

  // Print results
  if (!jsonOutputMode) {
    printRegimeMatrix(buckets);
    printSuppressionAnalysis(suppressionAnalysis);
    printPerWindowDetails(allRegimeData);
  }

  // Build result
  const result: AnalysisResult = {
    timestamp: new Date().toISOString(),
    symbols,
    threshold,
    totalWindows: allRegimeData.length,
    regimeBuckets: buckets,
    windowData: allRegimeData,
    suppressionAnalysis,
  };

  // Save results
  const experimentsDir = path.resolve('experiments');
  if (!fs.existsSync(experimentsDir)) {
    fs.mkdirSync(experimentsDir, { recursive: true });
  }

  const jsonPath = path.join(experimentsDir, 'iteration-5-regime-analysis.json');
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));

  if (jsonOutputMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    log(`Results saved to: ${jsonPath}`);
  }
}

// ============================================
// Run
// ============================================

const isDirectRun =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('analyze-regime-windows.ts') ||
    process.argv[1].endsWith('analyze-regime-windows'));

if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error('Analysis failed:', err);
    process.exit(1);
  });
}
