#!/usr/bin/env npx tsx
/**
 * Targeted Training Script
 * Focuses on BTC with Bullish OB signals only (the strongest ICT signal)
 *
 * Based on signal analysis:
 * - Bullish OB has 60-71% hit rate on BTC
 * - 0.54-1.38% edge depending on lookforward period
 * - This is the ONLY signal with consistent positive edge
 */

import fs from 'fs';
import path from 'path';

import '@tensorflow/tfjs-node';

import type { Candle } from '@/types';
import {
  Trainer,
  type TrainingConfig,
  type EnvironmentConfig,
  type DQNConfig,
} from '@/lib/rl';

function loadCandles(dataPath: string): Candle[] {
  const absolutePath = path.resolve(dataPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Data file not found: ${absolutePath}`);
  }
  const content = fs.readFileSync(absolutePath, 'utf-8');
  return JSON.parse(content) as Candle[];
}

async function main() {
  console.log('='.repeat(60));
  console.log('ICT Trading - Targeted BTC Training');
  console.log('Focus: Bullish OB (strongest ICT signal)');
  console.log('='.repeat(60));
  console.log();

  // Load BTC data only
  console.log('Loading BTC data...');
  const candles = loadCandles('./data/BTCUSDT_1h.json');
  console.log(`Loaded ${candles.length} candles\n`);

  // Simplified configuration - focus on exploitation not exploration
  const trainingConfig: Partial<TrainingConfig> = {
    episodes: 200,
    maxStepsPerEpisode: 500,
    trainSplit: 0.8,
    evalInterval: 20,
    saveInterval: 50,
    logInterval: 10,
    verbose: true,
    earlyStoppingPatience: 50,
    useRollingValidation: true,
    rollingTrainWindow: 6000, // 250 days of hourly data
    rollingTestWindow: 1500, // 62 days
    rollingStepSize: 500,
  };

  // Near-zero costs, focus on signal quality
  const envConfig: Partial<EnvironmentConfig> = {
    initialCapital: 10000,
    positionSize: 0.1,
    randomStart: true,
    maxDrawdownLimit: 0.30,
    // Near-zero transaction costs
    spread: 0.00001,
    commission: 0.00001,
    slippage: 0.00001,
    // No SL/TP - let the model learn pure signal value
    stopLossPercent: 0,
    takeProfitPercent: 0,
  };

  // Minimal model - reduce overfitting
  const dqnConfig: Partial<DQNConfig> = {
    hiddenLayers: [32, 16], // Very small model
    learningRate: 0.001, // Higher LR for faster convergence
    gamma: 0.95, // Shorter horizon
    epsilonStart: 0.5, // Less exploration - we know the signal
    epsilonEnd: 0.05,
    epsilonDecay: 0.99,
    dropout: 0.3,
    l2Regularization: 0.02,
    batchSize: 32,
    replayBufferSize: 5000, // Smaller buffer
    targetUpdateFreq: 200,
  };

  // Reward config - pure PnL focus
  const rewardConfig = {
    pnlWeight: 1.0,
    sharpeWeight: 0.0,
    drawdownWeight: 0.0,
    ictAlignmentWeight: 0.0,
  };

  console.log('Training configuration:');
  console.log(`  Model: [32, 16] (minimal)`);
  console.log(`  Episodes: 200`);
  console.log(`  Transaction costs: near-zero`);
  console.log(`  Reward: pure PnL`);
  console.log();

  let bestSharpe = -Infinity;
  let bestWeights = null;

  const trainer = new Trainer(
    candles,
    trainingConfig,
    envConfig,
    dqnConfig,
    {},
    rewardConfig,
    {
      onEpisodeEnd: (metrics) => {
        if (metrics.episode % 20 === 0) {
          console.log(`  Episode ${metrics.episode}: ε=${metrics.epsilon.toFixed(3)}`);
        }
      },
      onEvaluation: (result) => {
        const s = result.metrics.sharpeRatio;
        const wr = result.metrics.winRate;
        console.log(`  Eval: Sharpe=${s.toFixed(2)}, WinRate=${wr.toFixed(1)}%`);
        if (s > bestSharpe) {
          bestSharpe = s;
          console.log(`    ★ New best Sharpe: ${s.toFixed(3)}`);
        }
      },
      onCheckpoint: (weights) => {
        bestWeights = weights;
      },
    }
  );

  process.on('SIGINT', () => {
    console.log('\nInterrupted!');
    trainer.stop();
  });

  console.log('Starting training...\n');
  const startTime = Date.now();

  try {
    const result = await trainer.train();
    const duration = (Date.now() - startTime) / 1000;

    console.log('\n' + '='.repeat(60));
    console.log('Training Complete!');
    console.log('='.repeat(60));
    console.log(`Duration: ${duration.toFixed(1)}s`);

    const final = result.finalEvaluation;
    console.log('\nFinal Evaluation:');
    console.log(`  Sharpe: ${final.metrics.sharpeRatio.toFixed(3)}`);
    console.log(`  Win Rate: ${final.metrics.winRate.toFixed(1)}%`);
    console.log(`  Total PnL: $${final.metrics.totalPnL.toFixed(2)}`);
    console.log(`  Trades: ${final.metrics.totalTrades}`);

    // Walk-forward summary
    if (result.walkForwardMetrics && result.walkForwardMetrics.length > 0) {
      const wf = result.walkForwardMetrics;
      console.log('\nWalk-Forward Windows:');
      console.log('Window | Val WR | Val Sharpe');
      console.log('-'.repeat(30));

      let positiveSharpWindows = 0;
      for (let i = 0; i < wf.length; i++) {
        const m = wf[i]!;
        const indicator = m.valSharpe > 0 ? '✓' : '✗';
        console.log(`  ${i + 1}    | ${m.valWinRate.toFixed(1)}% | ${m.valSharpe.toFixed(2)} ${indicator}`);
        if (m.valSharpe > 0) positiveSharpWindows++;
      }

      console.log('\nSUCCESS CRITERIA:');
      const avgGap = wf.reduce((a, m) => a + (m.trainWinRate - m.valWinRate), 0) / wf.length;
      console.log(`  Gap < 20%: ${avgGap.toFixed(1)}% ${avgGap < 20 ? '✓' : '✗'}`);
      console.log(`  Positive Sharpe windows: ${positiveSharpWindows}/${wf.length} ${positiveSharpWindows > 0 ? '✓' : '✗'}`);
    }

    // Save model
    const weights = await result.agent.saveWeights();
    const outputPath = './models/targeted-btc.json';
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outputPath, JSON.stringify(weights, null, 2));
    console.log(`\nModel saved to ${outputPath}`);

    result.agent.dispose();
  } catch (error) {
    console.error('Training error:', error);
    process.exit(1);
  }
}

main();
