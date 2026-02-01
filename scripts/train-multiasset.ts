#!/usr/bin/env npx tsx
/**
 * Multi-Asset Training Script
 * Train agent on multiple symbols with per-symbol performance tracking
 *
 * Usage:
 *   npx tsx scripts/train-multiasset.ts --episodes 500
 *   npx tsx scripts/train-multiasset.ts --symbols BTCUSDT,ETHUSDT --episodes 500
 *   npx tsx scripts/train-multiasset.ts --agent ppo --episodes 500
 */

import fs from 'fs';
import path from 'path';

import '@tensorflow/tfjs-node';

import { DQNAgent, SerializedWeights as DQNSerializedWeights } from '../src/lib/rl/agent/dqn-agent';
import { PPOAgent, PPOConfig } from '../src/lib/rl/agent/ppo-agent';
import { TradingEnvironment } from '../src/lib/rl/environment/trading-env';
import { Evaluator, PerformanceMetrics } from '../src/lib/rl/training/evaluator';
import type { Candle } from '../src/types';
import type { EnvironmentConfig, DQNConfig } from '../src/lib/rl/types';
import { SYMBOLS, getEnvConfigForSymbol, normalizeSymbolName } from '../src/lib/rl/config/symbols';
import type { SerializedWeights as BaseSerializedWeights } from '../src/lib/rl/agent/base-agent';

interface SymbolData {
  symbol: string;
  train: Candle[];
  val: Candle[];
  envConfig: Partial<EnvironmentConfig>;
}

interface PerSymbolResult {
  symbol: string;
  valMetrics: PerformanceMetrics;
  equityCurve: number[];
}

interface TrainingReport {
  timestamp: string;
  agentType: string;
  episodes: number;
  symbols: string[];
  overallMetrics: {
    avgSharpe: number;
    avgWinRate: number;
    avgMaxDrawdown: number;
    avgProfitFactor: number;
  };
  perSymbolResults: PerSymbolResult[];
  bestWeightsPath: string;
}

function loadSymbolData(symbol: string, trainRatio: number = 0.8): SymbolData | null {
  const fileName = `${normalizeSymbolName(symbol)}_1h.json`;
  const dataPath = path.join(process.cwd(), 'data', fileName);

  if (!fs.existsSync(dataPath)) {
    console.warn(`  [SKIP] Data file not found: ${dataPath}`);
    return null;
  }

  const candles = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as Candle[];
  const splitIdx = Math.floor(candles.length * trainRatio);

  return {
    symbol,
    train: candles.slice(0, splitIdx),
    val: candles.slice(splitIdx),
    envConfig: {
      ...getEnvConfigForSymbol(symbol),
      initialCapital: 10000,
      stopLossPercent: 0.02,
      takeProfitPercent: 0.04,
    },
  };
}

function shuffleArray<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

