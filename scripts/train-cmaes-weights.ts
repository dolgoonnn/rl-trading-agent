#!/usr/bin/env npx tsx
/**
 * CMA-ES Weight Optimizer
 *
 * Uses Covariance Matrix Adaptation Evolution Strategy to optimize
 * confluence weight multipliers, evaluated via walk-forward fitness.
 *
 * Unlike PPO (which suffered policy collapse due to sparse rewards):
 * - No gradients needed — evaluates fitness directly
 * - Population-based — naturally explores diverse solutions
 * - Covariance adaptation — learns correlations between weights
 * - Direct optimization — no credit assignment problem
 *
 * Search space: 10 weight multipliers in [0.2, 3.0]
 * Fitness: walk-forward composite score (pass rate + PnL + WR)
 *
 * Usage:
 *   npx tsx scripts/train-cmaes-weights.ts
 *   npx tsx scripts/train-cmaes-weights.ts --generations 50 --pop 20
 *   npx tsx scripts/train-cmaes-weights.ts --mode regime  # per-regime weights
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import { CMAES, type CMAESConfig } from '../src/lib/rl/utils/cma-es';
import {
  ConfluenceScorer,
  type ConfluenceConfig,
  type ConfluenceWeights,
  DEFAULT_WEIGHTS,
  PRODUCTION_STRATEGY_CONFIG,
} from '../src/lib/rl/strategies/confluence-scorer';
import {
  detectRegime,
  regimeLabel,
} from '@/lib/ict';
import {
  runWalkForward,
  type WalkForwardStrategyRunner,
  type TradeResult,
  type WalkForwardConfig,
  type WalkForwardResult,
} from './walk-forward-validate';

// ============================================
// Weight names (the 10 active factors)
// ============================================

const OPTIMIZABLE_WEIGHTS: (keyof ConfluenceWeights)[] = [
  'structureAlignment',
  'killZoneActive',
  'liquiditySweep',
  'obProximity',
  'fvgAtCE',
  'recentBOS',
  'rrRatio',
  'oteZone',
  'obFvgConfluence',
  'momentumConfirmation',
];

// ============================================
// CLI Parsing
// ============================================

interface CLIConfig {
  generations: number;
  populationSize: number;
  symbols: string[];
  timeframe: string;
  threshold: number;
  mode: 'global' | 'regime';
  sigma: number;
}

function parseCLI(): CLIConfig {
  const args = process.argv.slice(2);
  const config: CLIConfig = {
    generations: 40,
    populationSize: 16,
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    timeframe: '1h',
    threshold: 4.15,
    mode: 'global',
    sigma: 0.3,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--generations':
      case '-g':
        config.generations = parseInt(args[++i] ?? '40');
        break;
      case '--pop':
        config.populationSize = parseInt(args[++i] ?? '16');
        break;
      case '--symbols':
        config.symbols = (args[++i] ?? '').split(',').map(s =>
          s.includes('USDT') ? s : `${s}USDT`
        );
        break;
      case '--timeframe':
        config.timeframe = args[++i] ?? '1h';
        break;
      case '--threshold':
        config.threshold = parseFloat(args[++i] ?? '4.15');
        break;
      case '--mode':
        config.mode = (args[++i] ?? 'global') as 'global' | 'regime';
        break;
      case '--sigma':
        config.sigma = parseFloat(args[++i] ?? '0.3');
        break;
    }
  }

  return config;
}

// ============================================
// Fitness Evaluation
// ============================================

/** Production scorer config (matches best known config) */
function makeBaseConfig(threshold: number): Partial<ConfluenceConfig> {
  return {
    minThreshold: threshold,
    activeStrategies: ['order_block'],
    suppressedRegimes: ['ranging+normal', 'ranging+high', 'downtrend+high'],
    obFreshnessHalfLife: 15,
    atrExtensionBands: 3.0,
    strategyConfig: {
      ...PRODUCTION_STRATEGY_CONFIG,
      slPlacementMode: 'dynamic_rr' as const,
    },
  };
}

/** Convert CMA-ES parameter vector to weight multipliers */
function paramsToWeights(params: number[]): Partial<ConfluenceWeights> {
  const weights: Partial<ConfluenceWeights> = {};
  for (let i = 0; i < OPTIMIZABLE_WEIGHTS.length && i < params.length; i++) {
    const name = OPTIMIZABLE_WEIGHTS[i]!;
    // params[i] is in [0.2, 3.0] range (clamped by CMA-ES bounds)
    weights[name] = DEFAULT_WEIGHTS[name] * params[i]!;
  }
  return weights;
}

