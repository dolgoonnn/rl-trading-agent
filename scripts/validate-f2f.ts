#!/usr/bin/env tsx
/**
 * F2F Gold Strategy — Validation Gate
 *
 * Runs the full 7-check validation scorecard:
 * 1. Walk-Forward pass rate ≥ 60%
 * 2. PBO < 25%
 * 3. DSR > 0
 * 4. MC Bootstrap Sharpe 5th pct > 0
 * 5. MC Bootstrap PnL 5th pct > 0
 * 6. MC Skip 20% → ≥ 90% profitable
 * 7. Param fragility < 50% drop
 *
 * Reuses existing generic validation utils (MC, DSR, PBO).
 *
 * Usage:
 *   npx tsx scripts/validate-f2f.ts                      # Full validation
 *   npx tsx scripts/validate-f2f.ts --mc-iterations 500   # Fewer MC iterations (faster)
 *   npx tsx scripts/validate-f2f.ts --save                # Save results
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';
import {
  runWalkForwardOptimization,
  generateSignals,
  runF2FSimulation,
  F2F_DEFAULT_WF_CONFIG,
  F2F_FIXED_PARAMS,
  F2F_GRID,
  type F2FWalkForwardConfig,
  type F2FOptimizedParams,
  type F2FDirectionMode,
  type RegimeFilterType,
} from '../src/lib/gold';

// Parse --override flags before opts to allow fixed param overrides
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--override') {
    const [key, val] = process.argv[++i]!.split('=');
    (F2F_FIXED_PARAMS as Record<string, number>)[key!] = parseFloat(val!);
  }
}
import {
  reshuffleTrades,
  bootstrapTrades,
  skipTrades,
  type MCTradeResult,
} from '../src/lib/rl/utils/monte-carlo';
import { calculateDeflatedSharpe } from '../src/lib/rl/utils/deflated-sharpe';
import { estimatePBO, type WindowResult } from '../src/lib/rl/utils/pbo';

// ============================================
// CLI
// ============================================

interface ValidationOpts {
  dataPath: string;
  friction: number;
  mcIterations: number;
  perturbations: number;
  save: boolean;
  numTrials: number;
  direction: F2FDirectionMode;
  regimeFilter: RegimeFilterType;
}

function parseArgs(): ValidationOpts {
  const args = process.argv.slice(2);
  const opts: ValidationOpts = {
    dataPath: path.resolve(__dirname, '..', 'data', 'GC_F_1d.json'),
    friction: 0.0005,
    mcIterations: 1000,
    perturbations: 50,
    save: false,
    numTrials: 1, // First F2F config — minimal trial count
    direction: 'long-only' as F2FDirectionMode,
    regimeFilter: 'none' as RegimeFilterType,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--data':
        opts.dataPath = args[++i]!;
        break;
      case '--friction':
        opts.friction = parseFloat(args[++i]!);
        break;
      case '--mc-iterations':
        opts.mcIterations = parseInt(args[++i]!, 10);
        break;
      case '--perturbations':
        opts.perturbations = parseInt(args[++i]!, 10);
        break;
      case '--save':
        opts.save = true;
        break;
      case '--trials':
        opts.numTrials = parseInt(args[++i]!, 10);
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
    }
  }

  return opts;
}

// ============================================
// Scorecard
// ============================================

interface CheckResult {
  name: string;
  value: string;
  threshold: string;
  pass: boolean;
}

// ============================================
// Main
// ============================================

function main(): void {
  const opts = parseArgs();

  if (!fs.existsSync(opts.dataPath)) {
    console.error(`Data file not found: ${opts.dataPath}`);
    console.error('Run: npx tsx scripts/download-gold-daily.ts');
    process.exit(1);
  }

  const candles: Candle[] = JSON.parse(fs.readFileSync(opts.dataPath, 'utf-8'));
  const startDate = new Date(candles[0]!.timestamp).toISOString().slice(0, 10);
  const endDate = new Date(candles[candles.length - 1]!.timestamp).toISOString().slice(0, 10);

  console.log('=== F2F Gold Strategy — Validation Gate ===\n');
  console.log(`  Data: ${candles.length.toLocaleString()} daily candles (${startDate} → ${endDate})`);
  console.log(`  MC iterations: ${opts.mcIterations}, Perturbations: ${opts.perturbations}`);
  console.log(`  Direction: ${opts.direction}`);
  console.log(`  DSR trials: ${opts.numTrials}\n`);

  const config: F2FWalkForwardConfig = { ...F2F_DEFAULT_WF_CONFIG };
  const checks: CheckResult[] = [];
  const startTime = Date.now();

  // ============================================
  // Check 1: Walk-Forward Pass Rate
  // ============================================
  console.log('--- Check 1: Walk-Forward Pass Rate ---');

  const wfResult = runWalkForwardOptimization(candles, config, opts.friction, undefined, opts.direction, opts.regimeFilter);
  const eligibleWindows = wfResult.windows.filter((w) => w.valTrades.length > 0);
  const passRate = wfResult.passRate;

  console.log(`  Windows: ${wfResult.windows.length} total, ${eligibleWindows.length} eligible`);
  console.log(`  Pass rate: ${(passRate * 100).toFixed(1)}% (threshold: ≥60%)`);
  console.log(`  OOS trades: ${wfResult.allOOSTrades.length}`);
  console.log(`  OOS Sharpe: ${wfResult.aggregate.sharpe.toFixed(2)}`);
  console.log(`  OOS PnL: ${(wfResult.aggregate.totalPnl * 100).toFixed(1)}%`);
  console.log(`  Win Rate: ${(wfResult.aggregate.winRate * 100).toFixed(1)}%\n`);

  checks.push({
    name: 'Walk-Forward ≥60%',
    value: `${(passRate * 100).toFixed(1)}%`,
    threshold: '≥60%',
    pass: passRate >= 0.60,
  });

  const oosReturns: MCTradeResult[] = wfResult.allOOSTrades.map((t) => ({
    pnlPercent: t.pnlPercent,
  }));

  if (oosReturns.length < 5) {
    console.log('WARNING: Too few OOS trades for statistical tests. Aborting validation.\n');
    printScorecard(checks);
    return;
  }

  // Annualization factor for daily trading: √252
  const annualizationFactor = F2F_FIXED_PARAMS.annualizationFactor;

  // ============================================
  // Check 2: PBO
  // ============================================
  console.log('--- Check 2: Probability of Backtest Overfitting (PBO) ---');

  // Generate 8 param-perturbation variants for PBO
  const pboVariants = generatePBOVariants(candles, config, opts.friction, opts.direction, opts.regimeFilter);
  const pboResult = estimatePBO(pboVariants, 2000, { threshold: 0.25 });

  console.log(`  PBO: ${(pboResult.pbo * 100).toFixed(1)}% (threshold: <25%)`);
  console.log(`  Configs tested: ${pboVariants.length}`);
  console.log(`  CSCV samples: ${pboResult.numCombinations}\n`);

  checks.push({
    name: 'PBO <25%',
    value: `${(pboResult.pbo * 100).toFixed(1)}%`,
    threshold: '<25%',
    pass: pboResult.pbo < 0.25,
  });

  // ============================================
  // Check 3: Deflated Sharpe Ratio
  // ============================================
  console.log('--- Check 3: Deflated Sharpe Ratio ---');

  const dsrResult = calculateDeflatedSharpe(
    wfResult.aggregate.sharpe,
    wfResult.allOOSTrades.length,
    opts.numTrials,
  );

  console.log(`  Original Sharpe: ${dsrResult.originalSharpe.toFixed(2)}`);
  console.log(`  Haircut: ${dsrResult.haircut.toFixed(2)} (${opts.numTrials} trials)`);
  console.log(`  DSR: ${dsrResult.deflatedSharpe.toFixed(2)} (threshold: >0)\n`);

  checks.push({
    name: 'DSR >0',
    value: dsrResult.deflatedSharpe.toFixed(2),
    threshold: '>0',
    pass: dsrResult.deflatedSharpe > 0,
  });

  // ============================================
  // Check 4: MC Bootstrap Sharpe
  // ============================================
  console.log('--- Check 4: Monte Carlo Bootstrap Sharpe ---');

  const bootstrap = bootstrapTrades(oosReturns, opts.mcIterations, undefined, annualizationFactor);

  console.log(`  Bootstrap Sharpe 5th pct: ${bootstrap.sharpe.p5.toFixed(2)} (threshold: >0)`);
  console.log(`  Bootstrap Sharpe median: ${bootstrap.sharpe.median.toFixed(2)}\n`);

  checks.push({
    name: 'MC Bootstrap Sharpe 5th >0',
    value: bootstrap.sharpe.p5.toFixed(2),
    threshold: '>0',
    pass: bootstrap.sharpe.p5 > 0,
  });

  // ============================================
  // Check 5: MC Bootstrap PnL
  // ============================================
  console.log('--- Check 5: Monte Carlo Bootstrap PnL ---');

  console.log(`  Bootstrap PnL 5th pct: ${(bootstrap.finalPnl.p5 * 100).toFixed(1)}% (threshold: >0%)`);
  console.log(`  Bootstrap PnL median: ${(bootstrap.finalPnl.median * 100).toFixed(1)}%\n`);

  checks.push({
    name: 'MC Bootstrap PnL 5th >0%',
    value: `${(bootstrap.finalPnl.p5 * 100).toFixed(1)}%`,
    threshold: '>0%',
    pass: bootstrap.finalPnl.p5 > 0,
  });

  // ============================================
  // Check 6: MC Skip 20%
  // ============================================
  console.log('--- Check 6: Monte Carlo Skip 20% ---');

  const skip20 = skipTrades(oosReturns, 0.20, opts.mcIterations, annualizationFactor);
  const skip30 = skipTrades(oosReturns, 0.30, opts.mcIterations, annualizationFactor);

  console.log(`  Skip 20%: ${(skip20.profitableFraction * 100).toFixed(1)}% profitable (threshold: ≥90%)`);
  console.log(`  Skip 30%: ${(skip30.profitableFraction * 100).toFixed(1)}% profitable\n`);

  checks.push({
    name: 'MC Skip 20% ≥90% profitable',
    value: `${(skip20.profitableFraction * 100).toFixed(1)}%`,
    threshold: '≥90%',
    pass: skip20.profitableFraction >= 0.90,
  });

  // ============================================
  // Check 7: Parameter Fragility
  // ============================================
  console.log('--- Check 7: Parameter Fragility ---');

  const fragility = computeParamFragility(
    candles,
    config,
    wfResult.finalParams,
    opts.friction,
    opts.perturbations,
    passRate,
    opts.direction,
    opts.regimeFilter,
  );

  console.log(`  Base pass rate: ${(passRate * 100).toFixed(1)}%`);
  console.log(`  Mean perturbed pass rate: ${(fragility.meanPassRate * 100).toFixed(1)}%`);
  console.log(`  Fragility (>5pp drop): ${(fragility.fragilityScore * 100).toFixed(0)}% (threshold: <50%)`);
  console.log(`  Perturbed 5th pct pass rate: ${(fragility.p5PassRate * 100).toFixed(1)}%\n`);

  checks.push({
    name: 'Param Fragility <50%',
    value: `${(fragility.fragilityScore * 100).toFixed(0)}%`,
    threshold: '<50%',
    pass: fragility.fragilityScore < 0.50,
  });

  // ============================================
  // Reshuffle (informational, not a gate check)
  // ============================================
  console.log('--- Reshuffle Test (informational) ---');
  const reshuffle = reshuffleTrades(oosReturns, opts.mcIterations, annualizationFactor);
  console.log(`  Real Sharpe vs shuffled: z=${reshuffle.sharpe.zScore.toFixed(2)}, p=${reshuffle.sharpe.pValue.toFixed(3)}`);
  console.log(`  Serial correlation dependency: ${reshuffle.sharpe.isSignificant ? 'YES (adverse)' : 'NO (PASS)'}\n`);

  // ============================================
  // Scorecard
  // ============================================
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Runtime: ${elapsed}s\n`);
  printScorecard(checks);

  // Save results
  if (opts.save) {
    const outPath = path.resolve(__dirname, '..', 'experiments', 'f2f-validation-results.json');
    const saveData = {
      timestamp: new Date().toISOString(),
      dataRange: { start: startDate, end: endDate, bars: candles.length },
      config: { ...config, friction: opts.friction },
      checks,
      passCount: checks.filter((c) => c.pass).length,
      totalChecks: checks.length,
      details: {
        wfPassRate: passRate,
        oosTrades: wfResult.allOOSTrades.length,
        oosSharpe: wfResult.aggregate.sharpe,
        oosPnl: wfResult.aggregate.totalPnl,
        oosWinRate: wfResult.aggregate.winRate,
        oosMaxDD: wfResult.aggregate.maxDrawdown,
        finalParams: wfResult.finalParams,
        pbo: pboResult.pbo,
        dsr: dsrResult.deflatedSharpe,
        bootstrapSharpe5: bootstrap.sharpe.p5,
        bootstrapPnl5: bootstrap.finalPnl.p5,
        skip20Profitable: skip20.profitableFraction,
        skip30Profitable: skip30.profitableFraction,
        fragility: fragility.fragilityScore,
        reshuffleZScore: reshuffle.sharpe.zScore,
      },
    };
    fs.writeFileSync(outPath, JSON.stringify(saveData, null, 2));
    console.log(`\nResults saved to ${outPath}`);
  }
}

// ============================================
// PBO Variant Generator
// ============================================

/**
 * Generate 8 param-perturbation variants for PBO.
 * Each variant uses slightly different λ/θ and produces different WF window metrics.
 */