async function trainMultiAsset(
  agentType: 'dqn' | 'ppo',
  symbols: string[],
  episodes: number,
  verbose: boolean = true
): Promise<TrainingReport> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Multi-Asset Training: ${agentType.toUpperCase()}`);
  console.log(`Symbols: ${symbols.join(', ')}`);
  console.log(`Episodes: ${episodes}`);
  console.log(`${'='.repeat(60)}\n`);

  // Load all symbol data
  const symbolDataList: SymbolData[] = [];
  for (const symbol of symbols) {
    const data = loadSymbolData(symbol);
    if (data) {
      symbolDataList.push(data);
      console.log(`  [OK] ${symbol}: ${data.train.length} train, ${data.val.length} val candles`);
    }
  }

  if (symbolDataList.length === 0) {
    throw new Error('No symbol data available. Run fetch-historical-data.ts first.');
  }

  // Get state size from first symbol
  const tempEnv = new TradingEnvironment(
    symbolDataList[0]!.train.slice(0, 100),
    symbolDataList[0]!.envConfig,
    {}, // stateConfig
    {}, // rewardConfig
    false // training=false just for size check
  );
  const stateSize = tempEnv.getStateSize();
  console.log(`\nState vector size: ${stateSize}`);

  // Create agent with anti-overfitting config
  let agent: DQNAgent | PPOAgent;
  if (agentType === 'dqn') {
    const config: Partial<DQNConfig> = {
      inputSize: stateSize,
      hiddenLayers: [64, 32], // Reduced capacity to prevent overfitting
      learningRate: 0.0003,
      dropout: 0.35, // Moderate dropout
      l2Regularization: 0.02, // L2 regularization
      useBatchNorm: true,
      useHuberLoss: true,
      gradientClipNorm: 1.0,
    };
    agent = new DQNAgent(config);
  } else {
    const config: Partial<PPOConfig> = {
      inputSize: stateSize,
      hiddenLayers: [256, 128, 64],
      learningRate: 0.0003,
      nSteps: 512,
      nEpochs: 4,
    };
    agent = new PPOAgent(config);
  }

  const evaluator = new Evaluator();
  let bestSharpe = -Infinity;
  let bestWeights: DQNSerializedWeights | BaseSerializedWeights | null = null;

  // Training loop
  console.log('\nStarting training...\n');
  const startTime = Date.now();

  for (let episode = 1; episode <= episodes; episode++) {
    // Shuffle symbols each episode to prevent memorization
    const shuffledData = shuffleArray(symbolDataList);

    for (const data of shuffledData) {
      const env = new TradingEnvironment(
        data.train,
        { ...data.envConfig, randomStart: true },
        {}, // stateConfig
        {}, // rewardConfig
        true // training=true for feature noise
      );

      let state = env.reset();
      let stepCount = 0;
      const maxSteps = 500; // Limit steps per symbol per episode

      while (!env.isDone() && stepCount < maxSteps) {
        const action = agent.selectAction(state.features, true);
        const { state: nextState, reward, done } = env.step(action);

        // Store experience based on agent type
        if (agent instanceof DQNAgent) {
          agent.storeExperience(
            state.features,
            action,
            reward,
            nextState.features,
            done
          );
          // Train every 4 steps for DQN
          if (stepCount % 4 === 0) {
            agent.train();
          }
        } else if (agent instanceof PPOAgent) {
          agent.storeExperience(
            state.features,
            action,
            reward,
            nextState.features,
            done
          );
          agent.train();
        }

        state = nextState;
        stepCount++;
      }
    }

    agent.endEpisode();

    // Evaluate and log every 25 episodes
    if (episode % 25 === 0 && verbose) {
      let totalSharpe = 0;
      let totalWinRate = 0;
      let validCount = 0;

      for (const data of symbolDataList) {
        const valEnv = new TradingEnvironment(data.val, { ...data.envConfig, randomStart: false }, {}, {}, false);
        let valState = valEnv.reset();
        const equityCurve: number[] = [data.envConfig.initialCapital ?? 10000];

        while (!valEnv.isDone()) {
          const action = agent.selectAction(valState.features, false);
          const { state: nextState } = valEnv.step(action);
          equityCurve.push(valEnv.getPortfolio().equity);
          valState = nextState;
        }

        const trades = valEnv.getTrades();
        if (trades.length > 0) {
          const metrics = evaluator.calculateMetrics(trades, equityCurve, data.envConfig.initialCapital ?? 10000);
          if (isFinite(metrics.sharpeRatio)) {
            totalSharpe += metrics.sharpeRatio;
            totalWinRate += metrics.winRate;
            validCount++;
          }
        }
      }

      if (validCount > 0) {
        const avgSharpe = totalSharpe / validCount;
        const avgWinRate = totalWinRate / validCount;

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const epsilon = agentType === 'dqn' ? ` ε=${agent.getState().epsilon.toFixed(3)}` : '';
        console.log(
          `Episode ${String(episode).padStart(4)} | Sharpe=${avgSharpe.toFixed(2).padStart(6)} | WinRate=${avgWinRate.toFixed(1).padStart(5)}%${epsilon} | ${elapsed}s`
        );

        // Save best model
        if (avgSharpe > bestSharpe) {
          bestSharpe = avgSharpe;
          bestWeights = await agent.saveWeights();
          console.log(`  -> New best! Sharpe=${avgSharpe.toFixed(3)}`);
        }
      }
    }
  }

  // Final evaluation per symbol
  console.log('\n' + '='.repeat(60));
  console.log('Final Evaluation (Validation Set)');
  console.log('='.repeat(60) + '\n');

  const perSymbolResults: PerSymbolResult[] = [];

  console.log('| Symbol     | Sharpe | Win Rate | Max DD  | PF    | Trades | Return    |');
  console.log('|------------|--------|----------|---------|-------|--------|-----------|');

  for (const data of symbolDataList) {
    const valEnv = new TradingEnvironment(data.val, { ...data.envConfig, randomStart: false }, {}, {}, false);
    let valState = valEnv.reset();
    const equityCurve: number[] = [data.envConfig.initialCapital ?? 10000];

    while (!valEnv.isDone()) {
      const action = agent.selectAction(valState.features, false);
      const { state: nextState } = valEnv.step(action);
      equityCurve.push(valEnv.getPortfolio().equity);
      valState = nextState;
    }

    const trades = valEnv.getTrades();
    const metrics = evaluator.calculateMetrics(trades, equityCurve, data.envConfig.initialCapital ?? 10000);

    perSymbolResults.push({
      symbol: data.symbol,
      valMetrics: metrics,
      equityCurve,
    });

    const pf = isFinite(metrics.profitFactor) ? metrics.profitFactor.toFixed(2) : 'N/A';
    console.log(
      `| ${data.symbol.padEnd(10)} | ${metrics.sharpeRatio.toFixed(2).padStart(6)} | ${metrics.winRate.toFixed(1).padStart(7)}% | ${metrics.maxDrawdown.toFixed(1).padStart(6)}% | ${String(pf).padStart(5)} | ${String(metrics.totalTrades).padStart(6)} | ${metrics.totalReturnPercent >= 0 ? '+' : ''}${metrics.totalReturnPercent.toFixed(1).padStart(8)}% |`
    );
  }

  // Save best weights
  const weightsDir = path.join(process.cwd(), 'models');
  if (!fs.existsSync(weightsDir)) {
    fs.mkdirSync(weightsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
  const weightsPath = path.join(weightsDir, `${agentType}_multiasset_${timestamp}.json`);

  if (bestWeights) {
    fs.writeFileSync(weightsPath, JSON.stringify(bestWeights, null, 2));
    console.log(`\nBest weights saved to: ${weightsPath}`);
  }

  // Calculate overall metrics
  const validResults = perSymbolResults.filter((r) => isFinite(r.valMetrics.sharpeRatio));
  const avgSharpe = validResults.reduce((a, r) => a + r.valMetrics.sharpeRatio, 0) / validResults.length;
  const avgWinRate = validResults.reduce((a, r) => a + r.valMetrics.winRate, 0) / validResults.length;
  const avgMaxDrawdown = validResults.reduce((a, r) => a + r.valMetrics.maxDrawdown, 0) / validResults.length;
  const avgProfitFactor = validResults.filter((r) => isFinite(r.valMetrics.profitFactor))
    .reduce((a, r) => a + r.valMetrics.profitFactor, 0) / validResults.length;

  const report: TrainingReport = {
    timestamp: new Date().toISOString(),
    agentType,
    episodes,
    symbols: symbolDataList.map((d) => d.symbol),
    overallMetrics: {
      avgSharpe,
      avgWinRate,
      avgMaxDrawdown,
      avgProfitFactor,
    },
    perSymbolResults,
    bestWeightsPath: weightsPath,
  };

  // Save report
  const reportPath = path.join(process.cwd(), 'data', `training_report_${timestamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Training Time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  console.log(`Average Sharpe: ${avgSharpe.toFixed(2)}`);
  console.log(`Average Win Rate: ${avgWinRate.toFixed(1)}%`);
  console.log(`Average Max Drawdown: ${avgMaxDrawdown.toFixed(1)}%`);
  console.log(`Average Profit Factor: ${isFinite(avgProfitFactor) ? avgProfitFactor.toFixed(2) : 'N/A'}`);

  // Check success criteria
  console.log('\n' + '-'.repeat(60));
  console.log('Success Criteria Check:');
  const checks = [
    { name: 'Sharpe > 0.8', pass: avgSharpe > 0.8, value: avgSharpe.toFixed(2) },
    { name: 'Win Rate > 50%', pass: avgWinRate > 50, value: `${avgWinRate.toFixed(1)}%` },
    { name: 'Max DD < 15%', pass: avgMaxDrawdown < 15, value: `${avgMaxDrawdown.toFixed(1)}%` },
    { name: 'Profit Factor > 1.3', pass: isFinite(avgProfitFactor) && avgProfitFactor > 1.3, value: isFinite(avgProfitFactor) ? avgProfitFactor.toFixed(2) : 'N/A' },
  ];

  for (const check of checks) {
    console.log(`  ${check.pass ? '✓' : '✗'} ${check.name}: ${check.value}`);
  }

  const passedCount = checks.filter((c) => c.pass).length;
  console.log(`\nPassed: ${passedCount}/${checks.length}`);

  console.log(`\nReport saved to: ${reportPath}`);

  agent.dispose();

  return report;
}

// CLI
function parseArgs(): {
  symbols: string[];
  agent: 'dqn' | 'ppo';
  episodes: number;
} {
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
      }
    }
  }

  let symbols: string[];
  if (options['symbols']) {
    symbols = options['symbols'].split(',').map((s) => s.trim());
  } else {
    // Default: all available symbols
    symbols = Object.keys(SYMBOLS);
  }

  return {
    symbols,
    agent: (options['agent'] as 'dqn' | 'ppo') || 'dqn',
    episodes: parseInt(options['episodes'] || '500', 10),
  };
}

async function main() {
  const { symbols, agent, episodes } = parseArgs();

  console.log('='.repeat(60));
  console.log('ICT Trading - Multi-Asset RL Agent Training');
  console.log('='.repeat(60));

  try {
    await trainMultiAsset(agent, symbols, episodes);
    console.log('\nDone!');
  } catch (error) {
    console.error('\nTraining error:', error);
    process.exit(1);
  }
}

main();
