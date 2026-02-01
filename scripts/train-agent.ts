#!/usr/bin/env npx tsx
/**
 * Train Agent
 * CLI script for training the RL trading agent with walk-forward validation
 *
 * Usage:
 *   npx tsx scripts/train-agent.ts --data ./data/BTCUSDT_1h.json --episodes 100
 *   npx tsx scripts/train-agent.ts --data ./data/BTCUSDT_1h.json --episodes 500 --no-walkforward
 */

import fs from 'fs';
import path from 'path';

import '@tensorflow/tfjs-node';

import type { Candle } from '@/types';
import {
  Trainer,
  type SerializedWeights,
  type TrainingConfig,
  type EnvironmentConfig,
  type DQNConfig,
} from '@/lib/rl';

interface Args {
  data: string;
  episodes: number;
  output: string;
  validateSplit: number;
  initialCapital: number;
  positionSize: number;
  learningRate: number;
  gamma: number;
  epsilonDecay: number;
  verbose: boolean;
  walkforward: boolean;
  trainWindow: number;
  testWindow: number;
  stepSize: number;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const options: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg?.startsWith('--')) {
      const key = arg.replace(/^--/, '');
      const value = args[i + 1];
      if (value && !value.startsWith('--')) {
        options[key] = value;
        i++;
      } else {
        options[key] = 'true';
      }
    }
  }

  return {
    data: options['data'] || './data/BTCUSDT_1h.json',
    episodes: parseInt(options['episodes'] || '100', 10),
    output: options['output'] || './models/agent.json',
    validateSplit: parseFloat(options['validate-split'] || '0.2'),
    initialCapital: parseFloat(options['initial-capital'] || '10000'),
    positionSize: parseFloat(options['position-size'] || '0.1'),
    learningRate: parseFloat(options['learning-rate'] || '0.0003'),
    gamma: parseFloat(options['gamma'] || '0.99'),
    epsilonDecay: parseFloat(options['epsilon-decay'] || '0.995'),
    verbose: options['verbose'] !== 'false',
    // Walk-forward validation (enabled by default)
    walkforward: options['no-walkforward'] !== 'true',
    trainWindow: parseInt(options['train-window'] || '4000', 10),
    testWindow: parseInt(options['test-window'] || '1000', 10),
    stepSize: parseInt(options['step-size'] || '500', 10),
  };
}

