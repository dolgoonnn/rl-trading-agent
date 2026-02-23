#!/usr/bin/env npx tsx
/**
 * Monthly Walk-Forward Reoptimization
 *
 * Runs CMA-ES on the trailing 3-month window of data and compares
 * new params to the current live config. Flags parameter drift for
 * human review. Does NOT auto-deploy — outputs a report.
 *
 * This is a production maintenance tool, not a trading script.
 *
 * Usage:
 *   npx tsx scripts/reoptimize-monthly.ts
 *   npx tsx scripts/reoptimize-monthly.ts --generations 20 --pop 12
 *   npx tsx scripts/reoptimize-monthly.ts --dry-run   # Compare only, no optimization
 */

import fs from 'fs';
import { execSync } from 'child_process';
import { RUN18_STRATEGY_CONFIG } from '../src/lib/bot/config';

// ============================================
// Configuration
// ============================================

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const TRAILING_MONTHS = 3;
const DRIFT_THRESHOLD = 0.05; // 5% relative drift flags for review
const DEFAULT_GENERATIONS = 20;
const DEFAULT_POP_SIZE = 12;
const DEFAULT_PARALLEL = 4;

interface ReoptResult {
  timestamp: string;
  trailingWindow: { startDate: string; endDate: string };
  currentConfig: ParamSnapshot;
  currentPerformance: BacktestSummary | null;
  newConfig: ParamSnapshot | null;
  newPerformance: BacktestSummary | null;
  driftReport: DriftItem[];
  recommendation: 'keep' | 'review' | 'update';
}

interface ParamSnapshot {
  baseThreshold: number;
  obHalfLife: number;
  atrExtensionBands: number;
  maxBars: number;
  cooldownBars: number;
  partialTP: { fraction: number; triggerR: number; beBuffer: number };
  weights: Record<string, number>;
  regimeThresholds: Record<string, number>;
}

interface BacktestSummary {
  passRate: number;
  totalTrades: number;
  winRate: number;
  pnl: number;
  sharpe: number;
  maxDD: number;
}

interface DriftItem {
  param: string;
  current: number;
  new: number;
  driftPct: number;
  flagged: boolean;
}

// ============================================
// CLI Parsing
// ============================================

function parseArgs(): {
  generations: number;
  popSize: number;
  parallel: number;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  let generations = DEFAULT_GENERATIONS;
  let popSize = DEFAULT_POP_SIZE;
  let parallel = DEFAULT_PARALLEL;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--generations': generations = parseInt(args[++i]!, 10); break;
      case '--pop': popSize = parseInt(args[++i]!, 10); break;
      case '--parallel': parallel = parseInt(args[++i]!, 10); break;
      case '--dry-run': dryRun = true; break;
    }
  }

  return { generations, popSize, parallel, dryRun };
}

// ============================================
// Backtest Runner
// ============================================

function buildBacktestArgs(config: ParamSnapshot): string {
  const weightStr = Object.entries(config.weights)
    .map(([k, v]) => `${k}:${v.toFixed(3)}`)
    .join(',');

  const regimeStr = Object.entries(config.regimeThresholds)
    .map(([k, v]) => `${k}:${v.toFixed(2)}`)
    .join(',');

  return [
    '--strategy ob',
    '--sl-mode dynamic_rr',
    `--friction ${RUN18_STRATEGY_CONFIG.frictionPerSide}`,
    '--suppress-regime "ranging+normal,ranging+high,downtrend+high"',
    `--threshold ${config.baseThreshold.toFixed(3)}`,
    '--exit-mode simple',
    `--partial-tp "${config.partialTP.fraction.toFixed(2)},${config.partialTP.triggerR.toFixed(2)},${config.partialTP.beBuffer.toFixed(2)}"`,
    `--atr-extension ${config.atrExtensionBands.toFixed(2)}`,
    `--ob-half-life ${config.obHalfLife}`,
    `--max-bars ${config.maxBars}`,
    `--cooldown-bars ${config.cooldownBars}`,
    `--symbols ${SYMBOLS.join(',')}`,
    `--regime-threshold "${regimeStr}"`,
    `--weights "${weightStr}"`,
    '--json',
  ].join(' ');
}

