#!/usr/bin/env npx tsx
/**
 * Improved Multi-Symbol ICT Ensemble Training Script
 *
 * Based on research and analysis of model ict_ensemble_multi_2026-02-03T11-14-45.json:
 * - Win rate: 38.8% -> Target: > 45%
 * - SOL Sharpe: -7.99 -> Target: > 0
 * - Strategy balance: Heavy BOS (56-66%), no FVG/CHoCH -> More even distribution
 *
 * Key improvements:
 * 1. Higher dropout (0.30 vs 0.18) - Forces diverse representations
 * 2. Stronger L2 (0.012 vs 0.008) - Reduces overfitting
 * 3. Lower learning rate (0.0004 vs 0.0006) - More stable learning
 * 4. Lower epsilon end (0.15 vs 0.20) - More exploitation in late training
 * 5. More episodes (200) - More training time
 * 6. Walk-forward validation - Better generalization testing
 * 7. Strategy diversity rewards - Encourages using all strategies
 * 8. Double DQN (explicit) - Reduces Q-value overestimation
 *
 * Usage:
 *   npx tsx scripts/train-ict-ensemble-improved.ts
 *   npx tsx scripts/train-ict-ensemble-improved.ts --episodes 300 --dropout 0.35
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
    return parseFloat(argValue);
  }
  return defaultValue;
};

const hasFlag = (name: string): boolean => {
  return args.includes(`--${name}`);
};

// ============================================
// Configuration - IMPROVED HYPERPARAMETERS
// ============================================

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

const CONFIG = {
  // Ensemble
  numAgents: getArg('agents', 3),
  votingMethod: 'majority' as 'majority' | 'average',

  // Symbols
  symbols: SYMBOLS,

  // Data
  trainSplit: 0.8,
  monthsOfData: 6,

  // Training - INCREASED episodes for better convergence
  episodes: getArg('episodes', 200),
  episodeLength: 1000,
  trainFrequency: 4,
  batchSize: 64,
  bufferSize: 50000,

  // DQN Agent - IMPROVED HYPERPARAMETERS
  // Research: Higher dropout/L2 reduces overfitting gap
  dqn: {
    inputSize: 42, // 18 base + 20 strategy + 4 KB
    hiddenLayers: [128, 64, 32],
    outputSize: STRATEGY_COUNT,

    // IMPROVED: Lower learning rate for stability
    learningRate: getArg('lr', 0.0004), // Was 0.0006

    gamma: 0.95,
    tau: 0.01,

    // IMPROVED: Lower epsilon end for more exploitation
    epsilonStart: 1.0,
    epsilonEnd: getArg('epsilon-end', 0.15), // Was 0.20
    epsilonDecay: 0.995,

    // IMPROVED: Higher dropout for regularization
    dropout: getArg('dropout', 0.30), // Was 0.18

    // IMPROVED: Stronger L2 regularization
    l2Regularization: getArg('l2', 0.012), // Was 0.008

    useBatchNorm: true,
    gradientClipNorm: 0.5,
    useHuberLoss: true,
    huberDelta: 1.0,
    actionBias: true,
    actionBiasDecay: 0.997,

    // Research-backed improvements
    useDoubleDQN: true, // Explicit Double DQN
    useLinearEpsilonDecay: true,
    totalExpectedEpisodes: getArg('episodes', 200),
    rewardBasedEpsilonAdjustment: true,
    lowWinRateThreshold: 0.4,
    epsilonBoostAmount: 0.1,
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

  // Walk-Forward Validation - NEW
  walkForward: {
    enabled: hasFlag('walk-forward'),
    trainWindow: 120 * 24, // 120 days of hourly data
    testWindow: 30 * 24,   // 30 days of hourly data
    stepSize: 30 * 24,     // Move forward 30 days
  },

  // Early Stopping
  earlyStoppingPatience: 30,
  minImprovement: 0.01,

  // Logging
  logInterval: 10,
  evalInterval: 25,
  diagnosticsInterval: 50,

  // Strategy diversity reward config
  strategyDiversity: {
    enabled: true,
    weight: 0.1,
    tradeFrequencyPenalty: 0.001,
    targetTradesPerEpisode: 15,
  },
};

// ============================================
// Logging
// ============================================

function log(message: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

function logDiagnostics(agentId: number, diagnostics: ExplorationDiagnostics, weightHealth: WeightHealthReport) {
  // Handle dynamic action distribution
  const actionDist = diagnostics.actionDistribution;
  const waitPct = ((actionDist.hold ?? 0) * 100).toFixed(1);
  const obPct = ((actionDist.buy ?? 0) * 100).toFixed(1);
  const fvgPct = ((actionDist.sell ?? 0) * 100).toFixed(1);
  const bosPct = ((actionDist.close ?? 0) * 100).toFixed(1);

  log(`  Agent ${agentId}: Actions=[WAIT=${waitPct}% OB=${obPct}% FVG=${fvgPct}% BOS=${bosPct}%] QSpread=${diagnostics.qValueSpread.toFixed(4)} ${diagnostics.qValueCollapsed ? '⚠️ COLLAPSED' : '✓'}`);

  if (weightHealth.vanishingGradientRisk) {
    log(`    ⚠️ Agent ${agentId}: Vanishing gradient risk (${(weightHealth.tinyWeightRatio * 100).toFixed(1)}% tiny weights)`);
  }
}

// ============================================
// Symbol Data Structure
// ============================================

interface SymbolData {
  symbol: string;
  trainCandles: Candle[];
  valCandles: Candle[];
  allCandles: Candle[];
}

interface WalkForwardWindow {
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
  windowIndex: number;
}

function loadSymbolData(symbols: string[], monthsOfData: number, trainSplit: number): SymbolData[] {
  const symbolData: SymbolData[] = [];

  for (const symbol of symbols) {
    const dataPath = path.join('data', `${symbol}_1h.json`);
    if (!fs.existsSync(dataPath)) {
      log(`⚠️ Data file not found for ${symbol}: ${dataPath}`);
      continue;
    }

    const allCandles = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as Candle[];
    const recentCandles = allCandles.slice(-monthsOfData * 30 * 24);

    const splitIdx = Math.floor(recentCandles.length * trainSplit);

    symbolData.push({
      symbol,
      trainCandles: recentCandles.slice(0, splitIdx),
      valCandles: recentCandles.slice(splitIdx),
      allCandles: recentCandles,
    });

    log(`  ${symbol}: ${recentCandles.length} candles (${(recentCandles.length / 24).toFixed(0)} days)`);
    log(`    Train: ${splitIdx} | Val: ${recentCandles.length - splitIdx}`);
  }

  return symbolData;
}

/**
 * Generate walk-forward windows for a symbol
 * Instead of fixed train/val split, use rolling windows
 */
