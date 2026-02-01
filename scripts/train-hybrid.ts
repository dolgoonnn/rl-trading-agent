#!/usr/bin/env npx tsx
/**
 * Train Hybrid Agent
 * CLI script for training the hybrid rule+RL trading agent
 *
 * Architecture:
 * - Rule-based entries: ICT confluence scoring (3+ factors)
 * - RL-controlled exits: 4-action agent for optimal exit timing
 *
 * Usage:
 *   npx tsx scripts/train-hybrid.ts --data ./data/BTCUSDT_1h.json --episodes 200
 *   npx tsx scripts/train-hybrid.ts --data ./data/BTCUSDT_1h.json --episodes 500 --min-confluence 4
 */

import fs from 'fs';
import path from 'path';

import '@tensorflow/tfjs-node';
import * as tf from '@tensorflow/tfjs';

import type { Candle } from '@/types';
import {
  HybridTradingEnvironment,
  DQNAgent,
  ReplayBuffer,
  type SerializedWeights,
  type DQNConfig,
  type TradeRecord,
  type Portfolio,
  ExitActions,
  type ExitAction,
  type HybridEnvConfig,
  type EntryFilterConfig,
} from '@/lib/rl';

interface Args {
  data: string;
  episodes: number;
  output: string;
  // Entry filter
  minConfluence: number;
  requireOBTouch: boolean;
  requireTrendAlignment: boolean;
  // Environment
  initialCapital: number;
  positionSize: number;
  maxHoldBars: number;
  slPercent: number;
  tpPercent: number;
  // Training
  learningRate: number;
  gamma: number;
  epsilonDecay: number;
  trainFrequency: number;
  batchSize: number;
  // Walk-forward
  walkforward: boolean;
  trainWindow: number;
  testWindow: number;
  stepSize: number;
  // Other
  verbose: boolean;
  baseline: boolean; // Compare with fixed-hold baseline
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
    episodes: parseInt(options['episodes'] || '200', 10),
    output: options['output'] || './models/hybrid-agent.json',
    // Entry filter
    minConfluence: parseInt(options['min-confluence'] || '3', 10),
    requireOBTouch: options['no-ob-touch'] !== 'true',
    requireTrendAlignment: options['no-trend-align'] !== 'true',
    // Environment
    initialCapital: parseFloat(options['initial-capital'] || '10000'),
    positionSize: parseFloat(options['position-size'] || '0.1'),
    maxHoldBars: parseInt(options['max-hold-bars'] || '50', 10),
    slPercent: parseFloat(options['sl-percent'] || '0.02'),
    tpPercent: parseFloat(options['tp-percent'] || '0.04'),
    // Training
    learningRate: parseFloat(options['learning-rate'] || '0.001'),
    gamma: parseFloat(options['gamma'] || '0.9'),
    epsilonDecay: parseFloat(options['epsilon-decay'] || '0.995'),
    trainFrequency: parseInt(options['train-frequency'] || '4', 10),
    batchSize: parseInt(options['batch-size'] || '32', 10),
    // Walk-forward
    walkforward: options['no-walkforward'] !== 'true',
    trainWindow: parseInt(options['train-window'] || '6000', 10),
    testWindow: parseInt(options['test-window'] || '1500', 10),
    stepSize: parseInt(options['step-size'] || '3000', 10),
    // Other
    verbose: options['verbose'] !== 'false',
    baseline: options['no-baseline'] !== 'true',
  };
}

