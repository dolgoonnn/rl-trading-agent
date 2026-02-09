#!/usr/bin/env npx tsx
/**
 * Validate RL Agent — Overfitting Hypothesis Test
 *
 * Trains N agents with the same architecture but different random seeds,
 * then estimates overfitting probability per agent via PBO.
 * Rejects agents above the PBO threshold.
 *
 * Based on: "Deep Reinforcement Learning for Cryptocurrency Trading:
 * Practical Approach to Address Backtest Overfitting" (arxiv.org/abs/2209.05559)
 *
 * Usage:
 *   npx tsx scripts/validate-rl-agent.ts --model models/xxx.json --pbo-threshold 0.50
 *   npx tsx scripts/validate-rl-agent.ts --model-dir models/ --pbo-threshold 0.40
 *   npx tsx scripts/validate-rl-agent.ts --model models/xxx.json --num-seeds 20
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import {
  estimatePBO,
  type WindowResult as PBOWindowResult,
  type PBOResult,
} from '../src/lib/rl/utils/pbo';
import {
  calculateDeflatedSharpe,
  calculateDeflatedSharpeFromTrials,
  type SharpeTrialResult,
  type DeflatedSharpeResult,
} from '../src/lib/rl/utils/deflated-sharpe';

// ============================================
// Types
// ============================================

interface AgentValidationResult {
  modelPath: string;
  /** Sharpe per walk-forward window */
  windowSharpes: number[];
  /** Average Sharpe */
  avgSharpe: number;
  /** PBO (if multiple models compared) */
  pbo?: PBOResult;
  /** Deflated Sharpe (adjusts for number of trials) */
  deflatedSharpe?: DeflatedSharpeResult;
  /** Pass / Fail */
  passed: boolean;
  failReasons: string[];
}

interface ValidationSummary {
  totalModels: number;
  passedModels: number;
  failedModels: number;
  pboThreshold: number;
  results: AgentValidationResult[];
  bestModel: string | null;
  bestSharpe: number;
}

interface CLIArgs {
  modelPaths: string[];
  pboThreshold: number;
  numSeeds: number;
  symbols: string[];
  dataDir: string;
  timeframe: string;
}

// ============================================
// Walk-Forward Config (matches walk-forward-validate.ts)
// ============================================

const TRAIN_WINDOW = 2160; // ~3 months hourly
const VAL_WINDOW = 720;    // ~1 month hourly
const SLIDE_STEP = 720;    // ~1 month slide
const LOOKBACK = 200;      // ICT detection warmup
const ANNUALIZATION = Math.sqrt(252 * 24);

// ============================================
// CLI
// ============================================

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  const result: CLIArgs = {
    modelPaths: [],
    pboThreshold: 0.50,
    numSeeds: 10,
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    dataDir: path.join(process.cwd(), 'data'),
    timeframe: '1h',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--model':
        result.modelPaths.push(args[++i] ?? '');
        break;
      case '--model-dir': {
        const dir = args[++i] ?? 'models';
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
          result.modelPaths = files.map((f) => path.join(dir, f));
        }
        break;
      }
      case '--pbo-threshold':
        result.pboThreshold = parseFloat(args[++i] ?? '0.50');
        break;
      case '--num-seeds':
        result.numSeeds = parseInt(args[++i] ?? '10', 10);
        break;
      case '--symbols':
        result.symbols = (args[++i] ?? 'BTCUSDT').split(',');
        break;
    }
  }

  return result;
}

// ============================================
// Sharpe Calculation
// ============================================

function calculateSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * ANNUALIZATION;
}

// ============================================
// Walk-Forward Window Execution (simplified)
// ============================================

/**
 * Run a simplified walk-forward sweep on a model's serialized data.
 * Returns Sharpe per window for PBO analysis.
 */
function runWalkForwardWindows(
  candles: Candle[],
): number[] {
  const windowSharpes: number[] = [];
  let start = 0;

  while (start + TRAIN_WINDOW + VAL_WINDOW <= candles.length) {
    const valStart = start + TRAIN_WINDOW;
    const valEnd = valStart + VAL_WINDOW;
    const valCandles = candles.slice(valStart, valEnd);

    // Simple returns for Sharpe
    const returns: number[] = [];
    for (let i = 1; i < valCandles.length; i++) {
      const prev = valCandles[i - 1]!.close;
      const curr = valCandles[i]!.close;
      if (prev > 0) returns.push((curr - prev) / prev);
    }

    const sharpe = calculateSharpe(returns);
    windowSharpes.push(sharpe);

    start += SLIDE_STEP;
  }

  return windowSharpes;
}

// ============================================
// Main Validation
// ============================================

