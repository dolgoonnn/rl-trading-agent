#!/usr/bin/env npx tsx
/**
 * CMA-ES Production-Matched Optimizer
 *
 * Uses the ACTUAL production backtest (backtest-confluence.ts --json) as the fitness
 * function. This eliminates any simulation mismatch between the optimizer and production.
 *
 * Optimizes:
 * - 10 confluence weight multipliers
 * - 5 regime-specific threshold overrides
 * - Base threshold
 * - OB freshness half-life
 * - ATR extension bands
 *
 * Total: 18 dimensions
 *
 * Usage:
 *   npx tsx scripts/train-cmaes-production.ts
 *   npx tsx scripts/train-cmaes-production.ts --generations 30 --pop 16 --parallel 4
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { CMAES } from '../src/lib/rl/utils/cma-es';
import {
  type ConfluenceWeights,
  DEFAULT_WEIGHTS,
} from '../src/lib/rl/strategies/confluence-scorer';

// ============================================
// Parameter Specification
// ============================================

interface ParamSpec {
  name: string;
  min: number;
  max: number;
  initial: number;
  type: 'weight_mult' | 'threshold' | 'hyperparameter';
}

const WEIGHT_NAMES: (keyof ConfluenceWeights)[] = [
  'structureAlignment', 'killZoneActive', 'liquiditySweep',
  'obProximity', 'fvgAtCE', 'recentBOS', 'rrRatio',
  'oteZone', 'obFvgConfluence', 'momentumConfirmation',
];

const REGIME_LABELS = [
  'uptrend+high', 'uptrend+normal', 'uptrend+low',
  'downtrend+normal', 'downtrend+low',
];

function buildParamSpecs(): ParamSpec[] {
  const specs: ParamSpec[] = [];

  // 10 weight multipliers [0, 3]
  for (const name of WEIGHT_NAMES) {
    specs.push({
      name: `w_${name}`,
      min: 0.0,
      max: 3.0,
      initial: 1.0,
      type: 'weight_mult',
    });
  }

  // 5 regime threshold overrides [2.5, 6.5]
  const regimeDefaults: Record<string, number> = {
    'uptrend+high': 3.5,
    'uptrend+normal': 5.0,
    'uptrend+low': 3.5,
    'downtrend+normal': 4.5,
    'downtrend+low': 5.0,
  };
  for (const label of REGIME_LABELS) {
    specs.push({
      name: `t_${label}`,
      min: 2.5,
      max: 6.5,
      initial: regimeDefaults[label] ?? 4.15,
      type: 'threshold',
    });
  }

  // Base threshold [3.0, 5.5]
  specs.push({
    name: 'baseThreshold',
    min: 3.0,
    max: 5.5,
    initial: 4.15,
    type: 'hyperparameter',
  });

  // OB freshness half-life [5, 30]
  specs.push({
    name: 'obFreshnessHalfLife',
    min: 5,
    max: 30,
    initial: 15,
    type: 'hyperparameter',
  });

  // ATR extension bands [1.5, 5.0]
  specs.push({
    name: 'atrExtensionBands',
    min: 1.5,
    max: 5.0,
    initial: 3.0,
    type: 'hyperparameter',
  });

  // Partial TP fraction [0.2, 0.7]
  specs.push({
    name: 'partialFraction',
    min: 0.2,
    max: 0.7,
    initial: 0.45,
    type: 'hyperparameter',
  });

  // Partial TP trigger R [0.5, 1.5]
  specs.push({
    name: 'partialTriggerR',
    min: 0.5,
    max: 1.5,
    initial: 0.85,
    type: 'hyperparameter',
  });

  // Partial TP breakeven buffer [0.0, 0.3]
  specs.push({
    name: 'partialBeBuffer',
    min: 0.0,
    max: 0.3,
    initial: 0.1,
    type: 'hyperparameter',
  });

  // Max position holding bars [50, 150]
  specs.push({
    name: 'maxBars',
    min: 50,
    max: 150,
    initial: 100,
    type: 'hyperparameter',
  });

  // Cooldown bars between trades [2, 12]
  specs.push({
    name: 'cooldownBars',
    min: 2,
    max: 12,
    initial: 6,
    type: 'hyperparameter',
  });

  return specs;
}

// ============================================
// Decoding
// ============================================

interface DecodedParams {
  weightMultipliers: Partial<ConfluenceWeights>;
  regimeThresholds: Record<string, number>;
  baseThreshold: number;
  obFreshnessHalfLife: number;
  atrExtensionBands: number;
  partialFraction: number;
  partialTriggerR: number;
  partialBeBuffer: number;
  maxBars: number;
  cooldownBars: number;
}

function decodeParams(params: number[], specs: ParamSpec[]): DecodedParams {
  const weightMultipliers: Partial<ConfluenceWeights> = {};
  const regimeThresholds: Record<string, number> = {};
  let baseThreshold = 4.15;
  let obFreshnessHalfLife = 15;
  let atrExtensionBands = 3.0;
  let partialFraction = 0.45;
  let partialTriggerR = 0.85;
  let partialBeBuffer = 0.1;
  let maxBars = 100;
  let cooldownBars = 6;

  for (let i = 0; i < specs.length && i < params.length; i++) {
    const spec = specs[i]!;
    const val = params[i]!;

    if (spec.type === 'weight_mult') {
      const wName = spec.name.replace('w_', '') as keyof ConfluenceWeights;
      weightMultipliers[wName] = DEFAULT_WEIGHTS[wName] * val;
    } else if (spec.type === 'threshold') {
      const rLabel = spec.name.replace('t_', '');
      regimeThresholds[rLabel] = val;
    } else if (spec.name === 'baseThreshold') {
      baseThreshold = val;
    } else if (spec.name === 'obFreshnessHalfLife') {
      obFreshnessHalfLife = Math.round(val);
    } else if (spec.name === 'atrExtensionBands') {
      atrExtensionBands = val;
    } else if (spec.name === 'partialFraction') {
      partialFraction = val;
    } else if (spec.name === 'partialTriggerR') {
      partialTriggerR = val;
    } else if (spec.name === 'partialBeBuffer') {
      partialBeBuffer = val;
    } else if (spec.name === 'maxBars') {
      maxBars = Math.round(val);
    } else if (spec.name === 'cooldownBars') {
      cooldownBars = Math.round(val);
    }
  }

  return {
    weightMultipliers, regimeThresholds, baseThreshold,
    obFreshnessHalfLife, atrExtensionBands,
    partialFraction, partialTriggerR, partialBeBuffer,
    maxBars, cooldownBars,
  };
}

// ============================================
// Production Backtest via Subprocess
// ============================================

interface BacktestResult {
  passRate: number;
  totalTrades: number;
  winRate: number;
  pnl: number;
}

function buildCLIArgs(decoded: DecodedParams, symbols?: string | null): string[] {
  const args: string[] = [
    '--strategy', 'ob',
    '--sl-mode', 'dynamic_rr',
    '--friction', '0.0007',
    '--suppress-regime', 'ranging+normal,ranging+high,downtrend+high',
    '--threshold', decoded.baseThreshold.toFixed(3),
    '--exit-mode', 'simple',
    '--partial-tp', `${decoded.partialFraction.toFixed(2)},${decoded.partialTriggerR.toFixed(2)},${decoded.partialBeBuffer.toFixed(2)}`,
    '--atr-extension', decoded.atrExtensionBands.toFixed(2),
    '--ob-half-life', decoded.obFreshnessHalfLife.toString(),
    '--max-bars', decoded.maxBars.toString(),
    '--cooldown-bars', decoded.cooldownBars.toString(),
  ];

  if (symbols) {
    args.push('--symbols', symbols);
  }

  // Regime thresholds
  const rtParts: string[] = [];
  for (const [label, val] of Object.entries(decoded.regimeThresholds)) {
    rtParts.push(`${label}:${val.toFixed(2)}`);
  }
  if (rtParts.length > 0) {
    args.push('--regime-threshold', rtParts.join(','));
  }

  // Weights
  const wParts: string[] = [];
  for (const [key, val] of Object.entries(decoded.weightMultipliers)) {
    wParts.push(`${key}:${(val as number).toFixed(4)}`);
  }
  if (wParts.length > 0) {
    args.push('--weights', wParts.join(','));
  }

  return args;
}

/**
 * Parse key metrics from the text output of backtest-confluence.ts.
 * Matches lines like:
 *   [HH:MM:SS] WF pass rate:      71.3%
 *   [HH:MM:SS] Total trades:      748
 *   [HH:MM:SS] Overall win rate:  54.5%
 *   [HH:MM:SS] Overall PnL:       532.97%
 */
