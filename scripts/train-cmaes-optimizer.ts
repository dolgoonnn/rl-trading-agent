#!/usr/bin/env npx tsx
/**
 * CMA-ES Weight Optimizer
 *
 * Uses Covariance Matrix Adaptation Evolution Strategy to find
 * regime-adaptive weight multipliers for the confluence scorer.
 *
 * Why CMA-ES over PPO:
 * - Weight → score → trade mapping is DISCONTINUOUS at the threshold
 * - PPO gets zero gradient in "no trade" regions and collapses to inactivity
 * - CMA-ES is gradient-free, handles discontinuous + noisy landscapes natively
 * - Only 3 dimensions (global, structure, proximity multipliers)
 *
 * Approach:
 *   1. Sample N candidate weight configs from Gaussian distribution
 *   2. Evaluate each candidate over M episodes (reduce noise)
 *   3. Rank by average reward, update distribution (mean + covariance)
 *   4. Repeat for G generations
 *
 * Usage:
 *   npx tsx scripts/train-cmaes-optimizer.ts
 *   npx tsx scripts/train-cmaes-optimizer.ts --generations 100 --population 20
 *   npx tsx scripts/train-cmaes-optimizer.ts --symbols BTC,ETH,SOL
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import {
  WeightOptimizerEnvironment,
  STATE_SIZE,
  COMPACT_ACTION_SIZE,
  WEIGHT_NAMES,
  type WeightOptimizerConfig,
} from '../src/lib/rl/environment/weight-optimizer-env';

// ============================================
// Config
// ============================================

interface CMAESConfig {
  /** Number of generations (default: 100) */
  generations: number;
  /** Population size per generation (default: 20) */
  populationSize: number;
  /** Episodes per candidate evaluation (default: 5) */
  episodesPerEval: number;
  /** Symbols to train on */
  symbols: string[];
  /** Data directory */
  dataDir: string;
  /** Timeframe */
  timeframe: string;
  /** Episode length in bars */
  episodeLength: number;
  /** Initial step size (sigma) */
  initialSigma: number;
  /** Model output directory */
  modelDir: string;
  /** Log interval */
  logInterval: number;
}

const DEFAULT_CONFIG: CMAESConfig = {
  generations: 100,
  populationSize: 20,
  episodesPerEval: 5,
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  dataDir: path.join(process.cwd(), 'data'),
  timeframe: '1h',
  episodeLength: 720,
  initialSigma: 0.5,
  modelDir: path.join(process.cwd(), 'models'),
  logInterval: 5,
};

function parseArgs(): CMAESConfig {
  const args = process.argv.slice(2);
  const config = { ...DEFAULT_CONFIG };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--generations':
        config.generations = parseInt(args[++i] ?? '100', 10);
        break;
      case '--population':
        config.populationSize = parseInt(args[++i] ?? '20', 10);
        break;
      case '--eval-episodes':
        config.episodesPerEval = parseInt(args[++i] ?? '5', 10);
        break;
      case '--symbols':
        config.symbols = (args[++i] ?? 'BTCUSDT').split(',').map((s) => {
          const upper = s.toUpperCase().trim();
          return upper.endsWith('USDT') ? upper : `${upper}USDT`;
        });
        break;
      case '--sigma':
        config.initialSigma = parseFloat(args[++i] ?? '0.5');
        break;
    }
  }

  return config;
}

// ============================================
// CMA-ES Implementation (Simplified)
// ============================================

/**
 * Simplified CMA-ES for 3 dimensions.
 * Uses the (µ, λ)-CMA-ES update rule with rank-based selection.
 */
class SimpleCMAES {
  private dim: number;
  private mean: number[];
  private sigma: number;
  private cov: number[][]; // Covariance matrix (dim × dim)
  private populationSize: number;
  private muEffective: number; // Number of parents for recombination

  // Evolution path
  private pc: number[];
  private ps: number[];

  // Step count
  private generation = 0;

