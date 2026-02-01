#!/usr/bin/env npx tsx
/**
 * Agent Comparison Script
 * Compares DQN vs PPO performance on the same dataset
 *
 * Usage:
 *   npx tsx scripts/compare-agents.ts --symbol BTCUSDT --episodes 500
 */

import fs from 'fs';
import path from 'path';
import { DQNAgent } from '../src/lib/rl/agent/dqn-agent';
import { PPOAgent } from '../src/lib/rl/agent/ppo-agent';
import { TradingEnvironment } from '../src/lib/rl/environment/trading-env';
import { Evaluator } from '../src/lib/rl/training/evaluator';
import type { Candle } from '../src/types';
import type { TrainingMetrics, EnvironmentConfig, DQNConfig } from '../src/lib/rl/types';
import type { PPOConfig } from '../src/lib/rl/agent/ppo-agent';
import { getEnvConfigForSymbol, normalizeSymbolName, SYMBOLS } from '../src/lib/rl/config/symbols';

interface ComparisonResult {
  symbol: string;
  dqn: {
    finalSharpe: number;
    finalWinRate: number;
    finalReturn: number;
    maxDrawdown: number;
    totalTrades: number;
    trainingTime: number;
  };
  ppo: {
    finalSharpe: number;
    finalWinRate: number;
    finalReturn: number;
    maxDrawdown: number;
    totalTrades: number;
    trainingTime: number;
  };
  winner: 'dqn' | 'ppo' | 'tie';
}

function loadCandles(symbol: string, timeframe: string = '1h'): Candle[] {
  const fileName = `${normalizeSymbolName(symbol)}_${timeframe}.json`;
  const dataPath = path.join(process.cwd(), 'data', fileName);

  if (!fs.existsSync(dataPath)) {
    throw new Error(`Data file not found: ${dataPath}\nRun: npx tsx scripts/fetch-historical-data.ts --symbol ${symbol}`);
  }

  const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  return data as Candle[];
}

function splitData(candles: Candle[], trainRatio: number = 0.8): { train: Candle[]; val: Candle[] } {
  const splitIdx = Math.floor(candles.length * trainRatio);
  return {
    train: candles.slice(0, splitIdx),
    val: candles.slice(splitIdx),
  };
}

async function trainDQN(
  trainCandles: Candle[],
  valCandles: Candle[],
  envConfig: Partial<EnvironmentConfig>,
  episodes: number
): Promise<{ metrics: TrainingMetrics; agent: DQNAgent; time: number }> {
  const startTime = Date.now();

  // Get state size
  const tempEnv = new TradingEnvironment(trainCandles.slice(0, 100), envConfig);
  const stateSize = tempEnv.getStateSize();

  const dqnConfig: Partial<DQNConfig> = {
    inputSize: stateSize,
    hiddenLayers: [256, 128, 64],
    learningRate: 0.0003,
    useBatchNorm: true,
    useHuberLoss: true,
  };

  const agent = new DQNAgent(dqnConfig);
  const evaluator = new Evaluator();

  let bestMetrics: TrainingMetrics | null = null;

  for (let episode = 1; episode <= episodes; episode++) {
    const env = new TradingEnvironment(trainCandles, { ...envConfig, randomStart: true });
    let state = env.reset();

    while (!env.isDone()) {
      const action = agent.selectAction(state.features);
      const { state: nextState, reward, done } = env.step(action);
      agent.storeExperience(state.features, action, reward, nextState.features, done);

      if (episode > 10) {
        agent.train();
      }

      state = nextState;
    }

    agent.endEpisode();

    // Evaluate every 50 episodes
    if (episode % 50 === 0) {
      const valEnv = new TradingEnvironment(valCandles, { ...envConfig, randomStart: false });
      let valState = valEnv.reset();
      let totalReward = 0;
      const equityCurve: number[] = [envConfig.initialCapital ?? 10000];

      while (!valEnv.isDone()) {
        const action = agent.selectAction(valState.features, false);
        const { state: nextState, reward } = valEnv.step(action);
        totalReward += reward;
        equityCurve.push(valEnv.getPortfolio().equity);
        valState = nextState;
      }

      const trades = valEnv.getTrades();
      const result = evaluator.evaluate(
        trades,
        equityCurve,
        envConfig.initialCapital ?? 10000,
        episode,
        totalReward,
        agent.getState().epsilon,
        agent.getState().averageLoss
      );

      console.log(`  DQN Episode ${episode}: Sharpe=${result.metrics.sharpeRatio.toFixed(2)}, WinRate=${result.metrics.winRate.toFixed(1)}%`);

      if (!bestMetrics || result.metrics.sharpeRatio > bestMetrics.sharpeRatio) {
        bestMetrics = result.metrics;
      }
    }
  }

  return {
    metrics: bestMetrics!,
    agent,
    time: Date.now() - startTime,
  };
}

