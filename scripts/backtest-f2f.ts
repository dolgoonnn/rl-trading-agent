#!/usr/bin/env tsx
/**
 * F2F Gold Strategy — Walk-Forward Backtest
 *
 * Loads daily gold data, runs walk-forward optimization with λ×θ grid search,
 * and reports aggregate OOS performance.
 *
 * Usage:
 *   npx tsx scripts/backtest-f2f.ts                     # Default
 *   npx tsx scripts/backtest-f2f.ts --verbose            # Per-window details
 *   npx tsx scripts/backtest-f2f.ts --friction 0.001     # Custom friction
 *   npx tsx scripts/backtest-f2f.ts --train-years 8      # Custom train window
 *   npx tsx scripts/backtest-f2f.ts --save               # Save results to experiments/
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';
import {
  runWalkForwardOptimization,
  F2F_DEFAULT_WF_CONFIG,
  F2F_FIXED_PARAMS,
  type F2FWalkForwardConfig,
  type F2FOptimizationResult,
  type F2FDirectionMode,
  type RegimeFilterType,
} from '../src/lib/gold';

// ============================================
// CLI Parsing
// ============================================

interface CLIOptions {
  dataPath: string;
  verbose: boolean;
  friction: number;
  trainYears: number;
  save: boolean;
  direction: F2FDirectionMode;
  regimeFilter: RegimeFilterType;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const opts: CLIOptions = {
    dataPath: path.resolve(__dirname, '..', 'data', 'GC_F_1d.json'),
    verbose: false,
    friction: 0.0005,
    trainYears: 10,
    save: false,
    direction: 'long-only',
    regimeFilter: 'none' as RegimeFilterType,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--data':
        opts.dataPath = args[++i]!;
        break;
      case '--verbose':
        opts.verbose = true;
        break;
      case '--friction':
        opts.friction = parseFloat(args[++i]!);
        break;
      case '--train-years':
        opts.trainYears = parseInt(args[++i]!, 10);
        break;
      case '--save':
        opts.save = true;
        break;
      case '--direction':
        opts.direction = args[++i]! as F2FDirectionMode;
        break;
      case '--allow-shorts':
        opts.direction = 'both';
        break;
      case '--shorts-only':
        opts.direction = 'short-only';
        break;
      case '--regime-filter':
        opts.regimeFilter = args[++i]! as RegimeFilterType;
        break;
      case '--override': {
        // Format: --override key=value (e.g., --override trailingStopAtrMultiple=2.25)
        const [key, val] = args[++i]!.split('=');
        (F2F_FIXED_PARAMS as Record<string, number>)[key!] = parseFloat(val!);
        break;
      }
    }
  }

  return opts;
}

// ============================================
// Main
// ============================================

function main(): void {
  const opts = parseArgs();

  // Load data
  if (!fs.existsSync(opts.dataPath)) {
    console.error(`Data file not found: ${opts.dataPath}`);
    console.error('Run: npx tsx scripts/download-gold-daily.ts');
    process.exit(1);
  }

  const candles: Candle[] = JSON.parse(fs.readFileSync(opts.dataPath, 'utf-8'));
  const startDate = new Date(candles[0]!.timestamp).toISOString().slice(0, 10);
  const endDate = new Date(candles[candles.length - 1]!.timestamp).toISOString().slice(0, 10);

  console.log('=== F2F Gold Strategy — Walk-Forward Backtest ===\n');
  console.log(`  Data: ${candles.length.toLocaleString()} daily candles (${startDate} → ${endDate})`);
  console.log(`  Friction: ${(opts.friction * 10000).toFixed(1)} bps/side`);
  console.log(`  Train: ${opts.trainYears}yr, Val: 6mo, Slide: 1mo`);
  console.log(`  Direction: ${opts.direction}`);
  console.log(`  Regime filter: ${opts.regimeFilter}`);
  console.log(`  Grid: λ ∈ [0.90, 0.99], θ ∈ [0.90, 0.99] (100 combos)\n`);

  // Walk-forward config
  const config: F2FWalkForwardConfig = {
    trainBars: opts.trainYears * 252,
    valBars: F2F_DEFAULT_WF_CONFIG.valBars,
    slideBars: F2F_DEFAULT_WF_CONFIG.slideBars,
  };

  // Run optimization
  const startTime = Date.now();

  const result = runWalkForwardOptimization(
    candles,
    config,
    opts.friction,
    opts.verbose
      ? (windowIdx, total, windowResult) => {
          const trainDates = `${new Date(candles[windowResult.trainStart]!.timestamp).toISOString().slice(0, 10)} → ${new Date(candles[windowResult.trainEnd - 1]!.timestamp).toISOString().slice(0, 10)}`;
          const valDates = `${new Date(candles[windowResult.valStart]!.timestamp).toISOString().slice(0, 10)} → ${new Date(candles[windowResult.valEnd - 1]!.timestamp).toISOString().slice(0, 10)}`;
          const passLabel = windowResult.pass ? 'PASS' : (windowResult.valTrades.length === 0 ? 'SKIP' : 'FAIL');
          console.log(
            `  [${windowIdx + 1}/${total}] train=${trainDates} val=${valDates} ` +
            `λ=${windowResult.bestLambda.toFixed(2)} θ=${windowResult.bestTheta.toFixed(2)} ` +
            `trainSharpe=${windowResult.trainSharpe.toFixed(2)} valSharpe=${windowResult.valSharpe.toFixed(2)} ` +
            `trades=${windowResult.valTrades.length} ${passLabel}`
          );
        }
      : undefined,
    opts.direction,
    opts.regimeFilter,
  );

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Report results
  printResults(result, elapsed);

  // Save if requested
  if (opts.save) {
    const outPath = path.resolve(__dirname, '..', 'experiments', 'f2f-backtest-results.json');
    const saveData = {
      timestamp: new Date().toISOString(),
      config: { ...config, friction: opts.friction },
      dataRange: { start: startDate, end: endDate, bars: candles.length },
      passRate: result.passRate,
      totalWindows: result.windows.length,
      eligibleWindows: result.windows.filter((w) => w.valTrades.length > 0).length,
      totalOOSTrades: result.allOOSTrades.length,
      finalParams: result.finalParams,
      aggregate: {
        sharpe: result.aggregate.sharpe,
        totalPnl: result.aggregate.totalPnl,
        maxDrawdown: result.aggregate.maxDrawdown,
        winRate: result.aggregate.winRate,
        avgDaysHeld: result.aggregate.avgDaysHeld,
        exitReasons: result.aggregate.exitReasons,
      },
      windows: result.windows.map((w) => ({
        windowIndex: w.windowIndex,
        trainStart: new Date(candles[w.trainStart]!.timestamp).toISOString().slice(0, 10),
        trainEnd: new Date(candles[w.trainEnd - 1]!.timestamp).toISOString().slice(0, 10),
        valStart: new Date(candles[w.valStart]!.timestamp).toISOString().slice(0, 10),
        valEnd: new Date(candles[w.valEnd - 1]!.timestamp).toISOString().slice(0, 10),
        bestLambda: w.bestLambda,
        bestTheta: w.bestTheta,
        trainSharpe: w.trainSharpe,
        valSharpe: w.valSharpe,
        valTrades: w.valTrades.length,
        pass: w.pass,
      })),
    };

    fs.writeFileSync(outPath, JSON.stringify(saveData, null, 2));
    console.log(`\nResults saved to ${outPath}`);
  }
}

// ============================================
// Results Printer
// ============================================

function printResults(
  result: F2FOptimizationResult,
  elapsed: string,
): void {
  const agg = result.aggregate;
  const eligibleWindows = result.windows.filter((w) => w.valTrades.length > 0);

  console.log('\n=== Walk-Forward Results ===\n');
  console.log(`  Total windows: ${result.windows.length}`);
  console.log(`  Eligible windows (>0 trades): ${eligibleWindows.length}`);
  console.log(`  Pass rate: ${(result.passRate * 100).toFixed(1)}% (${eligibleWindows.filter((w) => w.pass).length}/${eligibleWindows.length})`);
  console.log(`  Runtime: ${elapsed}s`);

  console.log('\n=== Aggregate OOS Performance ===\n');
  console.log(`  OOS trades: ${result.allOOSTrades.length}`);
  console.log(`  Total PnL: ${(agg.totalPnl * 100).toFixed(1)}%`);
  console.log(`  Sharpe: ${agg.sharpe.toFixed(2)}`);
  console.log(`  Max Drawdown: ${(agg.maxDrawdown * 100).toFixed(1)}%`);
  console.log(`  Win Rate: ${(agg.winRate * 100).toFixed(1)}%`);
  console.log(`  Avg Days Held: ${agg.avgDaysHeld.toFixed(1)}`);

  console.log('\n  Exit Reasons:');
  const exitReasons = agg.exitReasons;
  const total = result.allOOSTrades.length || 1;
  for (const [reason, count] of Object.entries(exitReasons)) {
    if (count > 0) {
      console.log(`    ${reason}: ${count} (${((count / total) * 100).toFixed(1)}%)`);
    }
  }

  console.log('\n=== Final Parameters (for live use) ===\n');
  console.log(`  λ (EMA decay): ${result.finalParams.lambda.toFixed(2)}`);
  console.log(`  θ (EWMA vol): ${result.finalParams.theta.toFixed(2)}`);

  // Parameter stability across windows
  if (result.windows.length > 0) {
    const lambdas = result.windows.map((w) => w.bestLambda);
    const thetas = result.windows.map((w) => w.bestTheta);
    const lambdaMean = lambdas.reduce((s, v) => s + v, 0) / lambdas.length;
    const thetaMean = thetas.reduce((s, v) => s + v, 0) / thetas.length;
    const lambdaStd = Math.sqrt(lambdas.reduce((s, v) => s + (v - lambdaMean) ** 2, 0) / lambdas.length);
    const thetaStd = Math.sqrt(thetas.reduce((s, v) => s + (v - thetaMean) ** 2, 0) / thetas.length);

    console.log('\n=== Parameter Stability ===\n');
    console.log(`  λ: mean=${lambdaMean.toFixed(3)} std=${lambdaStd.toFixed(3)} range=[${Math.min(...lambdas).toFixed(2)}, ${Math.max(...lambdas).toFixed(2)}]`);
    console.log(`  θ: mean=${thetaMean.toFixed(3)} std=${thetaStd.toFixed(3)} range=[${Math.min(...thetas).toFixed(2)}, ${Math.max(...thetas).toFixed(2)}]`);
  }

  // Compare to paper
  console.log('\n=== Paper Comparison ===\n');
  console.log('  Paper (2015-2025):  Sharpe=2.88, MaxDD=0.52%, WR=65.8%');
  console.log(`  Ours (OOS agg):     Sharpe=${agg.sharpe.toFixed(2)}, MaxDD=${(agg.maxDrawdown * 100).toFixed(2)}%, WR=${(agg.winRate * 100).toFixed(1)}%`);
}

main();
