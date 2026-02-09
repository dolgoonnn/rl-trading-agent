#!/usr/bin/env npx tsx
/**
 * Improved Training Script v2
 *
 * Addresses the key issues identified in training:
 * 1. Agent not trading (0 trades) - "hold" collapse
 * 2. Vanishing gradients (extremely small weights)
 * 3. Sparse reward signal making learning difficult
 *
 * Solutions implemented:
 * - Action bias to encourage trading actions
 * - Dense reward signals (unrealized PnL, inactivity penalty)
 * - Increased minimum epsilon (0.05 instead of 0.01)
 * - Action masking to force trading when flat
 * - Comprehensive diagnostics logging
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import { DQNAgent, ExplorationDiagnostics, WeightHealthReport } from '../src/lib/rl/agent/dqn-agent';
import { ReplayBuffer } from '../src/lib/rl/agent/replay-buffer';
import { TradingEnvironment } from '../src/lib/rl/environment/trading-env';

// ============================================
// Configuration
// ============================================

const SYMBOL = 'BTCUSDT';
const CONFIG = {
  // Data
  trainSplit: 0.8,
  monthsOfData: 6, // Use recent 6 months for regime consistency

  // Training
  episodes: 300,
  episodeLength: 800,
  trainFrequency: 4,
  batchSize: 64,
  bufferSize: 50000,

  // DQN Agent
  dqn: {
    inputSize: 104, // Will be auto-detected from environment
    hiddenLayers: [128, 64, 32],
    outputSize: 4,
    learningRate: 0.0005,
    gamma: 0.95,
    tau: 0.01, // Faster target network updates
    epsilonStart: 1.0,
    epsilonEnd: 0.05, // Higher minimum epsilon
    epsilonDecay: 0.995,
    dropout: 0.2,
    l2Regularization: 0.005,
    useBatchNorm: true,
    gradientClipNorm: 0.5,
    useHuberLoss: true,
    huberDelta: 1.0,
    actionBias: true,
    actionBiasDecay: 0.998,
  },

  // Environment
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
// Training Loop
// ============================================

async function train() {
  log('============================================================');
  log('IMPROVED TRAINING V2 - Anti-Hold-Collapse');
  log('============================================================');
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
  const splitIdx = Math.floor(recentCandles.length * CONFIG.trainSplit);
  const trainCandles = recentCandles.slice(0, splitIdx);
  const valCandles = recentCandles.slice(splitIdx);

  log(`Train: ${trainCandles.length} candles (${(trainCandles.length / 24).toFixed(0)} days)`);
  log(`Val: ${valCandles.length} candles (${(valCandles.length / 24).toFixed(0)} days)`);

  // Create environment to get state size
  const tempEnv = new TradingEnvironment(trainCandles.slice(0, 100), CONFIG.env, {}, CONFIG.reward, true);
  const stateSize = tempEnv.getStateSize();
  log(`State vector size: ${stateSize}`);
  log('');

  // Create replay buffer and agent
  const buffer = new ReplayBuffer({
    capacity: CONFIG.bufferSize,
    batchSize: CONFIG.batchSize,
    minExperience: CONFIG.batchSize * 2,
  });

  const agent = new DQNAgent({
    ...CONFIG.dqn,
    inputSize: stateSize,
  }, buffer);

  agent.resetDiagnostics();

  // Training metrics
  let bestValSharpe = -Infinity;
  let bestValPnL = -Infinity;
  let noImprovementCount = 0;
  const maxNoImprovement = 50;

  log('Starting training...');
  log('');

  for (let episode = 1; episode <= CONFIG.episodes; episode++) {
    // Create environment with random start
    const startIdx = Math.floor(Math.random() * (trainCandles.length - CONFIG.episodeLength - 100));
    const episodeCandles = trainCandles.slice(startIdx, startIdx + CONFIG.episodeLength + 100);

    const env = new TradingEnvironment(
      episodeCandles,
      { ...CONFIG.env, randomStart: true },
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
      // Select action
      const action = agent.selectAction(state.features, true);

      // Take step
      const { state: nextState, reward, done } = env.step(action);

      // Store experience
      agent.storeExperience(state.features, action, reward, nextState.features, done);

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
      const valResult = evaluate(agent, valCandles);

      log('');
      log(`[VAL] Trades=${valResult.trades} WinRate=${valResult.winRate.toFixed(1)}% PnL=${valResult.pnl.toFixed(0)} Sharpe=${valResult.sharpe.toFixed(3)}`);

      // Track improvement
      if (valResult.sharpe > bestValSharpe + 0.01 || valResult.pnl > bestValPnL + 50) {
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
          config: CONFIG,
          weights,
        };

        const modelPath = `models/model_improved_v2_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
        fs.writeFileSync(modelPath, JSON.stringify(modelData, null, 2));
        log(`✓ New best model saved: ${modelPath}`);
        log(`  Sharpe: ${valResult.sharpe.toFixed(3)}, PnL: ${valResult.pnl.toFixed(0)}`);
      } else {
        noImprovementCount++;
        if (noImprovementCount >= maxNoImprovement) {
          log('');
          log(`Early stopping: No improvement for ${maxNoImprovement} evaluations`);
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

  const finalResult = evaluate(agent, valCandles);
  const finalDiagnostics = agent.getDiagnostics();
  const finalWeightHealth = agent.checkWeightHealth();

  log('');
  log('Validation Results:');
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
  const sharpeOk = finalResult.sharpe > 0.1;
  const winRateOk = finalResult.winRate > 50;
  const holdOk = finalDiagnostics.actionDistribution.hold < 0.8;

  log(`  ${tradesOk ? '✓' : '✗'} Trades > 10: ${finalResult.trades}`);
  log(`  ${sharpeOk ? '✓' : '✗'} Sharpe > 0.1: ${finalResult.sharpe.toFixed(3)}`);
  log(`  ${winRateOk ? '✓' : '✗'} Win Rate > 50%: ${finalResult.winRate.toFixed(1)}%`);
  log(`  ${holdOk ? '✓' : '✗'} Hold < 80%: ${(finalDiagnostics.actionDistribution.hold * 100).toFixed(1)}%`);

  if (tradesOk && sharpeOk && winRateOk && holdOk) {
    log('');
    log('✓ All criteria PASSED!');
  } else {
    log('');
    log('✗ Some criteria FAILED. Consider:');
    if (!tradesOk) log('  - Increase action bias or reduce epsilon end');
    if (!sharpeOk) log('  - Adjust reward weights or add more training data');
    if (!winRateOk) log('  - Review ICT alignment signals');
    if (!holdOk) log('  - Increase inactivity penalty or entry bonus');
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

function evaluate(agent: DQNAgent, candles: Candle[]): EvalResult {
  const env = new TradingEnvironment(
    candles,
    { ...CONFIG.env, randomStart: false },
    {},
    CONFIG.reward,
    false // Evaluation mode
  );

  let state = env.reset();

  while (!env.isDone()) {
    const action = agent.selectAction(state.features, false);
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
