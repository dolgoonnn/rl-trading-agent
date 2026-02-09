#!/usr/bin/env npx tsx
/**
 * Train Signal Filter (Contextual Bandit)
 *
 * Trains a small neural network to decide take/skip on confluence signals.
 * Much simpler than PPO weight optimizer — each decision is independent.
 *
 * Approach:
 * 1. Scan all training candles to collect signal candidates with outcomes
 * 2. Build labeled dataset: (state, outcome) pairs
 * 3. Train classifier: inputs = signal state, output = P(take)
 * 4. Compare WF pass rate with filter vs without
 *
 * Usage:
 *   npx tsx scripts/train-signal-filter.ts
 *   npx tsx scripts/train-signal-filter.ts --threshold 2.0 --min-rr 1.0
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import {
  SignalFilterEnvironment,
  SIGNAL_FILTER_STATE_SIZE,
  type SignalCandidate,
  type SignalOutcome,
} from '../src/lib/rl/environment/signal-filter-env';
import {
  runWalkForward,
  type WalkForwardStrategyRunner,
  type TradeResult,
  type WalkForwardConfig,
} from './walk-forward-validate';
import {
  ConfluenceScorer,
  type ConfluenceConfig,
  PRODUCTION_STRATEGY_CONFIG,
} from '../src/lib/rl/strategies/confluence-scorer';

// ============================================
// Dataset Building
// ============================================

interface LabeledSignal {
  state: number[];
  outcome: SignalOutcome;
  symbol: string;
}

function buildDataset(
  symbols: string[],
  dataDir: string,
  timeframe: string,
): LabeledSignal[] {
  const env = new SignalFilterEnvironment();
  const dataset: LabeledSignal[] = [];

  for (const symbol of symbols) {
    const filePath = path.join(dataDir, `${symbol}_${timeframe}.json`);
    if (!fs.existsSync(filePath)) continue;

    const candles: Candle[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    log(`[Data] ${symbol}: ${candles.length} candles`);

    // Use first 80% for training, last 20% for quick validation
    const splitIndex = Math.floor(candles.length * 0.8);

    // Collect candidates from training portion
    const warmup = 200;
    const candidates = env.collectCandidates(candles, warmup, splitIndex);

    log(`[Data] ${symbol}: ${candidates.length} signal candidates`);

    // Simulate outcomes for each
    for (const candidate of candidates) {
      const outcome = env.simulateOutcome(candles, candidate.signal, candidate.candleIndex);
      dataset.push({
        state: candidate.state,
        outcome,
        symbol,
      });
    }
  }

  return dataset;
}

// ============================================
// Simple Logistic Classifier (no TF dependency)
// ============================================

interface FilterModel {
  weights: number[]; // 12 weights + 1 bias = 13 params
  bias: number;
  threshold: number; // P(take) > threshold → take
}

function sigmoid(x: number): number {
  if (x > 20) return 1;
  if (x < -20) return 0;
  return 1 / (1 + Math.exp(-x));
}

function predict(model: FilterModel, state: number[]): number {
  let sum = model.bias;
  for (let i = 0; i < model.weights.length; i++) {
    sum += model.weights[i]! * (state[i] ?? 0);
  }
  return sigmoid(sum);
}

function trainLogistic(
  dataset: LabeledSignal[],
  epochs: number = 200,
  lr: number = 0.01,
): FilterModel {
  const nFeatures = SIGNAL_FILTER_STATE_SIZE;
  const weights = new Array(nFeatures).fill(0);
  const bias = 0;

  // Label: 1 if trade was profitable, 0 if loss
  const labels = dataset.map(d => d.outcome.won ? 1 : 0);
  const states = dataset.map(d => d.state);

  let currentWeights = [...weights];
  let currentBias = bias;

  for (let epoch = 0; epoch < epochs; epoch++) {
    // Mini-batch gradient descent
    let totalLoss = 0;
    const gradW = new Array(nFeatures).fill(0);
    let gradB = 0;

    for (let i = 0; i < dataset.length; i++) {
      const state = states[i]!;
      const label = labels[i]!;

      let z = currentBias;
      for (let j = 0; j < nFeatures; j++) {
        z += currentWeights[j]! * (state[j] ?? 0);
      }
      const pred = sigmoid(z);

      // Binary cross-entropy gradient
      const error = pred - label;
      totalLoss += label === 1 ? -Math.log(pred + 1e-10) : -Math.log(1 - pred + 1e-10);

      for (let j = 0; j < nFeatures; j++) {
        gradW[j]! += error * (state[j] ?? 0);
      }
      gradB += error;
    }

    // Update with L2 regularization
    const n = dataset.length;
    const l2 = 0.001;
    for (let j = 0; j < nFeatures; j++) {
      currentWeights[j] = currentWeights[j]! - lr * (gradW[j]! / n + l2 * currentWeights[j]!);
    }
    currentBias -= lr * gradB / n;

    if (epoch % 50 === 0) {
      const avgLoss = totalLoss / n;
      const accuracy = dataset.reduce((acc, d, i) => {
        const p = predict({ weights: currentWeights, bias: currentBias, threshold: 0.5 }, d.state);
        return acc + ((p > 0.5) === (labels[i] === 1) ? 1 : 0);
      }, 0) / n;
      log(`  Epoch ${epoch}: loss=${avgLoss.toFixed(4)}, accuracy=${(accuracy * 100).toFixed(1)}%`);
    }
  }

  return { weights: currentWeights, bias: currentBias, threshold: 0.5 };
}

// ============================================
// Find Optimal Threshold
// ============================================

function findOptimalThreshold(
  model: FilterModel,
  dataset: LabeledSignal[],
): number {
  const thresholds = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7];
  let bestThreshold = 0.5;
  let bestPnL = -Infinity;

  for (const t of thresholds) {
    let totalPnL = 0;
    let trades = 0;
    let wins = 0;

    for (const d of dataset) {
      const p = predict(model, d.state);
      if (p > t) {
        totalPnL += d.outcome.pnl;
        trades++;
        if (d.outcome.won) wins++;
      }
    }

    const wr = trades > 0 ? wins / trades : 0;
    log(`  Threshold ${t.toFixed(2)}: ${trades} trades (${(wr * 100).toFixed(1)}% WR), PnL=${(totalPnL * 100).toFixed(1)}%`);

    if (totalPnL > bestPnL) {
      bestPnL = totalPnL;
      bestThreshold = t;
    }
  }

  return bestThreshold;
}

// ============================================
// WF Runner with Signal Filter
// ============================================

function createFilteredRunner(
  model: FilterModel,
  baseThreshold: number,
): WalkForwardStrategyRunner {
  return {
    name: `SignalFilter(p=${model.threshold.toFixed(2)},base=${baseThreshold})`,

    async run(
      trainCandles: Candle[],
      valCandles: Candle[],
      _meta?: { symbol?: string },
    ): Promise<TradeResult[]> {
      const scorerConfig: Partial<ConfluenceConfig> = {
        minThreshold: baseThreshold,
        activeStrategies: ['order_block'],
        suppressedRegimes: ['ranging+normal', 'ranging+high', 'downtrend+high'],
        obFreshnessHalfLife: 15,
        atrExtensionBands: 3.0,
        strategyConfig: {
          ...PRODUCTION_STRATEGY_CONFIG,
          slPlacementMode: 'dynamic_rr' as const,
        },
      };

      const env = new SignalFilterEnvironment({
        confluenceConfig: scorerConfig,
      });

      const allCandles = [...trainCandles, ...valCandles];
      const valStartIndex = trainCandles.length;
      const friction = 0.0007;

      // Collect candidates in validation period
      const candidates = env.collectCandidates(allCandles, valStartIndex, allCandles.length);

      const trades: TradeResult[] = [];

      for (const candidate of candidates) {
        // PPO filter: should we take this signal?
        const pTake = predict(model, candidate.state);
        if (pTake <= model.threshold) continue; // Skip

        // Simulate the trade
        const outcome = env.simulateOutcome(allCandles, candidate.signal, candidate.candleIndex);
        const sig = candidate.signal.signal;
        const candle = allCandles[candidate.candleIndex];

        trades.push({
          entryTimestamp: candle?.timestamp ?? 0,
          exitTimestamp: candle?.timestamp ?? 0, // approximate
          direction: sig.direction,
          entryPrice: sig.entryPrice,
          exitPrice: sig.entryPrice * (1 + outcome.pnl),
          pnlPercent: outcome.pnl,
          strategy: sig.strategy,
        });
      }

      return trades;
    },
  };
}

// ============================================
// Baseline Runner (same config, no filter)
// ============================================

function createBaselineRunner(baseThreshold: number): WalkForwardStrategyRunner {
  return {
    name: `Baseline(threshold=${baseThreshold})`,

    async run(
      trainCandles: Candle[],
      valCandles: Candle[],
      _meta?: { symbol?: string },
    ): Promise<TradeResult[]> {
      const scorerConfig: Partial<ConfluenceConfig> = {
        minThreshold: baseThreshold,
        activeStrategies: ['order_block'],
        suppressedRegimes: ['ranging+normal', 'ranging+high', 'downtrend+high'],
        obFreshnessHalfLife: 15,
        atrExtensionBands: 3.0,
        strategyConfig: {
          ...PRODUCTION_STRATEGY_CONFIG,
          slPlacementMode: 'dynamic_rr' as const,
        },
      };

      const env = new SignalFilterEnvironment({
        confluenceConfig: scorerConfig,
      });

      const allCandles = [...trainCandles, ...valCandles];
      const valStartIndex = trainCandles.length;

      const candidates = env.collectCandidates(allCandles, valStartIndex, allCandles.length);
      const trades: TradeResult[] = [];

      for (const candidate of candidates) {
        const outcome = env.simulateOutcome(allCandles, candidate.signal, candidate.candleIndex);
        const sig = candidate.signal.signal;
        const candle = allCandles[candidate.candleIndex];

        trades.push({
          entryTimestamp: candle?.timestamp ?? 0,
          exitTimestamp: candle?.timestamp ?? 0,
          direction: sig.direction,
          entryPrice: sig.entryPrice,
          exitPrice: sig.entryPrice * (1 + outcome.pnl),
          pnlPercent: outcome.pnl,
          strategy: sig.strategy,
        });
      }

      return trades;
    },
  };
}

// ============================================
// Main
// ============================================

function log(msg: string): void {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] ${msg}`);
}

async function main(): Promise<void> {
  const dataDir = path.join(process.cwd(), 'data');
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  const timeframe = '1h';

  log('============================================================');
  log('Signal Filter Training (Contextual Bandit)');
  log('============================================================');
  log(`Symbols: ${symbols.join(', ')}`);
  log(`Features: ${SIGNAL_FILTER_STATE_SIZE}`);
  log(`Model: Logistic Regression (${SIGNAL_FILTER_STATE_SIZE + 1} params)`);
  log('');

  // Phase 1: Build dataset
  log('--- Phase 1: Building Dataset ---');
  const dataset = buildDataset(symbols, dataDir, timeframe);

  const wins = dataset.filter(d => d.outcome.won).length;
  log(`Total signals: ${dataset.length}`);
  log(`Wins: ${wins} (${(wins / dataset.length * 100).toFixed(1)}%)`);
  log(`Avg PnL: ${(dataset.reduce((s, d) => s + d.outcome.pnl, 0) / dataset.length * 100).toFixed(2)}%`);
  log('');

  // Phase 2: Train classifier
  log('--- Phase 2: Training Logistic Classifier ---');
  const model = trainLogistic(dataset, 300, 0.02);
  log('');

  // Print learned weights
  const featureNames = [
    'confluenceScore', 'riskReward', 'direction',
    'regimeTrend', 'regimeVol', 'trendStrength', 'efficiency', 'atrPercentile',
    'structAlign', 'liqSweep', 'obFreshness', 'rrScore',
  ];
  log('Learned weights:');
  for (let i = 0; i < model.weights.length; i++) {
    log(`  ${featureNames[i]?.padEnd(20) ?? `f${i}`.padEnd(20)} = ${model.weights[i]!.toFixed(4)}`);
  }
  log(`  ${'bias'.padEnd(20)} = ${model.bias.toFixed(4)}`);
  log('');

  // Phase 3: Find optimal threshold
  log('--- Phase 3: Threshold Optimization ---');
  const bestThreshold = findOptimalThreshold(model, dataset);
  model.threshold = bestThreshold;
  log(`Best threshold: ${bestThreshold}`);
  log('');

  // Phase 4: Walk-forward comparison
  log('--- Phase 4: Walk-Forward Validation ---');
  const baseThreshold = 2.0;
  const wfConfig: Partial<WalkForwardConfig> = { symbols, timeframe };

  log('Running baseline (no filter)...');
  const baselineRunner = createBaselineRunner(baseThreshold);
  const baselineResult = await runWalkForward(baselineRunner, wfConfig, { quiet: true });

  log('Running with signal filter...');
  const filteredRunner = createFilteredRunner(model, baseThreshold);
  const filteredResult = await runWalkForward(filteredRunner, wfConfig, { quiet: true });

  // Compare
  const baseEligible = baselineResult.symbols.flatMap(s => s.windows).filter(w => w.trades > 0);
  const filtEligible = filteredResult.symbols.flatMap(s => s.windows).filter(w => w.trades > 0);

  const basePass = baseEligible.filter(w => w.passed).length / (baseEligible.length || 1);
  const filtPass = filtEligible.filter(w => w.passed).length / (filtEligible.length || 1);

  const baseTrades = baseEligible.reduce((s, w) => s + w.trades, 0);
  const filtTrades = filtEligible.reduce((s, w) => s + w.trades, 0);

  const baseWR = baseEligible.reduce((s, w) => s + w.winRate, 0) / (baseEligible.length || 1);
  const filtWR = filtEligible.reduce((s, w) => s + w.winRate, 0) / (filtEligible.length || 1);

  const basePnL = baseEligible.reduce((s, w) => s + w.pnl, 0);
  const filtPnL = filtEligible.reduce((s, w) => s + w.pnl, 0);

  log('');
  log('============================================================');
  log('RESULTS: Baseline vs Signal Filter');
  log('============================================================');
  log(`  Metric        | Baseline       | Signal Filter  | Delta`);
  log(`  --------------+----------------+----------------+---------`);
  log(`  Pass Rate     | ${(basePass * 100).toFixed(1).padStart(12)}% | ${(filtPass * 100).toFixed(1).padStart(12)}% | ${((filtPass - basePass) * 100).toFixed(1).padStart(6)}pp`);
  log(`  Trades        | ${String(baseTrades).padStart(13)} | ${String(filtTrades).padStart(13)} | ${String(filtTrades - baseTrades).padStart(7)}`);
  log(`  Avg Win Rate  | ${baseWR.toFixed(1).padStart(12)}% | ${filtWR.toFixed(1).padStart(12)}% | ${(filtWR - baseWR).toFixed(1).padStart(6)}pp`);
  log(`  Total PnL     | ${(basePnL * 100).toFixed(1).padStart(12)}% | ${(filtPnL * 100).toFixed(1).padStart(12)}% | ${((filtPnL - basePnL) * 100).toFixed(1).padStart(6)}pp`);

  const verdict = filtPass > basePass ? 'FILTER WINS' : filtPass === basePass ? 'TIE' : 'BASELINE WINS';
  log(`  VERDICT: ${verdict}`);
  log('============================================================');

  // Save model
  const modelPath = path.join(process.cwd(), 'models', 'signal_filter.json');
  fs.writeFileSync(modelPath, JSON.stringify({ model, featureNames, datasetSize: dataset.length }, null, 2));
  log(`Model saved to ${modelPath}`);
}

main().catch((err) => {
  console.error('Training failed:', err);
  process.exit(1);
});