function runBacktest(config: ParamSnapshot): BacktestSummary | null {
  const args = buildBacktestArgs(config);
  try {
    const output = execSync(
      `npx tsx scripts/backtest-confluence.ts ${args}`,
      { encoding: 'utf-8', timeout: 120_000, maxBuffer: 50 * 1024 * 1024 },
    );

    // Parse JSON output (last line or full output)
    const lines = output.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]!) as Record<string, number>;
        return {
          passRate: parsed.passRate ?? 0,
          totalTrades: parsed.totalTrades ?? 0,
          winRate: parsed.winRate ?? 0,
          pnl: parsed.pnl ?? 0,
          sharpe: parsed.sharpe ?? 0,
          maxDD: parsed.maxDD ?? 0,
        };
      } catch {
        continue;
      }
    }
    return null;
  } catch (err) {
    console.error('Backtest failed:', (err as Error).message);
    return null;
  }
}

// ============================================
// Drift Analysis
// ============================================

function computeDrift(current: ParamSnapshot, newParams: ParamSnapshot): DriftItem[] {
  const items: DriftItem[] = [];

  const compare = (name: string, curr: number, next: number) => {
    const denom = Math.abs(curr) || 1;
    const driftPct = Math.abs(next - curr) / denom;
    items.push({
      param: name,
      current: curr,
      new: next,
      driftPct,
      flagged: driftPct > DRIFT_THRESHOLD,
    });
  };

  compare('baseThreshold', current.baseThreshold, newParams.baseThreshold);
  compare('obHalfLife', current.obHalfLife, newParams.obHalfLife);
  compare('atrExtensionBands', current.atrExtensionBands, newParams.atrExtensionBands);
  compare('maxBars', current.maxBars, newParams.maxBars);
  compare('cooldownBars', current.cooldownBars, newParams.cooldownBars);
  compare('partialTP.fraction', current.partialTP.fraction, newParams.partialTP.fraction);
  compare('partialTP.triggerR', current.partialTP.triggerR, newParams.partialTP.triggerR);

  for (const [key, val] of Object.entries(current.weights)) {
    compare(`weight.${key}`, val, newParams.weights[key] ?? val);
  }

  for (const [key, val] of Object.entries(current.regimeThresholds)) {
    compare(`regime.${key}`, val, newParams.regimeThresholds[key] ?? val);
  }

  return items;
}

function snapshotFromConfig(): ParamSnapshot {
  return {
    baseThreshold: RUN18_STRATEGY_CONFIG.baseThreshold,
    obHalfLife: RUN18_STRATEGY_CONFIG.obHalfLife,
    atrExtensionBands: RUN18_STRATEGY_CONFIG.atrExtensionBands,
    maxBars: RUN18_STRATEGY_CONFIG.maxBars,
    cooldownBars: RUN18_STRATEGY_CONFIG.cooldownBars,
    partialTP: { ...RUN18_STRATEGY_CONFIG.partialTP },
    weights: { ...RUN18_STRATEGY_CONFIG.weights },
    regimeThresholds: { ...RUN18_STRATEGY_CONFIG.regimeThresholds },
  };
}

// ============================================
// CMA-ES Runner (delegates to train-cmaes-production.ts)
// ============================================