function loadCandles(dataPath: string): Candle[] {
  const absolutePath = path.resolve(dataPath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Data file not found: ${absolutePath}`);
  }

  const content = fs.readFileSync(absolutePath, 'utf-8');
  const data = JSON.parse(content) as Candle[];

  // Validate data structure
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('Data file must contain a non-empty array of candles');
  }

  const sample = data[0];
  if (!sample || typeof sample.timestamp !== 'number' || typeof sample.close !== 'number') {
    throw new Error('Invalid candle data structure');
  }

  return data;
}

function saveModel(weights: SerializedWeights, outputPath: string): void {
  const absolutePath = path.resolve(outputPath);
  const dir = path.dirname(absolutePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(absolutePath, JSON.stringify(weights, null, 2));
  console.log(`\nModel saved to ${absolutePath}`);
}

async function main() {
  const args = parseArgs();

  console.log('='.repeat(60));
  console.log('ICT Trading - RL Agent Trainer');
  console.log('='.repeat(60));
  console.log();

  // Load data
  console.log(`Loading data from ${args.data}...`);
  const candles = loadCandles(args.data);
  console.log(`Loaded ${candles.length} candles`);

  const firstCandle = candles[0];
  const lastCandle = candles[candles.length - 1];
  if (firstCandle && lastCandle) {
    console.log(`Period: ${new Date(firstCandle.timestamp).toISOString()} to ${new Date(lastCandle.timestamp).toISOString()}`);
  }
  console.log();

  // Configuration
  const trainingConfig: Partial<TrainingConfig> = {
    episodes: args.episodes,
    maxStepsPerEpisode: 500, // Limited steps per episode
    trainSplit: 1 - args.validateSplit,
    evalInterval: 10,
    saveInterval: 50,
    logInterval: 5,
    verbose: args.verbose,
    earlyStoppingPatience: 30,
    // Walk-forward validation
    useRollingValidation: args.walkforward,
    rollingTrainWindow: args.trainWindow,
    rollingTestWindow: args.testWindow,
    rollingStepSize: args.stepSize,
  };

  const envConfig: Partial<EnvironmentConfig> = {
    initialCapital: args.initialCapital,
    positionSize: args.positionSize,
    randomStart: true,
    maxDrawdownLimit: 0.25,
    // Near-zero costs
    spread: 0.00001,
    commission: 0.0001,
    slippage: 0.00001,
    // Tight SL/TP to limit loss size and lock profits
    stopLossPercent: 0.015, // 1.5% stop - smaller to limit losses
    takeProfitPercent: 0.03, // 3% TP - 2:1 risk-reward
  };

  const dqnConfig: Partial<DQNConfig> = {
    learningRate: args.learningRate,
    gamma: args.gamma,
    epsilonDecay: args.epsilonDecay,
  };

  console.log('Training configuration:');
  console.log(`  Episodes: ${args.episodes}`);
  console.log(`  Walk-forward: ${args.walkforward ? 'ENABLED' : 'disabled'}`);
  if (args.walkforward) {
    console.log(`    Train window: ${args.trainWindow} candles`);
    console.log(`    Test window: ${args.testWindow} candles`);
    console.log(`    Step size: ${args.stepSize} candles`);
  } else {
    console.log(`  Train/Val split: ${(1 - args.validateSplit) * 100}%/${args.validateSplit * 100}%`);
  }
  console.log(`  Initial capital: $${args.initialCapital}`);
  console.log(`  Position size: ${args.positionSize * 100}%`);
  console.log(`  Learning rate: ${args.learningRate}`);
  console.log(`  Gamma: ${args.gamma}`);
  console.log(`  Epsilon decay: ${args.epsilonDecay}`);
  console.log();

  // Best model tracking
  let bestWeights: SerializedWeights | null = null;
  let bestSharpe = -Infinity;

  // Create trainer
  const trainer = new Trainer(
    candles,
    trainingConfig,
    envConfig,
    dqnConfig,
    {},
    {},
    {
      onEpisodeEnd: (metrics) => {
        // Progress indicator
        if (metrics.episode % 50 === 0) {
          const progress = (metrics.episode / args.episodes) * 100;
          console.log(`Progress: ${progress.toFixed(0)}%`);
        }
      },
      onEvaluation: (result) => {
        if (result.metrics.sharpeRatio > bestSharpe) {
          bestSharpe = result.metrics.sharpeRatio;
          console.log(`\n  New best Sharpe: ${bestSharpe.toFixed(3)}`);
        }
      },
      onCheckpoint: (weights) => {
        // Track best model
        if (weights.state.episodeCount > 0) {
          bestWeights = weights;
        }
      },
      onLog: () => {
        // Already printed by trainer
      },
    }
  );

  // Handle interrupts
  process.on('SIGINT', () => {
    console.log('\n\nInterrupted! Saving current model...');
    trainer.stop();
  });

  // Train
  console.log('Starting training...\n');
  const startTime = Date.now();

  try {
    const result = await trainer.train();
    const duration = (Date.now() - startTime) / 1000;

    console.log('\n' + '='.repeat(60));
    console.log('Training Complete!');
    console.log('='.repeat(60));
    console.log(`Duration: ${duration.toFixed(1)} seconds`);
    console.log(`Episodes: ${result.metrics.length}`);
    console.log();

    // Final evaluation summary
    const final = result.finalEvaluation;
    console.log('Final Evaluation (Validation Set):');
    console.log(`  Total PnL: $${final.metrics.totalPnL.toFixed(2)}`);
    console.log(`  Total Trades: ${final.metrics.totalTrades}`);
    console.log(`  Win Rate: ${final.metrics.winRate.toFixed(1)}%`);
    console.log(`  Sharpe Ratio: ${final.metrics.sharpeRatio.toFixed(3)}`);
    console.log(`  Max Drawdown: ${final.metrics.maxDrawdown.toFixed(1)}%`);
    console.log();

    // Walk-forward summary if available
    if (result.walkForwardMetrics && result.walkForwardMetrics.length > 0) {
      const wf = result.walkForwardMetrics;
      const avgGap = wf.reduce((a, m) => a + (m.trainWinRate - m.valWinRate), 0) / wf.length;
      const avgValSharpe = wf.reduce((a, m) => a + m.valSharpe, 0) / wf.length;
      const positiveSharpWindows = wf.filter(m => m.valSharpe > 0).length;

      console.log('Walk-Forward Summary:');
      console.log(`  Windows tested: ${wf.length}`);
      console.log(`  Avg train/val gap: ${avgGap.toFixed(1)}%`);
      console.log(`  Avg validation Sharpe: ${avgValSharpe.toFixed(2)}`);
      console.log(`  Windows with positive Sharpe: ${positiveSharpWindows}/${wf.length}`);
      console.log();
    }

    // Save model
    const weights = await result.agent.saveWeights();
    saveModel(weights, args.output);

    // Save best model if different
    if (bestWeights && bestWeights !== weights) {
      const bestPath = args.output.replace('.json', '-best.json');
      saveModel(bestWeights, bestPath);
    }

    // Cleanup
    result.agent.dispose();

    console.log('\nDone!');
  } catch (error) {
    console.error('\nTraining error:', error);

    // Try to save what we have
    if (bestWeights) {
      console.log('Saving best model so far...');
      saveModel(bestWeights, args.output);
    }

    process.exit(1);
  }
}

main();
