#!/usr/bin/env npx tsx
/**
 * Multi-Symbol ICT Ensemble Training Script
 *
 * Trains a shared ICT ensemble across multiple symbols (BTC, ETH, SOL).
 * Key insight: Training on diverse assets improves generalization by learning
 * universal ICT patterns rather than asset-specific quirks.
 *
 * Architecture:
 * - Single ensemble of DQN agents shared across all symbols
 * - Rotation through symbols during training
 * - Per-symbol and aggregate validation
 * - Best model saved based on aggregate Sharpe
 *
 * Usage:
 *   npx tsx scripts/train-ict-ensemble-multi.ts
 *   npx tsx scripts/train-ict-ensemble-multi.ts --episodes 200 --agents 3
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

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

const CONFIG = {
  // Ensemble
  numAgents: getArg('agents', 3),
  votingMethod: 'majority' as 'majority' | 'average',

  // Symbols
  symbols: SYMBOLS,

  // Data
  trainSplit: 0.8,
  monthsOfData: 6, // Use 6 months for each symbol

  // Training
  episodes: getArg('episodes', 200), // More episodes for multi-symbol
  episodeLength: 1000,
  trainFrequency: 4,
  batchSize: 64,
  bufferSize: 50000, // Larger buffer for more diverse experiences

  // DQN Agent - Similar to single-symbol but slightly more regularized
  dqn: {
    inputSize: 42, // 18 base + 20 strategy + 4 KB
    hiddenLayers: [128, 64, 32],
    outputSize: STRATEGY_COUNT,
    learningRate: 0.0006, // Slightly lower for stability across symbols
    gamma: 0.95,
    tau: 0.01,
    epsilonStart: 1.0,
    epsilonEnd: 0.20, // Higher floor for more exploration across symbols
    epsilonDecay: 0.995, // Slower decay
    dropout: 0.18, // Slightly more regularization
    l2Regularization: 0.008,
    useBatchNorm: true,
    gradientClipNorm: 0.5,
    useHuberLoss: true,
    huberDelta: 1.0,
    actionBias: true,
    actionBiasDecay: 0.997,
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

  // Walk-Forward (per symbol)
  walkForward: {
    enabled: false, // Use static split for multi-symbol
  },

  // Early Stopping
  earlyStoppingPatience: 30, // More patience for multi-symbol
  minImprovement: 0.01,

  // Logging
  logInterval: 10,
  evalInterval: 25, // Evaluate less frequently
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
// Symbol Data Structure
// ============================================

interface SymbolData {
  symbol: string;
  trainCandles: Candle[];
  valCandles: Candle[];
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
    });

    log(`  ${symbol}: ${recentCandles.length} candles (${(recentCandles.length / 24).toFixed(0)} days)`);
    log(`    Train: ${splitIdx} | Val: ${recentCandles.length - splitIdx}`);
  }

  return symbolData;
}

// ============================================
// Ensemble Agent Wrapper
// ============================================

class MultiSymbolEnsemble {
  private agents: DQNAgent[];
  private buffers: ReplayBuffer[];
  private tradingBias: number = 3.0;
  private tradingBiasDecay: number = 0.998;

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
    if (training && this.tradingBias > 0.1) {
      for (let i = 1; i < STRATEGY_COUNT; i++) {
        const voteCount = votes[i];
        if (voteCount !== undefined) {
          votes[i] = voteCount + this.tradingBias * 3;
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
  ensemble: MultiSymbolEnsemble,
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
  ensemble: MultiSymbolEnsemble,
  symbolData: SymbolData[]
): Promise<{ results: EvalResult[]; aggregateSharpe: number }> {
  const results: EvalResult[] = [];

  for (const sd of symbolData) {
    const result = await evaluateSymbol(ensemble, sd.valCandles, sd.symbol);
    results.push(result);
  }

  // Calculate aggregate Sharpe (weighted by data size)
  let totalWeight = 0;
  let weightedSharpe = 0;
  for (let i = 0; i < results.length; i++) {
    const weight = symbolData[i]!.valCandles.length;
    totalWeight += weight;
    weightedSharpe += results[i]!.sharpe * weight;
  }
  const aggregateSharpe = totalWeight > 0 ? weightedSharpe / totalWeight : 0;

  return { results, aggregateSharpe };
}

// ============================================
// Training Loop
// ============================================

async function train() {
  log('============================================================');
  log('MULTI-SYMBOL ICT ENSEMBLE TRAINING');
  log('============================================================');
  log('');
  log('Configuration:');
  log(`  Symbols: ${CONFIG.symbols.join(', ')}`);
  log(`  Agents: ${CONFIG.numAgents}`);
  log(`  Episodes: ${CONFIG.episodes}`);
  log(`  State Size: ${CONFIG.dqn.inputSize} (18 base + 20 strategy + 4 KB)`);
  log(`  Actions: ${STRATEGY_COUNT} (WAIT, OB, FVG, BOS, CHoCH)`);
  log(`  KB Integration: ${CONFIG.env.kbConfig.enabled ? 'ENABLED' : 'DISABLED'}`);
  log('');

  // Load data for all symbols
  log('Loading symbol data...');
  const symbolData = loadSymbolData(CONFIG.symbols, CONFIG.monthsOfData, CONFIG.trainSplit);

  if (symbolData.length === 0) {
    throw new Error('No valid symbol data found. Run fetch-historical-data.ts first.');
  }

  log('');

  // Create ensemble
  const ensemble = new MultiSymbolEnsemble(CONFIG.numAgents, CONFIG.dqn);
  log(`Created ensemble with ${CONFIG.numAgents} agents`);

  // Initialize KB (only need one env to init KB)
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
  let bestPerSymbolSharpe: Record<string, number> = {};
  let noImprovementCount = 0;

  // Track current symbol for rotation
  let currentSymbolIndex = 0;

  log('Starting training...');
  log('');

  for (let episode = 1; episode <= CONFIG.episodes; episode++) {
    // Rotate through symbols
    const sd = symbolData[currentSymbolIndex]!;
    currentSymbolIndex = (currentSymbolIndex + 1) % symbolData.length;

    // Select random segment from current symbol
    const trainCandles = sd.trainCandles;
    const startIdx = Math.floor(Math.random() * (trainCandles.length - CONFIG.episodeLength - 150));
    const episodeCandles = trainCandles.slice(startIdx, startIdx + CONFIG.episodeLength + 150);

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
        const action = ensemble.selectAction(state.features, true);
        if (action >= 0 && action < strategyUsage.length && strategyUsage[action] !== undefined) {
          strategyUsage[action]++;
        }

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

    const totalStrategyUses = strategyUsage.reduce((a, b) => a + b, 0);
    const strategyPct = strategyUsage.map((s) =>
      totalStrategyUses > 0 ? ((s / totalStrategyUses) * 100).toFixed(0) : '0'
    );

    // Logging
    if (episode % CONFIG.logInterval === 0) {
      log(`Episode ${episode.toString().padStart(3)} [${sd.symbol}]: Reward=${episodeReward.toFixed(2).padStart(7)} Trades=${trades.length.toString().padStart(3)} WinRate=${winRate.toFixed(1).padStart(5)}% PnL=${portfolio.realizedPnL.toFixed(0).padStart(6)} Strat=[W:${strategyPct[0]}% OB:${strategyPct[1]}% FVG:${strategyPct[2]}% BOS:${strategyPct[3]}% CH:${strategyPct[4]}%]`);
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
      log('');
    }

    // Validation
    if (episode % CONFIG.evalInterval === 0) {
      const { results, aggregateSharpe } = await evaluateAllSymbols(ensemble, symbolData);

      log('');
      log('=== MULTI-SYMBOL VALIDATION ===');
      log('| Symbol   | Trades | WinRate |  PnL    | Sharpe | R:R  |');
      log('|----------|--------|---------|---------|--------|------|');

      for (const r of results) {
        log(`| ${r.symbol.padEnd(8)} | ${r.trades.toString().padStart(6)} | ${r.winRate.toFixed(1).padStart(6)}% | ${r.pnl.toFixed(0).padStart(7)} | ${r.sharpe.toFixed(2).padStart(6)} | ${r.avgRiskReward.toFixed(2).padStart(4)} |`);
      }

      const avgWinRate = results.reduce((a, r) => a + r.winRate, 0) / results.length;
      const avgPnL = results.reduce((a, r) => a + r.pnl, 0) / results.length;
      const avgRR = results.reduce((a, r) => a + r.avgRiskReward, 0) / results.length;
      const totalTrades = results.reduce((a, r) => a + r.trades, 0);

      log('|----------|--------|---------|---------|--------|------|');
      log(`| AGGREGATE| ${totalTrades.toString().padStart(6)} | ${avgWinRate.toFixed(1).padStart(6)}% | ${avgPnL.toFixed(0).padStart(7)} | ${aggregateSharpe.toFixed(2).padStart(6)} | ${avgRR.toFixed(2).padStart(4)} |`);
      log('');

      // Track improvement
      const improved = aggregateSharpe > bestAggregateSharpe + CONFIG.minImprovement;

      if (improved) {
        bestAggregateSharpe = aggregateSharpe;
        for (const r of results) {
          bestPerSymbolSharpe[r.symbol] = r.sharpe;
        }
        noImprovementCount = 0;

        // Save best model
        const weights = await ensemble.saveWeights();
        const modelData = {
          timestamp: new Date().toISOString(),
          episode,
          type: 'multi_symbol',
          symbols: CONFIG.symbols,
          numAgents: CONFIG.numAgents,
          aggregateSharpe,
          perSymbolResults: results,
          avgWinRate,
          avgPnL,
          avgRiskReward: avgRR,
          totalTrades,
          config: CONFIG,
          weights,
        };

        const modelPath = `models/ict_ensemble_multi_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
        fs.writeFileSync(modelPath, JSON.stringify(modelData, null, 2));
        log(`✓ New best multi-symbol ensemble saved: ${modelPath}`);
        log(`  Aggregate Sharpe: ${aggregateSharpe.toFixed(3)}`);

        // Check success criteria
        const positiveSharpCount = results.filter((r) => r.sharpe > 0).length;
        const winRateOkCount = results.filter((r) => r.winRate > 40).length;

        const meetsTargets =
          aggregateSharpe > 0.5 &&
          positiveSharpCount >= Math.ceil(results.length * 0.66) &&
          winRateOkCount >= Math.ceil(results.length * 0.66) &&
          avgRR >= 1.0;

        if (meetsTargets) {
          log('');
          log('🎯 MULTI-SYMBOL TARGETS ACHIEVED!');
          log(`   Aggregate Sharpe: ${aggregateSharpe.toFixed(3)} > 0.5`);
          log(`   Positive Sharpe on ${positiveSharpCount}/${results.length} symbols (≥ 66%)`);
          log(`   Win Rate > 40% on ${winRateOkCount}/${results.length} symbols`);
          log(`   Avg R:R: ${avgRR.toFixed(2)} >= 1.0`);
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
  log('FINAL MULTI-SYMBOL EVALUATION');
  log('============================================================');

  const { results, aggregateSharpe } = await evaluateAllSymbols(ensemble, symbolData);

  log('');
  log('Per-Symbol Results:');
  log('| Symbol   | Trades | WinRate |  PnL    | Sharpe | MaxDD  | R:R  |');
  log('|----------|--------|---------|---------|--------|--------|------|');

  for (const r of results) {
    log(`| ${r.symbol.padEnd(8)} | ${r.trades.toString().padStart(6)} | ${r.winRate.toFixed(1).padStart(6)}% | ${r.pnl.toFixed(0).padStart(7)} | ${r.sharpe.toFixed(2).padStart(6)} | ${(r.maxDrawdown * 100).toFixed(1).padStart(5)}% | ${r.avgRiskReward.toFixed(2).padStart(4)} |`);
  }

  const avgWinRate = results.reduce((a, r) => a + r.winRate, 0) / results.length;
  const avgRR = results.reduce((a, r) => a + r.avgRiskReward, 0) / results.length;
  const totalTrades = results.reduce((a, r) => a + r.trades, 0);
  const avgDD = results.reduce((a, r) => a + r.maxDrawdown, 0) / results.length;

  log('|----------|--------|---------|---------|--------|--------|------|');
  log(`| AGGREGATE| ${totalTrades.toString().padStart(6)} | ${avgWinRate.toFixed(1).padStart(6)}% |  N/A    | ${aggregateSharpe.toFixed(2).padStart(6)} | ${(avgDD * 100).toFixed(1).padStart(5)}% | ${avgRR.toFixed(2).padStart(4)} |`);
  log('');

  // Success criteria
  log('SUCCESS CRITERIA:');
  const positiveSharpCount = results.filter((r) => r.sharpe > 0).length;
  const winRateOkCount = results.filter((r) => r.winRate > 40).length;

  const sharpeOk = positiveSharpCount >= Math.ceil(results.length * 0.66);
  const winRateOk = winRateOkCount >= Math.ceil(results.length * 0.66);
  const rrOk = avgRR >= 1.0;
  const tradesOk = totalTrades >= 20;

  log(`  ${sharpeOk ? '✓' : '✗'} Positive Sharpe on ≥ 66% symbols: ${positiveSharpCount}/${results.length}`);
  log(`  ${winRateOk ? '✓' : '✗'} Win Rate > 40% on ≥ 66% symbols: ${winRateOkCount}/${results.length}`);
  log(`  ${rrOk ? '✓' : '✗'} Avg R:R >= 1.0: ${avgRR.toFixed(2)}`);
  log(`  ${tradesOk ? '✓' : '✗'} Total Trades >= 20: ${totalTrades}`);

  if (sharpeOk && winRateOk && rrOk && tradesOk) {
    log('');
    log('✓ All multi-symbol criteria PASSED!');
  } else {
    log('');
    log('✗ Some criteria FAILED. Consider:');
    if (!sharpeOk) log('  - More training episodes or adjust learning rate');
    if (!winRateOk) log('  - Tune strategy parameters or increase exploration');
    if (!rrOk) log('  - Adjust TP/SL ATR multiples');
    if (!tradesOk) log('  - Reduce WAIT preference or increase trading bias');
  }

  log('');
  log('============================================================');
  log('MULTI-SYMBOL TRAINING COMPLETE');
  log(`Best Aggregate Sharpe: ${bestAggregateSharpe.toFixed(3)}`);
  log('============================================================');

  ensemble.dispose();
}

// ============================================
// Run Training
// ============================================

train().catch((err) => {
  console.error('Multi-symbol training failed:', err);
  process.exit(1);
});
