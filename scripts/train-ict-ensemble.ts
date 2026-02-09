#!/usr/bin/env npx tsx
/**
 * ICT Ensemble Training Script
 *
 * Trains 3 DQN agents as an ensemble using the ICT Meta-Strategy Environment.
 * Each agent selects which ICT strategy to use (OB, FVG, BOS, CHoCH, WAIT).
 *
 * Key Features:
 * - KB integration for ICT-aligned reward shaping
 * - 42-feature state space (18 base + 20 strategy + 4 KB)
 * - 5 action outputs (strategy selection, not price prediction)
 * - Majority voting during inference
 * - Asymmetric loss (2x penalty on losses)
 *
 * Usage:
 *   npx tsx scripts/train-ict-ensemble.ts
 *   npx tsx scripts/train-ict-ensemble.ts --episodes 300 --agents 5
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import { DQNAgent, type WeightHealthReport, type ExplorationDiagnostics, type SerializedWeights } from '../src/lib/rl/agent/dqn-agent';
import { ReplayBuffer } from '../src/lib/rl/agent/replay-buffer';
import {
  ICTMetaStrategyEnvironment,
} from '../src/lib/rl/environment/ict-meta-env';
import {
  type StrategyAction,
  STRATEGY_COUNT,
} from '../src/lib/rl/strategies';

// ============================================
// CLI Arguments
// ============================================

const args = process.argv.slice(2);
const getArg = (name: string, defaultValue: number): number => {
  const idx = args.indexOf(`--${name}`);
  const argValue = args[idx + 1];
  if (idx !== -1 && argValue) {
    return parseInt(argValue, 10);
  }
  return defaultValue;
};

// ============================================
// Configuration
// ============================================

const SYMBOL = 'BTCUSDT';
const CONFIG = {
  // Ensemble
  numAgents: getArg('agents', 3),
  votingMethod: 'majority' as 'majority' | 'average',

  // Data
  trainSplit: 0.8,
  monthsOfData: 6,

  // Training
  episodes: getArg('episodes', 150),
  episodeLength: 1000, // 2x bars per episode for more trade opportunities
  trainFrequency: 4,
  batchSize: 64,
  bufferSize: 30000,

  // DQN Agent (per agent) - Iteration 3: MORE EXPLORATION
  dqn: {
    inputSize: 42, // 18 base + 20 strategy + 4 KB
    hiddenLayers: [128, 64, 32],
    outputSize: STRATEGY_COUNT,
    learningRate: 0.0008, // Increased for faster learning
    gamma: 0.95,
    tau: 0.01,
    epsilonStart: 1.0,
    epsilonEnd: 0.25, // Much higher floor = sustained exploration
    epsilonDecay: 0.996, // Much slower decay = explore much longer
    dropout: 0.15, // Reduced dropout
    l2Regularization: 0.005,
    useBatchNorm: true,
    gradientClipNorm: 0.5,
    useHuberLoss: true,
    huberDelta: 1.0,
    actionBias: true,
    actionBiasDecay: 0.998, // Much slower decay for action bias
  },

  // Environment
  env: {
    initialCapital: 10000,
    positionSizePercent: 0.1,
    commission: 0.001,
    slippage: 0.0005,
    lookbackPeriod: 100,
    maxBarsPerEpisode: null,
    maxDrawdownLimit: 0.15,
    maxBarsInPosition: 100,
    kbConfig: {
      enabled: true,
      addKBFeatures: true,
      useKBRewardShaping: true,
    },
  },

  // Walk-Forward Validation
  walkForward: {
    enabled: true,
    trainWindow: 2500,
    testWindow: 500,
    stepSize: 700,
  },

  // Early Stopping
  earlyStoppingPatience: 25,
  minImprovement: 0.02,

  // Logging
  logInterval: 10,
  evalInterval: 20,
  diagnosticsInterval: 50,
};

// ============================================
// Logging
// ============================================

function log(message: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

function logDiagnostics(agentId: number, diagnostics: ExplorationDiagnostics, weightHealth: WeightHealthReport) {
  log(`  Agent ${agentId}: Actions=[WAIT=${(diagnostics.actionDistribution.hold * 100).toFixed(1)}% OB=${((diagnostics.actionDistribution.buy || 0) * 100).toFixed(1)}% FVG=${((diagnostics.actionDistribution.sell || 0) * 100).toFixed(1)}% BOS=${((diagnostics.actionDistribution.close || 0) * 100).toFixed(1)}%] QSpread=${diagnostics.qValueSpread.toFixed(4)} ${diagnostics.qValueCollapsed ? '⚠️' : '✓'}`);

  if (weightHealth.vanishingGradientRisk) {
    log(`    ⚠️ Agent ${agentId}: Vanishing gradient risk`);
  }
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
// Ensemble Agent Wrapper
// ============================================

class EnsembleAgent {
  private agents: DQNAgent[];
  private buffers: ReplayBuffer[];
  private tradingBias: number = 3.0; // DOUBLED: Strong initial bias towards trading strategies
  private tradingBiasDecay: number = 0.998; // Slower decay per episode

  constructor(numAgents: number, config: typeof CONFIG.dqn) {
    this.agents = [];
    this.buffers = [];

    for (let i = 0; i < numAgents; i++) {
      const buffer = new ReplayBuffer({
        capacity: CONFIG.bufferSize,
        batchSize: CONFIG.batchSize,
        minExperience: CONFIG.batchSize * 2,
      });

      // Slightly vary each agent for diversity
      const agentConfig = {
        ...config,
        learningRate: config.learningRate * (0.9 + Math.random() * 0.2), // ±10%
        epsilonDecay: config.epsilonDecay * (0.995 + Math.random() * 0.01),
      };

      const agent = new DQNAgent(agentConfig, buffer);
      agent.resetDiagnostics();

      this.agents.push(agent);
      this.buffers.push(buffer);
    }
  }

  selectAction(features: number[], training: boolean): StrategyAction {
    if (CONFIG.votingMethod === 'majority') {
      // Majority voting
      const votes: number[] = new Array(STRATEGY_COUNT).fill(0);

      for (const agent of this.agents) {
        const action = agent.selectAction(features, training);
        if (action >= 0 && action < votes.length && votes[action] !== undefined) {
          votes[action]++;
        }
      }

      // During training, add STRONG bias towards trading strategies (1-4) over WAIT (0)
      if (training && this.tradingBias > 0.1) {
        // Add large fractional votes to trading strategies
        for (let i = 1; i < STRATEGY_COUNT; i++) {
          if (votes[i] !== undefined) {
            votes[i] += this.tradingBias * 3; // Strong bias towards trading
          }
        }
        // Also penalize WAIT votes during training
        if (votes[0] !== undefined) {
          votes[0] *= 0.3; // Reduce WAIT vote weight
        }
      }

      // Find action with most votes
      let maxVotes = 0;
      let selectedAction = 0;
      for (let i = 0; i < votes.length; i++) {
        if (votes[i]! > maxVotes) {
          maxVotes = votes[i]!;
          selectedAction = i;
        }
      }

      return selectedAction as StrategyAction;
    } else {
      // Average Q-values (would need to expose Q-values from agent)
      // For now, use first agent as fallback
      return this.agents[0]!.selectAction(features, training) as StrategyAction;
    }
  }

  storeExperience(state: number[], action: StrategyAction, reward: number, nextState: number[], done: boolean) {
    // Store in all agents' buffers (cast to Action since DQN is configured for 5 actions)
    for (const agent of this.agents) {
      agent.storeExperience(state, action as 0 | 1 | 2 | 3, reward, nextState, done);
    }
  }

  train(): number {
    let totalLoss = 0;
    for (const agent of this.agents) {
      totalLoss += agent.train();
    }
    return totalLoss / this.agents.length;
  }

  endEpisode() {
    for (const agent of this.agents) {
      agent.endEpisode();
    }
    // Decay trading bias over time
    this.tradingBias *= this.tradingBiasDecay;
  }

  getTradingBias(): number {
    return this.tradingBias;
  }

  getAgents(): DQNAgent[] {
    return this.agents;
  }

  getDiagnostics(): ExplorationDiagnostics[] {
    return this.agents.map((a) => a.getDiagnostics());
  }

  getWeightHealth(): WeightHealthReport[] {
    return this.agents.map((a) => a.checkWeightHealth());
  }

  async saveWeights(): Promise<SerializedWeights[]> {
    return Promise.all(this.agents.map((a) => a.saveWeights()));
  }

  dispose() {
    for (const agent of this.agents) {
      agent.dispose();
    }
  }
}

// ============================================
// Training Loop
// ============================================

async function train() {
  log('============================================================');
  log('ICT ENSEMBLE TRAINING');
  log('============================================================');
  log('');
  log(`Configuration:`);
  log(`  Agents: ${CONFIG.numAgents}`);
  log(`  Episodes: ${CONFIG.episodes}`);
  log(`  State Size: ${CONFIG.dqn.inputSize} (18 base + 20 strategy + 4 KB)`);
  log(`  Actions: ${STRATEGY_COUNT} (WAIT, OB, FVG, BOS, CHoCH)`);
  log(`  KB Integration: ${CONFIG.env.kbConfig.enabled ? 'ENABLED' : 'DISABLED'}`);
  log(`  Voting: ${CONFIG.votingMethod}`);
  log('');

  // Load data
  const dataPath = path.join('data', `${SYMBOL}_1h.json`);
  if (!fs.existsSync(dataPath)) {
    throw new Error(`Data file not found: ${dataPath}. Run fetch-historical-data.ts first.`);
  }

  const allCandles = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as Candle[];
  log(`Loaded ${allCandles.length} candles from ${dataPath}`);

  // Use recent data
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
    const splitIdx = Math.floor(recentCandles.length * CONFIG.trainSplit);
    windows = [{
      train: recentCandles.slice(0, splitIdx),
      test: recentCandles.slice(splitIdx),
      windowIndex: 0,
    }];
    log(`Static split: Train=${windows[0]!.train.length} Val=${windows[0]!.test.length}`);
  }
  log('');

  // Create ensemble
  const ensemble = new EnsembleAgent(CONFIG.numAgents, CONFIG.dqn);
  log(`Created ensemble with ${CONFIG.numAgents} agents`);
  log('');

  // Initialize KB (only need one env to init KB)
  log('Initializing KB integration...');
  const initEnv = new ICTMetaStrategyEnvironment(
    windows[0]!.train.slice(0, 500),
    CONFIG.env,
    true
  );
  await initEnv.initializeKB();
  log('  KB initialized');
  log('');

  // Training metrics
  let bestValSharpe = -Infinity;
  let bestValPnL = -Infinity;
  let noImprovementCount = 0;

  // Episodes per window
  const episodesPerWindow = Math.ceil(CONFIG.episodes / windows.length);
  let currentWindowIndex = 0;
  let currentTrainCandles = windows[0]!.train;
  let currentValCandles = windows[0]!.test;

  log('Starting training...');
  log('');

  for (let episode = 1; episode <= CONFIG.episodes; episode++) {
    // Check window rotation
    if (CONFIG.walkForward.enabled && windows.length > 1) {
      const newWindowIndex = Math.floor((episode - 1) / episodesPerWindow);
      if (newWindowIndex !== currentWindowIndex && newWindowIndex < windows.length) {
        currentWindowIndex = newWindowIndex;
        const window = windows[currentWindowIndex]!;
        currentTrainCandles = window.train;
        currentValCandles = window.test;

        log(`\n=== Rotating to Window ${currentWindowIndex + 1}/${windows.length} ===`);
        log(`Train: ${currentTrainCandles.length} Val: ${currentValCandles.length}`);
        log('');
      }
    }

    // Select random segment
    const startIdx = Math.floor(Math.random() * (currentTrainCandles.length - CONFIG.episodeLength - 150));
    const episodeCandles = currentTrainCandles.slice(startIdx, startIdx + CONFIG.episodeLength + 150);

    // Create environment
    const env = new ICTMetaStrategyEnvironment(
      episodeCandles,
      { ...CONFIG.env, randomStart: true },
      true
    );
    await env.initializeKB();

    let state = env.reset();
    let episodeReward = 0;
    let episodeLoss = 0;
    let lossCount = 0;
    let stepCount = 0;
    const strategyUsage: number[] = new Array(STRATEGY_COUNT).fill(0);

    while (!env.isDone() && stepCount < CONFIG.episodeLength) {
      if (state && !env.isInPosition()) {
        // Not in position, select strategy
        const action = ensemble.selectAction(state.features, true);
        if (action >= 0 && action < strategyUsage.length && strategyUsage[action] !== undefined) {
          strategyUsage[action]++;
        }

        const prevFeatures = state.features;
        const result = env.step(action);
        state = result.state;
        episodeReward += result.reward;

        // Store experience (only when not in position - strategy selection moment)
        if (result.state) {
          ensemble.storeExperience(
            prevFeatures,
            action,
            result.reward,
            result.state.features,
            result.done
          );
        }
      } else {
        // In position or no state, just step with null action
        const result = env.step(null);
        state = result.state;
        episodeReward += result.reward;
      }

      // Train periodically
      if (stepCount % CONFIG.trainFrequency === 0) {
        const loss = ensemble.train();
        if (loss > 0) {
          episodeLoss += loss;
          lossCount++;
        }
      }

      stepCount++;
    }

    ensemble.endEpisode();

    const portfolio = env.getPortfolio();
    const trades = env.getTrades();
    const winRate = trades.length > 0
      ? (portfolio.winningTrades / trades.length) * 100
      : 0;
    // Average loss available for detailed logging if needed
    // const avgLoss = lossCount > 0 ? episodeLoss / lossCount : 0;

    // Log strategy usage
    const totalStrategyUses = strategyUsage.reduce((a, b) => a + b, 0);
    const strategyPct = strategyUsage.map((s) =>
      totalStrategyUses > 0 ? ((s / totalStrategyUses) * 100).toFixed(0) : '0'
    );

    // Logging
    if (episode % CONFIG.logInterval === 0) {
      log(`Episode ${episode.toString().padStart(3)}: Reward=${episodeReward.toFixed(2).padStart(7)} Trades=${trades.length.toString().padStart(3)} WinRate=${winRate.toFixed(1).padStart(5)}% PnL=${portfolio.realizedPnL.toFixed(0).padStart(6)} Strat=[W:${strategyPct[0]}% OB:${strategyPct[1]}% FVG:${strategyPct[2]}% BOS:${strategyPct[3]}% CH:${strategyPct[4]}%]`);
    }

    // Diagnostics
    if (episode % CONFIG.diagnosticsInterval === 0) {
      log('');
      log('=== ENSEMBLE DIAGNOSTICS ===');
      const diagnostics = ensemble.getDiagnostics();
      const weightHealths = ensemble.getWeightHealth();

      diagnostics.forEach((d, i) => {
        logDiagnostics(i + 1, d, weightHealths[i]!);
      });

      // KB stats
      const kbStats = env.getKBCacheStats();
      log(`  KB Cache: ${kbStats.size} entries, ${kbStats.hitRate.toFixed(1)}% hit rate`);
      log('');
    }

    // Validation
    if (episode % CONFIG.evalInterval === 0) {
      const valResult = await evaluate(ensemble, currentValCandles);

      log('');
      log(`[VAL] Trades=${valResult.trades} WinRate=${valResult.winRate.toFixed(1)}% PnL=${valResult.pnl.toFixed(0)} Sharpe=${valResult.sharpe.toFixed(3)} R:R=${valResult.avgRiskReward.toFixed(2)}`);
      log(`      Strat=[W:${valResult.strategyPct[0]}% OB:${valResult.strategyPct[1]}% FVG:${valResult.strategyPct[2]}% BOS:${valResult.strategyPct[3]}% CH:${valResult.strategyPct[4]}%]`);

      // Track improvement
      const improved = valResult.sharpe > bestValSharpe + CONFIG.minImprovement ||
        (valResult.sharpe > 0 && valResult.pnl > bestValPnL + 50);

      if (improved) {
        if (valResult.sharpe > bestValSharpe) bestValSharpe = valResult.sharpe;
        if (valResult.pnl > bestValPnL) bestValPnL = valResult.pnl;
        noImprovementCount = 0;

        // Save best model
        const weights = await ensemble.saveWeights();
        const modelData = {
          timestamp: new Date().toISOString(),
          episode,
          numAgents: CONFIG.numAgents,
          valSharpe: valResult.sharpe,
          valPnL: valResult.pnl,
          valWinRate: valResult.winRate,
          valTrades: valResult.trades,
          avgRiskReward: valResult.avgRiskReward,
          strategyUsage: valResult.strategyPct,
          config: CONFIG,
          weights, // Array of weights per agent
        };

        const modelPath = `models/ict_ensemble_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
        fs.writeFileSync(modelPath, JSON.stringify(modelData, null, 2));
        log(`✓ New best ensemble saved: ${modelPath}`);
        log(`  Sharpe: ${valResult.sharpe.toFixed(3)}, PnL: ${valResult.pnl.toFixed(0)}`);

        // Early stopping if we achieve good results (prevent overfit)
        const meetsTargets = valResult.sharpe > 1.0 && valResult.trades >= 10 && valResult.avgRiskReward >= 1.0;
        if (meetsTargets) {
          log('');
          log('🎯 TARGET ACHIEVED! Stopping to prevent overfitting.');
          log(`   Sharpe: ${valResult.sharpe.toFixed(3)} > 1.0`);
          log(`   Trades: ${valResult.trades} >= 10`);
          log(`   R:R: ${valResult.avgRiskReward.toFixed(2)} >= 1.0`);
          break;
        }
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
    log('| Window | Val WR |  PnL   | Sharpe |  R:R  |');
    log('|--------|--------|--------|--------|-------|');

    let positiveSharpCount = 0;
    let totalSharpe = 0;
    let totalRR = 0;

    for (const window of windows) {
      const result = await evaluate(ensemble, window.test);
      totalSharpe += result.sharpe;
      totalRR += result.avgRiskReward;

      if (result.sharpe > 0) positiveSharpCount++;

      log(`|   ${window.windowIndex + 1}    | ${result.winRate.toFixed(1).padStart(5)}% | ${result.pnl.toFixed(0).padStart(6)} | ${result.sharpe.toFixed(2).padStart(6)} | ${result.avgRiskReward.toFixed(2).padStart(5)} |`);
    }

    const avgSharpe = totalSharpe / windows.length;
    const avgRR = totalRR / windows.length;
    log('|--------|--------|--------|--------|-------|');
    log(`| AVG    |   N/A  |   N/A  | ${avgSharpe.toFixed(2).padStart(6)} | ${avgRR.toFixed(2).padStart(5)} |`);
    log('');

    log('SUCCESS CRITERIA:');
    const sharpeOk = positiveSharpCount >= windows.length / 2;
    log(`  ${sharpeOk ? '✓' : '✗'} At least half windows with positive Sharpe: ${positiveSharpCount}/${windows.length}`);
    const rrOk = avgRR >= 1.0;
    log(`  ${rrOk ? '✓' : '✗'} Average R:R >= 1.0: ${avgRR.toFixed(2)}`);
  }

  const finalResult = await evaluate(ensemble, windows[windows.length - 1]!.test);

  log('');
  log('Final Validation Results:');
  log(`  Trades: ${finalResult.trades}`);
  log(`  Win Rate: ${finalResult.winRate.toFixed(1)}%`);
  log(`  Total PnL: ${finalResult.pnl.toFixed(2)}`);
  log(`  Sharpe Ratio: ${finalResult.sharpe.toFixed(3)}`);
  log(`  Avg Risk:Reward: ${finalResult.avgRiskReward.toFixed(2)}`);
  log(`  Max Drawdown: ${(finalResult.maxDrawdown * 100).toFixed(1)}%`);
  log('');
  log(`  Strategy Usage:`);
  log(`    WAIT: ${finalResult.strategyPct[0]}%`);
  log(`    ORDER_BLOCK: ${finalResult.strategyPct[1]}%`);
  log(`    FVG: ${finalResult.strategyPct[2]}%`);
  log(`    BOS_CONTINUATION: ${finalResult.strategyPct[3]}%`);
  log(`    CHOCH_REVERSAL: ${finalResult.strategyPct[4]}%`);
  log('');

  // Success criteria
  log('SUCCESS CRITERIA:');
  const tradesOk = finalResult.trades > 10;
  const sharpeOk = finalResult.sharpe > 0;
  const winRateOk = finalResult.winRate > 48;
  const rrOk = finalResult.avgRiskReward >= 1.0;
  const waitOk = parseInt(finalResult.strategyPct[0] ?? '100', 10) < 80;

  log(`  ${tradesOk ? '✓' : '✗'} Trades > 10: ${finalResult.trades}`);
  log(`  ${sharpeOk ? '✓' : '✗'} Val Sharpe > 0: ${finalResult.sharpe.toFixed(3)}`);
  log(`  ${winRateOk ? '✓' : '✗'} Val Win Rate > 48%: ${finalResult.winRate.toFixed(1)}%`);
  log(`  ${rrOk ? '✓' : '✗'} R:R >= 1.0: ${finalResult.avgRiskReward.toFixed(2)}`);
  log(`  ${waitOk ? '✓' : '✗'} WAIT < 80%: ${finalResult.strategyPct[0]}%`);

  if (tradesOk && sharpeOk && winRateOk && rrOk && waitOk) {
    log('');
    log('✓ All criteria PASSED! Ensemble shows good performance.');
  } else {
    log('');
    log('✗ Some criteria FAILED. Consider:');
    if (!tradesOk) log('  - Reduce WAIT penalty or increase strategy bonuses');
    if (!sharpeOk) log('  - Increase asymmetric loss multiplier');
    if (!winRateOk) log('  - Tune strategy detection parameters');
    if (!rrOk) log('  - Adjust stop loss / take profit ATR multiples');
    if (!waitOk) log('  - Increase exploration or action bias');
  }

  log('');
  log('============================================================');
  log('TRAINING COMPLETE');
  log(`Best Validation Sharpe: ${bestValSharpe.toFixed(3)}`);
  log(`Best Validation PnL: ${bestValPnL.toFixed(2)}`);
  log('============================================================');

  ensemble.dispose();
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
  avgRiskReward: number;
  strategyPct: string[];
}

async function evaluate(
  ensemble: EnsembleAgent,
  candles: Candle[]
): Promise<EvalResult> {
  const env = new ICTMetaStrategyEnvironment(
    candles,
    { ...CONFIG.env, randomStart: false },
    false // Evaluation mode
  );
  await env.initializeKB();

  let state = env.reset();
  const strategyUsage: number[] = new Array(STRATEGY_COUNT).fill(0);
  const riskRewards: number[] = [];

  while (!env.isDone()) {
    if (state && !env.isInPosition()) {
      // Not in position, select strategy
      const action = ensemble.selectAction(state.features, false);
      if (action >= 0 && action < strategyUsage.length && strategyUsage[action] !== undefined) {
        strategyUsage[action]++;
      }

      const result = env.step(action);
      state = result.state;

      // Track R:R from signal
      if (result.info.signal) {
        riskRewards.push(result.info.signal.riskReward);
      }
    } else {
      const result = env.step(null);
      state = result.state;
    }
  }

  const portfolio = env.getPortfolio();
  const trades = env.getTrades();

  // Calculate Sharpe ratio
  const returns = trades.map((t) => t.pnlPercent);
  let sharpe = 0;
  if (returns.length > 1) {
    const avgRet = returns.reduce((a, b) => a + b, 0) / returns.length;
    const stdRet = Math.sqrt(
      returns.reduce((a, r) => a + Math.pow(r - avgRet, 2), 0) / returns.length
    );
    sharpe = stdRet > 0 ? (avgRet / stdRet) * Math.sqrt(252 * 24) : 0;
  }

  // Calculate actual R:R from trades
  const winningTrades = trades.filter((t) => t.pnl > 0);
  const losingTrades = trades.filter((t) => t.pnl < 0);
  const avgWin = winningTrades.length > 0
    ? winningTrades.reduce((sum, t) => sum + t.pnlPercent, 0) / winningTrades.length
    : 0;
  const avgLoss = losingTrades.length > 0
    ? Math.abs(losingTrades.reduce((sum, t) => sum + t.pnlPercent, 0) / losingTrades.length)
    : 1;
  const actualRR = avgLoss > 0 ? avgWin / avgLoss : riskRewards.length > 0
    ? riskRewards.reduce((a, b) => a + b, 0) / riskRewards.length
    : 0;

  // Strategy usage percentages
  const totalUsage = strategyUsage.reduce((a, b) => a + b, 0) || 1;
  const strategyPct = strategyUsage.map((s) =>
    ((s / totalUsage) * 100).toFixed(0)
  );

  return {
    trades: trades.length,
    winRate: trades.length > 0 ? (portfolio.winningTrades / trades.length) * 100 : 0,
    pnl: portfolio.realizedPnL,
    sharpe,
    maxDrawdown: portfolio.maxDrawdown,
    avgRiskReward: actualRR,
    strategyPct,
  };
}

// ============================================
// Run Training
// ============================================

train().catch((err) => {
  console.error('Training failed:', err);
  process.exit(1);
});
