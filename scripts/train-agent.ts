#!/usr/bin/env npx tsx
/**
 * Train Agent
 * CLI script for training the RL trading agent
 *
 * Usage:
 *   npx tsx scripts/train-agent.ts --data ./data/BTCUSDT_1h.json --episodes 1000 --output ./models/agent-v1.json
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
    episodes: parseInt(options['episodes'] || '500', 10),
    output: options['output'] || './models/agent.json',
    validateSplit: parseFloat(options['validate-split'] || '0.2'),
    initialCapital: parseFloat(options['initial-capital'] || '10000'),
    positionSize: parseFloat(options['position-size'] || '0.1'),
    learningRate: parseFloat(options['learning-rate'] || '0.001'),
    gamma: parseFloat(options['gamma'] || '0.99'),
    epsilonDecay: parseFloat(options['epsilon-decay'] || '0.995'),
    verbose: options['verbose'] !== 'false',
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
  };

  const envConfig: Partial<EnvironmentConfig> = {
    initialCapital: args.initialCapital,
    positionSize: args.positionSize,
    randomStart: true,
    maxDrawdownLimit: 0.25,
  };

  const dqnConfig: Partial<DQNConfig> = {
    learningRate: args.learningRate,
    gamma: args.gamma,
    epsilonDecay: args.epsilonDecay,
  };

  console.log('Training configuration:');
  console.log(`  Episodes: ${args.episodes}`);
  console.log(`  Train/Val split: ${(1 - args.validateSplit) * 100}%/${args.validateSplit * 100}%`);
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