function generatePBOVariants(
  candles: Candle[],
  config: F2FWalkForwardConfig,
  friction: number,
  directionMode: F2FDirectionMode = 'long-only',
  regimeFilter: RegimeFilterType = 'none',
): WindowResult[] {
  // 8 variants spanning full [0.90, 0.99] grid — corners, center, and edges
  // Must include actual optimum (θ=0.90) to avoid PBO blind spot
  const paramSets: F2FOptimizedParams[] = [
    { lambda: 0.90, theta: 0.90 },  // Actual optimum corner
    { lambda: 0.92, theta: 0.94 },  // Near-optimum, mixed
    { lambda: 0.94, theta: 0.94 },  // Center
    { lambda: 0.96, theta: 0.96 },  // Upper quadrant
    { lambda: 0.98, theta: 0.98 },  // Far edge
    { lambda: 0.90, theta: 0.99 },  // Corner: low λ, high θ
    { lambda: 0.99, theta: 0.90 },  // Corner: high λ, low θ
    { lambda: 0.95, theta: 0.92 },  // Mixed mid-range
  ];

  const variants: WindowResult[] = [];

  for (let p = 0; p < paramSets.length; p++) {
    const params = paramSets[p]!;
    // Run fixed-param WF (no grid search — just evaluate this param set on each window)
    const wfResult = runFixedParamWF(candles, config, params, friction, directionMode, regimeFilter);

    variants.push({
      configId: `λ=${params.lambda}_θ=${params.theta}`,
      windowMetrics: wfResult,
    });
  }

  return variants;
}

