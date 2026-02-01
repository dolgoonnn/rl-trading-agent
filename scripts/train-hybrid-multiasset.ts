#!/usr/bin/env npx tsx
/**
 * Train Multi-Asset Hybrid Agent
 * CLI script for training a shared hybrid agent across multiple assets
 *
 * Architecture:
 * - Single shared DQN agent trained on multiple assets
 * - Per-asset transaction costs from symbols.ts
 * - Cross-asset walk-forward validation
 *
 * Usage:
 *   npx tsx scripts/train-hybrid-multiasset.ts --symbols BTCUSDT,ETHUSDT,SOLUSDT --episodes 300
 *   npx tsx scripts/train-hybrid-multiasset.ts --symbols BTCUSDT,ETHUSDT,SOLUSDT,EURUSD=X --episodes 400
 */

import fs from 'fs';
import path from 'path';

import '@tensorflow/tfjs-node';
import * as tf from '@tensorflow/tfjs';

import type { Candle } from '@/types';
import {
  HybridTradingEnvironment,
  DQNAgent,
  ReplayBuffer,
  type SerializedWeights,
  type DQNConfig,
  type TradeRecord,
  type Portfolio,
  ExitActions,
  type ExitAction,
  type HybridEnvConfig,
  type EntryFilterConfig,
} from '@/lib/rl';
import { getEnvConfigForSymbol, SYMBOLS, normalizeSymbolName } from '@/lib/rl/config/symbols';

interface Args {
  symbols: string[];
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
  // Training
  learningRate: number;
  gamma: number;
  epsilonDecay: number;
  trainFrequency: number;
  batchSize: number;
  // Walk-forward
  walkforward: boolean;
  trainWindow: number;
  testWindow: number;
  stepSize: number;
  // Other
  verbose: boolean;
  baseline: boolean;
  dataDir: string;
}

interface SymbolData {
  symbol: string;
  candles: Candle[];
  envConfig: Partial<HybridEnvConfig>;
}

interface SymbolResult {
  symbol: string;
  trades: number;
  winRate: number;
  sharpe: number;
  pnl: number;
  baselineSharpe: number;
  beatsBaseline: boolean;
}

interface WindowResult {
  window: number;
  symbolResults: SymbolResult[];
  aggregateSharpe: number;
  aggregateBaseline: number;
  trainWinRate: number;
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

  // Default symbols
  const defaultSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  const symbolsStr = options['symbols'] || defaultSymbols.join(',');
  const symbols = symbolsStr.split(',').map((s) => s.trim()).filter(Boolean);

  return {
    symbols,
    episodes: parseInt(options['episodes'] || '300', 10),
    output: options['output'] || './models/hybrid-multiasset.json',
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
    // Training
    learningRate: parseFloat(options['learning-rate'] || '0.001'),
    gamma: parseFloat(options['gamma'] || '0.9'),
    epsilonDecay: parseFloat(options['epsilon-decay'] || '0.995'),
    trainFrequency: parseInt(options['train-frequency'] || '4', 10),
    batchSize: parseInt(options['batch-size'] || '32', 10),
    // Walk-forward
    walkforward: options['no-walkforward'] !== 'true',
    trainWindow: parseInt(options['train-window'] || '6000', 10),
    testWindow: parseInt(options['test-window'] || '1500', 10),
    stepSize: parseInt(options['step-size'] || '3000', 10),
    // Other
    verbose: options['verbose'] !== 'false',
    baseline: options['no-baseline'] !== 'true',
    dataDir: options['data-dir'] || './data',
  };
}