function runCmaesOptimization(
  generations: number,
  popSize: number,
  parallel: number,
): ParamSnapshot | null {
  console.log(`\nRunning CMA-ES optimization: ${generations} generations, pop ${popSize}, ${parallel} parallel...`);

  try {
    const output = execSync(
      `npx tsx scripts/train-cmaes-production.ts --generations ${generations} --pop ${popSize} --parallel ${parallel} --json-output`,
      { encoding: 'utf-8', timeout: 3_600_000, maxBuffer: 100 * 1024 * 1024 },
    );

    // Parse the JSON output for best params
    const lines = output.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]!);
        if (parsed.bestParams) {
          return parsed.bestParams as ParamSnapshot;
        }
      } catch {
        continue;
      }
    }

    console.warn('CMA-ES completed but no params found in output');
    return null;
  } catch (err) {
    console.error('CMA-ES optimization failed:', (err as Error).message);
    return null;
  }
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
  const { generations, popSize, parallel, dryRun } = parseArgs();

  console.log('='.repeat(60));
  console.log('Monthly Reoptimization Check');
  console.log('='.repeat(60));

  const now = new Date();
  const startDate = new Date(now);
  startDate.setMonth(startDate.getMonth() - TRAILING_MONTHS);

  console.log(`Window: ${startDate.toISOString().slice(0, 10)} → ${now.toISOString().slice(0, 10)}`);
  console.log(`Symbols: ${SYMBOLS.join(', ')}`);

  // 1. Snapshot current config
  const currentConfig = snapshotFromConfig();

  // 2. Run current config on trailing window
  console.log('\n--- Current Config Performance ---');
  const currentPerf = runBacktest(currentConfig);
  if (currentPerf) {
    console.log(`  Pass rate: ${(currentPerf.passRate * 100).toFixed(1)}%`);
    console.log(`  Trades: ${currentPerf.totalTrades}`);
    console.log(`  Win rate: ${(currentPerf.winRate * 100).toFixed(1)}%`);
    console.log(`  PnL: ${(currentPerf.pnl * 100).toFixed(1)}%`);
    console.log(`  Sharpe: ${currentPerf.sharpe.toFixed(2)}`);
    console.log(`  Max DD: ${(currentPerf.maxDD * 100).toFixed(1)}%`);
  } else {
    console.log('  Backtest failed for current config');
  }

  // 3. Run CMA-ES optimization (unless dry-run)
  let newConfig: ParamSnapshot | null = null;
  let newPerf: BacktestSummary | null = null;

  if (!dryRun) {
    newConfig = runCmaesOptimization(generations, popSize, parallel);
    if (newConfig) {
      console.log('\n--- New Config Performance ---');
      newPerf = runBacktest(newConfig);
      if (newPerf) {
        console.log(`  Pass rate: ${(newPerf.passRate * 100).toFixed(1)}%`);
        console.log(`  Trades: ${newPerf.totalTrades}`);
        console.log(`  Win rate: ${(newPerf.winRate * 100).toFixed(1)}%`);
        console.log(`  PnL: ${(newPerf.pnl * 100).toFixed(1)}%`);
        console.log(`  Sharpe: ${newPerf.sharpe.toFixed(2)}`);
        console.log(`  Max DD: ${(newPerf.maxDD * 100).toFixed(1)}%`);
      }
    }
  } else {
    console.log('\n[Dry run — skipping CMA-ES optimization]');
  }

  // 4. Compute drift
  const driftReport = newConfig ? computeDrift(currentConfig, newConfig) : [];
  const flaggedParams = driftReport.filter((d) => d.flagged);

  // 5. Determine recommendation
  let recommendation: 'keep' | 'review' | 'update' = 'keep';
  if (newPerf && currentPerf) {
    const perfImproved = newPerf.passRate > currentPerf.passRate + 0.02; // >2pp improvement
    if (flaggedParams.length > 3 || flaggedParams.some((d) => d.driftPct > 0.20)) {
      recommendation = 'review'; // Large drift — needs human review
    } else if (perfImproved && flaggedParams.length <= 3) {
      recommendation = 'update'; // Small drift + improvement → safe to update
    }
  }

  // 6. Print report
  console.log('\n' + '='.repeat(60));
  console.log('DRIFT REPORT');
  console.log('='.repeat(60));

  if (driftReport.length > 0) {
    console.log('\nFlagged params (drift > 5%):');
    for (const d of flaggedParams) {
      console.log(`  ${d.param}: ${d.current.toFixed(3)} → ${d.new.toFixed(3)} (${(d.driftPct * 100).toFixed(1)}%)`);
    }
    if (flaggedParams.length === 0) {
      console.log('  None — parameters are stable');
    }
  }

  console.log(`\nRecommendation: ${recommendation.toUpperCase()}`);
  switch (recommendation) {
    case 'keep':
      console.log('  Current config is performing well. No changes needed.');
      break;
    case 'review':
      console.log('  Significant parameter drift detected. Review new config manually.');
      break;
    case 'update':
      console.log('  Small drift with performance improvement. Safe to update config.');
      break;
  }

  // 7. Save result
  const result: ReoptResult = {
    timestamp: now.toISOString(),
    trailingWindow: {
      startDate: startDate.toISOString().slice(0, 10),
      endDate: now.toISOString().slice(0, 10),
    },
    currentConfig,
    currentPerformance: currentPerf,
    newConfig,
    newPerformance: newPerf,
    driftReport,
    recommendation,
  };

  const outPath = `experiments/reoptimize-${now.toISOString().slice(0, 10)}.json`;
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nResults saved to ${outPath}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