/**
 * Run walk-forward with fixed params (no grid search).
 * Returns per-window Sharpe values.
 */
function runFixedParamWF(
  candles: Candle[],
  config: F2FWalkForwardConfig,
  params: F2FOptimizedParams,
  friction: number,
  directionMode: F2FDirectionMode = 'long-only',
  regimeFilter: RegimeFilterType = 'none',
): number[] {
  const windowSharpes: number[] = [];
  const totalBars = candles.length;

  for (let trainStart = 0; trainStart + config.trainBars + config.valBars <= totalBars; trainStart += config.slideBars) {
    const trainEnd = trainStart + config.trainBars;
    const valStart = trainEnd;
    const valEnd = Math.min(valStart + config.valBars, totalBars);

    if (valEnd - valStart < 21) break;

    const signals = generateSignals(candles, params, trainStart, trainEnd, valStart, valEnd, regimeFilter);
    const result = runF2FSimulation(signals, friction, directionMode);
    windowSharpes.push(result.sharpe);
  }

  return windowSharpes;
}

// ============================================
// Parameter Fragility
// ============================================

interface FragilityResult {
  meanPassRate: number;
  fragilityScore: number;
  p5PassRate: number;
}

function computeParamFragility(
  candles: Candle[],
  config: F2FWalkForwardConfig,
  baseParams: F2FOptimizedParams,
  friction: number,
  perturbations: number,
  basePassRate: number,
  directionMode: F2FDirectionMode = 'long-only',
  regimeFilter: RegimeFilterType = 'none',
): FragilityResult {
  const passRates: number[] = [];

  for (let i = 0; i < perturbations; i++) {
    // Jitter λ and θ by gaussian noise with σ=0.02 (2 grid steps, ±22% of range)
    const perturbSigma = 0.02;
    const perturbedLambda = clamp(
      baseParams.lambda + gaussianRandom() * perturbSigma,
      F2F_GRID.lambdaMin,
      F2F_GRID.lambdaMax,
    );
    const perturbedTheta = clamp(
      baseParams.theta + gaussianRandom() * perturbSigma,
      F2F_GRID.thetaMin,
      F2F_GRID.thetaMax,
    );

    const perturbedParams: F2FOptimizedParams = {
      lambda: perturbedLambda,
      theta: perturbedTheta,
    };

    const windowSharpes = runFixedParamWF(candles, config, perturbedParams, friction, directionMode, regimeFilter);
    const eligible = windowSharpes.filter((s) => s !== 0); // non-zero = had trades
    const pr = eligible.length > 0
      ? eligible.filter((s) => s > 0).length / eligible.length
      : 0;
    passRates.push(pr);
  }

  const sorted = [...passRates].sort((a, b) => a - b);
  const meanPassRate = passRates.reduce((s, v) => s + v, 0) / passRates.length;
  const fragile = passRates.filter((pr) => pr < basePassRate - 0.05).length;

  return {
    meanPassRate,
    fragilityScore: fragile / perturbations,
    p5PassRate: sorted[Math.floor(sorted.length * 0.05)] ?? 0,
  };
}

// ============================================
// Helpers
// ============================================

function gaussianRandom(): number {
  const u1 = Math.random() || Number.EPSILON; // Guard against log(0) → NaN
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function printScorecard(checks: CheckResult[]): void {
  console.log('=== VALIDATION SCORECARD ===\n');

  const passCount = checks.filter((c) => c.pass).length;

  for (const check of checks) {
    const icon = check.pass ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] ${check.name}: ${check.value} (${check.threshold})`);
  }

  console.log(`\n  Result: ${passCount}/${checks.length} checks pass`);

  if (passCount >= 5) {
    console.log('  → PROCEED to paper trading');
  } else {
    console.log('  → DO NOT paper trade — insufficient validation');
  }
}

main();