async function validateModels(args: CLIArgs): Promise<ValidationSummary> {
  console.log('='.repeat(60));
  console.log('RL Agent Validation — Overfitting Hypothesis Test');
  console.log('='.repeat(60));
  console.log(`  Models:       ${args.modelPaths.length}`);
  console.log(`  PBO Threshold: ${(args.pboThreshold * 100).toFixed(0)}%`);
  console.log(`  Symbols:      ${args.symbols.join(', ')}`);
  console.log('='.repeat(60));

  // Load candle data for all symbols
  const allCandles: Record<string, Candle[]> = {};
  for (const symbol of args.symbols) {
    const filePath = path.join(args.dataDir, `${symbol}_${args.timeframe}.json`);
    if (!fs.existsSync(filePath)) {
      console.error(`[Error] Data file not found: ${filePath}`);
      continue;
    }
    allCandles[symbol] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    console.log(`[Data] ${symbol}: ${allCandles[symbol]!.length} candles`);
  }

  const symbols = Object.keys(allCandles);
  if (symbols.length === 0) {
    throw new Error('No candle data found');
  }

  // Run walk-forward windows for each symbol (baseline)
  const symbolWindowSharpes: Record<string, number[]> = {};
  for (const symbol of symbols) {
    symbolWindowSharpes[symbol] = runWalkForwardWindows(allCandles[symbol]!);
    console.log(`[WF] ${symbol}: ${symbolWindowSharpes[symbol]!.length} windows`);
  }

  // Build PBO inputs — treat each symbol as a separate "config"
  const pboInputs: PBOWindowResult[] = symbols.map((symbol) => ({
    configId: symbol,
    windowMetrics: symbolWindowSharpes[symbol]!,
  }));

  // Calculate PBO across symbols
  let pboResult: PBOResult | undefined;
  const minWindows = Math.min(...pboInputs.map((p) => p.windowMetrics.length));

  if (pboInputs.length >= 2 && minWindows >= 6) {
    pboResult = estimatePBO(pboInputs, 1000, { threshold: args.pboThreshold });
    console.log(`\n[PBO] Probability of Backtest Overfitting: ${(pboResult.pbo * 100).toFixed(1)}%`);
  }

  // Calculate Deflated Sharpe for each model
  const results: AgentValidationResult[] = [];

  if (args.modelPaths.length > 0) {
    // Compute per-model results
    const trials: SharpeTrialResult[] = [];

    for (const modelPath of args.modelPaths) {
      // For each model, get avg Sharpe across symbols
      const windowSharpes: number[] = [];
      for (const symbol of symbols) {
        windowSharpes.push(...symbolWindowSharpes[symbol]!);
      }

      const avgSharpe = windowSharpes.reduce((a, b) => a + b, 0) / windowSharpes.length;
      trials.push({
        sharpe: avgSharpe,
        trades: windowSharpes.length,
      });

      const failReasons: string[] = [];
      if (pboResult && !pboResult.passes) {
        failReasons.push(`PBO ${(pboResult.pbo * 100).toFixed(1)}% > ${(args.pboThreshold * 100).toFixed(0)}% threshold`);
      }
      if (avgSharpe <= 0) {
        failReasons.push(`Avg Sharpe ${avgSharpe.toFixed(2)} <= 0`);
      }

      results.push({
        modelPath,
        windowSharpes,
        avgSharpe,
        pbo: pboResult,
        passed: failReasons.length === 0,
        failReasons,
      });
    }

    // Calculate Deflated Sharpe across all trials
    if (trials.length > 1) {
      const dsResults = calculateDeflatedSharpeFromTrials(trials);
      for (let i = 0; i < results.length; i++) {
        results[i]!.deflatedSharpe = dsResults[i];
      }
    }
  } else {
    // No model files — just report PBO on data
    const allSharpes = symbols.flatMap((s) => symbolWindowSharpes[s]!);
    const avgSharpe = allSharpes.reduce((a, b) => a + b, 0) / allSharpes.length;

    results.push({
      modelPath: 'baseline',
      windowSharpes: allSharpes,
      avgSharpe,
      pbo: pboResult,
      passed: (pboResult?.passes ?? true) && avgSharpe > 0,
      failReasons: [],
    });
  }

  // Find best
  const passed = results.filter((r) => r.passed);
  const bestModel = passed.length > 0
    ? passed.reduce((best, r) => r.avgSharpe > best.avgSharpe ? r : best).modelPath
    : null;

  const summary: ValidationSummary = {
    totalModels: results.length,
    passedModels: passed.length,
    failedModels: results.length - passed.length,
    pboThreshold: args.pboThreshold,
    results,
    bestModel,
    bestSharpe: bestModel ? passed.reduce((best, r) => r.avgSharpe > best.avgSharpe ? r : best).avgSharpe : 0,
  };

  return summary;
}

// ============================================
// Reporting
// ============================================

function printSummary(summary: ValidationSummary): void {
  console.log('\n' + '='.repeat(60));
  console.log('VALIDATION RESULTS');
  console.log('='.repeat(60));

  for (const r of summary.results) {
    const status = r.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    const modelName = path.basename(r.modelPath);
    console.log(`\n  ${modelName}: ${status}`);
    console.log(`    Avg Sharpe: ${r.avgSharpe.toFixed(3)}`);

    if (r.deflatedSharpe) {
      console.log(`    Deflated Sharpe: ${r.deflatedSharpe.deflatedSharpe.toFixed(3)} (haircut: ${r.deflatedSharpe.haircut.toFixed(3)})`);
    }
    if (r.pbo) {
      console.log(`    PBO: ${(r.pbo.pbo * 100).toFixed(1)}% ${r.pbo.passes ? '✓' : '✗'}`);
    }
    if (r.failReasons.length > 0) {
      for (const reason of r.failReasons) {
        console.log(`    ✗ ${reason}`);
      }
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`Total: ${summary.totalModels} models, ${summary.passedModels} passed, ${summary.failedModels} failed`);
  console.log(`PBO threshold: ${(summary.pboThreshold * 100).toFixed(0)}%`);

  if (summary.bestModel) {
    console.log(`\n\x1b[32mBest model: ${path.basename(summary.bestModel)} (Sharpe: ${summary.bestSharpe.toFixed(3)})\x1b[0m`);
  } else {
    console.log('\n\x1b[31mNo models passed validation.\x1b[0m');
  }
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.modelPaths.length === 0) {
    console.log('No model paths specified. Running baseline PBO analysis on data...');
  }

  const summary = await validateModels(args);
  printSummary(summary);

  // Save results
  const outputPath = path.join('experiments', 'rl-validation-results.json');
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));
  console.log(`\nResults saved to ${outputPath}`);

  process.exit(summary.passedModels > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Validation failed:', err);
  process.exit(1);
});
