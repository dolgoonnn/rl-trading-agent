#!/usr/bin/env tsx
/**
 * F2F Gold Strategy — Fixed Parameter Sensitivity Sweeps
 *
 * Tests each fixed parameter independently while holding others at paper defaults.
 * Reports WF pass rate and Sharpe for each value.
 *
 * Usage:
 *   npx tsx scripts/sweep-f2f-params.ts                        # All params
 *   npx tsx scripts/sweep-f2f-params.ts --param trendBlendWeight  # Single param
 *   npx tsx scripts/sweep-f2f-params.ts --regime-filter zscore50  # With regime filter
 *   npx tsx scripts/sweep-f2f-params.ts --save                    # Save results
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';
import {
  F2F_FIXED_PARAMS,
  F2F_DEFAULT_WF_CONFIG,
  type F2FWalkForwardConfig,
  type RegimeFilterType,
} from '../src/lib/gold';
import { generateSignals } from '../src/lib/gold/signals';
import { runF2FSimulation, type F2FDirectionMode } from '../src/lib/gold/strategy';

// ============================================
// Parameter Sweep Definitions
// ============================================

interface ParamSweepDef {
  name: string;
  key: string;
  paperValue: number;
  values: number[];
}

const SWEEP_DEFS: ParamSweepDef[] = [
  {
    name: 'Trend Blend Weight (ω)',
    key: 'trendBlendWeight',
    paperValue: 0.60,
    values: [0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80],
  },
  {
    name: 'Activation Threshold',
    key: 'activationThreshold',
    paperValue: 0.52,
    values: [0.50, 0.51, 0.52, 0.53, 0.54, 0.55, 0.56, 0.57, 0.58, 0.59, 0.60],
  },
  {
    name: 'Hard Stop ATR Multiple',
    key: 'hardStopAtrMultiple',
    paperValue: 2.0,
    values: [1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0],
  },
  {
    name: 'Trailing Stop ATR Multiple',
    key: 'trailingStopAtrMultiple',
    paperValue: 1.5,
    values: [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5],
  },
  {
    name: 'Timeout Days',
    key: 'timeoutDays',
    paperValue: 30,
    values: [15, 20, 25, 30, 35, 40, 45, 50, 55, 60],
  },
  {
    name: 'Kelly Fraction',
    key: 'kellyFraction',
    paperValue: 0.40,
    values: [0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60],
  },
  {
    name: 'Momentum Lookback',
    key: 'momentumLookback',
    paperValue: 50,
    values: [20, 30, 40, 50, 60, 70, 80, 90, 100],
  },
];

// ============================================
// CLI
// ============================================

interface SweepOpts {
  dataPath: string;
  friction: number;
  paramFilter: string | null;
  regimeFilter: RegimeFilterType;
  save: boolean;
}

function parseArgs(): SweepOpts {
  const args = process.argv.slice(2);
  const opts: SweepOpts = {
    dataPath: path.resolve(__dirname, '..', 'data', 'GC_F_1d.json'),
    friction: 0.0005,
    paramFilter: null,
    regimeFilter: 'none',
    save: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--data':
        opts.dataPath = args[++i]!;
        break;
      case '--friction':
        opts.friction = parseFloat(args[++i]!);
        break;
      case '--param':
        opts.paramFilter = args[++i]!;
        break;
      case '--regime-filter':
        opts.regimeFilter = args[++i]! as RegimeFilterType;
        break;
      case '--save':
        opts.save = true;
        break;
    }
  }

  return opts;
}

// ============================================
// Sweep Runner
// ============================================

interface SweepResult {
  param: string;
  value: number;
  isPaperDefault: boolean;
  passRate: number;
  sharpe: number;
  totalPnl: number;
  trades: number;
  maxDD: number;
  winRate: number;
}

/**
 * Override a fixed param, run WF, return metrics.
 *
 * Temporarily mutates F2F_FIXED_PARAMS (acceptable in a script context).
 */
function runWithOverride(
  candles: Candle[],
  config: F2FWalkForwardConfig,
  paramKey: string,
  value: number,
  friction: number,
  regimeFilter: RegimeFilterType,
): { passRate: number; sharpe: number; totalPnl: number; trades: number; maxDD: number; winRate: number } {
  // Save original and override
  const original = (F2F_FIXED_PARAMS as Record<string, number>)[paramKey];
  (F2F_FIXED_PARAMS as Record<string, number>)[paramKey] = value;

  try {
    // Run walk-forward manually (can't use optimizer since it imports the const)
    const totalBars = candles.length;
    let passCount = 0;
    let eligibleCount = 0;
    const allTrades: Array<{ pnlPercent: number }> = [];

    for (let trainStart = 0; trainStart + config.trainBars + config.valBars <= totalBars; trainStart += config.slideBars) {
      const trainEnd = trainStart + config.trainBars;
      const valStart = trainEnd;
      const valEnd = Math.min(valStart + config.valBars, totalBars);

      if (valEnd - valStart < 21) break;

      // Use fixed params (λ=0.92, θ=0.90 — the optimal values from WF)
      const params = { lambda: 0.92, theta: 0.90 };
      const signals = generateSignals(candles, params, trainStart, trainEnd, valStart, valEnd, regimeFilter);
      const result = runF2FSimulation(signals, friction);

      if (result.trades.length > 0) {
        eligibleCount++;
        if (result.sharpe > 0) passCount++;
        allTrades.push(...result.trades);
      }
    }

    const passRate = eligibleCount > 0 ? passCount / eligibleCount : 0;

    // Compute aggregate from all trades
    let equity = 1.0;
    let peak = 0;
    let maxDD = 0;
    for (const t of allTrades) {
      equity *= 1 + t.pnlPercent;
      if (equity > peak) peak = equity;
      if (peak > 0) {
        const dd = (peak - equity) / peak;
        if (dd > maxDD) maxDD = dd;
      }
    }
    const totalPnl = equity - 1;

    // Sharpe from per-trade returns
    const returns = allTrades.map((t) => t.pnlPercent);
    const mean = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
    const variance = returns.length > 1
      ? returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length
      : 0;
    const std = Math.sqrt(variance);
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

    const winRate = allTrades.length > 0
      ? allTrades.filter((t) => t.pnlPercent > 0).length / allTrades.length
      : 0;

    return { passRate, sharpe, totalPnl, trades: allTrades.length, maxDD, winRate };
  } finally {
    // Restore original
    (F2F_FIXED_PARAMS as Record<string, number>)[paramKey] = original!;
  }
}

