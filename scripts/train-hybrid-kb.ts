#!/usr/bin/env npx tsx
/**
 * Train Hybrid Agent with KB Integration
 * CLI script for training the KB-enhanced hybrid rule+RL trading agent
 *
 * Architecture:
 * - Rule-based entries: ICT confluence scoring (3+ factors)
 * - RL-controlled exits: 4-action agent with KB-informed decisions
 * - KB features: 4 additional features from semantic search
 * - KB reward shaping: ±20% bonus based on KB alignment
 *
 * Usage:
 *   npx tsx scripts/train-hybrid-kb.ts --data ./data/BTCUSDT_1h.json --episodes 200
 *   npx tsx scripts/train-hybrid-kb.ts --data ./data/BTCUSDT_1h.json --kb-features --kb-rewards
 *   npx tsx scripts/train-hybrid-kb.ts --data ./data/BTCUSDT_1h.json --no-kb  # Disable KB for comparison
 */

import fs from 'fs';
import path from 'path';

import '@tensorflow/tfjs-node';
import * as tf from '@tensorflow/tfjs';

import type { Candle } from '@/types';
import {
  DQNAgent,
  ReplayBuffer,
  PrioritizedReplayBuffer,
  type SerializedWeights,
  type DQNConfig,
  type TradeRecord,
  type Portfolio,
  ExitActions,
  type ExitAction,
  type EntryFilterConfig,
  // KB Integration
  KBHybridTradingEnvironment,
  KBDecisionExplainer,
  type KBHybridEnvConfig,
  type KBIntegrationConfig,
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
  // New environment flags for v2 features
  useATRStops: boolean;       // ATR-based SL/TP (default: true)
  useProgressiveTrailing: boolean; // Progressive trailing stops (default: true)
  useDynamicSizing: boolean;  // Confluence-based position sizing (default: true)
  // Training
  learningRate: number;
  gamma: number;
  epsilonDecay: number;
  trainFrequency: number;
  batchSize: number;
  usePER: boolean;          // Prioritized Experience Replay
  perAlpha: number;         // Priority exponent
  perBeta: number;          // Initial importance sampling weight
  useDueling: boolean;      // Dueling DQN architecture
  // Walk-forward
  walkforward: boolean;
  trainWindow: number;
  testWindow: number;
  stepSize: number;
  // KB Integration
  kbEnabled: boolean;
  kbFeatures: boolean;
  kbRewards: boolean;
  kbCacheSize: number;
  kbWarmCache: boolean;
  // Other
  verbose: boolean;
  baseline: boolean;
  explainDecisions: boolean;
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

  // Check for --no-kb flag
  const kbDisabled = options['no-kb'] === 'true';

  return {
    data: options['data'] || './data/BTCUSDT_1h.json',
    episodes: parseInt(options['episodes'] || '200', 10),
    output: options['output'] || './models/hybrid-kb-agent.json',
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
    // v2 experimental features (OFF by default due to performance regression)
    // Use --atr-stops, --progressive-trailing, --dynamic-sizing to enable
    useATRStops: options['atr-stops'] === 'true',
    useProgressiveTrailing: options['progressive-trailing'] === 'true',
    useDynamicSizing: options['dynamic-sizing'] === 'true',
    // Training
    learningRate: parseFloat(options['learning-rate'] || '0.001'),
    gamma: parseFloat(options['gamma'] || '0.9'),
    epsilonDecay: parseFloat(options['epsilon-decay'] || '0.995'),
    trainFrequency: parseInt(options['train-frequency'] || '2', 10),  // Increased from 4 to 2
    batchSize: parseInt(options['batch-size'] || '32', 10),
    usePER: options['no-per'] !== 'true',  // PER enabled by default
    perAlpha: parseFloat(options['per-alpha'] || '0.6'),
    perBeta: parseFloat(options['per-beta'] || '0.4'),
    useDueling: options['no-dueling'] !== 'true',  // Dueling DQN enabled by default
    // Walk-forward
    walkforward: options['no-walkforward'] !== 'true',
    trainWindow: parseInt(options['train-window'] || '6000', 10),
    testWindow: parseInt(options['test-window'] || '1500', 10),
    stepSize: parseInt(options['step-size'] || '3000', 10),
    // KB Integration
    kbEnabled: !kbDisabled,
    kbFeatures: !kbDisabled && options['no-kb-features'] !== 'true',
    kbRewards: !kbDisabled && options['no-kb-rewards'] !== 'true',
    kbCacheSize: parseInt(options['kb-cache-size'] || '500', 10),
    kbWarmCache: options['kb-warm-cache'] === 'true',
    // Other
    verbose: options['verbose'] !== 'false',
    baseline: options['no-baseline'] !== 'true',
    explainDecisions: options['explain'] === 'true',
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

function calculateSharpe(trades: TradeRecord[]): number {
  if (trades.length < 2) return 0;

  const returns = trades.map((t) => t.pnlPercent);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
  const std = Math.sqrt(variance);

  if (std === 0) return mean > 0 ? 1 : mean < 0 ? -1 : 0;

  return (mean / std) * Math.sqrt(252 * 24);
}

function runBaseline(
  candles: Candle[],
  envConfig: Partial<KBHybridEnvConfig>,
  entryConfig: Partial<EntryFilterConfig>,
  holdBars: number
): { trades: TradeRecord[]; portfolio: Portfolio } {
  const env = new KBHybridTradingEnvironment(
    candles,
    { ...envConfig, kbConfig: { enabled: false } },
    entryConfig,
    {},
    false
  );
  env.reset();

  let barsInPosition = 0;

  while (!env.isDone()) {
    let action: ExitAction | null = null;

    if (env.isInPosition()) {
      barsInPosition++;
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

async function trainOnWindow(
  agent: DQNAgent,
  trainCandles: Candle[],
  envConfig: Partial<KBHybridEnvConfig>,
  entryConfig: Partial<EntryFilterConfig>,
  kbConfig: Partial<KBIntegrationConfig>,
  episodes: number,
  trainFrequency: number,
  verbose: boolean
): Promise<{ trades: TradeRecord[]; winRate: number; avgReward: number }> {
  let allTrades: TradeRecord[] = [];
  let totalReward = 0;
  let totalSteps = 0;

  for (let episode = 1; episode <= episodes; episode++) {
    const env = new KBHybridTradingEnvironment(
      trainCandles,
      { ...envConfig, randomStart: true, kbConfig },
      entryConfig,
      { featureNoiseLevel: 0.02 },
      true
    );

    // Initialize KB if enabled
    if (kbConfig.enabled) {
      await env.initializeKB();
    }

    env.reset();
    let episodeReward = 0;
    let steps = 0;

    while (!env.isDone()) {
      let action: ExitAction | null = null;

      if (env.isInPosition()) {
        // Use environment's state builder consistently for action selection
        const envState = env.getCurrentState();
        if (envState) {
          action = agent.selectAction(envState.features, true) as ExitAction;
        }
      }

      const result = env.step(action);
      episodeReward += result.reward;
      steps++;

      // Store experience if we were in position
      if (action !== null && result.state) {
        const stateSize = env.getStateSize();
        // Use environment's state builder consistently for both state and nextState
        // result.state is from BEFORE advancing, so get current state from env
        const envState = env.getCurrentState();
        const nextState = envState
          ? envState.features
          : new Array(stateSize).fill(0);

        agent.storeExperience(
          result.state.features,
          action,
          result.reward,
          nextState,
          result.done || !env.isInPosition()
        );

        if (steps % trainFrequency === 0) {
          agent.train();
        }
      }
    }

    agent.endEpisode();
    allTrades = [...allTrades, ...env.getTrades()];
    totalReward += episodeReward;
    totalSteps += steps;

    if (verbose && episode % 20 === 0) {
      const winRate = allTrades.length > 0
        ? (allTrades.filter((t) => t.pnl > 0).length / allTrades.length) * 100
        : 0;
      const cacheStats = kbConfig.enabled ? env.getKBCacheStats() : null;
      const cacheInfo = cacheStats
        ? ` | KB Cache: ${cacheStats.hitRate.toFixed(0)}% hit`
        : '';
      console.log(
        `  Episode ${episode}/${episodes} | Trades: ${allTrades.length} | Win Rate: ${winRate.toFixed(1)}% | Epsilon: ${agent.getState().epsilon.toFixed(3)}${cacheInfo}`
      );
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

async function evaluate(
  agent: DQNAgent,
  testCandles: Candle[],
  envConfig: Partial<KBHybridEnvConfig>,
  entryConfig: Partial<EntryFilterConfig>,
  kbConfig: Partial<KBIntegrationConfig>,
  explainDecisions: boolean
): Promise<{
  trades: TradeRecord[];
  portfolio: Portfolio;
  winRate: number;
  sharpe: number;
  explanations: string[];
}> {
  const env = new KBHybridTradingEnvironment(
    testCandles,
    { ...envConfig, randomStart: false, kbConfig },
    entryConfig,
    {},
    false
  );

  if (kbConfig.enabled) {
    await env.initializeKB();
  }

  env.reset();

  const explainer = explainDecisions ? new KBDecisionExplainer() : null;
  const explanations: string[] = [];

  while (!env.isDone()) {
    let action: ExitAction | null = null;

    if (env.isInPosition()) {
      // Use environment's state builder for consistent state representation
      const envState = env.getCurrentState();
      if (envState) {
        action = agent.selectAction(envState.features, false) as ExitAction;

        // Generate explanation if requested
        if (explainer && action !== null) {
          const kbContext = env.getKBContext();
          const kbReward = env.getLastKBReward();
          const explanation = explainer.explainDetailed(action, kbContext, kbReward);
          explanations.push(explainer.formatForConsole(explanation));
        }
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

  return { trades, portfolio, winRate, sharpe, explanations };
}

async function main() {
  const args = parseArgs();

  console.log('='.repeat(60));
  console.log('ICT Trading - KB-Enhanced Hybrid Agent Trainer');
  console.log('(Rule-based entries + RL exits + KB integration)');
  console.log('='.repeat(60));
  console.log();

  // Load data
  console.log(`Loading data from ${args.data}...`);
  const candles = loadCandles(args.data);
  console.log(`Loaded ${candles.length} candles`);

  const firstCandle = candles[0];
  const lastCandle = candles[candles.length - 1];
  if (firstCandle && lastCandle) {
    console.log(
      `Period: ${new Date(firstCandle.timestamp).toISOString()} to ${new Date(lastCandle.timestamp).toISOString()}`
    );
  }
  console.log();

  // Configuration
  const entryConfig: Partial<EntryFilterConfig> = {
    minConfluence: args.minConfluence,
    requireOBTouch: args.requireOBTouch,
    requireTrendAlignment: args.requireTrendAlignment,
  };

  const kbConfig: Partial<KBIntegrationConfig> = {
    enabled: args.kbEnabled,
    addKBFeatures: args.kbFeatures,
    useKBRewardShaping: args.kbRewards,
    cacheSize: args.kbCacheSize,
    warmCacheOnInit: args.kbWarmCache,
    topK: 3,
    minSimilarity: 0.4,
    maxKBRewardBonus: 0.2,
  };

  const envConfig: Partial<KBHybridEnvConfig> = {
    initialCapital: args.initialCapital,
    positionSize: args.positionSize,
    maxHoldBars: args.maxHoldBars,
    defaultSLPercent: args.slPercent,
    defaultTPPercent: args.tpPercent,
    spread: 0.0001,
    commission: 0.001,
    slippage: 0.0005,
    maxDrawdownLimit: 0.25,
    // v2 feature flags
    useATRStops: args.useATRStops,
    useProgressiveTrailing: args.useProgressiveTrailing,
    useDynamicSizing: args.useDynamicSizing,
    kbConfig,
  };

  // Determine input size based on KB features
  // Base: 22 features (6 position + 8 market + 8 price action)
  // With KB: 26 features (22 base + 4 KB features)
  const inputSize = args.kbFeatures ? 26 : 22;

  const dqnConfig: Partial<DQNConfig> = {
    inputSize,
    hiddenLayers: [32, 16],
    outputSize: 4,
    learningRate: args.learningRate,
    gamma: args.gamma,
    epsilonStart: 0.3,
    epsilonEnd: 0.05,
    epsilonDecay: args.epsilonDecay,
    dropout: 0.2,
    l2Regularization: 0.01,
    useBatchNorm: false,
    gradientClipNorm: 1.0,
    useHuberLoss: true,
    useDueling: args.useDueling,  // Dueling DQN architecture
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
  console.log(`    ATR-based SL/TP: ${args.useATRStops ? 'YES' : 'NO (fixed %)'}`);
  console.log(`    Progressive Trailing: ${args.useProgressiveTrailing ? 'YES' : 'NO'}`);
  console.log(`    Dynamic Sizing: ${args.useDynamicSizing ? 'YES' : 'NO (fixed 10%)'}`);
  console.log(`    Dueling DQN: ${args.useDueling ? 'YES' : 'NO'}`);
  console.log(`    PER: ${args.usePER ? 'YES' : 'NO'}`);
  console.log(`    Train Frequency: ${args.trainFrequency}`);
  console.log('  KB Integration:');
  console.log(`    Enabled: ${args.kbEnabled ? 'YES' : 'NO'}`);
  if (args.kbEnabled) {
    console.log(`    KB Features: ${args.kbFeatures ? 'YES (+4 features)' : 'NO'}`);
    console.log(`    KB Rewards: ${args.kbRewards ? 'YES (±20% shaping)' : 'NO'}`);
    console.log(`    Cache Size: ${args.kbCacheSize}`);
  }
  console.log('  Training:');
  console.log(`    Episodes: ${args.episodes}`);
  console.log(`    Input Size: ${inputSize} features`);
  console.log(`    Learning rate: ${args.learningRate}`);
  console.log(`    Walk-forward: ${args.walkforward ? 'ENABLED' : 'disabled'}`);
  if (args.walkforward) {
    console.log(`    Train window: ${args.trainWindow} candles`);
    console.log(`    Test window: ${args.testWindow} candles`);
  }
  console.log();

  // Create agent with PER or standard replay buffer
  const bufferConfig = {
    capacity: 50000,
    batchSize: args.batchSize,
    minExperience: 500,
  };

  const buffer = args.usePER
    ? new PrioritizedReplayBuffer(bufferConfig, args.perAlpha, args.perBeta)
    : new ReplayBuffer(bufferConfig);

  console.log(`  Buffer: ${args.usePER ? 'Prioritized Experience Replay' : 'Standard Replay'}`);
  const agent = new DQNAgent(dqnConfig, buffer);

  // Walk-forward validation
  const windows = args.walkforward
    ? createRollingWindows(candles, args.trainWindow, args.testWindow, args.stepSize)
    : [
        {
          train: candles.slice(0, Math.floor(candles.length * 0.8)),
          test: candles.slice(Math.floor(candles.length * 0.8)),
        },
      ];

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

    // Reset epsilon for new window to allow fresh exploration
    // Use a moderate starting point (not full reset) to leverage prior learning
    const windowEpsilon = Math.max(0.15, agent.getState().epsilon * 1.5);
    agent.resetEpsilon(windowEpsilon);
    console.log(`  Epsilon reset to ${windowEpsilon.toFixed(3)}`);

    // Train on window
    console.log('\nTraining...');
    const trainResult = await trainOnWindow(
      agent,
      window.train,
      envConfig,
      entryConfig,
      kbConfig,
      episodesPerWindow,
      args.trainFrequency,
      args.verbose
    );

    console.log(
      `\nTraining complete: ${trainResult.trades.length} trades, ${trainResult.winRate.toFixed(1)}% win rate`
    );

    // Evaluate on test
    console.log('\nEvaluating on test set...');
    const evalResult = await evaluate(
      agent,
      window.test,
      envConfig,
      entryConfig,
      kbConfig,
      args.explainDecisions
    );

    console.log(`  Trades: ${evalResult.trades.length}`);
    console.log(`  Win Rate: ${evalResult.winRate.toFixed(1)}%`);
    console.log(`  Sharpe: ${evalResult.sharpe.toFixed(2)}`);
    console.log(`  Total PnL: $${evalResult.portfolio.realizedPnL.toFixed(2)}`);

    // Show sample explanations
    if (args.explainDecisions && evalResult.explanations.length > 0) {
      console.log('\n--- Sample KB Decision Explanations ---');
      for (const exp of evalResult.explanations.slice(0, 2)) {
        console.log(exp);
      }
    }

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

    windowMetrics.push({
      window: w,
      trainWinRate: trainResult.winRate,
      valWinRate: evalResult.winRate,
      valSharpe: evalResult.sharpe,
      baselineSharpe,
      trades: evalResult.trades.length,
    });

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

  console.log(
    '| Window | Train WR | Val WR | Gap    | Val Sharpe | Baseline | Improvement |'
  );
  console.log(
    '|--------|----------|--------|--------|------------|----------|-------------|'
  );

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

    console.log(
      `|   ${m.window + 1}    | ${m.trainWinRate.toFixed(1).padStart(7)}% | ${m.valWinRate.toFixed(1).padStart(5)}% | ${gapStr.padStart(6)} | ${m.valSharpe.toFixed(2).padStart(10)} | ${m.baselineSharpe.toFixed(2).padStart(8)} | ${impStr.padStart(11)} |`
    );
  }

  const avgGap = totalGap / windowMetrics.length;
  const avgValSharpe = windowMetrics.reduce((a, m) => a + m.valSharpe, 0) / windowMetrics.length;
  const avgBaseline = windowMetrics.reduce((a, m) => a + m.baselineSharpe, 0) / windowMetrics.length;

  console.log(
    '|--------|----------|--------|--------|------------|----------|-------------|'
  );
  console.log(
    `| AVG    |          |        | ${(avgGap >= 0 ? '+' : '') + avgGap.toFixed(1).padStart(5)}% | ${avgValSharpe.toFixed(2).padStart(10)} | ${avgBaseline.toFixed(2).padStart(8)} | ${(avgValSharpe - avgBaseline >= 0 ? '+' : '') + (avgValSharpe - avgBaseline).toFixed(2).padStart(10)} |`
  );
  console.log();

  // Success criteria
  console.log('SUCCESS CRITERIA:');
  const gapOk = Math.abs(avgGap) < 20;
  const sharpeOk = positiveSharpCount >= 1;
  const beatsBaseline = beatsBaselineCount >= 1;

  console.log(`  ${gapOk ? '✓' : '✗'} Average Gap < 20%: ${avgGap.toFixed(1)}%`);
  console.log(
    `  ${sharpeOk ? '✓' : '✗'} At least 1 window with positive Sharpe: ${positiveSharpCount}/${windowMetrics.length}`
  );
  console.log(
    `  ${beatsBaseline ? '✓' : '✗'} At least 1 window beats baseline: ${beatsBaselineCount}/${windowMetrics.length}`
  );

  if (gapOk && sharpeOk) {
    console.log('\n✓ Walk-forward validation PASSED');
    if (args.kbEnabled) {
      console.log('  KB-enhanced hybrid system shows generalization');
    }
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