function loadCandles(dataPath: string): Candle[] {
  const absolutePath = path.resolve(dataPath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Data file not found: ${absolutePath}`);
  }

  const content = fs.readFileSync(absolutePath, 'utf-8');
  const data = JSON.parse(content) as Candle[];

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

/**
 * Create rolling windows for walk-forward validation
 */
function createRollingWindows(
  candles: Candle[],
  trainWindow: number,
  testWindow: number,
  stepSize: number
): { train: Candle[]; test: Candle[] }[] {
  const windows: { train: Candle[]; test: Candle[] }[] = [];
  let start = 0;

  while (start + trainWindow + testWindow <= candles.length) {
    windows.push({
      train: candles.slice(start, start + trainWindow),
      test: candles.slice(start + trainWindow, start + trainWindow + testWindow),
    });
    start += stepSize;
  }

  return windows;
}

/**
 * Calculate Sharpe ratio from trades
 */
function calculateSharpe(trades: TradeRecord[]): number {
  if (trades.length < 2) return 0;

  const returns = trades.map((t) => t.pnlPercent);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
  const std = Math.sqrt(variance);

  if (std === 0) return mean > 0 ? 1 : mean < 0 ? -1 : 0;

  // Annualized (assuming hourly data)
  return (mean / std) * Math.sqrt(252 * 24);
}

/**
 * Run fixed-hold baseline (no RL, just rule entries with fixed exit)
 */
function runBaseline(
  candles: Candle[],
  envConfig: Partial<HybridEnvConfig>,
  entryConfig: Partial<EntryFilterConfig>,
  holdBars: number
): { trades: TradeRecord[]; portfolio: Portfolio } {
  const env = new HybridTradingEnvironment(candles, envConfig, entryConfig, {}, false);
  env.reset();

  let barsInPosition = 0;

  while (!env.isDone()) {
    let action: ExitAction | null = null;

    if (env.isInPosition()) {
      barsInPosition++;
      // Fixed exit after N bars
      if (barsInPosition >= holdBars) {
        action = ExitActions.EXIT_MARKET;
        barsInPosition = 0;
      } else {
        action = ExitActions.HOLD;
      }
    } else {
      barsInPosition = 0;
    }

    env.step(action);
  }

  return {
    trades: env.getTrades(),
    portfolio: env.getPortfolio(),
  };
}

/**
 * Train on a single window
 */
async function trainOnWindow(
  agent: DQNAgent,
  trainCandles: Candle[],
  envConfig: Partial<HybridEnvConfig>,
  entryConfig: Partial<EntryFilterConfig>,
  episodes: number,
  trainFrequency: number,
  verbose: boolean
): Promise<{ trades: TradeRecord[]; winRate: number; avgReward: number }> {
  let allTrades: TradeRecord[] = [];
  let totalReward = 0;
  let totalSteps = 0;

  for (let episode = 1; episode <= episodes; episode++) {
    const env = new HybridTradingEnvironment(
      trainCandles,
      { ...envConfig, randomStart: true },
      entryConfig,
      { featureNoiseLevel: 0.02 },
      true // Training mode
    );

    env.reset();
    let episodeReward = 0;
    let steps = 0;

    while (!env.isDone()) {
      let action: ExitAction | null = null;

      // Only select action if in position
      if (env.isInPosition()) {
        const position = env.getPosition();
        if (position) {
          // Build minimal state for action selection
          const state = buildMinimalState(env, position);
          action = agent.selectAction(state, true) as ExitAction;
        }
      }

      const result = env.step(action);
      episodeReward += result.reward;
      steps++;

      // Store experience if we were in position
      if (action !== null && result.state) {
        const position = env.getPosition();
        const nextState = position
          ? buildMinimalState(env, position)
          : new Array(18).fill(0);

        agent.storeExperience(
          result.state.features,
          action,
          result.reward,
          nextState,
          result.done || !env.isInPosition()
        );

        // Train periodically
        if (steps % trainFrequency === 0) {
          agent.train();
        }
      }
    }

    agent.endEpisode();
    allTrades = [...allTrades, ...env.getTrades()];
    totalReward += episodeReward;
    totalSteps += steps;

    // Log progress
    if (verbose && episode % 20 === 0) {
      const winRate = allTrades.length > 0
        ? (allTrades.filter((t) => t.pnl > 0).length / allTrades.length) * 100
        : 0;
      console.log(`  Episode ${episode}/${episodes} | Trades: ${allTrades.length} | Win Rate: ${winRate.toFixed(1)}% | Epsilon: ${agent.getState().epsilon.toFixed(3)}`);
    }
  }

  const winRate = allTrades.length > 0
    ? (allTrades.filter((t) => t.pnl > 0).length / allTrades.length) * 100
    : 0;

  return {
    trades: allTrades,
    winRate,
    avgReward: totalSteps > 0 ? totalReward / totalSteps : 0,
  };
}

/**
 * Evaluate agent on test data
 */
function evaluate(
  agent: DQNAgent,
  testCandles: Candle[],
  envConfig: Partial<HybridEnvConfig>,
  entryConfig: Partial<EntryFilterConfig>
): { trades: TradeRecord[]; portfolio: Portfolio; winRate: number; sharpe: number } {
  const env = new HybridTradingEnvironment(
    testCandles,
    { ...envConfig, randomStart: false },
    entryConfig,
    {},
    false // Evaluation mode
  );

  env.reset();

  while (!env.isDone()) {
    let action: ExitAction | null = null;

    if (env.isInPosition()) {
      const position = env.getPosition();
      if (position) {
        const state = buildMinimalState(env, position);
        action = agent.selectAction(state, false) as ExitAction; // Greedy
      }
    }

    env.step(action);
  }

  const trades = env.getTrades();
  const portfolio = env.getPortfolio();
  const winRate = trades.length > 0
    ? (trades.filter((t) => t.pnl > 0).length / trades.length) * 100
    : 0;
  const sharpe = calculateSharpe(trades);

  return { trades, portfolio, winRate, sharpe };
}

/**
 * Build minimal 18-feature state from environment
 * This is a simplified version - the real ExitStateBuilder would be used in production
 */
function buildMinimalState(env: HybridTradingEnvironment, position: {
  entryPrice: number;
  entryIndex: number;
  side: 'long' | 'short';
  stopLoss: number;
  takeProfit: number;
  entryATR: number;
  unrealizedPnL: number;
  barsHeld: number;
  peakPnL: number;
  size: number;
}): number[] {
  const candles = env.getCandles();
  const currentIndex = env.getCurrentIndex();
  const currentCandle = candles[currentIndex];

  if (!currentCandle) {
    return new Array(18).fill(0);
  }

  const currentPrice = currentCandle.close;

  // Position info (4)
  const pnlPercent = position.side === 'long'
    ? (currentPrice - position.entryPrice) / position.entryPrice
    : (position.entryPrice - currentPrice) / position.entryPrice;
  const unrealizedPnL = Math.max(-1, Math.min(1, pnlPercent * 10));
  const barsInPosition = Math.min(position.barsHeld / 50, 1);

  const slDistance = position.side === 'long'
    ? (currentPrice - position.stopLoss) / position.entryATR
    : (position.stopLoss - currentPrice) / position.entryATR;
  const distanceToSL = Math.max(0, Math.min(1, slDistance / 3));

  const tpDistance = position.side === 'long'
    ? (position.takeProfit - currentPrice) / position.entryATR
    : (currentPrice - position.takeProfit) / position.entryATR;
  const distanceToTP = Math.max(0, Math.min(1, tpDistance / 6));

  // Market context (6)
  const priceVsEntry = Math.max(-1, Math.min(1, pnlPercent * 20));
  const volatilityRatio = 1.0; // Simplified
  const trendStrength = 0.0; // Simplified
  const nearestOBDistance = 1.0; // Simplified
  const fvgProximity = 1.0; // Simplified
  const sessionProgress = 0.5; // Simplified

  // Price action (8)
  const getReturn = (bars: number): number => {
    if (currentIndex < bars) return 0;
    const prev = candles[currentIndex - bars]?.close ?? currentPrice;
    const ret = (currentPrice - prev) / prev;
    return Math.max(-1, Math.min(1, ret * 20));
  };

  const returns1bar = getReturn(1);
  const returns3bar = getReturn(3);
  const returns5bar = getReturn(5);
  const returns10bar = getReturn(10);

  // Highest/lowest since entry
  let highestSinceEntry = 0;
  let lowestSinceEntry = 0;
  for (let i = position.entryIndex; i <= currentIndex; i++) {
    const c = candles[i];
    if (c) {
      const highPct = (c.high - position.entryPrice) / position.entryPrice;
      const lowPct = (position.entryPrice - c.low) / position.entryPrice;
      highestSinceEntry = Math.max(highestSinceEntry, highPct);
      lowestSinceEntry = Math.max(lowestSinceEntry, lowPct);
    }
  }
  highestSinceEntry = Math.min(1, highestSinceEntry * 10);
  lowestSinceEntry = Math.min(1, lowestSinceEntry * 10);

  // Candle pattern (simplified)
  const candlePatternScore = currentCandle.close > currentCandle.open ? 0.3 : -0.3;
  const volumeRatio = 1.0; // Simplified

  return [
    unrealizedPnL,
    barsInPosition,
    distanceToSL,
    distanceToTP,
    priceVsEntry,
    volatilityRatio,
    trendStrength,
    nearestOBDistance,
    fvgProximity,
    sessionProgress,
    returns1bar,
    returns3bar,
    returns5bar,
    returns10bar,
    highestSinceEntry,
    lowestSinceEntry,
    candlePatternScore,
    volumeRatio,
  ];
}

async function main() {
  const args = parseArgs();

  console.log('='.repeat(60));
  console.log('ICT Trading - Hybrid Agent Trainer');
  console.log('(Rule-based entries + RL-controlled exits)');
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
  const entryConfig: Partial<EntryFilterConfig> = {
    minConfluence: args.minConfluence,
    requireOBTouch: args.requireOBTouch,
    requireTrendAlignment: args.requireTrendAlignment,
  };

  const envConfig: Partial<HybridEnvConfig> = {
    initialCapital: args.initialCapital,
    positionSize: args.positionSize,
    maxHoldBars: args.maxHoldBars,
    defaultSLPercent: args.slPercent,
    defaultTPPercent: args.tpPercent,
    // Transaction costs
    spread: 0.0001,
    commission: 0.001,
    slippage: 0.0005,
    maxDrawdownLimit: 0.25,
  };

  const dqnConfig: Partial<DQNConfig> = {
    inputSize: 18, // Simplified exit state
    hiddenLayers: [32, 16], // Smaller network for simpler problem
    outputSize: 4, // 4 exit actions
    learningRate: args.learningRate,
    gamma: args.gamma,
    epsilonStart: 0.3, // Less exploration needed
    epsilonEnd: 0.05,
    epsilonDecay: args.epsilonDecay,
    dropout: 0.2,
    l2Regularization: 0.01,
    useBatchNorm: false, // Simpler network
    gradientClipNorm: 1.0,
    useHuberLoss: true,
  };

  console.log('Configuration:');
  console.log('  Entry Filter:');
  console.log(`    Min confluence: ${args.minConfluence}`);
  console.log(`    Require OB touch: ${args.requireOBTouch}`);
  console.log(`    Require trend alignment: ${args.requireTrendAlignment}`);
  console.log('  Environment:');
  console.log(`    Max hold bars: ${args.maxHoldBars}`);
  console.log(`    Stop loss: ${args.slPercent * 100}%`);
  console.log(`    Take profit: ${args.tpPercent * 100}%`);
  console.log('  Training:');
  console.log(`    Episodes: ${args.episodes}`);
  console.log(`    Learning rate: ${args.learningRate}`);
  console.log(`    Gamma: ${args.gamma}`);
  console.log(`    Walk-forward: ${args.walkforward ? 'ENABLED' : 'disabled'}`);
  if (args.walkforward) {
    console.log(`    Train window: ${args.trainWindow} candles`);
    console.log(`    Test window: ${args.testWindow} candles`);
  }
  console.log();

  // Create agent
  const buffer = new ReplayBuffer({
    capacity: 50000,
    batchSize: args.batchSize,
    minExperience: 500,
  });
  const agent = new DQNAgent(dqnConfig, buffer);

  // Walk-forward validation
  const windows = args.walkforward
    ? createRollingWindows(candles, args.trainWindow, args.testWindow, args.stepSize)
    : [{ train: candles.slice(0, Math.floor(candles.length * 0.8)), test: candles.slice(Math.floor(candles.length * 0.8)) }];

  console.log(`Created ${windows.length} walk-forward windows`);
  console.log();

  const windowMetrics: {
    window: number;
    trainWinRate: number;
    valWinRate: number;
    valSharpe: number;
    baselineSharpe: number;
    trades: number;
  }[] = [];

  let bestWeights: SerializedWeights | null = null;
  let bestSharpe = -Infinity;

  const episodesPerWindow = Math.ceil(args.episodes / windows.length);

  for (let w = 0; w < windows.length; w++) {
    const window = windows[w]!;
    console.log('='.repeat(60));
    console.log(`Window ${w + 1}/${windows.length}`);
    console.log(`  Train: ${window.train.length} candles`);
    console.log(`  Test: ${window.test.length} candles`);
    console.log('='.repeat(60));

    // Train on window
    console.log('\nTraining...');
    const trainResult = await trainOnWindow(
      agent,
      window.train,
      envConfig,
      entryConfig,
      episodesPerWindow,
      args.trainFrequency,
      args.verbose
    );

    console.log(`\nTraining complete: ${trainResult.trades.length} trades, ${trainResult.winRate.toFixed(1)}% win rate`);

    // Evaluate on test
    console.log('\nEvaluating on test set...');
    const evalResult = evaluate(agent, window.test, envConfig, entryConfig);

    console.log(`  Trades: ${evalResult.trades.length}`);
    console.log(`  Win Rate: ${evalResult.winRate.toFixed(1)}%`);
    console.log(`  Sharpe: ${evalResult.sharpe.toFixed(2)}`);
    console.log(`  Total PnL: $${evalResult.portfolio.realizedPnL.toFixed(2)}`);

    // Run baseline comparison
    let baselineSharpe = 0;
    if (args.baseline) {
      console.log('\nRunning baseline (fixed 10-bar hold)...');
      const baseline = runBaseline(window.test, envConfig, entryConfig, 10);
      baselineSharpe = calculateSharpe(baseline.trades);
      const baselineWinRate = baseline.trades.length > 0
        ? (baseline.trades.filter((t) => t.pnl > 0).length / baseline.trades.length) * 100
        : 0;
      console.log(`  Baseline Trades: ${baseline.trades.length}`);
      console.log(`  Baseline Win Rate: ${baselineWinRate.toFixed(1)}%`);
      console.log(`  Baseline Sharpe: ${baselineSharpe.toFixed(2)}`);

      const improvement = evalResult.sharpe - baselineSharpe;
      console.log(`  Improvement: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(2)}`);
    }

    // Track metrics
    windowMetrics.push({
      window: w,
      trainWinRate: trainResult.winRate,
      valWinRate: evalResult.winRate,
      valSharpe: evalResult.sharpe,
      baselineSharpe,
      trades: evalResult.trades.length,
    });

    // Track best model
    if (evalResult.sharpe > bestSharpe) {
      bestSharpe = evalResult.sharpe;
      bestWeights = await agent.saveWeights();
      console.log(`\n  New best Sharpe: ${bestSharpe.toFixed(2)}`);
    }

    console.log();
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('WALK-FORWARD VALIDATION SUMMARY');
  console.log('='.repeat(60));

  console.log('| Window | Train WR | Val WR | Gap    | Val Sharpe | Baseline | Improvement |');
  console.log('|--------|----------|--------|--------|------------|----------|-------------|');

  let totalGap = 0;
  let positiveSharpCount = 0;
  let beatsBaselineCount = 0;

  for (const m of windowMetrics) {
    const gap = m.trainWinRate - m.valWinRate;
    totalGap += gap;
    if (m.valSharpe > 0) positiveSharpCount++;
    if (m.valSharpe > m.baselineSharpe) beatsBaselineCount++;

    const gapStr = gap >= 0 ? `+${gap.toFixed(1)}%` : `${gap.toFixed(1)}%`;
    const improvement = m.valSharpe - m.baselineSharpe;
    const impStr = improvement >= 0 ? `+${improvement.toFixed(2)}` : improvement.toFixed(2);

    console.log(`|   ${m.window + 1}    | ${m.trainWinRate.toFixed(1).padStart(7)}% | ${m.valWinRate.toFixed(1).padStart(5)}% | ${gapStr.padStart(6)} | ${m.valSharpe.toFixed(2).padStart(10)} | ${m.baselineSharpe.toFixed(2).padStart(8)} | ${impStr.padStart(11)} |`);
  }

  const avgGap = totalGap / windowMetrics.length;
  const avgValSharpe = windowMetrics.reduce((a, m) => a + m.valSharpe, 0) / windowMetrics.length;
  const avgBaseline = windowMetrics.reduce((a, m) => a + m.baselineSharpe, 0) / windowMetrics.length;

  console.log('|--------|----------|--------|--------|------------|----------|-------------|');
  console.log(`| AVG    |          |        | ${(avgGap >= 0 ? '+' : '') + avgGap.toFixed(1).padStart(5)}% | ${avgValSharpe.toFixed(2).padStart(10)} | ${avgBaseline.toFixed(2).padStart(8)} | ${(avgValSharpe - avgBaseline >= 0 ? '+' : '') + (avgValSharpe - avgBaseline).toFixed(2).padStart(10)} |`);
  console.log();

  // Success criteria
  console.log('SUCCESS CRITERIA:');
  const gapOk = Math.abs(avgGap) < 20;
  const sharpeOk = positiveSharpCount >= 1;
  const beatsBaseline = beatsBaselineCount >= 1;

  console.log(`  ${gapOk ? '✓' : '✗'} Average Gap < 20%: ${avgGap.toFixed(1)}%`);
  console.log(`  ${sharpeOk ? '✓' : '✗'} At least 1 window with positive Sharpe: ${positiveSharpCount}/${windowMetrics.length}`);
  console.log(`  ${beatsBaseline ? '✓' : '✗'} At least 1 window beats baseline: ${beatsBaselineCount}/${windowMetrics.length}`);

  if (gapOk && sharpeOk) {
    console.log('\n✓ Walk-forward validation PASSED - hybrid system shows generalization');
  } else {
    console.log('\n✗ Walk-forward validation FAILED - may need more data or tuning');
  }

  // Save model
  if (bestWeights) {
    saveModel(bestWeights, args.output);
  } else {
    const weights = await agent.saveWeights();
    saveModel(weights, args.output);
  }

  // Cleanup
  agent.dispose();
  tf.dispose();

  console.log('\nDone!');
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
