#!/usr/bin/env npx tsx
/**
 * Final Training Attempt
 * Based on backtest insights:
 * - Use both OB types (bullish and bearish together)
 * - Short hold period (10-20 bars) works best on OOS
 * - Simple model to prevent overfitting
 * - Accept small edge (~0.5-0.8 Sharpe target)
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
  console.log('ICT Trading - Final Training Attempt');
  console.log('='.repeat(60));
  console.log();
  console.log('Key Insights from Backtest:');
  console.log('  - Bullish OB overfits (reverses in OOS)');
  console.log('  - Both OB types together is more robust');
  console.log('  - Short holds (10-20 bars) work best');
  console.log('  - Target Sharpe: 0.5-0.8 (realistic)');
  console.log();

  // Load BTC data
  const candles = loadCandles('./data/BTCUSDT_1h.json');
  console.log(`Loaded ${candles.length} candles\n`);

  // Conservative training config
  const trainingConfig: Partial<TrainingConfig> = {
    episodes: 300,
    maxStepsPerEpisode: 200, // Shorter episodes
    trainSplit: 0.8,
    evalInterval: 20,
    saveInterval: 100,
    logInterval: 20,
    verbose: true,
    earlyStoppingPatience: 80, // More patience
    useRollingValidation: true,
    rollingTrainWindow: 8000, // ~333 days
    rollingTestWindow: 2000, // ~83 days
    rollingStepSize: 1000,
  };

  // Environment optimized for short hold
  const envConfig: Partial<EnvironmentConfig> = {
    initialCapital: 10000,
    positionSize: 0.05, // Smaller positions
    randomStart: true,
    maxDrawdownLimit: 0.20,
    // Minimal costs
    spread: 0.0001,
    commission: 0.0004, // 0.04%
    slippage: 0.0001,
    // Encourage short holds with tight stops
    stopLossPercent: 0.02, // 2% stop
    takeProfitPercent: 0.02, // 2% TP - 1:1 RR initially
  };

  // Simple, regularized DQN
  const dqnConfig: Partial<DQNConfig> = {
    hiddenLayers: [64, 32], // Small network
    learningRate: 0.0005,
    gamma: 0.95, // Shorter horizon
    epsilonStart: 0.8, // Less exploration (we know signals work)
    epsilonEnd: 0.1,
    epsilonDecay: 0.995,
    dropout: 0.4, // Heavy dropout
    l2Regularization: 0.03, // Strong L2
    batchSize: 64,
    replayBufferSize: 10000,
    targetUpdateFreq: 100,
  };

  // Pure PnL reward - simpler signal
  const rewardConfig = {
    pnlWeight: 1.0,
    sharpeWeight: 0.0,
    drawdownWeight: 0.0,
    ictAlignmentWeight: 0.0,
  };

  console.log('Configuration:');
  console.log(`  Model: [64, 32] with 40% dropout`);
  console.log(`  Episodes: 300`);
  console.log(`  SL/TP: 2%/2% (1:1 RR)`);
  console.log(`  Walk-forward: 8000/2000/1000`);
  console.log();

  let bestSharpe = -Infinity;

  const trainer = new Trainer(
    candles,
    trainingConfig,
    envConfig,
    dqnConfig,
    {},
    rewardConfig,
    {
      onEpisodeEnd: (metrics) => {
        if (metrics.episode % 50 === 0) {
          const progress = (metrics.episode / 300) * 100;
          console.log(`Progress: ${progress.toFixed(0)}%`);
        }
      },
      onEvaluation: (result) => {
        const s = result.metrics.sharpeRatio;
        const wr = result.metrics.winRate;
        console.log(`  Eval: Sharpe=${s.toFixed(2)}, WR=${wr.toFixed(1)}%, Trades=${result.metrics.totalTrades}`);
        if (s > bestSharpe) {
          bestSharpe = s;
          if (s > 0) {
            console.log(`    ★★★ NEW BEST SHARPE: ${s.toFixed(3)} ★★★`);
          }
        }
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
    console.log('TRAINING COMPLETE');
    console.log('='.repeat(60));
    console.log(`Duration: ${(duration / 60).toFixed(1)} minutes`);

    const final = result.finalEvaluation;
    console.log('\nFinal Validation:');
    console.log(`  Sharpe: ${final.metrics.sharpeRatio.toFixed(3)}`);
    console.log(`  Win Rate: ${final.metrics.winRate.toFixed(1)}%`);
    console.log(`  Trades: ${final.metrics.totalTrades}`);
    console.log(`  PnL: $${final.metrics.totalPnL.toFixed(2)}`);

    if (result.walkForwardMetrics && result.walkForwardMetrics.length > 0) {
      const wf = result.walkForwardMetrics;
      console.log('\n=== WALK-FORWARD RESULTS ===');
      console.log('Window | Val WR | Val Sharpe');
      console.log('-'.repeat(35));

      let positiveCount = 0;
      let totalGap = 0;

      for (let i = 0; i < wf.length; i++) {
        const m = wf[i]!;
        const gap = m.trainWinRate - m.valWinRate;
        totalGap += gap;
        if (m.valSharpe > 0) positiveCount++;

        const indicator = m.valSharpe > 0 ? '✓' : '✗';
        console.log(`  ${(i + 1).toString().padStart(2)}   | ${m.valWinRate.toFixed(1).padStart(5)}% | ${m.valSharpe.toFixed(2).padStart(7)} ${indicator}`);
      }

      const avgGap = totalGap / wf.length;
      console.log('-'.repeat(35));
      console.log(`\nSUCCESS CRITERIA:`);
      console.log(`  ✓ Gap < 20%: ${avgGap.toFixed(1)}% ${avgGap < 20 ? '✓' : '✗'}`);
      console.log(`  ✓ Positive Sharpe windows: ${positiveCount}/${wf.length} ${positiveCount > 0 ? '✓' : '✗'}`);

      if (avgGap < 20 && positiveCount > 0) {
        console.log('\n🎉 SUCCESS CRITERIA MET! 🎉');
      }
    }

    // Save model
    const weights = await result.agent.saveWeights();
    const outputPath = './models/final-agent.json';
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(weights, null, 2));
    console.log(`\nModel saved to ${outputPath}`);

    result.agent.dispose();
  } catch (error) {
    console.error('Training error:', error);
    process.exit(1);
  }
}

main();