  constructor(dim: number, initialMean: number[], sigma: number, popSize: number) {
    this.dim = dim;
    this.mean = [...initialMean];
    this.sigma = sigma;
    this.populationSize = popSize;

    // Initialize covariance to identity
    this.cov = Array.from({ length: dim }, (_, i) =>
      Array.from({ length: dim }, (_, j) => (i === j ? 1.0 : 0.0)),
    );

    // Evolution paths
    this.pc = new Array(dim).fill(0);
    this.ps = new Array(dim).fill(0);

    // Parent count: top 50% selection
    this.muEffective = Math.floor(popSize / 2);
  }

  /**
   * Sample a population of candidates from the current distribution.
   */
  samplePopulation(): number[][] {
    const population: number[][] = [];
    const sqrtCov = this.choleskyDecompose(this.cov);

    for (let i = 0; i < this.populationSize; i++) {
      // Sample from N(0, I)
      const z = Array.from({ length: this.dim }, () => randn());

      // Transform: x = mean + sigma * L * z (where L is Cholesky of cov)
      const x = this.mean.map((m, j) => {
        let sum = 0;
        for (let k = 0; k <= j; k++) {
          sum += sqrtCov[j]![k]! * z[k]!;
        }
        return m + this.sigma * sum;
      });

      population.push(x);
    }

    return population;
  }

  /**
   * Update distribution based on fitness-ranked population.
   * @param population The sampled candidates
   * @param fitnesses Fitness values (higher = better)
   */
  update(population: number[][], fitnesses: number[]): void {
    // Rank by fitness (descending)
    const indexed = fitnesses.map((f, i) => ({ idx: i, fitness: f }));
    indexed.sort((a, b) => b.fitness - a.fitness);

    // Recombination weights (log-linear)
    const mu = this.muEffective;
    const weights: number[] = [];
    for (let i = 0; i < mu; i++) {
      weights.push(Math.log(mu + 0.5) - Math.log(i + 1));
    }
    const wSum = weights.reduce((s, w) => s + w, 0);
    const normWeights = weights.map((w) => w / wSum);

    // Weighted mean of selected parents
    const newMean = new Array(this.dim).fill(0);
    for (let i = 0; i < mu; i++) {
      const parent = population[indexed[i]!.idx]!;
      for (let j = 0; j < this.dim; j++) {
        newMean[j] += normWeights[i]! * parent[j]!;
      }
    }

    // Update evolution path for sigma adaptation
    const meanShift = newMean.map((m, i) => (m - this.mean[i]!) / this.sigma);

    // Cumulative step-size adaptation (CSA)
    const cs = 0.3; // Step size learning rate
    const ds = 1.0 + 2.0 * Math.max(0, Math.sqrt(mu / this.populationSize) - 1) + cs;
    const chiN = Math.sqrt(this.dim) * (1 - 1 / (4 * this.dim) + 1 / (21 * this.dim * this.dim));

    for (let i = 0; i < this.dim; i++) {
      this.ps[i] = (1 - cs) * this.ps[i]! + Math.sqrt(cs * (2 - cs) * mu) * meanShift[i]!;
    }

    const psNorm = Math.sqrt(this.ps.reduce((s, v) => s + v * v, 0));
    this.sigma *= Math.exp((cs / ds) * (psNorm / chiN - 1));

    // Clamp sigma to prevent collapse or explosion
    this.sigma = Math.max(0.01, Math.min(2.0, this.sigma));

    // Update covariance matrix (simplified rank-µ update)
    const cc = 0.2; // Covariance learning rate
    for (let i = 0; i < this.dim; i++) {
      this.pc[i] = (1 - cc) * this.pc[i]! + Math.sqrt(cc * (2 - cc) * mu) * meanShift[i]!;
    }

    const c1 = 0.1 / this.dim; // Rank-1 update weight
    const cmu = 0.1 / this.dim; // Rank-µ update weight

    for (let i = 0; i < this.dim; i++) {
      for (let j = 0; j < this.dim; j++) {
        // Rank-1 update from evolution path
        let update = c1 * (this.pc[i]! * this.pc[j]!);

        // Rank-µ update from selected parents
        for (let k = 0; k < mu; k++) {
          const parent = population[indexed[k]!.idx]!;
          const di = (parent[i]! - this.mean[i]!) / this.sigma;
          const dj = (parent[j]! - this.mean[j]!) / this.sigma;
          update += cmu * normWeights[k]! * di * dj;
        }

        this.cov[i]![j] = (1 - c1 - cmu) * this.cov[i]![j]! + update;
      }
    }

    this.mean = newMean;
    this.generation++;
  }