function parseBacktestOutput(output: string): BacktestResult | null {
  const passMatch = output.match(/WF pass rate:\s+([\d.]+)%/);
  const tradesMatch = output.match(/Total trades:\s+(\d+)/);
  const wrMatch = output.match(/Overall win rate:\s+([\d.]+)%/);
  const pnlMatch = output.match(/Overall PnL:\s+([-\d.]+)%/);

  if (!passMatch || !tradesMatch) return null;

  return {
    passRate: parseFloat(passMatch[1]!) / 100,
    totalTrades: parseInt(tradesMatch[1]!, 10),
    winRate: wrMatch ? parseFloat(wrMatch[1]!) : 0,
    pnl: pnlMatch ? parseFloat(pnlMatch[1]!) / 100 : 0,
  };
}

function runProductionBacktest(decoded: DecodedParams, symbols?: string | null): BacktestResult | null {
  const args = buildCLIArgs(decoded, symbols);
  // Write output to temp file to avoid 8KB stdout truncation when exit code ≠ 0.
  // With 10 symbols the text output easily exceeds the execSync pipe buffer.
  const tmpFile = path.join(os.tmpdir(), `cmaes-bt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  const cmd = `npx tsx scripts/backtest-confluence.ts ${args.map(a => `"${a}"`).join(' ')} > "${tmpFile}" 2>&1`;

  try {
    try {
      execSync(cmd, {
        cwd: path.resolve(__dirname, '..'),
        shell: true,
        timeout: 300_000,
      });
    } catch {
      // backtest-confluence.ts exits with code 1 when pass rate < 75%
      // but still writes full output to tmpFile
    }

    if (!fs.existsSync(tmpFile)) return null;

    const output = fs.readFileSync(tmpFile, 'utf-8');
    fs.unlinkSync(tmpFile);
    return parseBacktestOutput(output);
  } catch {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    return null;
  }
}

// ============================================
// Fitness Function
// ============================================

function computeFitness(result: BacktestResult, symbolCount: number): number {
  const passRate = result.passRate * 100;
  const trades = result.totalTrades;
  const winRate = result.winRate;
  const pnl = result.pnl * 100;

  // Primary: pass rate (×10 for dominance)
  let fitness = passRate * 10;

  // PnL component (capped, logarithmic for large values)
  if (pnl > 0) {
    fitness += Math.min(pnl, 200) + Math.log1p(Math.max(0, pnl - 200)) * 10;
  } else {
    fitness += pnl * 0.5;
  }

  // Win rate bonus
  if (winRate > 50) {
    fitness += (winRate - 50) * 2;
  }

  // Trade count: scale thresholds by symbol count (~67 min trades per symbol)
  const minTrades = Math.round(67 * symbolCount);
  const bonusTrades = Math.round(133 * symbolCount);
  if (trades < minTrades) {
    fitness -= (minTrades - trades) * 0.5;
  } else if (trades >= bonusTrades) {
    fitness += Math.min((trades - bonusTrades) * 0.02, 10);
  }

  return fitness;
}

// ============================================
// CLI
// ============================================

interface CLIConfig {
  generations: number;
  populationSize: number;
  sigma: number;
  warmStart: string | null;
  output: string | null;
  symbols: string | null;
}

function parseCLI(): CLIConfig {
  const args = process.argv.slice(2);
  const config: CLIConfig = {
    generations: 30,
    populationSize: 16,
    sigma: 0.2,
    warmStart: null,
    output: null,
    symbols: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--generations': case '-g':
        config.generations = parseInt(args[++i] ?? '30');
        break;
      case '--pop':
        config.populationSize = parseInt(args[++i] ?? '16');
        break;
      case '--sigma':
        config.sigma = parseFloat(args[++i] ?? '0.2');
        break;
      case '--warm-start':
        config.warmStart = args[++i] ?? null;
        break;
      case '--output': case '-o':
        config.output = args[++i] ?? null;
        break;
      case '--symbols':
        config.symbols = args[++i] ?? null;
        break;
    }
  }

  return config;
}

// ============================================
// Main
// ============================================

async function main() {
  const config = parseCLI();
  const specs = buildParamSpecs();
  const dims = specs.length;

  const log = (msg: string) => console.log(`[${new Date().toLocaleTimeString('en-US', { hour12: false })}] ${msg}`);

  log('============================================================');
  log('CMA-ES Production-Matched Optimizer');
  log('============================================================');
  log(`Dimensions: ${dims}`);
  log(`  Weights: ${WEIGHT_NAMES.length}`);
  log(`  Regime thresholds: ${REGIME_LABELS.length}`);
  log(`  Hyperparameters: 3 (baseThreshold, obFreshnessHalfLife, atrExtensionBands)`);
  log(`Population: ${config.populationSize}`);
  log(`Generations: ${config.generations}`);
  log(`Sigma: ${config.sigma}`);
  log(`Warm start: ${config.warmStart ?? 'none'}`);
  log(`Output: ${config.output ?? 'cmaes_production.json'}`);
  log(`Symbols: ${config.symbols ?? 'default (BTCUSDT,ETHUSDT,SOLUSDT)'}`);
  log('');

  const symbolCount = config.symbols ? config.symbols.split(',').length : 3;

  // Load warm-start params if specified
  let initialMean: number[] | undefined;
  if (config.warmStart) {
    const wsPath = path.resolve(config.warmStart);
    if (fs.existsSync(wsPath)) {
      const wsData = JSON.parse(fs.readFileSync(wsPath, 'utf-8'));
      if (wsData.bestParams) {
        const wsParams = wsData.bestParams as number[];
        if (wsParams.length === dims) {
          initialMean = wsParams;
          log(`Loaded warm-start from ${config.warmStart} (fitness=${wsData.fitness?.toFixed(1)}, ${dims}d)`);
        } else if (wsParams.length < dims) {
          // Extend with defaults for new params
          initialMean = [...wsParams, ...specs.slice(wsParams.length).map(s => s.initial)];
          log(`Loaded warm-start from ${config.warmStart} (${wsParams.length}d → ${dims}d, extended with defaults)`);
        } else {
          // Truncate extra params
          initialMean = wsParams.slice(0, dims);
          log(`Loaded warm-start from ${config.warmStart} (${wsParams.length}d → ${dims}d, truncated)`);
        }
      }
    }
  }

  // Normalization: CMA-ES operates in [0,1] space for uniform exploration
  const rawBounds = specs.map(s => [s.min, s.max] as [number, number]);
  const ranges = rawBounds.map(([lo, hi]) => hi - lo);
  const normalize = (raw: number[]): number[] =>
    raw.map((v, i) => (v - rawBounds[i]![0]) / ranges[i]!);
  const denormalize = (norm: number[]): number[] =>
    norm.map((v, i) => v * ranges[i]! + rawBounds[i]![0]);

  // Normalize initial mean and warm-start
  const rawMean = initialMean ?? specs.map(s => s.initial);
  const normMean = normalize(rawMean);

  const cmaes = new CMAES({
    dim: dims,
    populationSize: config.populationSize,
    initialMean: normMean,
    initialSigma: config.sigma,
    lowerBounds: new Array(dims).fill(0),
    upperBounds: new Array(dims).fill(1),
    maxGenerations: config.generations,
  });

  // Evaluate baseline (production defaults)
  log('--- Evaluating Baseline ---');
  const baselineDecoded: DecodedParams = {
    weightMultipliers: {},
    regimeThresholds: {
      'uptrend+high': 3.5,
      'uptrend+normal': 5.0,
      'uptrend+low': 3.5,
      'downtrend+normal': 4.5,
      'downtrend+low': 5.0,
    },
    baseThreshold: 4.15,
    obFreshnessHalfLife: 15,
    atrExtensionBands: 3.0,
    partialFraction: 0.45,
    partialTriggerR: 0.85,
    partialBeBuffer: 0.1,
    maxBars: 100,
    cooldownBars: 6,
  };
  const baselineResult = runProductionBacktest(baselineDecoded, config.symbols);
  const baselineFitness = baselineResult ? computeFitness(baselineResult, symbolCount) : 0;
  log(`Baseline: fitness=${baselineFitness.toFixed(1)}, passRate=${(baselineResult?.passRate ?? 0) * 100 | 0}%, trades=${baselineResult?.totalTrades ?? 0}, PnL=${((baselineResult?.pnl ?? 0) * 100).toFixed(1)}%`);
  log('');

  // CMA-ES optimization loop
  log('--- CMA-ES Optimization ---');
  let allTimeBestFitness = -Infinity;
  let allTimeBestParams: number[] | null = null;
  let allTimeBestGen = -1;

  const history: {
    generation: number;
    meanFitness: number;
    bestFitness: number;
    sigma: number;
  }[] = [];

  for (let gen = 0; gen < config.generations; gen++) {
    const population = cmaes.samplePopulation();
    const fitnesses: number[] = [];

    for (let ci = 0; ci < population.length; ci++) {
      const candidate = population[ci]!;

      // Debug: check for NaN in candidate params
      const nanIdx = candidate.findIndex(v => isNaN(v));
      if (nanIdx >= 0) {
        log(`  WARNING: NaN at param[${nanIdx}] (${specs[nanIdx]?.name})`);
        fitnesses.push(0);
        process.stdout.write('x');
        continue;
      }

      const rawCandidate = denormalize(candidate);
      const decoded = decodeParams(rawCandidate, specs);
      const result = runProductionBacktest(decoded, config.symbols);

      if (result) {
        const fitness = computeFitness(result, symbolCount);
        fitnesses.push(fitness);
        const improved = fitness > allTimeBestFitness;
        process.stdout.write(improved ? '+' : '.');

        // Debug first candidate of first gen
        if (gen === 0 && ci === 0) {
          log(`  C0 detail: pass=${(result.passRate*100).toFixed(1)}%, trades=${result.totalTrades}, WR=${result.winRate.toFixed(1)}%, PnL=${(result.pnl*100).toFixed(1)}%, fit=${fitness.toFixed(1)}`);
          log(`  C0 threshold=${decoded.baseThreshold.toFixed(2)}, atrExt=${decoded.atrExtensionBands.toFixed(2)}`);
        }
      } else {
        fitnesses.push(0);
        process.stdout.write('x');
        if (gen === 0 && ci === 0) {
          log(`  C0 FAILED: no output from subprocess`);
          const debugArgs = buildCLIArgs(decoded, config.symbols);
          log(`  CMD: npx tsx scripts/backtest-confluence.ts ${debugArgs.slice(0, 8).join(' ')} ...`);
        }
      }
    }
    process.stdout.write('\n');

    cmaes.update(population, fitnesses);

    const genBest = Math.max(...fitnesses);
    const genMean = fitnesses.reduce((a, b) => a + b, 0) / fitnesses.length;

    if (genBest > allTimeBestFitness) {
      const bestIdx = fitnesses.indexOf(genBest);
      allTimeBestFitness = genBest;
      allTimeBestParams = [...population[bestIdx]!];
      allTimeBestGen = gen;
    }

    history.push({
      generation: gen,
      meanFitness: genMean,
      bestFitness: genBest,
      sigma: config.sigma,
    });

    log(`Gen ${gen.toString().padStart(3)}: mean=${genMean.toFixed(1)}, genBest=${genBest.toFixed(1)}, allTimeBest=${allTimeBestFitness.toFixed(1)} (gen ${allTimeBestGen}), sigma=${cmaes.getSigma().toFixed(4)}`);

    // Print decoded params every 5 gens
    if (gen % 5 === 4 || gen === config.generations - 1) {
      const best = denormalize(allTimeBestParams ?? normMean);
      const d = decodeParams(best, specs);
      log(`  baseThreshold=${d.baseThreshold.toFixed(2)}, halfLife=${d.obFreshnessHalfLife}, atrExt=${d.atrExtensionBands.toFixed(1)}`);
      log(`  regimes: ${Object.entries(d.regimeThresholds).map(([k, v]) => `${k}:${v.toFixed(1)}`).join(', ')}`);
    }

    // Early stopping
    if (cmaes.shouldStop()) {
      log(`Early stop at gen ${gen} (converged)`);
      break;
    }
  }

  // Final evaluation of best params
  log('');
  log('--- Final Evaluation ---');
  const bestNormParams = allTimeBestParams ?? normMean;
  const bestParams = denormalize(bestNormParams);
  const bestDecoded = decodeParams(bestParams, specs);
  const finalResult = runProductionBacktest(bestDecoded, config.symbols);
  const finalFitness = finalResult ? computeFitness(finalResult, symbolCount) : 0;

  log('');
  log('============================================================');
  log('RESULTS: Baseline vs CMA-ES Production');
  log('============================================================');
  const fmtPct = (v: number | undefined | null) => v !== undefined && v !== null ? `${(v * 100).toFixed(1)}%` : 'N/A';
  const fmtNum = (v: number | undefined | null) => v !== undefined && v !== null ? v.toString() : 'N/A';
  log(`  Metric        | Baseline       | CMA-ES         | Delta`);
  log(`  --------------+----------------+----------------+---------`);
  log(`  Pass Rate     | ${fmtPct(baselineResult?.passRate).padStart(14)} | ${fmtPct(finalResult?.passRate).padStart(14)} | ${((((finalResult?.passRate ?? 0) - (baselineResult?.passRate ?? 0)) * 100)).toFixed(1).padStart(5)}pp`);
  log(`  Trades        | ${fmtNum(baselineResult?.totalTrades).padStart(14)} | ${fmtNum(finalResult?.totalTrades).padStart(14)} | ${((finalResult?.totalTrades ?? 0) - (baselineResult?.totalTrades ?? 0)).toString().padStart(7)}`);
  log(`  Win Rate      | ${fmtPct(baselineResult ? baselineResult.winRate / 100 : null).padStart(14)} | ${fmtPct(finalResult ? finalResult.winRate / 100 : null).padStart(14)} | ${(((finalResult?.winRate ?? 0) - (baselineResult?.winRate ?? 0))).toFixed(1).padStart(5)}pp`);
  log(`  Total PnL     | ${fmtPct(baselineResult?.pnl).padStart(14)} | ${fmtPct(finalResult?.pnl).padStart(14)} | ${(((finalResult?.pnl ?? 0) - (baselineResult?.pnl ?? 0)) * 100).toFixed(1).padStart(5)}pp`);
  log(`  Fitness       | ${baselineFitness.toFixed(1).padStart(14)} | ${finalFitness.toFixed(1).padStart(14)} | ${(finalFitness - baselineFitness).toFixed(1).padStart(7)}`);
  const verdict = finalFitness > baselineFitness ? 'CMA-ES WINS' : 'BASELINE WINS';
  log(`  VERDICT: ${verdict}`);
  log('============================================================');

  // Print optimized params
  log('');
  log('Optimized weight multipliers:');
  for (const wName of WEIGHT_NAMES) {
    const val = bestDecoded.weightMultipliers[wName];
    const mult = val !== undefined ? val / DEFAULT_WEIGHTS[wName] : 1.0;
    log(`  ${wName.padEnd(25)} = ${(val ?? DEFAULT_WEIGHTS[wName]).toFixed(3)} (${mult.toFixed(2)}x)`);
  }

  log('');
  log('Optimized regime thresholds:');
  log(`  Base: ${bestDecoded.baseThreshold.toFixed(2)}`);
  for (const label of REGIME_LABELS) {
    const val = bestDecoded.regimeThresholds[label] ?? bestDecoded.baseThreshold;
    log(`  ${label.padEnd(25)} = ${val.toFixed(2)}`);
  }
  log(`  OB freshness half-life: ${bestDecoded.obFreshnessHalfLife}`);
  log(`  ATR extension bands: ${bestDecoded.atrExtensionBands.toFixed(2)}`);
  log(`  Partial TP: ${(bestDecoded.partialFraction * 100).toFixed(0)}% @ ${bestDecoded.partialTriggerR.toFixed(2)}R, BE buffer ${bestDecoded.partialBeBuffer.toFixed(2)}`);
  log(`  Max bars: ${bestDecoded.maxBars}, Cooldown bars: ${bestDecoded.cooldownBars}`);

  // Print per-symbol breakdown from final result
  if (finalResult) {
    log('');
    log('Per-symbol breakdown (from final eval):');
    log(`  Total: passRate=${fmtPct(finalResult.passRate)}, trades=${finalResult.totalTrades}, PnL=${fmtPct(finalResult.pnl)}`);
  }

  // Print CLI command to reproduce
  log('');
  log('Reproduce with:');
  const cliArgs = buildCLIArgs(bestDecoded, config.symbols);
  log(`  npx tsx scripts/backtest-confluence.ts ${cliArgs.filter(a => a !== '--json').join(' ')}`);

  // Save model
  const outputFile = config.output ?? 'cmaes_production.json';
  const modelPath = path.resolve(__dirname, '..', 'models', outputFile);
  const modelDir = path.dirname(modelPath);
  if (!fs.existsSync(modelDir)) {
    fs.mkdirSync(modelDir, { recursive: true });
  }

  fs.writeFileSync(modelPath, JSON.stringify({
    specs: specs.map(s => s.name),
    bestParams,
    decoded: bestDecoded,
    fitness: allTimeBestFitness,
    baselineFitness,
    generation: allTimeBestGen,
    symbols: config.symbols ?? 'BTCUSDT,ETHUSDT,SOLUSDT',
    config: {
      generations: config.generations,
      populationSize: config.populationSize,
      sigma: config.sigma,
      warmStart: config.warmStart,
    },
    history,
    baselineResult,
    finalResult,
  }, null, 2));

  log('');
  log(`Model saved to ${modelPath}`);
}

main().catch(console.error);