async function trainPPO(
  trainCandles: Candle[],
  valCandles: Candle[],
  envConfig: Partial<EnvironmentConfig>,
  episodes: number
): Promise<{ metrics: TrainingMetrics; agent: PPOAgent; time: number }> {
  const startTime = Date.now();

  // Get state size
  const tempEnv = new TradingEnvironment(trainCandles.slice(0, 100), envConfig);
  const stateSize = tempEnv.getStateSize();

  const ppoConfig: Partial<PPOConfig> = {
    inputSize: stateSize,
    hiddenLayers: [256, 128, 64],
    learningRate: 0.0003,
    nSteps: 512, // Smaller rollouts for faster feedback
    nEpochs: 4,
  };

  const agent = new PPOAgent(ppoConfig);
  const evaluator = new Evaluator();

  let bestMetrics: TrainingMetrics | null = null;

  for (let episode = 1; episode <= episodes; episode++) {
    const env = new TradingEnvironment(trainCandles, { ...envConfig, randomStart: true });
    let state = env.reset();

    while (!env.isDone()) {
      const action = agent.selectAction(state.features);
      const { state: nextState, reward, done } = env.step(action);
      agent.storeExperience(state.features, action, reward, nextState.features, done);
      agent.train(); // PPO trains internally when buffer is full
      state = nextState;
    }

    agent.endEpisode();

    // Evaluate every 50 episodes
    if (episode % 50 === 0) {
      const valEnv = new TradingEnvironment(valCandles, { ...envConfig, randomStart: false });
      let valState = valEnv.reset();
      let totalReward = 0;
      const equityCurve: number[] = [envConfig.initialCapital ?? 10000];

      while (!valEnv.isDone()) {
        const action = agent.selectAction(valState.features, false);
        const { state: nextState, reward } = valEnv.step(action);
        totalReward += reward;
        equityCurve.push(valEnv.getPortfolio().equity);
        valState = nextState;
      }

      const trades = valEnv.getTrades();
      const result = evaluator.evaluate(
        trades,
        equityCurve,
        envConfig.initialCapital ?? 10000,
        episode,
        totalReward,
        0,
        agent.getState().averageLoss
      );

      console.log(`  PPO Episode ${episode}: Sharpe=${result.metrics.sharpeRatio.toFixed(2)}, WinRate=${result.metrics.winRate.toFixed(1)}%`);

      if (!bestMetrics || result.metrics.sharpeRatio > bestMetrics.sharpeRatio) {
        bestMetrics = result.metrics;
      }
    }
  }

  return {
    metrics: bestMetrics!,
    agent,
    time: Date.now() - startTime,
  };
}

