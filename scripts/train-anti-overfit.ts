#!/usr/bin/env npx tsx
/**
 * Anti-Overfitting Training Script
 *
 * Addresses the critical overfitting issue:
 * - Training: 82% win rate, +1561 PnL
 * - Validation: 42% win rate, -209 PnL, Sharpe -4.5 to -9
 *
 * Solutions implemented:
 * 1. Feature reduction (104 → 50 features via PCA)
 * 2. Smaller network architecture [64, 32]
 * 3. Stronger regularization (dropout 0.4, L2 0.03)
 * 4. Data augmentation (4-8x more training samples)
 * 5. Domain randomization (spread, commission, volatility)
 * 6. Stricter early stopping
 * 7. Walk-forward validation
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import { DQNAgent, ExplorationDiagnostics, WeightHealthReport } from '../src/lib/rl/agent/dqn-agent';
import { ReplayBuffer } from '../src/lib/rl/agent/replay-buffer';
import { TradingEnvironment } from '../src/lib/rl/environment/trading-env';
import { FeatureReducer, createFeatureReducer } from '../src/lib/rl/environment/feature-reducer';
import { DataAugmentor, combineAugmentedDatasets } from '../src/lib/rl/training/data-augmentation';

// ============================================
// Configuration - Anti-Overfitting Settings
// ============================================

const SYMBOL = 'BTCUSDT';
const CONFIG = {
  // Data
  trainSplit: 0.8,
  monthsOfData: 6,

  // Feature Reduction
  featureReduction: {
    enabled: true,
    type: 'moderate' as const, // 104 → 50 features via PCA (95% variance)
    warmupSamples: 1000,
  },

  // Data Augmentation
  augmentation: {
    enabled: true,
    enableMultiTimeframe: true,
    enableNoise: true,
    noiseLevel: 0.0005, // 0.05% price noise
    volumeNoiseLevel: 0.1, // 10% volume noise
    enableJittering: true,
    jitterWindow: 5,
    enableSynthetic: true,
    syntheticMultiplier: 2,
  },

  // Domain Randomization
  domainRandomization: {
    enabled: true,
    spreadRange: [0.00005, 0.0002], // 0.5x to 2x base spread
    commissionRange: [0.0002, 0.0006], // 0.5x to 1.5x base commission
    slippageRange: [0.00025, 0.001], // 0.5x to 2x base slippage
  },

  // Training
  episodes: 200, // Reduced episodes with more data per episode
  episodeLength: 600,
  trainFrequency: 4,
  batchSize: 64,
  bufferSize: 50000,

  // DQN Agent - SMALLER network with STRONGER regularization
  // Note: inputSize will be set dynamically based on PCA output
  dqn: {
    inputSize: 104, // Will be overridden by PCA output size
    hiddenLayers: [64, 32], // Smaller network (was [128, 64, 32])
    outputSize: 4,
    learningRate: 0.0003, // Lower LR (was 0.0005)
    gamma: 0.95,
    tau: 0.01,
    epsilonStart: 1.0,
    epsilonEnd: 0.05,
    epsilonDecay: 0.995,
    dropout: 0.25, // Reduced from 0.4 - was too aggressive
    l2Regularization: 0.01, // Reduced from 0.03 - was too aggressive
    useBatchNorm: true,
    gradientClipNorm: 0.5,
    useHuberLoss: true,
    huberDelta: 1.0,
    actionBias: true,
    actionBiasDecay: 0.998,
  },

  // Base Environment (will be randomized)
  env: {
    initialCapital: 10000,
    positionSize: 0.1,
    spread: 0.0001,
    commission: 0.0004,
    slippage: 0.0005,
    lookbackPeriod: 60,
    maxDrawdownLimit: 0.15,
    stopLossPercent: 0.02,
    takeProfitPercent: 0.04,
  },

  // Reward shaping
  reward: {
    pnlWeight: 0.6,
    sharpeWeight: 0.2,
    drawdownWeight: 0.1,
    ictAlignmentWeight: 0.1,
    useDenseReward: true,
    unrealizedPnLWeight: 0.3,
    holdingCostPerBar: 0.001,
    inactivityPenalty: 0.003,
    inactivityThreshold: 8,
  },

  // Walk-Forward Validation
  // Adjusted for 6 months of hourly data (~4320 candles)
  walkForward: {
    enabled: true,
    trainWindow: 2500,  // ~3.5 months
    testWindow: 500,    // ~3 weeks
    stepSize: 700,      // Overlap for 2-3 windows
  },

  // Stricter Early Stopping
  earlyStoppingPatience: 30, // Reduced from 50
  minImprovement: 0.02, // Increased from 0.01

  // Logging
  logInterval: 10,
  evalInterval: 20,
  diagnosticsInterval: 50,
};

// ============================================
// Logging Utilities
// ============================================

function log(message: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

function logDiagnostics(diagnostics: ExplorationDiagnostics, weightHealth: WeightHealthReport) {
  log('');
  log('=== EXPLORATION DIAGNOSTICS ===');
  log(`Action Distribution: HOLD=${(diagnostics.actionDistribution.hold * 100).toFixed(1)}% BUY=${(diagnostics.actionDistribution.buy * 100).toFixed(1)}% SELL=${(diagnostics.actionDistribution.sell * 100).toFixed(1)}% CLOSE=${(diagnostics.actionDistribution.close * 100).toFixed(1)}%`);
  log(`Total Actions: ${diagnostics.totalActions}`);
  log(`Avg Q-Values: [${diagnostics.avgQValues.map(q => q.toFixed(4)).join(', ')}]`);
  log(`Q-Value Range: [${diagnostics.qValueRange.min.toFixed(6)}, ${diagnostics.qValueRange.max.toFixed(6)}]`);
  log(`Q-Value Spread: ${diagnostics.qValueSpread.toFixed(6)} ${diagnostics.qValueCollapsed ? '⚠️ COLLAPSED' : '✓'}`);
  log(`Action Bias: ${diagnostics.actionBias.toFixed(4)}`);

  log('');
  log('=== WEIGHT HEALTH ===');
  log(`Weight Range: [${weightHealth.minWeight.toExponential(2)}, ${weightHealth.maxWeight.toExponential(2)}]`);
  log(`Total Weights: ${weightHealth.totalWeights}`);
  log(`Tiny Weights (<1e-10): ${weightHealth.tinyWeights} (${(weightHealth.tinyWeightRatio * 100).toFixed(1)}%)`);
  if (weightHealth.vanishingGradientRisk) {
    log('⚠️ WARNING: Vanishing gradient risk detected!');
  } else {
    log('✓ Weight health OK');
  }
  log('');
}

// ============================================
// Domain Randomization
// ============================================

function randomizeEnvConfig(baseConfig: typeof CONFIG.env): typeof CONFIG.env {
  if (!CONFIG.domainRandomization.enabled) {
    return baseConfig;
  }

  const { spreadRange, commissionRange, slippageRange } = CONFIG.domainRandomization;

  return {
    ...baseConfig,
    spread: spreadRange[0]! + Math.random() * (spreadRange[1]! - spreadRange[0]!),
    commission: commissionRange[0]! + Math.random() * (commissionRange[1]! - commissionRange[0]!),
    slippage: slippageRange[0]! + Math.random() * (slippageRange[1]! - slippageRange[0]!),
  };
}

// ============================================
// Walk-Forward Windows
// ============================================

interface WalkForwardWindow {
  train: Candle[];
  test: Candle[];
  windowIndex: number;
}

function createWalkForwardWindows(candles: Candle[]): WalkForwardWindow[] {
  const { trainWindow, testWindow, stepSize } = CONFIG.walkForward;
  const windows: WalkForwardWindow[] = [];

  let start = 0;
  let windowIndex = 0;

  while (start + trainWindow + testWindow <= candles.length) {
    windows.push({
      train: candles.slice(start, start + trainWindow),
      test: candles.slice(start + trainWindow, start + trainWindow + testWindow),
      windowIndex,
    });
    start += stepSize;
    windowIndex++;
  }

  return windows;
}

// ============================================
// Training Loop
// ============================================

async function train() {
  log('============================================================');
  log('ANTI-OVERFITTING TRAINING');
  log('============================================================');
  log('');
  log('Key changes from previous training:');
  log('  - Feature reduction: 104 → 50 (PCA, 95% variance)');
  log('  - Network: [128, 64, 32] → [64, 32]');
  log('  - Dropout: 0.25 → 0.4');
  log('  - L2 regularization: 0.01 → 0.03');
  log('  - Data augmentation enabled');
  log('  - Domain randomization enabled');
  log('  - Early stopping patience: 50 → 30');
  log('');

  // Load data
  const dataPath = path.join('data', `${SYMBOL}_1h.json`);
  if (!fs.existsSync(dataPath)) {
    throw new Error(`Data file not found: ${dataPath}. Run fetch-historical-data.ts first.`);
  }

  const allCandles = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as Candle[];
  log(`Loaded ${allCandles.length} candles from ${dataPath}`);

  // Use recent data for regime consistency
  const recentCandles = allCandles.slice(-CONFIG.monthsOfData * 30 * 24);
  log(`Using ${recentCandles.length} recent candles (${CONFIG.monthsOfData} months)`);

  // Create walk-forward windows
  let windows: WalkForwardWindow[];
  if (CONFIG.walkForward.enabled) {
    windows = createWalkForwardWindows(recentCandles);
    log(`Created ${windows.length} walk-forward windows`);
    windows.forEach((w, i) => {
      log(`  Window ${i + 1}: Train=${w.train.length} Test=${w.test.length}`);
    });
  } else {
    // Static split
    const splitIdx = Math.floor(recentCandles.length * CONFIG.trainSplit);
    windows = [{
      train: recentCandles.slice(0, splitIdx),
      test: recentCandles.slice(splitIdx),
      windowIndex: 0,
    }];
    log(`Static split: Train=${windows[0]!.train.length} Val=${windows[0]!.test.length}`);
  }
  log('');

  // Data augmentation
  let trainCandles = windows[0]!.train;
  if (CONFIG.augmentation.enabled) {
    log('Applying data augmentation...');
    const augmentor = new DataAugmentor({
      enableMultiTimeframe: CONFIG.augmentation.enableMultiTimeframe,
      timeframes: [1, 5, 15, 60],
      enableNoise: CONFIG.augmentation.enableNoise,
      noiseLevel: CONFIG.augmentation.noiseLevel,
      volumeNoiseLevel: CONFIG.augmentation.volumeNoiseLevel,
      enableJittering: CONFIG.augmentation.enableJittering,
      jitterWindow: CONFIG.augmentation.jitterWindow,
      enableSynthetic: CONFIG.augmentation.enableSynthetic,
      syntheticMultiplier: CONFIG.augmentation.syntheticMultiplier,
    });

    const augmentedDatasets = augmentor.augmentHourlyData(trainCandles);
    const stats = augmentor.getAugmentationStats(trainCandles.length, augmentedDatasets);
    log(`  Datasets created: ${stats.datasetsCreated}`);
    log(`  Total augmented candles: ${stats.totalAugmentedCandles}`);
    log(`  Augmentation factor: ${stats.augmentationFactor.toFixed(2)}x`);

    // Combine datasets (we'll sample randomly during training)
    const combined = combineAugmentedDatasets(augmentedDatasets, true);
    trainCandles = combined.candles;
    log(`  Combined training set: ${trainCandles.length} candles`);
  }
  log('');

  // Create feature reducer
  let featureReducer: FeatureReducer | null = null;
  let reducedStateSize = 104; // Default full size

  if (CONFIG.featureReduction.enabled) {
    log('Creating feature reducer...');
    featureReducer = createFeatureReducer(CONFIG.featureReduction.type);
    reducedStateSize = featureReducer.getOutputDimension();
    log(`  Method: PCA (${CONFIG.featureReduction.type})`);
    log(`  Target dimension: ${reducedStateSize}`);
    log(`  Warmup samples: ${CONFIG.featureReduction.warmupSamples}`);

    // Warmup the feature reducer with samples from training data
    log('  Warming up feature reducer...');
    const warmupEnv = new TradingEnvironment(trainCandles.slice(0, 2000), CONFIG.env, {}, CONFIG.reward, true);
    const state = warmupEnv.reset();

    // Collect warmup samples
    let warmupCount = 0;
    for (let i = 0; i < CONFIG.featureReduction.warmupSamples && !warmupEnv.isDone(); i++) {
      const currentState = warmupEnv.getState();
      featureReducer.addSample(currentState.features);
      warmupEnv.step(Math.floor(Math.random() * 4) as 0 | 1 | 2 | 3);
      warmupCount++;
    }

    // Fit the reducer if we have enough samples
    if (!featureReducer.isReady() && warmupCount >= CONFIG.featureReduction.warmupSamples) {
      featureReducer.fit();
    }

    const reducerStats = featureReducer.getStats();
    log(`  Fitted: ${reducerStats.isFitted}`);
    log(`  Input dimension: ${reducerStats.inputDimension}`);
    log(`  Output dimension: ${reducerStats.outputDimension}`);
    if (reducerStats.explainedVariance) {
      log(`  Explained variance: ${(reducerStats.explainedVariance * 100).toFixed(1)}%`);
    }

    reducedStateSize = reducerStats.outputDimension;
  }
  log('');

  // Create replay buffer and agent
  const buffer = new ReplayBuffer({
    capacity: CONFIG.bufferSize,
    batchSize: CONFIG.batchSize,
    minExperience: CONFIG.batchSize * 2,
  });

  const agent = new DQNAgent({
    ...CONFIG.dqn,
    inputSize: reducedStateSize,
  }, buffer);

  agent.resetDiagnostics();

  log(`Agent created with input size: ${reducedStateSize}`);
  log('');

  // Training metrics
  let bestValSharpe = -Infinity;
  let bestValPnL = -Infinity;
  let noImprovementCount = 0;
  const windowMetrics: { window: number; trainWinRate: number; valWinRate: number; valSharpe: number; gap: number }[] = [];

  // Episodes per window
  const episodesPerWindow = Math.ceil(CONFIG.episodes / windows.length);
  let currentWindowIndex = 0;
  let currentTrainCandles = trainCandles;
  let currentValCandles = windows[0]!.test;

  log('Starting training...');
  log('');

  for (let episode = 1; episode <= CONFIG.episodes; episode++) {
    // Check if we should rotate to next window
    if (CONFIG.walkForward.enabled && windows.length > 1) {
      const newWindowIndex = Math.floor((episode - 1) / episodesPerWindow);
      if (newWindowIndex !== currentWindowIndex && newWindowIndex < windows.length) {
        // Log metrics for current window
        const windowResult = evaluate(agent, currentValCandles, featureReducer);
        windowMetrics.push({
          window: currentWindowIndex,
          trainWinRate: 0, // Will be filled from recent episodes
          valWinRate: windowResult.winRate,
          valSharpe: windowResult.sharpe,
          gap: 0, // Will be calculated
        });

        // Rotate to next window
        currentWindowIndex = newWindowIndex;
        const window = windows[currentWindowIndex]!;

        // Apply augmentation to new window's training data
        if (CONFIG.augmentation.enabled) {
          const augmentor = new DataAugmentor({
            enableMultiTimeframe: CONFIG.augmentation.enableMultiTimeframe,
            timeframes: [1, 5, 15, 60],
            enableNoise: CONFIG.augmentation.enableNoise,
            noiseLevel: CONFIG.augmentation.noiseLevel,
            volumeNoiseLevel: CONFIG.augmentation.volumeNoiseLevel,
            enableJittering: CONFIG.augmentation.enableJittering,
            jitterWindow: CONFIG.augmentation.jitterWindow,
            enableSynthetic: CONFIG.augmentation.enableSynthetic,
            syntheticMultiplier: CONFIG.augmentation.syntheticMultiplier,
          });
          const augmented = augmentor.augmentHourlyData(window.train);
          const combined = combineAugmentedDatasets(augmented, true);
          currentTrainCandles = combined.candles;
        } else {
          currentTrainCandles = window.train;
        }
        currentValCandles = window.test;

        log(`\n=== Rotating to Window ${currentWindowIndex + 1}/${windows.length} ===`);
        log(`Train: ${currentTrainCandles.length} Val: ${currentValCandles.length}`);
        log('');

        // Reset epsilon partially for new window (allow more exploration)
        agent.resetEpsilon(Math.max(0.3, agent.getState().epsilon));
      }
    }

    // Randomize environment config for this episode
    const randomizedEnvConfig = randomizeEnvConfig(CONFIG.env);

    // Select random segment for episode
    const startIdx = Math.floor(Math.random() * (currentTrainCandles.length - CONFIG.episodeLength - 100));
    const episodeCandles = currentTrainCandles.slice(startIdx, startIdx + CONFIG.episodeLength + 100);

    // Create environment with randomized config
    const env = new TradingEnvironment(
      episodeCandles,
      { ...randomizedEnvConfig, randomStart: true },
      {},
      CONFIG.reward,
      true // Training mode
    );

    let state = env.reset();
    let episodeReward = 0;
    let episodeLoss = 0;
    let lossCount = 0;
    let stepCount = 0;

    while (!env.isDone() && stepCount < CONFIG.episodeLength) {
      // Apply feature reduction if enabled
      const features = featureReducer && featureReducer.isReady()
        ? featureReducer.transform(state.features)
        : state.features;

      // Select action
      const action = agent.selectAction(features, true);

      // Take step
      const { state: nextState, reward, done } = env.step(action);

      // Apply feature reduction to next state
      const nextFeatures = featureReducer && featureReducer.isReady()
        ? featureReducer.transform(nextState.features)
        : nextState.features;

      // Store experience
      agent.storeExperience(features, action, reward, nextFeatures, done);

      // Train periodically
      if (stepCount % CONFIG.trainFrequency === 0) {
        const loss = agent.train();
        if (loss > 0) {
          episodeLoss += loss;
          lossCount++;
        }
      }

      episodeReward += reward;
      state = nextState;
      stepCount++;
    }

    agent.endEpisode();

    const portfolio = env.getPortfolio();
    const trades = env.getTrades();
    const winRate = trades.length > 0
      ? (portfolio.winningTrades / trades.length) * 100
      : 0;
    const avgLoss = lossCount > 0 ? episodeLoss / lossCount : 0;

    // Update window metrics with train win rate
    if (windowMetrics.length > 0 && windowMetrics[windowMetrics.length - 1]!.trainWinRate === 0) {
      windowMetrics[windowMetrics.length - 1]!.trainWinRate = winRate;
      windowMetrics[windowMetrics.length - 1]!.gap = winRate - windowMetrics[windowMetrics.length - 1]!.valWinRate;
    }

    // Logging
    if (episode % CONFIG.logInterval === 0) {
      const agentState = agent.getState();
      log(`Episode ${episode.toString().padStart(3)}: Reward=${episodeReward.toFixed(2).padStart(7)} Trades=${trades.length.toString().padStart(3)} WinRate=${winRate.toFixed(1).padStart(5)}% PnL=${portfolio.realizedPnL.toFixed(0).padStart(6)} DD=${(portfolio.maxDrawdown * 100).toFixed(1).padStart(5)}% Eps=${agentState.epsilon.toFixed(3)} Loss=${avgLoss.toFixed(4)}`);
    }

    // Diagnostics
    if (episode % CONFIG.diagnosticsInterval === 0) {
      const diagnostics = agent.getDiagnostics();
      const weightHealth = agent.checkWeightHealth();
      logDiagnostics(diagnostics, weightHealth);

      // Check for issues
      if (diagnostics.actionDistribution.hold > 0.9) {
        log('⚠️ WARNING: Hold action dominates (>90%). Model may be stuck.');
      }
      if (diagnostics.vanishingGradients) {
        log('⚠️ WARNING: Q-values near zero. Possible vanishing gradients.');
      }
      if (trades.length === 0) {
        log('⚠️ WARNING: No trades in this episode!');
      }
    }

    // Validation
    if (episode % CONFIG.evalInterval === 0) {
      const valResult = evaluate(agent, currentValCandles, featureReducer);

      log('');
      log(`[VAL] Trades=${valResult.trades} WinRate=${valResult.winRate.toFixed(1)}% PnL=${valResult.pnl.toFixed(0)} Sharpe=${valResult.sharpe.toFixed(3)}`);

      // Track improvement
      const improved = valResult.sharpe > bestValSharpe + CONFIG.minImprovement ||
        (valResult.sharpe > 0 && valResult.pnl > bestValPnL + 50);

      if (improved) {
        if (valResult.sharpe > bestValSharpe) bestValSharpe = valResult.sharpe;
        if (valResult.pnl > bestValPnL) bestValPnL = valResult.pnl;
        noImprovementCount = 0;

        // Save best model
        const weights = await agent.saveWeights();
        const modelData = {
          timestamp: new Date().toISOString(),
          episode,
          valSharpe: valResult.sharpe,
          valPnL: valResult.pnl,
          valWinRate: valResult.winRate,
          valTrades: valResult.trades,
          featureReduction: CONFIG.featureReduction,
          featureReducerModel: featureReducer?.exportModel() ?? null,
          config: CONFIG,
          weights,
        };

        const modelPath = `models/model_anti_overfit_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
        fs.writeFileSync(modelPath, JSON.stringify(modelData, null, 2));
        log(`✓ New best model saved: ${modelPath}`);
        log(`  Sharpe: ${valResult.sharpe.toFixed(3)}, PnL: ${valResult.pnl.toFixed(0)}`);
      } else {
        noImprovementCount++;
        if (noImprovementCount >= CONFIG.earlyStoppingPatience) {
          log('');
          log(`Early stopping: No improvement for ${CONFIG.earlyStoppingPatience} evaluations`);
          break;
        }
      }
      log('');
    }
  }

  // Final evaluation
  log('');
  log('============================================================');
  log('FINAL EVALUATION');
  log('============================================================');

  // Evaluate on all windows
  if (CONFIG.walkForward.enabled && windows.length > 1) {
    log('\nWALK-FORWARD RESULTS:');
    log('| Window | Train WR | Val WR |   Gap   | Val Sharpe |');
    log('|--------|----------|--------|---------|------------|');

    let totalGap = 0;
    let positiveSharpCount = 0;

    for (const window of windows) {
      const result = evaluate(agent, window.test, featureReducer);
      const gap = 0; // We don't have train WR for all windows
      totalGap += Math.abs(gap);

      if (result.sharpe > 0) positiveSharpCount++;

      log(`|   ${window.windowIndex + 1}    |    N/A   | ${result.winRate.toFixed(1).padStart(5)}% |   N/A   | ${result.sharpe.toFixed(2).padStart(10)} |`);
    }

    const avgValSharpe = windows.reduce((sum, w) => sum + evaluate(agent, w.test, featureReducer).sharpe, 0) / windows.length;
    log('|--------|----------|--------|---------|------------|');
    log(`| AVG    |    N/A   |   N/A  |   N/A   | ${avgValSharpe.toFixed(2).padStart(10)} |`);
    log('');

    log('SUCCESS CRITERIA:');
    const sharpeOk = positiveSharpCount >= windows.length / 2;
    log(`  ${sharpeOk ? '✓' : '✗'} At least half windows with positive Sharpe: ${positiveSharpCount}/${windows.length}`);
  }

  // Final val evaluation
  const finalResult = evaluate(agent, windows[windows.length - 1]!.test, featureReducer);
  const finalDiagnostics = agent.getDiagnostics();
  const finalWeightHealth = agent.checkWeightHealth();

  log('');
  log('Final Validation Results:');
  log(`  Trades: ${finalResult.trades}`);
  log(`  Win Rate: ${finalResult.winRate.toFixed(1)}%`);
  log(`  Total PnL: ${finalResult.pnl.toFixed(2)}`);
  log(`  Sharpe Ratio: ${finalResult.sharpe.toFixed(3)}`);
  log(`  Max Drawdown: ${(finalResult.maxDrawdown * 100).toFixed(1)}%`);
  log('');

  logDiagnostics(finalDiagnostics, finalWeightHealth);

  // Success criteria
  log('SUCCESS CRITERIA:');
  const tradesOk = finalResult.trades > 10;
  const sharpeOk = finalResult.sharpe > 0;
  const winRateOk = finalResult.winRate > 48;
  const holdOk = finalDiagnostics.actionDistribution.hold < 0.8;

  log(`  ${tradesOk ? '✓' : '✗'} Trades > 10: ${finalResult.trades}`);
  log(`  ${sharpeOk ? '✓' : '✗'} Val Sharpe > 0: ${finalResult.sharpe.toFixed(3)}`);
  log(`  ${winRateOk ? '✓' : '✗'} Val Win Rate > 48%: ${finalResult.winRate.toFixed(1)}%`);
  log(`  ${holdOk ? '✓' : '✗'} Hold < 80%: ${(finalDiagnostics.actionDistribution.hold * 100).toFixed(1)}%`);

  if (tradesOk && sharpeOk && winRateOk && holdOk) {
    log('');
    log('✓ All criteria PASSED! Model shows reduced overfitting.');
  } else {
    log('');
    log('✗ Some criteria FAILED. Consider:');
    if (!tradesOk) log('  - Increase action bias or reduce epsilon end');
    if (!sharpeOk) log('  - Try exit-only agent (rule-based entry, RL exit)');
    if (!winRateOk) log('  - Review ICT alignment signals');
    if (!holdOk) log('  - Increase inactivity penalty');
  }

  log('');
  log('============================================================');
  log('TRAINING COMPLETE');
  log(`Best Validation Sharpe: ${bestValSharpe.toFixed(3)}`);
  log(`Best Validation PnL: ${bestValPnL.toFixed(2)}`);
  log('============================================================');

  // Cleanup
  agent.dispose();
}

// ============================================
// Evaluation Function
// ============================================

interface EvalResult {
  trades: number;
  winRate: number;
  pnl: number;
  sharpe: number;
  maxDrawdown: number;
}

function evaluate(
  agent: DQNAgent,
  candles: Candle[],
  featureReducer: FeatureReducer | null
): EvalResult {
  const env = new TradingEnvironment(
    candles,
    { ...CONFIG.env, randomStart: false },
    {},
    CONFIG.reward,
    false // Evaluation mode
  );

  let state = env.reset();

  while (!env.isDone()) {
    // Apply feature reduction if enabled
    const features = featureReducer && featureReducer.isReady()
      ? featureReducer.transform(state.features)
      : state.features;

    const action = agent.selectAction(features, false);
    const { state: nextState } = env.step(action);
    state = nextState;
  }

  const portfolio = env.getPortfolio();
  const trades = env.getTrades();

  // Calculate Sharpe ratio
  const returns = trades.map(t => t.pnlPercent);
  let sharpe = 0;
  if (returns.length > 1) {
    const avgRet = returns.reduce((a, b) => a + b, 0) / returns.length;
    const stdRet = Math.sqrt(
      returns.reduce((a, r) => a + Math.pow(r - avgRet, 2), 0) / returns.length
    );
    sharpe = stdRet > 0 ? (avgRet / stdRet) * Math.sqrt(252 * 24) : 0; // Annualized
  }

  return {
    trades: trades.length,
    winRate: trades.length > 0 ? (portfolio.winningTrades / trades.length) * 100 : 0,
    pnl: portfolio.realizedPnL,
    sharpe,
    maxDrawdown: portfolio.maxDrawdown,
  };
}

// ============================================
// Run Training
// ============================================

train().catch(err => {
  console.error('Training failed:', err);
  process.exit(1);
});
