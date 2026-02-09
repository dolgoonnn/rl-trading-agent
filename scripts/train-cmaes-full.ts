#!/usr/bin/env npx tsx
/**
 * CMA-ES Full Hyperparameter Optimizer
 *
 * Jointly optimizes:
 * - 10 confluence weight multipliers
 * - 5 regime-specific threshold overrides
 * - Base threshold
 * - OB freshness half-life
 * - ATR extension bands
 *
 * Total: 18 dimensions (well within CMA-ES sweet spot of 5-30)
 *
 * Usage:
 *   npx tsx scripts/train-cmaes-full.ts
 *   npx tsx scripts/train-cmaes-full.ts --generations 50 --pop 24
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import { CMAES } from '../src/lib/rl/utils/cma-es';
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

  // 5 regime threshold overrides [2.5, 6.0]
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

  return specs;
}

// ============================================
// CLI
// ============================================

interface CLIConfig {
  generations: number;
  populationSize: number;
  symbols: string[];
  timeframe: string;
  sigma: number;
}

function parseCLI(): CLIConfig {
  const args = process.argv.slice(2);
  const config: CLIConfig = {
    generations: 40,
    populationSize: 20,
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    timeframe: '1h',
    sigma: 0.25,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--generations': case '-g':
        config.generations = parseInt(args[++i] ?? '40');
        break;
      case '--pop':
        config.populationSize = parseInt(args[++i] ?? '20');
        break;
      case '--symbols':
        config.symbols = (args[++i] ?? '').split(',').map(s =>
          s.includes('USDT') ? s : `${s}USDT`
        );
        break;
      case '--timeframe':
        config.timeframe = args[++i] ?? '1h';
        break;
      case '--sigma':
        config.sigma = parseFloat(args[++i] ?? '0.25');
        break;
    }
  }

  return config;
}

// ============================================
// Fitness Evaluation
// ============================================

function decodeParams(
  params: number[],
  specs: ParamSpec[],
): {
  weightMultipliers: Partial<ConfluenceWeights>;
  regimeThresholds: Record<string, number>;
  baseThreshold: number;
  obFreshnessHalfLife: number;
  atrExtensionBands: number;
} {
  const weightMultipliers: Partial<ConfluenceWeights> = {};
  const regimeThresholds: Record<string, number> = {};
  let baseThreshold = 4.15;
  let obFreshnessHalfLife = 15;
  let atrExtensionBands = 3.0;

  for (let i = 0; i < specs.length && i < params.length; i++) {
    const spec = specs[i]!;
    const val = params[i]!;

    if (spec.type === 'weight_mult') {
      const wName = spec.name.replace('w_', '') as keyof ConfluenceWeights;
      weightMultipliers[wName] = DEFAULT_WEIGHTS[wName] * val;
    } else if (spec.type === 'threshold') {
      const regimeLabel = spec.name.replace('t_', '');
      regimeThresholds[regimeLabel] = val;
    } else if (spec.name === 'baseThreshold') {
      baseThreshold = val;
    } else if (spec.name === 'obFreshnessHalfLife') {
      obFreshnessHalfLife = Math.round(val);
    } else if (spec.name === 'atrExtensionBands') {
      atrExtensionBands = val;
    }
  }

  return { weightMultipliers, regimeThresholds, baseThreshold, obFreshnessHalfLife, atrExtensionBands };
}

function createRunner(
  params: number[],
  specs: ParamSpec[],
  friction: number = 0.0007,
): WalkForwardStrategyRunner {
  const decoded = decodeParams(params, specs);

  return {
    name: `CMA-ES-Full`,

    async run(
      trainCandles: Candle[],
      valCandles: Candle[],
      _meta?: { symbol?: string },
    ): Promise<TradeResult[]> {
      const customWeights: ConfluenceWeights = { ...DEFAULT_WEIGHTS, ...decoded.weightMultipliers };

      const scorer = new ConfluenceScorer({
        minThreshold: decoded.baseThreshold,
        activeStrategies: ['order_block'],
        suppressedRegimes: ['ranging+normal', 'ranging+high', 'downtrend+high'],
        obFreshnessHalfLife: decoded.obFreshnessHalfLife,
        atrExtensionBands: decoded.atrExtensionBands,
        weights: customWeights,
        regimeThresholdOverrides: decoded.regimeThresholds,
        strategyConfig: {
          ...PRODUCTION_STRATEGY_CONFIG,
          slPlacementMode: 'dynamic_rr' as const,
        },
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

          const entryPrice = signal.direction === 'long'
            ? signal.entryPrice * (1 + friction)
            : signal.entryPrice * (1 - friction);

          // Partial TP config matching production: close 45% at 0.85R, move SL to BE+0.1R
          const partialFraction = 0.45;
          const partialTriggerR = 0.85;
          const beBuffer = 0.1;
          const riskDistance = signal.direction === 'long'
            ? signal.entryPrice - signal.stopLoss
            : signal.stopLoss - signal.entryPrice;

          let exitPrice: number | null = null;
          let exitBar = i;
          let partialTaken = false;
          let partialPnl = 0;
          let currentSL = signal.stopLoss;

          for (let bar = i + 1; bar < Math.min(i + 72, allCandles.length); bar++) {
            const candle = allCandles[bar];
            if (!candle) break;

            // Check SL and TP FIRST (matches production order)
            const slHit = signal.direction === 'long'
              ? candle.low <= currentSL
              : candle.high >= currentSL;
            const tpHit = signal.direction === 'long'
              ? candle.high >= signal.takeProfit
              : candle.low <= signal.takeProfit;

            if (slHit) { exitPrice = currentSL; exitBar = bar; break; }
            if (tpHit) { exitPrice = signal.takeProfit; exitBar = bar; break; }

            // Partial TP: check using candle.close (not high/low), matching production
            if (!partialTaken && riskDistance > 0) {
              const unrealizedR = signal.direction === 'long'
                ? (candle.close - signal.entryPrice) / riskDistance
                : (signal.entryPrice - candle.close) / riskDistance;

              if (unrealizedR >= partialTriggerR) {
                partialTaken = true;
                const partialExit = signal.direction === 'long'
                  ? candle.close * (1 - friction)
                  : candle.close * (1 + friction);
                partialPnl = signal.direction === 'long'
                  ? (partialExit - entryPrice) / entryPrice
                  : (entryPrice - partialExit) / entryPrice;
                // Move SL to breakeven + buffer
                const buffer = riskDistance * beBuffer;
                if (signal.direction === 'long') {
                  currentSL = Math.max(currentSL, signal.entryPrice + buffer);
                } else {
                  currentSL = Math.min(currentSL, signal.entryPrice - buffer);
                }
              }
            }

            // Max bars
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

          // Compute blended PnL
          const remainderPnl = signal.direction === 'long'
            ? (exitPrice - entryPrice) / entryPrice
            : (entryPrice - exitPrice) / entryPrice;

          const pnl = partialTaken
            ? partialFraction * partialPnl + (1 - partialFraction) * remainderPnl
            : remainderPnl;

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

function computeFitness(result: WalkForwardResult): number {
  const allWindows = result.symbols.flatMap(s => s.windows);
  const eligible = allWindows.filter(w => w.trades > 0);

  if (eligible.length === 0) return -10;

  const passRate = eligible.filter(w => w.passed).length / eligible.length;
  const totalTrades = eligible.reduce((s, w) => s + w.trades, 0);
  const avgWR = eligible.reduce((s, w) => s + w.winRate, 0) / eligible.length;
  const totalPnL = eligible.reduce((s, w) => s + w.pnl, 0);

  if (totalTrades < 100) return -5 + totalTrades / 100;

  // Primary: pass rate (0-10)
  // Secondary: PnL and WR
  // Penalty: too few trades
  const fitness =
    passRate * 10 +
    Math.min(Math.max(totalPnL * 1.5, -3), 5) +
    (avgWR > 0.40 ? (avgWR - 0.40) * 15 : (avgWR - 0.40) * 5) +
    (totalTrades > 400 ? 0.5 : 0);

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
  const specs = buildParamSpecs();
  const dim = specs.length;

  log('============================================================');
  log('CMA-ES Full Hyperparameter Optimizer');
  log('============================================================');
  log(`Dimensions: ${dim}`);
  log(`  Weights: ${WEIGHT_NAMES.length}`);
  log(`  Regime thresholds: ${REGIME_LABELS.length}`);
  log(`  Hyperparameters: 3 (baseThreshold, obFreshnessHalfLife, atrExtensionBands)`);
  log(`Population: ${cli.populationSize}`);
  log(`Generations: ${cli.generations}`);
  log(`Sigma: ${cli.sigma}`);
  log(`Symbols: ${cli.symbols.join(', ')}`);
  log('');

  // Normalize initial params to [0, 1] then scale to bounds
  // CMA-ES works in the raw parameter space with bounds
  const initialMean = specs.map(s => s.initial);
  const lowerBounds = specs.map(s => s.min);
  const upperBounds = specs.map(s => s.max);

  const cmaes = new CMAES({
    dim,
    populationSize: cli.populationSize,
    initialSigma: cli.sigma,
    initialMean,
    lowerBounds,
    upperBounds,
    maxGenerations: cli.generations,
  });

  const wfConfig: Partial<WalkForwardConfig> = {
    symbols: cli.symbols,
    timeframe: cli.timeframe,
  };

  // Baseline
  log('--- Evaluating Baseline ---');
  const baselineRunner = createRunner(initialMean, specs);
  const baselineResult = await runWalkForward(baselineRunner, wfConfig, { quiet: true });
  const baselineFitness = computeFitness(baselineResult);

  const baseEligible = baselineResult.symbols.flatMap(s => s.windows).filter(w => w.trades > 0);
  const basePassRate = baseEligible.filter(w => w.passed).length / baseEligible.length;
  const baseTrades = baseEligible.reduce((s, w) => s + w.trades, 0);
  const basePnL = baseEligible.reduce((s, w) => s + w.pnl, 0);

  log(`Baseline: fitness=${baselineFitness.toFixed(3)}, passRate=${(basePassRate * 100).toFixed(1)}%, trades=${baseTrades}, PnL=${(basePnL * 100).toFixed(1)}%`);
  log('');

  // CMA-ES loop
  log('--- CMA-ES Optimization ---');

  while (!cmaes.shouldStop()) {
    const gen = cmaes.getGeneration();
    const population = cmaes.samplePopulation();
    const fitnesses: number[] = [];

    for (let i = 0; i < population.length; i++) {
      const runner = createRunner(population[i]!, specs);
      const result = await runWalkForward(runner, wfConfig, { quiet: true });
      fitnesses.push(computeFitness(result));
      process.stdout.write(fitnesses[i]! > baselineFitness ? '+' : '.');
    }
    process.stdout.write('\n');

    cmaes.update(population, fitnesses);

    const best = cmaes.getBest();
    const meanFit = fitnesses.reduce((a, b) => a + b, 0) / fitnesses.length;
    const genBest = Math.max(...fitnesses);

    log(
      `Gen ${gen.toString().padStart(3)}: ` +
      `mean=${meanFit.toFixed(3)}, genBest=${genBest.toFixed(3)}, ` +
      `allTimeBest=${best.fitness.toFixed(3)} (gen ${best.generation}), ` +
      `sigma=${cmaes.getSigma().toFixed(4)}`
    );

    // Show decoded best params periodically
    if ((gen + 1) % 5 === 0 || gen === 0) {
      const decoded = decodeParams(best.params, specs);
      log(`  baseThreshold=${decoded.baseThreshold.toFixed(2)}, halfLife=${decoded.obFreshnessHalfLife}, atrExt=${decoded.atrExtensionBands.toFixed(1)}`);
      const regStr = Object.entries(decoded.regimeThresholds).map(([k, v]) => `${k}:${v.toFixed(1)}`).join(', ');
      log(`  regimes: ${regStr}`);
    }
  }

  // Final evaluation
  log('');
  log('--- Final Evaluation ---');
  const best = cmaes.getBest();
  const bestRunner = createRunner(best.params, specs);
  const bestResult = await runWalkForward(bestRunner, wfConfig, { quiet: true });

  const bestEligible = bestResult.symbols.flatMap(s => s.windows).filter(w => w.trades > 0);
  const bestPassRate = bestEligible.filter(w => w.passed).length / bestEligible.length;
  const bestTrades = bestEligible.reduce((s, w) => s + w.trades, 0);
  const bestWR = bestEligible.reduce((s, w) => s + w.winRate, 0) / (bestEligible.length || 1);
  const bestPnL = bestEligible.reduce((s, w) => s + w.pnl, 0);

  const baseWR = baseEligible.reduce((s, w) => s + w.winRate, 0) / baseEligible.length;

  log('');
  log('============================================================');
  log('RESULTS: Baseline vs CMA-ES Full');
  log('============================================================');
  log(`  Metric        | Baseline       | CMA-ES         | Delta`);
  log(`  --------------+----------------+----------------+---------`);
  log(`  Pass Rate     | ${(basePassRate * 100).toFixed(1).padStart(12)}% | ${(bestPassRate * 100).toFixed(1).padStart(12)}% | ${((bestPassRate - basePassRate) * 100).toFixed(1).padStart(6)}pp`);
  log(`  Trades        | ${String(baseTrades).padStart(13)} | ${String(bestTrades).padStart(13)} | ${String(bestTrades - baseTrades).padStart(7)}`);
  log(`  Avg Win Rate  | ${baseWR.toFixed(1).padStart(12)}% | ${bestWR.toFixed(1).padStart(12)}% | ${(bestWR - baseWR).toFixed(1).padStart(6)}pp`);
  log(`  Total PnL     | ${(basePnL * 100).toFixed(1).padStart(12)}% | ${(bestPnL * 100).toFixed(1).padStart(12)}% | ${((bestPnL - basePnL) * 100).toFixed(1).padStart(6)}pp`);
  log(`  Fitness       | ${baselineFitness.toFixed(3).padStart(13)} | ${best.fitness.toFixed(3).padStart(13)} | ${(best.fitness - baselineFitness).toFixed(3).padStart(7)}`);

  const verdict = bestPassRate > basePassRate ? 'CMA-ES WINS' : bestPassRate === basePassRate ? 'TIE' : 'BASELINE WINS';
  log(`  VERDICT: ${verdict}`);
  log('============================================================');

  // Decoded best
  const decoded = decodeParams(best.params, specs);

  log('');
  log('Optimized weight multipliers:');
  for (const name of WEIGHT_NAMES) {
    const absW = decoded.weightMultipliers[name] ?? DEFAULT_WEIGHTS[name];
    const mult = absW / DEFAULT_WEIGHTS[name];
    log(`  ${name.padEnd(22)} = ${absW.toFixed(3)} (${mult.toFixed(2)}x)`);
  }

  log('');
  log('Optimized regime thresholds:');
  log(`  Base: ${decoded.baseThreshold.toFixed(2)}`);
  for (const [label, val] of Object.entries(decoded.regimeThresholds)) {
    log(`  ${label.padEnd(22)} = ${val.toFixed(2)}`);
  }
  log(`  OB freshness half-life: ${decoded.obFreshnessHalfLife}`);
  log(`  ATR extension bands: ${decoded.atrExtensionBands.toFixed(2)}`);

  // Per-symbol
  log('');
  log('Per-symbol breakdown:');
  for (const sym of bestResult.symbols) {
    const eligible = sym.windows.filter(w => w.trades > 0);
    const pr = eligible.filter(w => w.passed).length / (eligible.length || 1);
    const pnl = eligible.reduce((s, w) => s + w.pnl, 0);
    const trades = eligible.reduce((s, w) => s + w.trades, 0);
    log(`  ${sym.symbol}: passRate=${(pr * 100).toFixed(1)}%, trades=${trades}, PnL=${(pnl * 100).toFixed(1)}%`);
  }

  // Save
  const modelDir = path.join(process.cwd(), 'models');
  if (!fs.existsSync(modelDir)) fs.mkdirSync(modelDir, { recursive: true });

  const modelPath = path.join(modelDir, 'cmaes_full.json');
  fs.writeFileSync(modelPath, JSON.stringify({
    specs: specs.map(s => s.name),
    bestParams: best.params,
    decoded,
    fitness: best.fitness,
    baselineFitness,
    generation: best.generation,
    config: cli,
    history: cmaes.getResult().history,
  }, null, 2));
  log(`\nModel saved to ${modelPath}`);
}

main().catch((err) => {
  console.error('CMA-ES full training failed:', err);
  process.exit(1);
});