async function compareAgents(symbol: string, episodes: number): Promise<ComparisonResult> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Comparing DQN vs PPO on ${symbol}`);
  console.log(`${'='.repeat(60)}\n`);

  const candles = loadCandles(symbol);
  const { train, val } = splitData(candles);

  console.log(`Training data: ${train.length} candles`);
  console.log(`Validation data: ${val.length} candles`);
  console.log(`Episodes: ${episodes}\n`);

  const envConfig: Partial<EnvironmentConfig> = {
    ...getEnvConfigForSymbol(symbol),
    initialCapital: 10000,
    stopLossPercent: 0.02,
    takeProfitPercent: 0.04,
  };

  // Train DQN
  console.log('Training DQN...');
  const dqnResult = await trainDQN(train, val, envConfig, episodes);
  console.log(`DQN completed in ${(dqnResult.time / 1000).toFixed(1)}s\n`);

  // Train PPO
  console.log('Training PPO...');
  const ppoResult = await trainPPO(train, val, envConfig, episodes);
  console.log(`PPO completed in ${(ppoResult.time / 1000).toFixed(1)}s\n`);

  // Compare results
  const dqnMetrics = dqnResult.metrics;
  const ppoMetrics = ppoResult.metrics;

  const result: ComparisonResult = {
    symbol,
    dqn: {
      finalSharpe: dqnMetrics.sharpeRatio,
      finalWinRate: dqnMetrics.winRate,
      finalReturn: dqnMetrics.totalPnL,
      maxDrawdown: dqnMetrics.maxDrawdown,
      totalTrades: dqnMetrics.totalTrades,
      trainingTime: dqnResult.time,
    },
    ppo: {
      finalSharpe: ppoMetrics.sharpeRatio,
      finalWinRate: ppoMetrics.winRate,
      finalReturn: ppoMetrics.totalPnL,
      maxDrawdown: ppoMetrics.maxDrawdown,
      totalTrades: ppoMetrics.totalTrades,
      trainingTime: ppoResult.time,
    },
    winner: 'tie',
  };

  // Determine winner based on Sharpe ratio
  if (dqnMetrics.sharpeRatio > ppoMetrics.sharpeRatio + 0.1) {
    result.winner = 'dqn';
  } else if (ppoMetrics.sharpeRatio > dqnMetrics.sharpeRatio + 0.1) {
    result.winner = 'ppo';
  }

  // Clean up
  dqnResult.agent.dispose();
  ppoResult.agent.dispose();

  return result;
}

function printResults(results: ComparisonResult[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('COMPARISON RESULTS');
  console.log('='.repeat(80));
  console.log();

  console.log('| Symbol     | Agent | Sharpe | Win Rate | Return     | Max DD  | Trades | Time    |');
  console.log('|------------|-------|--------|----------|------------|---------|--------|---------|');

  for (const r of results) {
    const dqnWinner = r.winner === 'dqn' ? '*' : ' ';
    const ppoWinner = r.winner === 'ppo' ? '*' : ' ';

    console.log(
      `| ${r.symbol.padEnd(10)} | DQN${dqnWinner} | ${r.dqn.finalSharpe.toFixed(2).padStart(6)} | ${r.dqn.finalWinRate.toFixed(1).padStart(7)}% | ${r.dqn.finalReturn.toFixed(2).padStart(10)} | ${r.dqn.maxDrawdown.toFixed(1).padStart(6)}% | ${String(r.dqn.totalTrades).padStart(6)} | ${(r.dqn.trainingTime / 1000).toFixed(0).padStart(6)}s |`
    );
    console.log(
      `| ${' '.repeat(10)} | PPO${ppoWinner} | ${r.ppo.finalSharpe.toFixed(2).padStart(6)} | ${r.ppo.finalWinRate.toFixed(1).padStart(7)}% | ${r.ppo.finalReturn.toFixed(2).padStart(10)} | ${r.ppo.maxDrawdown.toFixed(1).padStart(6)}% | ${String(r.ppo.totalTrades).padStart(6)} | ${(r.ppo.trainingTime / 1000).toFixed(0).padStart(6)}s |`
    );
    console.log('|------------|-------|--------|----------|------------|---------|--------|---------|');
  }

  // Summary
  const dqnWins = results.filter((r) => r.winner === 'dqn').length;
  const ppoWins = results.filter((r) => r.winner === 'ppo').length;
  const ties = results.filter((r) => r.winner === 'tie').length;

  console.log(`\nOverall: DQN wins ${dqnWins}, PPO wins ${ppoWins}, Ties ${ties}`);

  const overallWinner = dqnWins > ppoWins ? 'DQN' : ppoWins > dqnWins ? 'PPO' : 'TIE';
  console.log(`Recommendation: ${overallWinner}`);
}

// CLI
function parseArgs(): { symbol?: string; all: boolean; episodes: number } {
  const args = process.argv.slice(2);
  const options: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all') {
      options['all'] = 'true';
    } else if (arg?.startsWith('--')) {
      const key = arg.replace(/^--/, '');
      const value = args[i + 1];
      if (value && !value.startsWith('--')) {
        options[key] = value;
        i++;
      }
    }
  }

  return {
    symbol: options['symbol'],
    all: options['all'] === 'true',
    episodes: parseInt(options['episodes'] || '200', 10),
  };
}

async function main() {
  const { symbol, all, episodes } = parseArgs();

  console.log('='.repeat(60));
  console.log('ICT Trading - Agent Comparison (DQN vs PPO)');
  console.log('='.repeat(60));

  const results: ComparisonResult[] = [];

  if (all) {
    // Compare on all available symbols
    for (const sym of Object.keys(SYMBOLS)) {
      try {
        const result = await compareAgents(sym, episodes);
        results.push(result);
      } catch (error) {
        console.warn(`Skipping ${sym}: ${error}`);
      }
    }
  } else if (symbol) {
    const result = await compareAgents(symbol, episodes);
    results.push(result);
  } else {
    // Default to BTCUSDT
    const result = await compareAgents('BTCUSDT', episodes);
    results.push(result);
  }

  printResults(results);

  // Save results
  const outputPath = path.join(process.cwd(), 'data', 'agent_comparison.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to ${outputPath}`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