  getMean(): number[] { return [...this.mean]; }
  getSigma(): number { return this.sigma; }
  getGeneration(): number { return this.generation; }

  /**
   * Cholesky decomposition of a positive-definite matrix.
   * Returns lower triangular matrix L where cov = L * L^T.
   */
  private choleskyDecompose(matrix: number[][]): number[][] {
    const n = matrix.length;
    const L = Array.from({ length: n }, () => new Array(n).fill(0));

    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = 0;
        for (let k = 0; k < j; k++) {
          sum += L[i]![k]! * L[j]![k]!;
        }

        if (i === j) {
          const val = matrix[i]![i]! - sum;
          L[i]![j] = Math.sqrt(Math.max(val, 1e-10)); // Ensure positive
        } else {
          L[i]![j] = (matrix[i]![j]! - sum) / (L[j]![j]! || 1e-10);
        }
      }
    }

    return L;
  }
}

/** Standard normal random number (Box-Muller) */
function randn(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
}

// ============================================
// Data Loading
// ============================================

interface SymbolData {
  symbol: string;
  candles: Candle[];
  episodeStarts: number[];
}

function loadData(config: CMAESConfig): SymbolData[] {
  const data: SymbolData[] = [];
  const lookback = 200;

  for (const symbol of config.symbols) {
    const filePath = path.join(config.dataDir, `${symbol}_${config.timeframe}.json`);
    if (!fs.existsSync(filePath)) {
      console.error(`[Warning] Not found: ${filePath}, skipping ${symbol}`);
      continue;
    }

    const candles: Candle[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const episodeStarts: number[] = [];
    let start = lookback;
    while (start + config.episodeLength <= candles.length) {
      episodeStarts.push(start);
      start += Math.floor(config.episodeLength / 2); // 50% overlap
    }

    console.log(`[Data] ${symbol}: ${candles.length} candles, ${episodeStarts.length} episodes`);
    data.push({ symbol, candles, episodeStarts });
  }

  return data;
}

// ============================================
// Evaluation
// ============================================

interface EvalResult {
  avgReward: number;
  avgTrades: number;
  avgWinRate: number;
  avgPnL: number;
}

function evaluateCandidate(
  action: number[],
  symbolData: SymbolData[],
  env: WeightOptimizerEnvironment,
  numEpisodes: number,
): EvalResult {
  let totalReward = 0;
  let totalTrades = 0;
  let totalWins = 0;
  let totalPnL = 0;
  let evalCount = 0;

  for (let ep = 0; ep < numEpisodes; ep++) {
    // Pick random symbol and episode
    const sym = symbolData[Math.floor(Math.random() * symbolData.length)]!;
    const startIdx = sym.episodeStarts[Math.floor(Math.random() * sym.episodeStarts.length)]!;

    env.setData(sym.candles);
    let state = env.reset(startIdx);
    let done = false;
    let epReward = 0;
    let epTrades = 0;
    let epWins = 0;
    let epPnL = 0;

    while (!done) {
      // Use the same action for every step (fixed config per episode)
      const result = env.step(action);
      epReward += result.reward;
      epTrades += result.info.trades;
      epWins += result.info.wins;
      epPnL += result.info.pnl;
      state = result.state;
      done = result.done;
    }

    totalReward += epReward;
    totalTrades += epTrades;
    totalWins += epWins;
    totalPnL += epPnL;
    evalCount++;
  }

  return {
    avgReward: evalCount > 0 ? totalReward / evalCount : 0,
    avgTrades: evalCount > 0 ? totalTrades / evalCount : 0,
    avgWinRate: totalTrades > 0 ? totalWins / totalTrades : 0,
    avgPnL: evalCount > 0 ? totalPnL / evalCount : 0,
  };
}

/** Convert 3-dim CMA-ES candidate to action array for the environment */
function candidateToAction(candidate: number[]): number[] {
  // Clamp to [-1, 1] range (env handles exp() mapping)
  return candidate.map((v) => Math.max(-1, Math.min(1, v)));
}

/** Decode 3-dim action to human-readable multipliers */
function decodeMultipliers(action: number[], scale: number): { global: number; structure: number; proximity: number } {
  return {
    global: Math.exp(Math.max(-1, Math.min(1, action[0]!)) * scale),
    structure: Math.exp(Math.max(-1, Math.min(1, action[1]!)) * scale * 0.5),
    proximity: Math.exp(Math.max(-1, Math.min(1, action[2]!)) * scale * 0.5),
  };
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
  const config = parseArgs();

  console.log('='.repeat(60));
  console.log('CMA-ES Weight Optimizer');
  console.log('='.repeat(60));
  console.log(`  Generations:    ${config.generations}`);
  console.log(`  Population:     ${config.populationSize}`);
  console.log(`  Eval episodes:  ${config.episodesPerEval}`);
  console.log(`  Symbols:        ${config.symbols.join(', ')}`);
  console.log(`  Action dims:    ${COMPACT_ACTION_SIZE} (global, structure, proximity)`);
  console.log(`  Initial sigma:  ${config.initialSigma}`);
  console.log('='.repeat(60));

  // Load data
  const symbolData = loadData(config);
  if (symbolData.length === 0) {
    console.error('[Error] No data loaded.');
    process.exit(1);
  }

  // Create environment
  const env = new WeightOptimizerEnvironment();

  // Initialize CMA-ES
  const initialMean = new Array(COMPACT_ACTION_SIZE).fill(0); // Start at neutral (mult=1.0)
  const cmaes = new SimpleCMAES(
    COMPACT_ACTION_SIZE,
    initialMean,
    config.initialSigma,
    config.populationSize,
  );

  // Ensure model dir
  if (!fs.existsSync(config.modelDir)) {
    fs.mkdirSync(config.modelDir, { recursive: true });
  }

  let bestOverallReward = -Infinity;
  let bestOverallAction: number[] = [];
  let bestOverallResult: EvalResult = { avgReward: 0, avgTrades: 0, avgWinRate: 0, avgPnL: 0 };

  // Generation loop
  for (let gen = 0; gen < config.generations; gen++) {
    // Sample population
    const population = cmaes.samplePopulation();

    // Evaluate each candidate
    const fitnesses: number[] = [];
    const results: EvalResult[] = [];

    for (let i = 0; i < population.length; i++) {
      const action = candidateToAction(population[i]!);
      const result = evaluateCandidate(action, symbolData, env, config.episodesPerEval);
      fitnesses.push(result.avgReward);
      results.push(result);
    }

    // Update CMA-ES distribution
    cmaes.update(population, fitnesses);

    // Find best in this generation
    let bestIdx = 0;
    for (let i = 1; i < fitnesses.length; i++) {
      if (fitnesses[i]! > fitnesses[bestIdx]!) bestIdx = i;
    }

    const bestResult = results[bestIdx]!;
    const bestAction = candidateToAction(population[bestIdx]!);

    if (bestResult.avgReward > bestOverallReward) {
      bestOverallReward = bestResult.avgReward;
      bestOverallAction = bestAction;
      bestOverallResult = bestResult;
    }

    // Logging
    if (gen % config.logInterval === 0 || gen === config.generations - 1) {
      const mean = cmaes.getMean();
      const sigma = cmaes.getSigma();
      const meanAction = candidateToAction(mean);
      const mults = decodeMultipliers(meanAction, 0.7);
      const avgFit = fitnesses.reduce((s, f) => s + f, 0) / fitnesses.length;

      console.log(
        `[Gen ${gen.toString().padStart(3)}] ` +
        `σ=${sigma.toFixed(3)} | ` +
        `Avg R: ${avgFit.toFixed(3)} | ` +
        `Best R: ${bestResult.avgReward.toFixed(3)} | ` +
        `Trades: ${bestResult.avgTrades.toFixed(1)} | ` +
        `WR: ${(bestResult.avgWinRate * 100).toFixed(1)}% | ` +
        `PnL: ${(bestResult.avgPnL * 100).toFixed(2)}% | ` +
        `Mults: G=${mults.global.toFixed(2)} S=${mults.structure.toFixed(2)} P=${mults.proximity.toFixed(2)}`,
      );
    }
  }

  // Final evaluation of best candidate with more episodes
  console.log('\n' + '='.repeat(60));
  console.log('FINAL EVALUATION');
  console.log('='.repeat(60));

  const finalResult = evaluateCandidate(
    bestOverallAction,
    symbolData,
    env,
    config.episodesPerEval * 5, // 5x more episodes for robust estimate
  );

  const mults = decodeMultipliers(bestOverallAction, 0.7);
  console.log(`Best action: [${bestOverallAction.map((a) => a.toFixed(4)).join(', ')}]`);
  console.log(`Multipliers: Global=${mults.global.toFixed(3)}, Structure=${mults.structure.toFixed(3)}, Proximity=${mults.proximity.toFixed(3)}`);
  console.log(`Avg Reward:  ${finalResult.avgReward.toFixed(3)}`);
  console.log(`Avg Trades:  ${finalResult.avgTrades.toFixed(1)} per episode`);
  console.log(`Win Rate:    ${(finalResult.avgWinRate * 100).toFixed(1)}%`);
  console.log(`Avg PnL:     ${(finalResult.avgPnL * 100).toFixed(2)}% per episode`);

  // Compute per-weight multiplier mapping
  console.log('\nPer-weight multipliers:');
  for (const name of WEIGHT_NAMES) {
    let mult = mults.global;
    if (['structureAlignment', 'recentBOS', 'killZoneActive'].includes(name)) {
      mult *= mults.structure;
    } else if (['obProximity', 'fvgAtCE', 'oteZone', 'breakerConfluence', 'obFvgConfluence'].includes(name)) {
      mult *= mults.proximity;
    }
    console.log(`  ${name.padEnd(20)} × ${mult.toFixed(3)}`);
  }

  // Also evaluate neutral baseline for comparison
  console.log('\n--- Baseline (neutral multipliers, all = 1.0) ---');
  const baselineAction = new Array(COMPACT_ACTION_SIZE).fill(0);
  const baselineResult = evaluateCandidate(
    baselineAction,
    symbolData,
    env,
    config.episodesPerEval * 5,
  );
  console.log(`Avg Reward:  ${baselineResult.avgReward.toFixed(3)}`);
  console.log(`Avg Trades:  ${baselineResult.avgTrades.toFixed(1)} per episode`);
  console.log(`Win Rate:    ${(baselineResult.avgWinRate * 100).toFixed(1)}%`);
  console.log(`Avg PnL:     ${(baselineResult.avgPnL * 100).toFixed(2)}% per episode`);

  const improvement = finalResult.avgReward - baselineResult.avgReward;
  console.log(`\nImprovement over baseline: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(3)} reward`);

  // Save results
  const outputPath = path.join(config.modelDir, 'cmaes_optimizer_best.json');
  const output = {
    action: bestOverallAction,
    multipliers: mults,
    perWeight: Object.fromEntries(WEIGHT_NAMES.map((name) => {
      let mult = mults.global;
      if (['structureAlignment', 'recentBOS', 'killZoneActive'].includes(name)) mult *= mults.structure;
      else if (['obProximity', 'fvgAtCE', 'oteZone', 'breakerConfluence', 'obFvgConfluence'].includes(name)) mult *= mults.proximity;
      return [name, mult];
    })),
    evaluation: finalResult,
    baseline: baselineResult,
    config: {
      generations: config.generations,
      populationSize: config.populationSize,
      episodesPerEval: config.episodesPerEval,
      symbols: config.symbols,
    },
    timestamp: new Date().toISOString(),
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n[Save] Results saved to ${outputPath}`);
}

main().catch(console.error);
