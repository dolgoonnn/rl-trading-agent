#!/usr/bin/env npx tsx
/**
 * ICT Ensemble Paper Trading Script
 *
 * Paper trades using a trained ICT ensemble model.
 * Provides detailed KB explanations for each decision.
 *
 * Modes:
 * - Backtest: Run on historical data
 * - Live: Connect to WebSocket for real-time trading
 *
 * Usage:
 *   npx tsx scripts/paper-trade-ict.ts --model models/ict_ensemble_xxx.json --backtest 500
 *   npx tsx scripts/paper-trade-ict.ts --model models/ict_ensemble_xxx.json --live
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import { DQNAgent, type SerializedWeights } from '../src/lib/rl/agent/dqn-agent';
import { ReplayBuffer } from '../src/lib/rl/agent/replay-buffer';
import {
  ICTMetaStrategyEnvironment,
} from '../src/lib/rl/environment/ict-meta-env';
import {
  type StrategyAction,
  STRATEGY_COUNT,
  strategyActionToName,
} from '../src/lib/rl/strategies';
// KB explainer can be used for detailed reasoning if needed
// import { KBDecisionExplainer } from '../src/lib/rl/kb-integration/explainer';

// ============================================
// CLI Arguments
// ============================================

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const MODEL_PATH = getArg('model');
const BACKTEST_BARS = getArg('backtest') ? parseInt(getArg('backtest')!, 10) : 0;
const LIVE_MODE = hasFlag('live');
const VERBOSE = hasFlag('verbose');
const SYMBOL = getArg('symbol') ?? 'BTCUSDT';

if (!MODEL_PATH) {
  console.error('Usage: paper-trade-ict.ts --model <path> [--backtest <bars>] [--live] [--verbose]');
  process.exit(1);
}

// ============================================
// Logging
// ============================================

function log(message: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

function logTrade(trade: {
  side: 'long' | 'short';
  entry: number;
  exit: number;
  pnl: number;
  pnlPercent: number;
  strategy: string;
  reasoning: string[];
}) {
  const icon = trade.pnl >= 0 ? '✓' : '✗';
  const color = trade.pnl >= 0 ? '\x1b[32m' : '\x1b[31m';
  const reset = '\x1b[0m';

  log(`${color}${icon} ${trade.side.toUpperCase()} closed | Entry: ${trade.entry.toFixed(2)} | Exit: ${trade.exit.toFixed(2)} | PnL: ${trade.pnl.toFixed(2)} (${(trade.pnlPercent * 100).toFixed(2)}%)${reset}`);
  log(`  Strategy: ${trade.strategy}`);
  if (VERBOSE && trade.reasoning.length > 0) {
    log(`  Reasoning: ${trade.reasoning.slice(0, 2).join(', ')}`);
  }
}

function logKBExplanation(explanation: string | null) {
  if (explanation && VERBOSE) {
    log(`  [KB] ${explanation}`);
  }
}

// ============================================
// Ensemble Agent Loader
// ============================================

interface SavedModel {
  numAgents: number;
  config: {
    dqn: {
      inputSize: number;
      hiddenLayers: number[];
      outputSize: number;
      learningRate: number;
      gamma: number;
      tau: number;
      epsilonStart: number;
      epsilonEnd: number;
      epsilonDecay: number;
      dropout: number;
      l2Regularization: number;
    };
    env: Record<string, unknown>;
  };
  weights: SerializedWeights[];
  valSharpe: number;
  valPnL: number;
  valWinRate: number;
}

class LoadedEnsemble {
  private agents: DQNAgent[];

  constructor(modelData: SavedModel) {
    this.agents = [];

    for (let i = 0; i < modelData.numAgents; i++) {
      const buffer = new ReplayBuffer({
        capacity: 1000,
        batchSize: 32,
        minExperience: 32,
      });

      const agent = new DQNAgent({
        ...modelData.config.dqn,
        epsilonStart: 0.01, // Minimal exploration for paper trading
        epsilonEnd: 0.01,
      }, buffer);

      // Load weights
      if (modelData.weights[i]) {
        agent.loadWeights(modelData.weights[i]!).catch((err) => {
          console.error(`Failed to load weights for agent ${i}:`, err);
        });
      }

      this.agents.push(agent);
    }
  }

  selectAction(features: number[]): StrategyAction {
    // Majority voting
    const votes: number[] = new Array(STRATEGY_COUNT).fill(0);

    for (const agent of this.agents) {
      const action = agent.selectAction(features, false);
      if (action >= 0 && action < votes.length && votes[action] !== undefined) {
        votes[action]++;
      }
    }

    let maxVotes = 0;
    let selectedAction = 0;
    for (let i = 0; i < votes.length; i++) {
      const voteCount = votes[i] ?? 0;
      if (voteCount > maxVotes) {
        maxVotes = voteCount;
        selectedAction = i;
      }
    }

    return selectedAction as StrategyAction;
  }

  getVoteDistribution(features: number[]): { action: StrategyAction; votes: number[] } {
    const votes: number[] = new Array(STRATEGY_COUNT).fill(0);

    for (const agent of this.agents) {
      const action = agent.selectAction(features, false);
      if (action >= 0 && action < votes.length && votes[action] !== undefined) {
        votes[action]++;
      }
    }

    let maxVotes = 0;
    let selectedAction = 0;
    for (let i = 0; i < votes.length; i++) {
      const voteCount = votes[i] ?? 0;
      if (voteCount > maxVotes) {
        maxVotes = voteCount;
        selectedAction = i;
      }
    }

    return { action: selectedAction as StrategyAction, votes };
  }

  dispose() {
    for (const agent of this.agents) {
      agent.dispose();
    }
  }
}

// ============================================
// Backtest Mode
// ============================================

async function runBacktest(ensemble: LoadedEnsemble, modelData: SavedModel) {
  log('============================================================');
  log('ICT ENSEMBLE PAPER TRADING - BACKTEST MODE');
  log('============================================================');
  log('');

  // Load data
  const dataPath = path.join('data', `${SYMBOL}_1h.json`);
  if (!fs.existsSync(dataPath)) {
    throw new Error(`Data file not found: ${dataPath}`);
  }

  const allCandles = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as Candle[];
  log(`Loaded ${allCandles.length} candles`);

  // Use most recent bars for backtest
  const backtestCandles = allCandles.slice(-BACKTEST_BARS - 100);
  log(`Backtesting on ${BACKTEST_BARS} bars`);
  log('');

  // Create environment
  const env = new ICTMetaStrategyEnvironment(
    backtestCandles,
    modelData.config.env as Partial<import('../src/lib/rl/environment/ict-meta-env').MetaStrategyEnvConfig>,
    false
  );
  await env.initializeKB();

  // Explainer available for detailed KB reasoning if needed
  // const explainer = new KBDecisionExplainer();

  let state = env.reset();
  const trades: Array<{
    side: 'long' | 'short';
    entry: number;
    exit: number;
    pnl: number;
    pnlPercent: number;
    strategy: string;
    reasoning: string[];
    kbExplanation?: string;
  }> = [];

  const strategyUsage: number[] = new Array(STRATEGY_COUNT).fill(0);
  let currentSignal: { strategy: string; reasoning: string[] } | null = null;
  let stepCount = 0;

  log('Starting backtest...');
  log('');

  while (!env.isDone() && stepCount < BACKTEST_BARS) {
    if (state && !env.isInPosition()) {
      // Not in position, select strategy
      const { action, votes } = ensemble.getVoteDistribution(state.features);
      const strategyName = strategyActionToName(action);
      if (action >= 0 && action < strategyUsage.length && strategyUsage[action] !== undefined) {
        strategyUsage[action]++;
      }

      if (VERBOSE) {
        log(`Step ${stepCount}: Selecting ${strategyName} (votes: ${votes.join(',')})`);
      }

      const result = env.step(action);

      // Track signal
      if (result.info.signal) {
        currentSignal = {
          strategy: result.info.signal.strategy,
          reasoning: result.info.signal.reasoning,
        };

        log(`📈 Opening ${result.info.signal.direction.toUpperCase()} via ${strategyName}`);
        log(`   Entry: ${result.info.signal.entryPrice.toFixed(2)} | SL: ${result.info.signal.stopLoss.toFixed(2)} | TP: ${result.info.signal.takeProfit.toFixed(2)}`);
        log(`   R:R: ${result.info.signal.riskReward.toFixed(2)} | Confidence: ${(result.info.signal.confidence * 100).toFixed(0)}%`);

        if (VERBOSE) {
          log(`   Reasoning: ${result.info.signal.reasoning.join(', ')}`);
        }

        // KB explanation
        const kbContext = env.getKBContext();
        if (kbContext) {
          logKBExplanation(kbContext.explanation);
        }
      }

      // Track trade close
      if (result.info.trade) {
        trades.push({
          side: result.info.trade.side,
          entry: result.info.trade.entryPrice,
          exit: result.info.trade.exitPrice,
          pnl: result.info.trade.pnl,
          pnlPercent: result.info.trade.pnlPercent,
          strategy: currentSignal?.strategy ?? 'unknown',
          reasoning: currentSignal?.reasoning ?? [],
          kbExplanation: result.info.kbExplanation ?? undefined,
        });

        logTrade({
          side: result.info.trade.side,
          entry: result.info.trade.entryPrice,
          exit: result.info.trade.exitPrice,
          pnl: result.info.trade.pnl,
          pnlPercent: result.info.trade.pnlPercent,
          strategy: currentSignal?.strategy ?? 'unknown',
          reasoning: currentSignal?.reasoning ?? [],
        });

        currentSignal = null;
        log('');
      }

      state = result.state;
    } else {
      // In position, step with null
      const result = env.step(null);

      // Check for trade close (from SL/TP/strategy exit)
      if (result.info.trade) {
        trades.push({
          side: result.info.trade.side,
          entry: result.info.trade.entryPrice,
          exit: result.info.trade.exitPrice,
          pnl: result.info.trade.pnl,
          pnlPercent: result.info.trade.pnlPercent,
          strategy: currentSignal?.strategy ?? 'unknown',
          reasoning: currentSignal?.reasoning ?? [],
          kbExplanation: result.info.kbExplanation ?? undefined,
        });

        logTrade({
          side: result.info.trade.side,
          entry: result.info.trade.entryPrice,
          exit: result.info.trade.exitPrice,
          pnl: result.info.trade.pnl,
          pnlPercent: result.info.trade.pnlPercent,
          strategy: currentSignal?.strategy ?? 'unknown',
          reasoning: currentSignal?.reasoning ?? [],
        });

        currentSignal = null;
        log('');
      }

      state = result.state;
    }

    stepCount++;
  }

  // Final statistics
  const portfolio = env.getPortfolio();
  const winningTrades = trades.filter((t) => t.pnl > 0);
  const losingTrades = trades.filter((t) => t.pnl < 0);

  // Calculate metrics
  const avgWin = winningTrades.length > 0
    ? winningTrades.reduce((sum, t) => sum + t.pnlPercent, 0) / winningTrades.length
    : 0;
  const avgLoss = losingTrades.length > 0
    ? Math.abs(losingTrades.reduce((sum, t) => sum + t.pnlPercent, 0) / losingTrades.length)
    : 0;
  const riskReward = avgLoss > 0 ? avgWin / avgLoss : 0;

  const returns = trades.map((t) => t.pnlPercent);
  let sharpe = 0;
  if (returns.length > 1) {
    const avgRet = returns.reduce((a, b) => a + b, 0) / returns.length;
    const stdRet = Math.sqrt(
      returns.reduce((a, r) => a + Math.pow(r - avgRet, 2), 0) / returns.length
    );
    sharpe = stdRet > 0 ? (avgRet / stdRet) * Math.sqrt(252 * 24) : 0;
  }

  // Strategy breakdown
  const totalUsage = strategyUsage.reduce((a, b) => a + b, 0) || 1;
  const strategyPct = strategyUsage.map((s) => ((s / totalUsage) * 100).toFixed(1));

  // Trade breakdown by strategy
  const tradesByStrategy: Record<string, { count: number; wins: number; totalPnl: number }> = {};
  for (const trade of trades) {
    if (!tradesByStrategy[trade.strategy]) {
      tradesByStrategy[trade.strategy] = { count: 0, wins: 0, totalPnl: 0 };
    }
    tradesByStrategy[trade.strategy]!.count++;
    if (trade.pnl > 0) tradesByStrategy[trade.strategy]!.wins++;
    tradesByStrategy[trade.strategy]!.totalPnl += trade.pnl;
  }

  log('');
  log('============================================================');
  log('BACKTEST RESULTS');
  log('============================================================');
  log('');
  log('OVERALL PERFORMANCE:');
  log(`  Total Trades: ${trades.length}`);
  log(`  Winning Trades: ${winningTrades.length}`);
  log(`  Losing Trades: ${losingTrades.length}`);
  log(`  Win Rate: ${trades.length > 0 ? ((winningTrades.length / trades.length) * 100).toFixed(1) : 0}%`);
  log('');
  log(`  Total PnL: ${portfolio.realizedPnL.toFixed(2)}`);
  log(`  Average Win: ${(avgWin * 100).toFixed(2)}%`);
  log(`  Average Loss: ${(avgLoss * 100).toFixed(2)}%`);
  log(`  Risk:Reward Ratio: ${riskReward.toFixed(2)}`);
  log(`  Sharpe Ratio: ${sharpe.toFixed(3)}`);
  log(`  Max Drawdown: ${(portfolio.maxDrawdown * 100).toFixed(1)}%`);
  log('');
  log('STRATEGY SELECTION:');
  log(`  WAIT: ${strategyPct[0]}%`);
  log(`  ORDER_BLOCK: ${strategyPct[1]}%`);
  log(`  FVG: ${strategyPct[2]}%`);
  log(`  BOS_CONTINUATION: ${strategyPct[3]}%`);
  log(`  CHOCH_REVERSAL: ${strategyPct[4]}%`);
  log('');
  log('PERFORMANCE BY STRATEGY:');
  for (const [strategy, stats] of Object.entries(tradesByStrategy)) {
    const wr = stats.count > 0 ? ((stats.wins / stats.count) * 100).toFixed(1) : '0.0';
    log(`  ${strategy}: ${stats.count} trades, ${wr}% WR, ${stats.totalPnl.toFixed(2)} PnL`);
  }
  log('');

  // Success criteria
  log('SUCCESS CRITERIA:');
  const tradesOk = trades.length >= 10;
  const sharpeOk = sharpe > 0;
  const winRateOk = winningTrades.length / trades.length > 0.48;
  const rrOk = riskReward >= 1.0;

  log(`  ${tradesOk ? '✓' : '✗'} Trades >= 10: ${trades.length}`);
  log(`  ${sharpeOk ? '✓' : '✗'} Sharpe > 0: ${sharpe.toFixed(3)}`);
  log(`  ${winRateOk ? '✓' : '✗'} Win Rate > 48%: ${((winningTrades.length / trades.length) * 100).toFixed(1)}%`);
  log(`  ${rrOk ? '✓' : '✗'} R:R >= 1.0: ${riskReward.toFixed(2)}`);

  if (tradesOk && sharpeOk && winRateOk && rrOk) {
    log('');
    log('✓ All criteria PASSED!');
  } else {
    log('');
    log('✗ Some criteria FAILED');
  }

  log('');
  log('============================================================');
}

// ============================================
// Live Mode (Placeholder)
// ============================================

async function runLive(_ensemble: LoadedEnsemble, _modelData: SavedModel) {
  log('============================================================');
  log('ICT ENSEMBLE PAPER TRADING - LIVE MODE');
  log('============================================================');
  log('');
  log('Live trading mode not yet implemented.');
  log('This would connect to Binance WebSocket and execute in real-time.');
  log('');
  log('For now, use --backtest <bars> to test on historical data.');
}

// ============================================
// Main
// ============================================

async function main() {
  // Load model
  if (!fs.existsSync(MODEL_PATH!)) {
    console.error(`Model file not found: ${MODEL_PATH}`);
    process.exit(1);
  }

  log(`Loading model from ${MODEL_PATH}`);
  const modelData = JSON.parse(fs.readFileSync(MODEL_PATH!, 'utf-8')) as SavedModel;

  log(`  Agents: ${modelData.numAgents}`);
  log(`  Validation Sharpe: ${modelData.valSharpe?.toFixed(3) ?? 'N/A'}`);
  log(`  Validation PnL: ${modelData.valPnL?.toFixed(0) ?? 'N/A'}`);
  log('');

  const ensemble = new LoadedEnsemble(modelData);

  // Wait for weights to load
  await new Promise((resolve) => setTimeout(resolve, 500));

  try {
    if (BACKTEST_BARS > 0) {
      await runBacktest(ensemble, modelData);
    } else if (LIVE_MODE) {
      await runLive(ensemble, modelData);
    } else {
      console.error('Please specify --backtest <bars> or --live');
      process.exit(1);
    }
  } finally {
    ensemble.dispose();
  }
}

main().catch((err) => {
  console.error('Paper trading failed:', err);
  process.exit(1);
});