/** Create a WF runner with custom weight multipliers */
function createWeightRunner(
  threshold: number,
  weightMultipliers: number[],
  friction: number = 0.0007,
): WalkForwardStrategyRunner {
  const weights = paramsToWeights(weightMultipliers);
  const label = weightMultipliers.map(w => w.toFixed(2)).join(',');

  return {
    name: `CMA-ES(${label})`,

    async run(
      trainCandles: Candle[],
      valCandles: Candle[],
      _meta?: { symbol?: string },
    ): Promise<TradeResult[]> {
      const scorerConfig = makeBaseConfig(threshold);
      // Override weights with CMA-ES candidate
      const customWeights: ConfluenceWeights = { ...DEFAULT_WEIGHTS, ...weights };

      const scorer = new ConfluenceScorer({
        ...scorerConfig,
        weights: customWeights,
      });

      const allCandles = [...trainCandles, ...valCandles];
      const valStartIndex = trainCandles.length;
      const trades: TradeResult[] = [];
      let inPosition = false;
      let positionExitBar = -1;

      for (let i = valStartIndex; i < allCandles.length; i++) {
        if (!allCandles[i]) continue;
        if (inPosition && i <= positionExitBar) continue;
        inPosition = false;

        const result = scorer.evaluate(allCandles, i);

        if (result.action === 'trade' && result.selectedSignal) {
          const signal = result.selectedSignal.signal;

          // Simulate SL/TP exit
          const entryPrice = signal.direction === 'long'
            ? signal.entryPrice * (1 + friction)
            : signal.entryPrice * (1 - friction);

          let exitPrice: number | null = null;
          let exitBar = i;

          for (let bar = i + 1; bar < Math.min(i + 72, allCandles.length); bar++) {
            const candle = allCandles[bar];
            if (!candle) break;

            const slHit = signal.direction === 'long'
              ? candle.low <= signal.stopLoss
              : candle.high >= signal.stopLoss;
            const tpHit = signal.direction === 'long'
              ? candle.high >= signal.takeProfit
              : candle.low <= signal.takeProfit;

            if (slHit) { exitPrice = signal.stopLoss; exitBar = bar; break; }
            if (tpHit) { exitPrice = signal.takeProfit; exitBar = bar; break; }
            if (bar === Math.min(i + 71, allCandles.length - 1)) {
              exitPrice = candle.close;
              exitBar = bar;
              break;
            }
          }

          if (exitPrice === null) {
            const lastBar = Math.min(i + 71, allCandles.length - 1);
            exitPrice = allCandles[lastBar]?.close ?? signal.entryPrice;
            exitBar = lastBar;
          }

          exitPrice = signal.direction === 'long'
            ? exitPrice * (1 - friction)
            : exitPrice * (1 + friction);

          const pnl = signal.direction === 'long'
            ? (exitPrice - entryPrice) / entryPrice
            : (entryPrice - exitPrice) / entryPrice;

          trades.push({
            entryTimestamp: allCandles[i]?.timestamp ?? 0,
            exitTimestamp: allCandles[exitBar]?.timestamp ?? 0,
            direction: signal.direction,
            entryPrice: signal.entryPrice,
            exitPrice,
            pnlPercent: pnl,
            strategy: signal.strategy,
          });

          inPosition = true;
          positionExitBar = exitBar;
        }
      }

      return trades;
    },
  };
}

/** Compute fitness from walk-forward results */
function computeFitness(result: WalkForwardResult): number {
  const allWindows = result.symbols.flatMap(s => s.windows);
  const eligible = allWindows.filter(w => w.trades > 0);

  if (eligible.length === 0) return -10; // Penalize no-trade solutions

  const passRate = eligible.filter(w => w.passed).length / eligible.length;
  const totalTrades = eligible.reduce((s, w) => s + w.trades, 0);
  const avgWR = eligible.reduce((s, w) => s + w.winRate, 0) / eligible.length;
  const totalPnL = eligible.reduce((s, w) => s + w.pnl, 0);

  // Minimum trade count requirement (avoid sparse solutions)
  if (totalTrades < 200) return -5 + totalTrades / 200;

  // Composite fitness: weighted combination
  // Pass rate is the primary objective (what we gate on)
  // PnL and WR are secondary
  const fitness =
    passRate * 10 +                              // 0-10 points for pass rate
    Math.min(totalPnL * 2, 5) +                  // 0-5 points for PnL (capped)
    (avgWR > 0.40 ? (avgWR - 0.40) * 20 : 0) +  // bonus for WR > 40%
    (totalTrades > 500 ? 0.5 : 0);               // small bonus for sufficient trades

  return fitness;
}