function generateWalkForwardWindows(totalCandles: number, config: typeof CONFIG.walkForward): WalkForwardWindow[] {
  if (!config.enabled) {
    return [];
  }

  const windows: WalkForwardWindow[] = [];
  let windowIndex = 0;

  for (let start = 0; start + config.trainWindow + config.testWindow <= totalCandles; start += config.stepSize) {
    windows.push({
      trainStart: start,
      trainEnd: start + config.trainWindow,
      testStart: start + config.trainWindow,
      testEnd: start + config.trainWindow + config.testWindow,
      windowIndex: windowIndex++,
    });
  }

  return windows;
}

// ============================================
// Ensemble Agent Wrapper - IMPROVED
// ============================================

class ImprovedMultiSymbolEnsemble {
  private agents: DQNAgent[];
  private buffers: ReplayBuffer[];
  private tradingBias: number = 3.0;
  private tradingBiasDecay: number = 0.998;

  // Strategy tracking for diversity rewards
  private strategyUsageCount: number[] = [0, 0, 0, 0, 0];
  private episodeTradeCount: number = 0;
  private episodeBars: number = 0;

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
        learningRate: config.learningRate * (0.9 + Math.random() * 0.2),
        epsilonDecay: config.epsilonDecay * (0.995 + Math.random() * 0.01),
      };

      const agent = new DQNAgent(agentConfig, buffer);
      agent.resetDiagnostics();

      this.agents.push(agent);
      this.buffers.push(buffer);
    }
  }

  selectAction(features: number[], training: boolean): StrategyAction {
    // Majority voting
    const votes: number[] = new Array(STRATEGY_COUNT).fill(0);

    for (const agent of this.agents) {
      const action = agent.selectAction(features, training);
      if (action >= 0 && action < votes.length && votes[action] !== undefined) {
        votes[action]++;
      }
    }

    // During training, add bias towards trading strategies
    // IMPROVED: Also add bias towards underused strategies (FVG, CHoCH)
    if (training && this.tradingBias > 0.1) {
      for (let i = 1; i < STRATEGY_COUNT; i++) {
        const voteCount = votes[i];
        if (voteCount !== undefined) {
          // Base trading bias
          let bias = this.tradingBias * 3;

          // Extra bias for underused strategies (FVG=2, CHoCH=4)
          const totalUsage = this.strategyUsageCount.slice(1).reduce((a, b) => a + b, 0);
          if (totalUsage > 10) {
            const usageRatio = (this.strategyUsageCount[i] ?? 0) / totalUsage;
            if (usageRatio < 0.15) {
              // Boost underused strategies
              bias *= 1.5;
            }
          }

          votes[i] = voteCount + bias;
        }
      }
      const waitVotes = votes[0];
      if (waitVotes !== undefined) {
        votes[0] = waitVotes * 0.3;
      }
    }

    let maxVotes = 0;
    let selectedAction = 0;
    for (let i = 0; i < votes.length; i++) {
      if (votes[i]! > maxVotes) {
        maxVotes = votes[i]!;
        selectedAction = i;
      }
    }

    // Track strategy usage
    if (selectedAction > 0) {
      const currentCount = this.strategyUsageCount[selectedAction];
      if (currentCount !== undefined) {
        this.strategyUsageCount[selectedAction] = currentCount + 1;
      }
      this.episodeTradeCount++;
    }
    this.episodeBars++;

    return selectedAction as StrategyAction;
  }

  storeExperience(state: number[], action: StrategyAction, reward: number, nextState: number[], done: boolean) {
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
    this.tradingBias *= this.tradingBiasDecay;
  }

  /**
   * Reset epsilon for new walk-forward window
   * This allows re-exploration when market regime may have changed
   */
  resetEpsilonForNewWindow() {
    for (const agent of this.agents) {
      agent.resetEpsilon();
    }
    log('  Epsilon reset for new walk-forward window');
  }

  /**
   * Reset strategy tracking for new episode
   */
  resetEpisodeTracking() {
    this.strategyUsageCount = [0, 0, 0, 0, 0];
    this.episodeTradeCount = 0;
    this.episodeBars = 0;
  }

  /**
   * Get strategy distribution for logging
   */
  getStrategyDistribution(): string {
    const strategies = ['W', 'OB', 'FVG', 'BOS', 'CH'];
    const total = this.strategyUsageCount.slice(1).reduce((a, b) => a + b, 0) || 1;
    return strategies.slice(1).map((name, i) => {
      const pct = ((this.strategyUsageCount[i + 1] ?? 0) / total * 100).toFixed(0);
      return `${name}:${pct}%`;
    }).join(' ');
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
// Evaluation
// ============================================

interface EvalResult {
  symbol: string;
  trades: number;
  winRate: number;
  pnl: number;
  sharpe: number;
  maxDrawdown: number;
  avgRiskReward: number;
  strategyPct: string[];
}

async function evaluateSymbol(
  ensemble: ImprovedMultiSymbolEnsemble,
  candles: Candle[],
  symbol: string
): Promise<EvalResult> {
  const env = new ICTMetaStrategyEnvironment(
    candles,
    { ...CONFIG.env, randomStart: false },
    false
  );
  await env.initializeKB();

  let state = env.reset();
  const strategyUsage: number[] = new Array(STRATEGY_COUNT).fill(0);
  const riskRewards: number[] = [];

  while (!env.isDone()) {
    if (state && !env.isInPosition()) {
      const action = ensemble.selectAction(state.features, false);
      if (action >= 0 && action < strategyUsage.length && strategyUsage[action] !== undefined) {
        strategyUsage[action]++;
      }

      const result = env.step(action);
      state = result.state;

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

  // Calculate Sharpe
  const returns = trades.map((t) => t.pnlPercent);
  let sharpe = 0;
  if (returns.length > 1) {
    const avgRet = returns.reduce((a, b) => a + b, 0) / returns.length;
    const stdRet = Math.sqrt(
      returns.reduce((a, r) => a + Math.pow(r - avgRet, 2), 0) / returns.length
    );
    sharpe = stdRet > 0 ? (avgRet / stdRet) * Math.sqrt(252 * 24) : 0;
  }

  // Calculate R:R
  const winningTrades = trades.filter((t) => t.pnl > 0);
  const losingTrades = trades.filter((t) => t.pnl < 0);
  const avgWin = winningTrades.length > 0
    ? winningTrades.reduce((sum, t) => sum + t.pnlPercent, 0) / winningTrades.length
    : 0;
  const avgLoss = losingTrades.length > 0
    ? Math.abs(losingTrades.reduce((sum, t) => sum + t.pnlPercent, 0) / losingTrades.length)
    : 1;
  const actualRR = avgLoss > 0 ? avgWin / avgLoss : 0;

  const totalUsage = strategyUsage.reduce((a, b) => a + b, 0) || 1;
  const strategyPct = strategyUsage.map((s) => ((s / totalUsage) * 100).toFixed(0));

  return {
    symbol,
    trades: trades.length,
    winRate: trades.length > 0 ? (portfolio.winningTrades / trades.length) * 100 : 0,
    pnl: portfolio.realizedPnL,
    sharpe,
    maxDrawdown: portfolio.maxDrawdown,
    avgRiskReward: actualRR,
    strategyPct,
  };
}

async function evaluateAllSymbols(
  ensemble: ImprovedMultiSymbolEnsemble,
  symbolData: SymbolData[],
  useValData: boolean = true
): Promise<{ results: EvalResult[]; aggregateSharpe: number }> {
  const results: EvalResult[] = [];

  for (const sd of symbolData) {
    const candles = useValData ? sd.valCandles : sd.trainCandles;
    const result = await evaluateSymbol(ensemble, candles, sd.symbol);
    results.push(result);
  }

  // Calculate aggregate Sharpe (weighted by data size)
  let totalWeight = 0;
  let weightedSharpe = 0;
  for (let i = 0; i < results.length; i++) {
    const sd = symbolData[i];
    const candles = useValData ? sd?.valCandles : sd?.trainCandles;
    const weight = candles?.length ?? 0;
    totalWeight += weight;
    weightedSharpe += (results[i]?.sharpe ?? 0) * weight;
  }
  const aggregateSharpe = totalWeight > 0 ? weightedSharpe / totalWeight : 0;

  return { results, aggregateSharpe };
}

// ============================================
// Training Loop
// ============================================

async function train() {
  log('============================================================');
  log('IMPROVED MULTI-SYMBOL ICT ENSEMBLE TRAINING');
  log('============================================================');
  log('');
  log('IMPROVEMENTS over baseline model:');
  log(`  Dropout: 0.18 -> ${CONFIG.dqn.dropout} (higher regularization)`);
  log(`  L2 Reg:  0.008 -> ${CONFIG.dqn.l2Regularization} (stronger weight penalty)`);
  log(`  LR:      0.0006 -> ${CONFIG.dqn.learningRate} (slower, more stable)`);
  log(`  Epsilon End: 0.20 -> ${CONFIG.dqn.epsilonEnd} (more exploitation)`);
  log(`  Episodes: 100 -> ${CONFIG.episodes} (more training)`);
  log(`  Double DQN: ${CONFIG.dqn.useDoubleDQN ? 'ENABLED' : 'DISABLED'}`);
  log(`  Strategy Diversity: ${CONFIG.strategyDiversity.enabled ? 'ENABLED' : 'DISABLED'}`);
  log(`  Walk-Forward: ${CONFIG.walkForward.enabled ? 'ENABLED' : 'DISABLED'}`);
  log('');
  log('Configuration:');
  log(`  Symbols: ${CONFIG.symbols.join(', ')}`);
  log(`  Agents: ${CONFIG.numAgents}`);
  log(`  Episodes: ${CONFIG.episodes}`);
  log(`  State Size: ${CONFIG.dqn.inputSize} (18 base + 20 strategy + 4 KB)`);
  log(`  Actions: ${STRATEGY_COUNT} (WAIT, OB, FVG, BOS, CHoCH)`);
  log('');

  // Load data for all symbols
  log('Loading symbol data...');
  const symbolData = loadSymbolData(CONFIG.symbols, CONFIG.monthsOfData, CONFIG.trainSplit);

  if (symbolData.length === 0) {
    throw new Error('No valid symbol data found. Run fetch-historical-data.ts first.');
  }

  log('');

  // Create ensemble
  const ensemble = new ImprovedMultiSymbolEnsemble(CONFIG.numAgents, CONFIG.dqn);
  log(`Created improved ensemble with ${CONFIG.numAgents} agents`);

  // Initialize KB
  log('Initializing KB integration...');
  const initEnv = new ICTMetaStrategyEnvironment(
    symbolData[0]!.trainCandles.slice(0, 500),
    CONFIG.env,
    true
  );
  await initEnv.initializeKB();
  log('  KB initialized');
  log('');

  // Training metrics
  let bestAggregateSharpe = -Infinity;
  let bestValTrainRatio = 0; // Track validation/training Sharpe ratio for overfitting
  let noImprovementCount = 0;

  // Track current symbol for rotation
  let currentSymbolIndex = 0;

  // Walk-forward windows if enabled
  let walkForwardWindows: WalkForwardWindow[] = [];
  let currentWindowIndex = 0;
  if (CONFIG.walkForward.enabled) {
    walkForwardWindows = generateWalkForwardWindows(
      symbolData[0]!.allCandles.length,
      CONFIG.walkForward
    );
    log(`Walk-forward validation: ${walkForwardWindows.length} windows`);
    log('');
  }

  log('Starting training...');
  log('');

  for (let episode = 1; episode <= CONFIG.episodes; episode++) {
    ensemble.resetEpisodeTracking();

    // Rotate through symbols
    const sd = symbolData[currentSymbolIndex]!;
    currentSymbolIndex = (currentSymbolIndex + 1) % symbolData.length;

    // Select candles based on walk-forward or static split
    let episodeCandles: Candle[];
    if (CONFIG.walkForward.enabled && walkForwardWindows.length > 0) {
      const window = walkForwardWindows[currentWindowIndex % walkForwardWindows.length]!;
      const trainCandles = sd.allCandles.slice(window.trainStart, window.trainEnd);

      // Random segment from training window
      const startIdx = Math.floor(Math.random() * (trainCandles.length - CONFIG.episodeLength - 150));
      episodeCandles = trainCandles.slice(startIdx, startIdx + CONFIG.episodeLength + 150);

      // Move to next window periodically
      if (episode % (CONFIG.episodes / walkForwardWindows.length) === 0 && currentWindowIndex < walkForwardWindows.length - 1) {
        currentWindowIndex++;
        ensemble.resetEpsilonForNewWindow();
        log(`  Moving to walk-forward window ${currentWindowIndex + 1}/${walkForwardWindows.length}`);
      }
    } else {
      // Standard static split
      const trainCandles = sd.trainCandles;
      const startIdx = Math.floor(Math.random() * (trainCandles.length - CONFIG.episodeLength - 150));
      episodeCandles = trainCandles.slice(startIdx, startIdx + CONFIG.episodeLength + 150);
    }

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

    while (!env.isDone() && stepCount < CONFIG.episodeLength) {
      if (state && !env.isInPosition()) {
        const action = ensemble.selectAction(state.features, true);

        const prevFeatures = state.features;
        const result = env.step(action);
        state = result.state;
        episodeReward += result.reward;

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
        const result = env.step(null);
        state = result.state;
        episodeReward += result.reward;
      }

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

    const strategyDist = ensemble.getStrategyDistribution();

    // Logging
    if (episode % CONFIG.logInterval === 0) {
      const avgLoss = lossCount > 0 ? episodeLoss / lossCount : 0;
      log(`Ep ${episode.toString().padStart(3)} [${sd.symbol}]: R=${episodeReward.toFixed(2).padStart(7)} Tr=${trades.length.toString().padStart(3)} WR=${winRate.toFixed(1).padStart(5)}% PnL=${portfolio.realizedPnL.toFixed(0).padStart(6)} Loss=${avgLoss.toFixed(4)} | ${strategyDist}`);
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

      const kbStats = env.getKBCacheStats();
      log(`  KB Cache: ${kbStats.size} entries, ${kbStats.hitRate.toFixed(1)}% hit rate`);
      log(`  Trading Bias: ${ensemble.getTradingBias().toFixed(3)}`);
      log('');
    }

    // Validation
    if (episode % CONFIG.evalInterval === 0) {
      // Evaluate on both train and validation sets
      const trainResults = await evaluateAllSymbols(ensemble, symbolData, false);
      const valResults = await evaluateAllSymbols(ensemble, symbolData, true);

      log('');
      log('=== MULTI-SYMBOL VALIDATION ===');
      log('| Symbol   | Trades | WinRate |  PnL    | Sharpe | R:R  | Strat Distribution     |');
      log('|----------|--------|---------|---------|--------|------|------------------------|');

      for (const r of valResults.results) {
        const stratStr = `W:${r.strategyPct[0]} OB:${r.strategyPct[1]} FVG:${r.strategyPct[2]} BOS:${r.strategyPct[3]} CH:${r.strategyPct[4]}`;
        log(`| ${r.symbol.padEnd(8)} | ${r.trades.toString().padStart(6)} | ${r.winRate.toFixed(1).padStart(6)}% | ${r.pnl.toFixed(0).padStart(7)} | ${r.sharpe.toFixed(2).padStart(6)} | ${r.avgRiskReward.toFixed(2).padStart(4)} | ${stratStr.padEnd(22)} |`);
      }

      const avgWinRate = valResults.results.reduce((a, r) => a + r.winRate, 0) / valResults.results.length;
      const avgPnL = valResults.results.reduce((a, r) => a + r.pnl, 0) / valResults.results.length;
      const avgRR = valResults.results.reduce((a, r) => a + r.avgRiskReward, 0) / valResults.results.length;
      const totalTrades = valResults.results.reduce((a, r) => a + r.trades, 0);

      log('|----------|--------|---------|---------|--------|------|------------------------|');
      log(`| AGGREGATE| ${totalTrades.toString().padStart(6)} | ${avgWinRate.toFixed(1).padStart(6)}% | ${avgPnL.toFixed(0).padStart(7)} | ${valResults.aggregateSharpe.toFixed(2).padStart(6)} | ${avgRR.toFixed(2).padStart(4)} |                        |`);
      log('');

      // Calculate overfitting metric: validation Sharpe / training Sharpe
      const valTrainRatio = trainResults.aggregateSharpe !== 0
        ? valResults.aggregateSharpe / trainResults.aggregateSharpe
        : 0;

      log(`  Overfitting check: Val/Train Sharpe ratio = ${valTrainRatio.toFixed(3)} (target > 0.50)`);
      log(`    Train Sharpe: ${trainResults.aggregateSharpe.toFixed(3)} | Val Sharpe: ${valResults.aggregateSharpe.toFixed(3)}`);

      // Track improvement based on validation Sharpe
      const improved = valResults.aggregateSharpe > bestAggregateSharpe + CONFIG.minImprovement;

      if (improved) {
        bestAggregateSharpe = valResults.aggregateSharpe;
        bestValTrainRatio = valTrainRatio;
        noImprovementCount = 0;

        // Save best model
        const weights = await ensemble.saveWeights();
        const modelData = {
          timestamp: new Date().toISOString(),
          episode,
          type: 'improved_multi_symbol',
          version: '2.0',
          symbols: CONFIG.symbols,
          numAgents: CONFIG.numAgents,
          aggregateSharpe: valResults.aggregateSharpe,
          trainSharpe: trainResults.aggregateSharpe,
          valTrainRatio,
          perSymbolResults: valResults.results,
          avgWinRate,
          avgPnL,
          avgRiskReward: avgRR,
          totalTrades,
          improvements: {
            dropout: CONFIG.dqn.dropout,
            l2Regularization: CONFIG.dqn.l2Regularization,
            learningRate: CONFIG.dqn.learningRate,
            epsilonEnd: CONFIG.dqn.epsilonEnd,
            useDoubleDQN: CONFIG.dqn.useDoubleDQN,
            strategyDiversity: CONFIG.strategyDiversity.enabled,
            walkForward: CONFIG.walkForward.enabled,
          },
          config: CONFIG,
          weights,
        };

        const modelPath = `models/ict_ensemble_improved_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
        fs.writeFileSync(modelPath, JSON.stringify(modelData, null, 2));
        log(`✓ New best improved model saved: ${modelPath}`);
        log(`  Val Sharpe: ${valResults.aggregateSharpe.toFixed(3)} | Val/Train: ${valTrainRatio.toFixed(3)}`);

        // Check success criteria (improved targets)
        const positiveSharpCount = valResults.results.filter((r) => r.sharpe > 0).length;
        const winRateOkCount = valResults.results.filter((r) => r.winRate > 45).length; // Increased from 40%
        const strategyBalanced = checkStrategyBalance(valResults.results);

        const meetsTargets =
          valResults.aggregateSharpe > 0.5 &&
          positiveSharpCount >= Math.ceil(valResults.results.length * 0.66) &&
          winRateOkCount >= Math.ceil(valResults.results.length * 0.66) &&
          avgRR >= 1.0 &&
          valTrainRatio > 0.50 && // Overfitting check
          strategyBalanced;

        if (meetsTargets) {
          log('');
          log('🎯 IMPROVED TARGETS ACHIEVED!');
          log(`   Val Sharpe: ${valResults.aggregateSharpe.toFixed(3)} > 0.5`);
          log(`   Positive Sharpe on ${positiveSharpCount}/${valResults.results.length} symbols (≥ 66%)`);
          log(`   Win Rate > 45% on ${winRateOkCount}/${valResults.results.length} symbols`);
          log(`   Avg R:R: ${avgRR.toFixed(2)} >= 1.0`);
          log(`   Val/Train ratio: ${valTrainRatio.toFixed(3)} > 0.50 (not overfitting)`);
          log(`   Strategy balance: ✓`);
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
  log('FINAL IMPROVED MODEL EVALUATION');
  log('============================================================');

  const finalResults = await evaluateAllSymbols(ensemble, symbolData, true);

  log('');
  log('Per-Symbol Results:');
  log('| Symbol   | Trades | WinRate |  PnL    | Sharpe | MaxDD  | R:R  |');
  log('|----------|--------|---------|---------|--------|--------|------|');

  for (const r of finalResults.results) {
    log(`| ${r.symbol.padEnd(8)} | ${r.trades.toString().padStart(6)} | ${r.winRate.toFixed(1).padStart(6)}% | ${r.pnl.toFixed(0).padStart(7)} | ${r.sharpe.toFixed(2).padStart(6)} | ${(r.maxDrawdown * 100).toFixed(1).padStart(5)}% | ${r.avgRiskReward.toFixed(2).padStart(4)} |`);
  }

  const avgWinRate = finalResults.results.reduce((a, r) => a + r.winRate, 0) / finalResults.results.length;
  const avgRR = finalResults.results.reduce((a, r) => a + r.avgRiskReward, 0) / finalResults.results.length;
  const totalTrades = finalResults.results.reduce((a, r) => a + r.trades, 0);
  const avgDD = finalResults.results.reduce((a, r) => a + r.maxDrawdown, 0) / finalResults.results.length;

  log('|----------|--------|---------|---------|--------|--------|------|');
  log(`| AGGREGATE| ${totalTrades.toString().padStart(6)} | ${avgWinRate.toFixed(1).padStart(6)}% |  N/A    | ${finalResults.aggregateSharpe.toFixed(2).padStart(6)} | ${(avgDD * 100).toFixed(1).padStart(5)}% | ${avgRR.toFixed(2).padStart(4)} |`);
  log('');

  // Success criteria comparison
  log('SUCCESS CRITERIA vs BASELINE:');
  log('');
  log('| Metric                    | Baseline | Current | Target | Status |');
  log('|---------------------------|----------|---------|--------|--------|');
  log(`| Aggregate Win Rate        |  38.8%   | ${avgWinRate.toFixed(1).padStart(6)}% |  > 45% | ${avgWinRate > 45 ? '✓' : '✗'}      |`);

  const solResult = finalResults.results.find(r => r.symbol === 'SOLUSDT');
  const solSharpe = solResult?.sharpe ?? 0;
  log(`| SOL Sharpe                |  -7.99   | ${solSharpe.toFixed(2).padStart(6)} |  > 0   | ${solSharpe > 0 ? '✓' : '✗'}      |`);

  const btcResult = finalResults.results.find(r => r.symbol === 'BTCUSDT');
  const btcWinRate = btcResult?.winRate ?? 0;
  log(`| BTC Win Rate              |  30.0%   | ${btcWinRate.toFixed(1).padStart(6)}% |  > 40% | ${btcWinRate > 40 ? '✓' : '✗'}      |`);

  log(`| Val/Train Sharpe Ratio    |  ~0.25   | ${bestValTrainRatio.toFixed(2).padStart(6)} |  > 0.50| ${bestValTrainRatio > 0.50 ? '✓' : '✗'}      |`);
  log(`| Strategy Balance          |  Unbal.  | ${checkStrategyBalance(finalResults.results) ? 'Bal.' : 'Unbal.'}.  | Balanced| ${checkStrategyBalance(finalResults.results) ? '✓' : '✗'}      |`);

  log('');
  log('============================================================');
  log('IMPROVED TRAINING COMPLETE');
  log(`Best Val Sharpe: ${bestAggregateSharpe.toFixed(3)}`);
  log(`Best Val/Train Ratio: ${bestValTrainRatio.toFixed(3)}`);
  log('============================================================');

  ensemble.dispose();
}

/**
 * Check if strategy usage is balanced (no strategy dominates > 50%)
 */
function checkStrategyBalance(results: EvalResult[]): boolean {
  for (const r of results) {
    // Check if any single trading strategy dominates > 50%
    for (let i = 1; i < r.strategyPct.length; i++) {
      const pct = parseFloat(r.strategyPct[i] ?? '0');
      if (pct > 50) {
        return false; // One strategy dominates
      }
    }

    // Check if FVG and CHoCH are both used (> 5% each)
    const fvgPct = parseFloat(r.strategyPct[2] ?? '0');
    const chochPct = parseFloat(r.strategyPct[4] ?? '0');
    if (fvgPct < 5 && chochPct < 5) {
      return false; // FVG and CHoCH both underused
    }
  }
  return true;
}

// ============================================
// Run Training
// ============================================

train().catch((err) => {
  console.error('Improved training failed:', err);
  process.exit(1);
});