// ============================================
// Main
// ============================================

function main(): void {
  const opts = parseArgs();

  if (!fs.existsSync(opts.dataPath)) {
    console.error(`Data file not found: ${opts.dataPath}`);
    process.exit(1);
  }

  const candles: Candle[] = JSON.parse(fs.readFileSync(opts.dataPath, 'utf-8'));
  const config: F2FWalkForwardConfig = { ...F2F_DEFAULT_WF_CONFIG };

  const sweeps = opts.paramFilter
    ? SWEEP_DEFS.filter((s) => s.key === opts.paramFilter)
    : SWEEP_DEFS;

  if (sweeps.length === 0) {
    console.error(`Unknown param: ${opts.paramFilter}`);
    console.error(`Available: ${SWEEP_DEFS.map((s) => s.key).join(', ')}`);
    process.exit(1);
  }

  const totalExperiments = sweeps.reduce((s, sw) => s + sw.values.length, 0);
  console.log(`=== F2F Parameter Sensitivity Sweep ===\n`);
  console.log(`  Params to sweep: ${sweeps.length}`);
  console.log(`  Total experiments: ${totalExperiments}`);
  console.log(`  Regime filter: ${opts.regimeFilter}\n`);

  const allResults: SweepResult[] = [];
  const startTime = Date.now();
  let experimentsDone = 0;

  for (const sweep of sweeps) {
    console.log(`--- ${sweep.name} (paper=${sweep.paperValue}) ---`);

    const results: SweepResult[] = [];

    for (const value of sweep.values) {
      experimentsDone++;
      const metrics = runWithOverride(candles, config, sweep.key, value, opts.friction, opts.regimeFilter);
      const isPaper = value === sweep.paperValue;

      const result: SweepResult = {
        param: sweep.key,
        value,
        isPaperDefault: isPaper,
        passRate: metrics.passRate,
        sharpe: metrics.sharpe,
        totalPnl: metrics.totalPnl,
        trades: metrics.trades,
        maxDD: metrics.maxDD,
        winRate: metrics.winRate,
      };
      results.push(result);
      allResults.push(result);

      const marker = isPaper ? ' ★' : '';
      console.log(
        `  ${value.toString().padStart(6)} → WF=${(metrics.passRate * 100).toFixed(1).padStart(5)}% ` +
        `Sharpe=${metrics.sharpe.toFixed(2).padStart(6)} ` +
        `PnL=${(metrics.totalPnl * 100).toFixed(0).padStart(5)}% ` +
        `DD=${(metrics.maxDD * 100).toFixed(1).padStart(5)}% ` +
        `trades=${metrics.trades.toString().padStart(5)}${marker}` +
        ` [${experimentsDone}/${totalExperiments}]`
      );
    }

    // Find best value for this param
    const bestByWF = [...results].sort((a, b) => b.passRate - a.passRate)[0]!;
    const paperResult = results.find((r) => r.isPaperDefault);
    const wfDelta = paperResult
      ? ((bestByWF.passRate - paperResult.passRate) * 100).toFixed(1)
      : 'N/A';

    console.log(
      `  Best: ${bestByWF.value} (WF=${(bestByWF.passRate * 100).toFixed(1)}%, ` +
      `Δ vs paper: ${wfDelta}pp)\n`
    );
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nRuntime: ${elapsed}s (${totalExperiments} experiments)`);

  // Summary: which params improved WF by >3pp?
  console.log('\n=== Improvement Summary ===\n');
  for (const sweep of sweeps) {
    const results = allResults.filter((r) => r.param === sweep.key);
    const paperResult = results.find((r) => r.isPaperDefault);
    if (!paperResult) continue;

    const improvements = results.filter((r) => r.passRate > paperResult.passRate + 0.03);
    if (improvements.length > 0) {
      const best = improvements.sort((a, b) => b.passRate - a.passRate)[0]!;
      console.log(
        `  ✓ ${sweep.name}: ${sweep.paperValue} → ${best.value} ` +
        `(+${((best.passRate - paperResult.passRate) * 100).toFixed(1)}pp WF, ` +
        `Sharpe ${paperResult.sharpe.toFixed(2)} → ${best.sharpe.toFixed(2)})`
      );
    } else {
      console.log(`  · ${sweep.name}: paper default is optimal (no >3pp improvement)`);
    }
  }

  if (opts.save) {
    const outPath = path.resolve(__dirname, '..', 'experiments', 'f2f-param-sweep-results.json');
    fs.writeFileSync(outPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      regimeFilter: opts.regimeFilter,
      friction: opts.friction,
      results: allResults,
    }, null, 2));
    console.log(`\nResults saved to ${outPath}`);
  }
}

main();