// ============================================
// Main
// ============================================

function log(msg: string): void {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] ${msg}`);
}

async function main(): Promise<void> {
  const cli = parseCLI();
  const dim = OPTIMIZABLE_WEIGHTS.length; // 10

  log('============================================================');
  log('CMA-ES Confluence Weight Optimizer');
  log('============================================================');
  log(`Dimensions: ${dim} (${OPTIMIZABLE_WEIGHTS.join(', ')})`);
  log(`Population: ${cli.populationSize}`);
  log(`Generations: ${cli.generations}`);
  log(`Sigma: ${cli.sigma}`);
  log(`Threshold: ${cli.threshold}`);
  log(`Symbols: ${cli.symbols.join(', ')}`);
  log(`Mode: ${cli.mode}`);
  log('');

  // Initial mean = all 1.0 (no change from default weights)
  const initialMean = new Array(dim).fill(1.0);

  const cmaes = new CMAES({
    dim,
    populationSize: cli.populationSize,
    initialSigma: cli.sigma,
    initialMean,
    lowerBounds: new Array(dim).fill(0.0),  // Allow disabling factors
    upperBounds: new Array(dim).fill(3.0),   // Allow 3x boost
    maxGenerations: cli.generations,
  });

  const wfConfig: Partial<WalkForwardConfig> = {
    symbols: cli.symbols,
    timeframe: cli.timeframe,
  };

  // Run baseline first
  log('--- Evaluating Baseline (default weights) ---');
  const baselineRunner = createWeightRunner(cli.threshold, initialMean);
  const baselineResult = await runWalkForward(baselineRunner, wfConfig, { quiet: true });
  const baselineFitness = computeFitness(baselineResult);

  const baseEligible = baselineResult.symbols.flatMap(s => s.windows).filter(w => w.trades > 0);
  const basePassRate = baseEligible.filter(w => w.passed).length / baseEligible.length;
  const baseTrades = baseEligible.reduce((s, w) => s + w.trades, 0);
  const basePnL = baseEligible.reduce((s, w) => s + w.pnl, 0);

  log(`Baseline: fitness=${baselineFitness.toFixed(3)}, passRate=${(basePassRate * 100).toFixed(1)}%, trades=${baseTrades}, PnL=${(basePnL * 100).toFixed(1)}%`);
  log('');

  // CMA-ES optimization loop
  log('--- CMA-ES Optimization ---');

  while (!cmaes.shouldStop()) {
    const gen = cmaes.getGeneration();
    const population = cmaes.samplePopulation();
    const fitnesses: number[] = [];

    // Evaluate each candidate in the population
    for (let i = 0; i < population.length; i++) {
      const params = population[i]!;
      const runner = createWeightRunner(cli.threshold, params);
      const result = await runWalkForward(runner, wfConfig, { quiet: true });
      const fitness = computeFitness(result);
      fitnesses.push(fitness);

      // Compact progress dot
      process.stdout.write(fitness > baselineFitness ? '+' : '.');
    }
    process.stdout.write('\n');

    // Update CMA-ES distribution
    cmaes.update(population, fitnesses);

    const best = cmaes.getBest();
    const meanFit = fitnesses.reduce((a, b) => a + b, 0) / fitnesses.length;
    const genBest = Math.max(...fitnesses);

    log(
      `Gen ${gen.toString().padStart(3)}: ` +
      `mean=${meanFit.toFixed(3)}, best=${genBest.toFixed(3)}, ` +
      `allTimeBest=${best.fitness.toFixed(3)} (gen ${best.generation}), ` +
      `sigma=${cmaes.getSigma().toFixed(4)}`
    );

    // Show current best weights
    if ((gen + 1) % 5 === 0 || gen === 0) {
      const bestWeights = best.params;
      const weightStr = OPTIMIZABLE_WEIGHTS.map((name, j) =>
        `${name.slice(0, 10)}=${bestWeights[j]!.toFixed(2)}`
      ).join(', ');
      log(`  Best weights: ${weightStr}`);
    }
  }

  // Final evaluation of best solution
  log('');
  log('--- Final Evaluation ---');
  const best = cmaes.getBest();
  const bestRunner = createWeightRunner(cli.threshold, best.params);
  const bestResult = await runWalkForward(bestRunner, wfConfig, { quiet: true });

  const bestEligible = bestResult.symbols.flatMap(s => s.windows).filter(w => w.trades > 0);
  const bestPassRate = bestEligible.filter(w => w.passed).length / bestEligible.length;
  const bestTrades = bestEligible.reduce((s, w) => s + w.trades, 0);
  const bestWR = bestEligible.reduce((s, w) => s + w.winRate, 0) / (bestEligible.length || 1);
  const bestPnL = bestEligible.reduce((s, w) => s + w.pnl, 0);

  log('');
  log('============================================================');
  log('RESULTS: Baseline vs CMA-ES Optimized');
  log('============================================================');
  log(`  Metric        | Baseline       | CMA-ES         | Delta`);
  log(`  --------------+----------------+----------------+---------`);
  log(`  Pass Rate     | ${(basePassRate * 100).toFixed(1).padStart(12)}% | ${(bestPassRate * 100).toFixed(1).padStart(12)}% | ${((bestPassRate - basePassRate) * 100).toFixed(1).padStart(6)}pp`);
  log(`  Trades        | ${String(baseTrades).padStart(13)} | ${String(bestTrades).padStart(13)} | ${String(bestTrades - baseTrades).padStart(7)}`);
  log(`  Avg Win Rate  | ${(baseEligible.reduce((s, w) => s + w.winRate, 0) / baseEligible.length).toFixed(1).padStart(12)}% | ${bestWR.toFixed(1).padStart(12)}% | ${(bestWR - baseEligible.reduce((s, w) => s + w.winRate, 0) / baseEligible.length).toFixed(1).padStart(6)}pp`);
  log(`  Total PnL     | ${(basePnL * 100).toFixed(1).padStart(12)}% | ${(bestPnL * 100).toFixed(1).padStart(12)}% | ${((bestPnL - basePnL) * 100).toFixed(1).padStart(6)}pp`);
  log(`  Fitness       | ${baselineFitness.toFixed(3).padStart(13)} | ${best.fitness.toFixed(3).padStart(13)} | ${(best.fitness - baselineFitness).toFixed(3).padStart(7)}`);

  const verdict = bestPassRate > basePassRate ? 'CMA-ES WINS' : bestPassRate === basePassRate ? 'TIE' : 'BASELINE WINS';
  log(`  VERDICT: ${verdict}`);
  log('============================================================');

  // Print optimized weights
  log('');
  log('Optimized weight multipliers:');
  const finalWeights: Record<string, number> = {};
  for (let i = 0; i < OPTIMIZABLE_WEIGHTS.length; i++) {
    const name = OPTIMIZABLE_WEIGHTS[i]!;
    const mult = best.params[i]!;
    const absWeight = DEFAULT_WEIGHTS[name] * mult;
    log(`  ${name.padEnd(22)} = ${absWeight.toFixed(3)} (${mult.toFixed(2)}x default)`);
    finalWeights[name] = absWeight;
  }

  // Per-symbol breakdown
  log('');
  log('Per-symbol breakdown:');
  for (const sym of bestResult.symbols) {
    const eligible = sym.windows.filter(w => w.trades > 0);
    const passRate = eligible.filter(w => w.passed).length / (eligible.length || 1);
    const pnl = eligible.reduce((s, w) => s + w.pnl, 0);
    const trades = eligible.reduce((s, w) => s + w.trades, 0);
    log(`  ${sym.symbol}: passRate=${(passRate * 100).toFixed(1)}%, trades=${trades}, PnL=${(pnl * 100).toFixed(1)}%`);
  }

  // Save model
  const modelDir = path.join(process.cwd(), 'models');
  if (!fs.existsSync(modelDir)) fs.mkdirSync(modelDir, { recursive: true });

  const modelPath = path.join(modelDir, 'cmaes_weights.json');
  const model = {
    weightNames: OPTIMIZABLE_WEIGHTS,
    multipliers: best.params,
    absoluteWeights: finalWeights,
    fitness: best.fitness,
    baselineFitness,
    generation: best.generation,
    config: cli,
    cmaesResult: cmaes.getResult(),
  };
  fs.writeFileSync(modelPath, JSON.stringify(model, null, 2));
  log(`\nModel saved to ${modelPath}`);
}

main().catch((err) => {
  console.error('CMA-ES training failed:', err);
  process.exit(1);
});