function getDataFilePath(dataDir: string, symbol: string): string {
  // Try different naming conventions
  const normalizedSymbol = normalizeSymbolName(symbol);
  const candidates = [
    path.resolve(dataDir, `${symbol}_1h.json`),
    path.resolve(dataDir, `${normalizedSymbol}_1h.json`),
    path.resolve(dataDir, `${symbol.replace('=', '_')}_1h.json`),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Data file not found for ${symbol}. Tried: ${candidates.join(', ')}`);
}

function loadCandles(dataPath: string): Candle[] {
  const content = fs.readFileSync(dataPath, 'utf-8');
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

function loadAllSymbols(args: Args): SymbolData[] {
  const symbolData: SymbolData[] = [];

  for (const symbol of args.symbols) {
    console.log(`  Loading ${symbol}...`);

    const dataPath = getDataFilePath(args.dataDir, symbol);
    const candles = loadCandles(dataPath);

    // Get per-asset costs
    const symbolCosts = getEnvConfigForSymbol(symbol);

    const envConfig: Partial<HybridEnvConfig> = {
      initialCapital: args.initialCapital,
      positionSize: args.positionSize,
      maxHoldBars: args.maxHoldBars,
      defaultSLPercent: args.slPercent,
      defaultTPPercent: args.tpPercent,
      spread: symbolCosts.spread,
      commission: symbolCosts.commission,
      slippage: symbolCosts.slippage,
      maxDrawdownLimit: 0.25,
    };

    const symbolInfo = SYMBOLS[symbol];
    console.log(`    Loaded ${candles.length} candles (${symbolInfo?.name || symbol})`);
    console.log(`    Costs: spread=${(symbolCosts.spread * 100).toFixed(4)}%, commission=${(symbolCosts.commission * 100).toFixed(3)}%`);

    symbolData.push({
      symbol,
      candles,
      envConfig,
    });
  }

  return symbolData;
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

/**
 * Create aligned walk-forward windows across all symbols
 * Uses the minimum common length to ensure all symbols have the same windows
 */
function createMultiAssetWindows(
  symbolData: SymbolData[],
  trainWindow: number,
  testWindow: number,
  stepSize: number
): { train: Map<string, Candle[]>; test: Map<string, Candle[]> }[] {
  // Find minimum length across all symbols
  const minLength = Math.min(...symbolData.map((s) => s.candles.length));
  const numWindows = Math.floor((minLength - trainWindow - testWindow) / stepSize) + 1;

  if (numWindows <= 0) {
    throw new Error(`Not enough data for walk-forward. Min length: ${minLength}, Required: ${trainWindow + testWindow}`);
  }

  const windows: { train: Map<string, Candle[]>; test: Map<string, Candle[]> }[] = [];

  for (let w = 0; w < numWindows; w++) {
    const start = w * stepSize;
    const trainEnd = start + trainWindow;
    const testEnd = trainEnd + testWindow;

    const train = new Map<string, Candle[]>();
    const test = new Map<string, Candle[]>();

    for (const { symbol, candles } of symbolData) {
      train.set(symbol, candles.slice(start, trainEnd));
      test.set(symbol, candles.slice(trainEnd, testEnd));
    }

    windows.push({ train, test });
  }

  return windows;
}

/**
 * Calculate Sharpe ratio from trades
 */
function calculateSharpe(trades: TradeRecord[]): number {
  if (trades.length < 2) return 0;

  const returns = trades.map((t) => t.pnlPercent);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
  const std = Math.sqrt(variance);

  if (std === 0) return mean > 0 ? 1 : mean < 0 ? -1 : 0;

  // Annualized (assuming hourly data)
  return (mean / std) * Math.sqrt(252 * 24);
}

/**
 * Run fixed-hold baseline
 */
function runBaseline(
  candles: Candle[],
  envConfig: Partial<HybridEnvConfig>,
  entryConfig: Partial<EntryFilterConfig>,
  holdBars: number
): { trades: TradeRecord[]; portfolio: Portfolio } {
  const env = new HybridTradingEnvironment(candles, envConfig, entryConfig, {}, false);
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

/**
 * Build minimal 18-feature state
 */
function buildMinimalState(env: HybridTradingEnvironment, position: {
  entryPrice: number;
  entryIndex: number;
  side: 'long' | 'short';
  stopLoss: number;
  takeProfit: number;
  entryATR: number;
  unrealizedPnL: number;
  barsHeld: number;
  peakPnL: number;
  size: number;
}): number[] {
  const candles = env.getCandles();
  const currentIndex = env.getCurrentIndex();
  const currentCandle = candles[currentIndex];

  if (!currentCandle) {
    return new Array(18).fill(0);
  }

  const currentPrice = currentCandle.close;

  // Position info (4)
  const pnlPercent = position.side === 'long'
    ? (currentPrice - position.entryPrice) / position.entryPrice
    : (position.entryPrice - currentPrice) / position.entryPrice;
  const unrealizedPnL = Math.max(-1, Math.min(1, pnlPercent * 10));
  const barsInPosition = Math.min(position.barsHeld / 50, 1);

  const slDistance = position.side === 'long'
    ? (currentPrice - position.stopLoss) / position.entryATR
    : (position.stopLoss - currentPrice) / position.entryATR;
  const distanceToSL = Math.max(0, Math.min(1, slDistance / 3));

  const tpDistance = position.side === 'long'
    ? (position.takeProfit - currentPrice) / position.entryATR
    : (currentPrice - position.takeProfit) / position.entryATR;
  const distanceToTP = Math.max(0, Math.min(1, tpDistance / 6));

  // Market context (6)
  const priceVsEntry = Math.max(-1, Math.min(1, pnlPercent * 20));
  const volatilityRatio = 1.0;
  const trendStrength = 0.0;
  const nearestOBDistance = 1.0;
  const fvgProximity = 1.0;
  const sessionProgress = 0.5;

  // Price action (8)
  const getReturn = (bars: number): number => {
    if (currentIndex < bars) return 0;
    const prev = candles[currentIndex - bars]?.close ?? currentPrice;
    const ret = (currentPrice - prev) / prev;
    return Math.max(-1, Math.min(1, ret * 20));
  };

  const returns1bar = getReturn(1);
  const returns3bar = getReturn(3);
  const returns5bar = getReturn(5);
  const returns10bar = getReturn(10);

  // Highest/lowest since entry
  let highestSinceEntry = 0;
  let lowestSinceEntry = 0;
  for (let i = position.entryIndex; i <= currentIndex; i++) {
    const c = candles[i];
    if (c) {
      const highPct = (c.high - position.entryPrice) / position.entryPrice;
      const lowPct = (position.entryPrice - c.low) / position.entryPrice;
      highestSinceEntry = Math.max(highestSinceEntry, highPct);
      lowestSinceEntry = Math.max(lowestSinceEntry, lowPct);
    }
  }
  highestSinceEntry = Math.min(1, highestSinceEntry * 10);
  lowestSinceEntry = Math.min(1, lowestSinceEntry * 10);

  // Candle pattern
  const candlePatternScore = currentCandle.close > currentCandle.open ? 0.3 : -0.3;
  const volumeRatio = 1.0;

  return [
    unrealizedPnL,
    barsInPosition,
    distanceToSL,
    distanceToTP,
    priceVsEntry,
    volatilityRatio,
    trendStrength,
    nearestOBDistance,
    fvgProximity,
    sessionProgress,
    returns1bar,
    returns3bar,
    returns5bar,
    returns10bar,
    highestSinceEntry,
    lowestSinceEntry,
    candlePatternScore,
    volumeRatio,
  ];
}

/**
 * Shuffle array in place (Fisher-Yates)
 */
function shuffleArray<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/**
 * Train one episode across all symbols
 */
async function trainEpisode(
  agent: DQNAgent,
  symbolData: SymbolData[],
  trainDataMap: Map<string, Candle[]>,
  entryConfig: Partial<EntryFilterConfig>,
  trainFrequency: number
): Promise<{ totalTrades: number; totalReward: number; totalSteps: number }> {
  // Shuffle symbol order each episode
  const shuffledSymbols = shuffleArray(symbolData);

  let totalTrades = 0;
  let totalReward = 0;
  let totalSteps = 0;

  for (const { symbol, envConfig } of shuffledSymbols) {
    const trainCandles = trainDataMap.get(symbol);
    if (!trainCandles) continue;

    const env = new HybridTradingEnvironment(
      trainCandles,
      { ...envConfig, randomStart: true },
      entryConfig,
      { featureNoiseLevel: 0.02 },
      true
    );

    env.reset();
    let steps = 0;

    while (!env.isDone()) {
      let action: ExitAction | null = null;

      if (env.isInPosition()) {
        const position = env.getPosition();
        if (position) {
          const state = buildMinimalState(env, position);
          action = agent.selectAction(state, true) as ExitAction;
        }
      }

      const result = env.step(action);
      totalReward += result.reward;
      steps++;

      if (action !== null && result.state) {
        const position = env.getPosition();
        const nextState = position
          ? buildMinimalState(env, position)
          : new Array(18).fill(0);

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

    totalTrades += env.getTrades().length;
    totalSteps += steps;
  }

  return { totalTrades, totalReward, totalSteps };
}

/**
 * Evaluate agent on a single symbol
 */
function evaluateSymbol(
  agent: DQNAgent,
  candles: Candle[],
  envConfig: Partial<HybridEnvConfig>,
  entryConfig: Partial<EntryFilterConfig>,
  runBaselineComparison: boolean
): SymbolResult {
  const env = new HybridTradingEnvironment(
    candles,
    { ...envConfig, randomStart: false },
    entryConfig,
    {},
    false
  );

  env.reset();

  while (!env.isDone()) {
    let action: ExitAction | null = null;

    if (env.isInPosition()) {
      const position = env.getPosition();
      if (position) {
        const state = buildMinimalState(env, position);
        action = agent.selectAction(state, false) as ExitAction;
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

  let baselineSharpe = 0;
  if (runBaselineComparison) {
    const baseline = runBaseline(candles, envConfig, entryConfig, 10);
    baselineSharpe = calculateSharpe(baseline.trades);
  }

  return {
    symbol: '',
    trades: trades.length,
    winRate,
    sharpe,
    pnl: portfolio.realizedPnL,
    baselineSharpe,
    beatsBaseline: sharpe > baselineSharpe,
  };
}

/**
 * Train on a window across all symbols
 */
async function trainOnWindow(
  agent: DQNAgent,
  symbolData: SymbolData[],
  trainDataMap: Map<string, Candle[]>,
  entryConfig: Partial<EntryFilterConfig>,
  episodes: number,
  trainFrequency: number,
  verbose: boolean
): Promise<{ totalTrades: number; winRate: number }> {
  let allTrades = 0;

  for (let episode = 1; episode <= episodes; episode++) {
    const result = await trainEpisode(
      agent,
      symbolData,
      trainDataMap,
      entryConfig,
      trainFrequency
    );

    allTrades += result.totalTrades;
    agent.endEpisode();

    if (verbose && episode % 20 === 0) {
      console.log(`  Episode ${episode}/${episodes} | Trades: ${allTrades} | Epsilon: ${agent.getState().epsilon.toFixed(3)}`);
    }
  }

  // Final evaluation pass to get accurate win rate
  let totalWins = 0;
  let totalTrades = 0;

  for (const { symbol, envConfig } of symbolData) {
    const trainCandles = trainDataMap.get(symbol);
    if (!trainCandles) continue;

    const result = evaluateSymbol(agent, trainCandles, envConfig, entryConfig, false);
    totalWins += result.trades * (result.winRate / 100);
    totalTrades += result.trades;
  }

  const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;

  return { totalTrades: allTrades, winRate };
}

async function main() {
  const args = parseArgs();

  console.log('='.repeat(70));
  console.log('ICT Trading - Multi-Asset Hybrid Agent Trainer');
  console.log('(Single shared agent trained across multiple assets)');
  console.log('='.repeat(70));
  console.log();

  // Validate symbols
  console.log('Symbols:', args.symbols.join(', '));
  console.log();

  // Load all symbol data
  console.log('Loading data for all symbols...');
  const symbolData = loadAllSymbols(args);
  console.log();

  // Entry filter config
  const entryConfig: Partial<EntryFilterConfig> = {
    minConfluence: args.minConfluence,
    requireOBTouch: args.requireOBTouch,
    requireTrendAlignment: args.requireTrendAlignment,
  };

  // DQN config
  const dqnConfig: Partial<DQNConfig> = {
    inputSize: 18,
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
  console.log('  Training:');
  console.log(`    Total episodes: ${args.episodes}`);
  console.log(`    Learning rate: ${args.learningRate}`);
  console.log(`    Gamma: ${args.gamma}`);
  console.log(`    Walk-forward: ${args.walkforward ? 'ENABLED' : 'disabled'}`);
  if (args.walkforward) {
    console.log(`    Train window: ${args.trainWindow} candles`);
    console.log(`    Test window: ${args.testWindow} candles`);
  }
  console.log();

  // Create agent
  const buffer = new ReplayBuffer({
    capacity: 100000, // Larger buffer for multi-asset
    batchSize: args.batchSize,
    minExperience: 1000,
  });
  const agent = new DQNAgent(dqnConfig, buffer);

  // Create walk-forward windows
  const windows = args.walkforward
    ? createMultiAssetWindows(symbolData, args.trainWindow, args.testWindow, args.stepSize)
    : [createSingleWindow(symbolData)];

  console.log(`Created ${windows.length} walk-forward windows`);
  console.log();

  const windowResults: WindowResult[] = [];
  let bestWeights: SerializedWeights | null = null;
  let bestAggregateSharpe = -Infinity;

  const episodesPerWindow = Math.ceil(args.episodes / windows.length);

  for (let w = 0; w < windows.length; w++) {
    const window = windows[w]!;

    console.log('='.repeat(70));
    console.log(`Window ${w + 1}/${windows.length}`);
    console.log('='.repeat(70));

    // Train on window
    console.log('\nTraining on all symbols...');
    const trainResult = await trainOnWindow(
      agent,
      symbolData,
      window.train,
      entryConfig,
      episodesPerWindow,
      args.trainFrequency,
      args.verbose
    );

    console.log(`\nTraining complete: ${trainResult.totalTrades} total trades`);

    // Evaluate on each symbol
    console.log('\nEvaluating on test set...\n');
    console.log('| Symbol   | Trades | Win Rate | Sharpe   | Baseline | Improvement |');
    console.log('|----------|--------|----------|----------|----------|-------------|');

    const symbolResults: SymbolResult[] = [];

    for (const { symbol, envConfig } of symbolData) {
      const testCandles = window.test.get(symbol);
      if (!testCandles) continue;

      const result = evaluateSymbol(agent, testCandles, envConfig, entryConfig, args.baseline);
      result.symbol = symbol;
      symbolResults.push(result);

      const improvement = result.sharpe - result.baselineSharpe;
      const impStr = improvement >= 0 ? `+${improvement.toFixed(2)}` : improvement.toFixed(2);
      const beatsStr = result.beatsBaseline ? '✓' : '✗';

      console.log(
        `| ${symbol.padEnd(8)} | ${result.trades.toString().padStart(6)} | ${result.winRate.toFixed(1).padStart(7)}% | ${result.sharpe.toFixed(2).padStart(8)} | ${result.baselineSharpe.toFixed(2).padStart(8)} | ${impStr.padStart(8)} ${beatsStr} |`
      );
    }

    // Aggregate metrics
    const aggregateSharpe = symbolResults.reduce((a, r) => a + r.sharpe, 0) / symbolResults.length;
    const aggregateBaseline = symbolResults.reduce((a, r) => a + r.baselineSharpe, 0) / symbolResults.length;
    const aggregateImprovement = aggregateSharpe - aggregateBaseline;

    console.log('|----------|--------|----------|----------|----------|-------------|');
    console.log(
      `| AVERAGE  |        |          | ${aggregateSharpe.toFixed(2).padStart(8)} | ${aggregateBaseline.toFixed(2).padStart(8)} | ${(aggregateImprovement >= 0 ? '+' : '') + aggregateImprovement.toFixed(2).padStart(7)}   |`
    );

    windowResults.push({
      window: w,
      symbolResults,
      aggregateSharpe,
      aggregateBaseline,
      trainWinRate: trainResult.winRate,
    });

    // Track best model
    if (aggregateSharpe > bestAggregateSharpe) {
      bestAggregateSharpe = aggregateSharpe;
      bestWeights = await agent.saveWeights();
      console.log(`\n  ★ New best aggregate Sharpe: ${aggregateSharpe.toFixed(2)}`);
    }

    console.log();
  }

  // Final summary
  console.log('\n' + '='.repeat(70));
  console.log('MULTI-ASSET WALK-FORWARD VALIDATION SUMMARY');
  console.log('='.repeat(70));
  console.log();

  // Per-symbol summary
  console.log('PER-SYMBOL RESULTS (averaged across windows):');
  console.log();

  const symbolSummary: Record<string, { sharpes: number[]; baselines: number[]; trades: number[] }> = {};

  for (const { symbolResults } of windowResults) {
    for (const r of symbolResults) {
      if (!symbolSummary[r.symbol]) {
        symbolSummary[r.symbol] = { sharpes: [], baselines: [], trades: [] };
      }
      symbolSummary[r.symbol]!.sharpes.push(r.sharpe);
      symbolSummary[r.symbol]!.baselines.push(r.baselineSharpe);
      symbolSummary[r.symbol]!.trades.push(r.trades);
    }
  }

  console.log('| Symbol   | Avg Sharpe | Avg Baseline | Avg Improvement | Beat Baseline |');
  console.log('|----------|------------|--------------|-----------------|---------------|');

  let totalPositiveSharpe = 0;
  let totalBeatsBaseline = 0;
  let worstSharpe = Infinity;
  let worstSymbol = '';

  for (const symbol of args.symbols) {
    const summary = symbolSummary[symbol];
    if (!summary) continue;

    const avgSharpe = summary.sharpes.reduce((a, b) => a + b, 0) / summary.sharpes.length;
    const avgBaseline = summary.baselines.reduce((a, b) => a + b, 0) / summary.baselines.length;
    const avgImprovement = avgSharpe - avgBaseline;
    const beatsCount = summary.sharpes.filter((s, i) => s > summary.baselines[i]!).length;
    const beatsRatio = `${beatsCount}/${summary.sharpes.length}`;

    if (avgSharpe > 0) totalPositiveSharpe++;
    if (avgSharpe > avgBaseline) totalBeatsBaseline++;
    if (avgSharpe < worstSharpe) {
      worstSharpe = avgSharpe;
      worstSymbol = symbol;
    }

    console.log(
      `| ${symbol.padEnd(8)} | ${avgSharpe.toFixed(2).padStart(10)} | ${avgBaseline.toFixed(2).padStart(12)} | ${(avgImprovement >= 0 ? '+' : '') + avgImprovement.toFixed(2).padStart(14)} | ${beatsRatio.padStart(13)} |`
    );
  }

  console.log();

  // Overall summary
  const avgAggregateSharpe = windowResults.reduce((a, w) => a + w.aggregateSharpe, 0) / windowResults.length;
  const avgAggregateBaseline = windowResults.reduce((a, w) => a + w.aggregateBaseline, 0) / windowResults.length;
  const positiveAggregateWindows = windowResults.filter((w) => w.aggregateSharpe > 0).length;
  const beatsBaselineWindows = windowResults.filter((w) => w.aggregateSharpe > w.aggregateBaseline).length;

  console.log('AGGREGATE METRICS:');
  console.log(`  Avg Aggregate Sharpe:    ${avgAggregateSharpe.toFixed(2)}`);
  console.log(`  Avg Aggregate Baseline:  ${avgAggregateBaseline.toFixed(2)}`);
  console.log(`  Avg Improvement:         ${(avgAggregateSharpe - avgAggregateBaseline >= 0 ? '+' : '') + (avgAggregateSharpe - avgAggregateBaseline).toFixed(2)}`);
  console.log();
  console.log(`  Windows with positive Sharpe: ${positiveAggregateWindows}/${windowResults.length}`);
  console.log(`  Windows beating baseline:     ${beatsBaselineWindows}/${windowResults.length}`);
  console.log(`  Symbols with positive Sharpe: ${totalPositiveSharpe}/${args.symbols.length}`);
  console.log(`  Symbols beating baseline:     ${totalBeatsBaseline}/${args.symbols.length}`);
  console.log(`  Worst symbol:                 ${worstSymbol} (Sharpe: ${worstSharpe.toFixed(2)})`);
  console.log();

  // Success criteria
  console.log('SUCCESS CRITERIA:');
  const sharpeOk = avgAggregateSharpe > 0;
  const majorityBeats = beatsBaselineWindows >= Math.ceil(windowResults.length / 2);
  const noCollapse = worstSharpe > -50;

  console.log(`  ${sharpeOk ? '✓' : '✗'} Avg aggregate Sharpe > 0: ${avgAggregateSharpe.toFixed(2)}`);
  console.log(`  ${majorityBeats ? '✓' : '✗'} Majority windows beat baseline: ${beatsBaselineWindows}/${windowResults.length}`);
  console.log(`  ${noCollapse ? '✓' : '✗'} No catastrophic failure (Sharpe > -50): ${worstSharpe.toFixed(2)}`);

  if (sharpeOk && majorityBeats && noCollapse) {
    console.log('\n✓ Multi-asset validation PASSED - agent generalizes across assets');
  } else {
    console.log('\n✗ Multi-asset validation FAILED - may need tuning or more data');
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

/**
 * Create single window for non-walkforward mode
 */
function createSingleWindow(symbolData: SymbolData[]): { train: Map<string, Candle[]>; test: Map<string, Candle[]> } {
  const train = new Map<string, Candle[]>();
  const test = new Map<string, Candle[]>();

  for (const { symbol, candles } of symbolData) {
    const splitIdx = Math.floor(candles.length * 0.8);
    train.set(symbol, candles.slice(0, splitIdx));
    test.set(symbol, candles.slice(splitIdx));
  }

  return { train, test };
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
