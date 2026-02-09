#!/usr/bin/env npx tsx
/**
 * 90-Day Validation Gate Script
 *
 * This is the HARD GATE for model acceptance.
 * A model must pass ALL criteria to be considered successful.
 *
 * Criteria:
 * - BTC 90-day Sharpe > 0
 * - ETH 90-day Sharpe > 0
 * - SOL 90-day Sharpe > 0
 * - Aggregate Win Rate > 35%
 * - Min 10 trades per symbol
 *
 * Usage:
 *   npx tsx scripts/validate-90day.ts --model models/xxx.json
 *   npx tsx scripts/validate-90day.ts --model models/xxx.json --save-result
 *   npx tsx scripts/validate-90day.ts --model models/xxx.json --experiment-id exp-001
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
} from '../src/lib/rl/strategies';

// ============================================
// Configuration
// ============================================

const VALIDATION_CONFIG = {
  backtestBars: 2160, // 90 days of hourly data
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  gate: {
    minSharpePerSymbol: 0, // All symbols must be positive
    minAggregateWinRate: 35, // Percentage
    minTradesPerSymbol: 10,
  },
};

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
const EXPERIMENT_ID = getArg('experiment-id');
const SAVE_RESULT = hasFlag('save-result');
const JSON_OUTPUT = hasFlag('json');

if (!MODEL_PATH) {
  console.error('Usage: validate-90day.ts --model <path> [--save-result] [--experiment-id <id>] [--json]');
  process.exit(1);
}

// ============================================
// Types
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
}

interface SymbolResult {
  symbol: string;
  trades: number;
  winRate: number;
  pnl: number;
  sharpe: number;
  maxDrawdown: number;
  avgRiskReward: number;
  passed: boolean;
  failReasons: string[];
}

interface ValidationResult {
  timestamp: string;
  modelPath: string;
  backtestBars: number;
  symbols: SymbolResult[];
  aggregate: {
    totalTrades: number;
    avgWinRate: number;
    avgSharpe: number;
    avgDrawdown: number;
  };
  gate: {
    passed: boolean;
    criteria: {
      allSymbolsSharpePositive: boolean;
      aggregateWinRateOk: boolean;
      allSymbolsMinTrades: boolean;
    };
    failReasons: string[];
  };
}

// ============================================
// Logging
// ============================================

function log(message: string) {
  if (!JSON_OUTPUT) {
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
  }
}

// ============================================
// Ensemble Loader
// ============================================

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
        epsilonStart: 0.01,
        epsilonEnd: 0.01,
      }, buffer);

      if (modelData.weights[i]) {
        agent.loadWeights(modelData.weights[i]!).catch((err) => {
          console.error(`Failed to load weights for agent ${i}:`, err);
        });
      }

      this.agents.push(agent);
    }
  }

  selectAction(features: number[]): StrategyAction {
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

  dispose() {
    for (const agent of this.agents) {
      agent.dispose();
    }
  }
}

// ============================================
// Validation Logic
// ============================================

async function validateSymbol(
  ensemble: LoadedEnsemble,
  symbol: string,
  modelData: SavedModel
): Promise<SymbolResult> {
  const dataPath = path.join('data', `${symbol}_1h.json`);
  if (!fs.existsSync(dataPath)) {
    return {
      symbol,
      trades: 0,
      winRate: 0,
      pnl: 0,
      sharpe: 0,
      maxDrawdown: 0,
      avgRiskReward: 0,
      passed: false,
      failReasons: [`Data file not found: ${dataPath}`],
    };
  }

  const allCandles = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as Candle[];

  // Use most recent 90 days (+ 100 for lookback)
  const backtestCandles = allCandles.slice(-(VALIDATION_CONFIG.backtestBars + 100));

  log(`  ${symbol}: Testing on ${VALIDATION_CONFIG.backtestBars} bars (${(VALIDATION_CONFIG.backtestBars / 24).toFixed(0)} days)`);

  const env = new ICTMetaStrategyEnvironment(
    backtestCandles,
    modelData.config.env as Parameters<typeof ICTMetaStrategyEnvironment.prototype.constructor>[1],
    false
  );
  await env.initializeKB();

  let state = env.reset();
  let stepCount = 0;

  while (!env.isDone() && stepCount < VALIDATION_CONFIG.backtestBars) {
    if (state && !env.isInPosition()) {
      const action = ensemble.selectAction(state.features);
      const result = env.step(action);
      state = result.state;
    } else {
      const result = env.step(null);
      state = result.state;
    }
    stepCount++;
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
  const avgRiskReward = avgLoss > 0 ? avgWin / avgLoss : 0;

  const winRate = trades.length > 0 ? (winningTrades.length / trades.length) * 100 : 0;

  // Check pass criteria
  const failReasons: string[] = [];
  if (sharpe <= VALIDATION_CONFIG.gate.minSharpePerSymbol) {
    failReasons.push(`Sharpe ${sharpe.toFixed(2)} <= ${VALIDATION_CONFIG.gate.minSharpePerSymbol}`);
  }
  if (trades.length < VALIDATION_CONFIG.gate.minTradesPerSymbol) {
    failReasons.push(`Trades ${trades.length} < ${VALIDATION_CONFIG.gate.minTradesPerSymbol}`);
  }

  return {
    symbol,
    trades: trades.length,
    winRate,
    pnl: portfolio.realizedPnL,
    sharpe,
    maxDrawdown: portfolio.maxDrawdown,
    avgRiskReward,
    passed: failReasons.length === 0,
    failReasons,
  };
}

async function runValidation(): Promise<ValidationResult> {
  log('============================================================');
  log('90-DAY VALIDATION GATE');
  log('============================================================');
  log('');
  log(`Model: ${MODEL_PATH}`);
  log(`Backtest: ${VALIDATION_CONFIG.backtestBars} bars (${(VALIDATION_CONFIG.backtestBars / 24).toFixed(0)} days)`);
  log('');

  // Load model
  if (!fs.existsSync(MODEL_PATH!)) {
    throw new Error(`Model file not found: ${MODEL_PATH}`);
  }

  const modelData = JSON.parse(fs.readFileSync(MODEL_PATH!, 'utf-8')) as SavedModel;
  log(`Loaded model with ${modelData.numAgents} agents`);
  log('');

  const ensemble = new LoadedEnsemble(modelData);

  // Wait for weights to load
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Validate each symbol
  log('Running validation...');
  log('');

  const symbolResults: SymbolResult[] = [];
  for (const symbol of VALIDATION_CONFIG.symbols) {
    const result = await validateSymbol(ensemble, symbol, modelData);
    symbolResults.push(result);
  }

  ensemble.dispose();

  // Calculate aggregate metrics
  const totalTrades = symbolResults.reduce((a, r) => a + r.trades, 0);
  const avgWinRate = symbolResults.reduce((a, r) => a + r.winRate, 0) / symbolResults.length;
  const avgSharpe = symbolResults.reduce((a, r) => a + r.sharpe, 0) / symbolResults.length;
  const avgDrawdown = symbolResults.reduce((a, r) => a + r.maxDrawdown, 0) / symbolResults.length;

  // Check gate criteria
  const allSymbolsSharpePositive = symbolResults.every((r) => r.sharpe > 0);
  const aggregateWinRateOk = avgWinRate >= VALIDATION_CONFIG.gate.minAggregateWinRate;
  const allSymbolsMinTrades = symbolResults.every((r) => r.trades >= VALIDATION_CONFIG.gate.minTradesPerSymbol);

  const gateFailReasons: string[] = [];
  if (!allSymbolsSharpePositive) {
    const failedSymbols = symbolResults.filter((r) => r.sharpe <= 0);
    gateFailReasons.push(`Negative Sharpe on: ${failedSymbols.map((r) => `${r.symbol}(${r.sharpe.toFixed(2)})`).join(', ')}`);
  }
  if (!aggregateWinRateOk) {
    gateFailReasons.push(`Aggregate win rate ${avgWinRate.toFixed(1)}% < ${VALIDATION_CONFIG.gate.minAggregateWinRate}%`);
  }
  if (!allSymbolsMinTrades) {
    const failedSymbols = symbolResults.filter((r) => r.trades < VALIDATION_CONFIG.gate.minTradesPerSymbol);
    gateFailReasons.push(`Insufficient trades on: ${failedSymbols.map((r) => `${r.symbol}(${r.trades})`).join(', ')}`);
  }

  const gatePassed = gateFailReasons.length === 0;

  const result: ValidationResult = {
    timestamp: new Date().toISOString(),
    modelPath: MODEL_PATH!,
    backtestBars: VALIDATION_CONFIG.backtestBars,
    symbols: symbolResults,
    aggregate: {
      totalTrades,
      avgWinRate,
      avgSharpe,
      avgDrawdown,
    },
    gate: {
      passed: gatePassed,
      criteria: {
        allSymbolsSharpePositive,
        aggregateWinRateOk,
        allSymbolsMinTrades,
      },
      failReasons: gateFailReasons,
    },
  };

  return result;
}

function printResults(result: ValidationResult) {
  if (JSON_OUTPUT) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  log('');
  log('============================================================');
  log('RESULTS');
  log('============================================================');
  log('');
  log('| Symbol   | Trades | WinRate |  PnL    | Sharpe | MaxDD  | Status |');
  log('|----------|--------|---------|---------|--------|--------|--------|');

  for (const r of result.symbols) {
    const status = r.passed ? 'PASS' : 'FAIL';
    const statusIcon = r.passed ? '\x1b[32m' : '\x1b[31m';
    const reset = '\x1b[0m';
    log(`| ${r.symbol.padEnd(8)} | ${r.trades.toString().padStart(6)} | ${r.winRate.toFixed(1).padStart(6)}% | ${r.pnl.toFixed(0).padStart(7)} | ${r.sharpe.toFixed(2).padStart(6)} | ${(r.maxDrawdown * 100).toFixed(1).padStart(5)}% | ${statusIcon}${status.padStart(6)}${reset} |`);
  }

  log('|----------|--------|---------|---------|--------|--------|--------|');
  log(`| AGGREGATE| ${result.aggregate.totalTrades.toString().padStart(6)} | ${result.aggregate.avgWinRate.toFixed(1).padStart(6)}% |    -    | ${result.aggregate.avgSharpe.toFixed(2).padStart(6)} | ${(result.aggregate.avgDrawdown * 100).toFixed(1).padStart(5)}% |        |`);
  log('');

  log('GATE CRITERIA:');
  log(`  ${result.gate.criteria.allSymbolsSharpePositive ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} All symbols Sharpe > 0`);
  log(`  ${result.gate.criteria.aggregateWinRateOk ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} Aggregate win rate >= ${VALIDATION_CONFIG.gate.minAggregateWinRate}%`);
  log(`  ${result.gate.criteria.allSymbolsMinTrades ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} All symbols >= ${VALIDATION_CONFIG.gate.minTradesPerSymbol} trades`);
  log('');

  if (result.gate.passed) {
    log('\x1b[32m============================================================\x1b[0m');
    log('\x1b[32m                    GATE: PASSED\x1b[0m');
    log('\x1b[32m============================================================\x1b[0m');
  } else {
    log('\x1b[31m============================================================\x1b[0m');
    log('\x1b[31m                    GATE: FAILED\x1b[0m');
    log('\x1b[31m============================================================\x1b[0m');
    log('');
    log('Fail reasons:');
    for (const reason of result.gate.failReasons) {
      log(`  - ${reason}`);
    }
  }
}

async function saveToExperiments(result: ValidationResult) {
  const experimentsPath = path.join('experiments', 'experiments.json');

  if (!fs.existsSync(experimentsPath)) {
    log('Warning: experiments.json not found, skipping save');
    return;
  }

  const experiments = JSON.parse(fs.readFileSync(experimentsPath, 'utf-8'));

  if (EXPERIMENT_ID) {
    // Update existing experiment
    const expIndex = experiments.experiments.findIndex((e: { id: string }) => e.id === EXPERIMENT_ID);
    if (expIndex !== -1) {
      experiments.experiments[expIndex].backtest_90day = {
        timestamp: result.timestamp,
        btc_sharpe: result.symbols.find((s) => s.symbol === 'BTCUSDT')?.sharpe ?? 0,
        eth_sharpe: result.symbols.find((s) => s.symbol === 'ETHUSDT')?.sharpe ?? 0,
        sol_sharpe: result.symbols.find((s) => s.symbol === 'SOLUSDT')?.sharpe ?? 0,
        aggregate_win_rate: result.aggregate.avgWinRate,
        total_trades: result.aggregate.totalTrades,
      };
      experiments.experiments[expIndex].outcome = result.gate.passed ? 'PASS' : 'FAIL';
      experiments.experiments[expIndex].fail_reasons = result.gate.failReasons;

      fs.writeFileSync(experimentsPath, JSON.stringify(experiments, null, 2));
      log(`Updated experiment ${EXPERIMENT_ID} in experiments.json`);
    } else {
      log(`Warning: Experiment ${EXPERIMENT_ID} not found`);
    }
  } else if (SAVE_RESULT) {
    // Create new experiment entry
    const newId = `exp-${String(experiments.experiments.length + 1).padStart(3, '0')}`;
    const newExp = {
      id: newId,
      timestamp: result.timestamp,
      model_path: result.modelPath,
      hypothesis: 'Manual validation run',
      config_changes: {},
      training_result: null,
      backtest_90day: {
        btc_sharpe: result.symbols.find((s) => s.symbol === 'BTCUSDT')?.sharpe ?? 0,
        eth_sharpe: result.symbols.find((s) => s.symbol === 'ETHUSDT')?.sharpe ?? 0,
        sol_sharpe: result.symbols.find((s) => s.symbol === 'SOLUSDT')?.sharpe ?? 0,
        aggregate_win_rate: result.aggregate.avgWinRate,
        total_trades: result.aggregate.totalTrades,
      },
      outcome: result.gate.passed ? 'PASS' : 'FAIL',
      fail_reasons: result.gate.failReasons,
      learnings: '',
    };

    experiments.experiments.push(newExp);
    fs.writeFileSync(experimentsPath, JSON.stringify(experiments, null, 2));
    log(`Created new experiment ${newId} in experiments.json`);
  }
}

// ============================================
// Main
// ============================================

async function main() {
  const result = await runValidation();
  printResults(result);

  if (SAVE_RESULT || EXPERIMENT_ID) {
    await saveToExperiments(result);
  }

  // Exit with code based on gate result
  process.exit(result.gate.passed ? 0 : 1);
}

main().catch((err) => {
  console.error('Validation failed:', err);
  process.exit(1);
});
