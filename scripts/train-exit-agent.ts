#!/usr/bin/env npx tsx
/**
 * Train Exit Agent
 *
 * Hybrid approach: Rule-based entries + RL-trained exits
 *
 * Entry Rules (simple, proven):
 * - EMA crossover (fast > slow = long, fast < slow = short)
 * - RSI confirmation (RSI < 40 for long, RSI > 60 for short)
 *
 * RL Agent learns:
 * - When to exit positions for maximum profit
 * - Actions: HOLD (keep position) or EXIT (close position)
 *
 * This avoids the "do nothing" exploit because:
 * - Entries are forced by rules
 * - Agent only sees states when IN a position
 * - Must decide when to exit, can't avoid trading
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';
import { ExitAgent, type ExitAgentConfig } from '../src/lib/rl/agent/exit-agent';
import { FeatureReducer, createFeatureReducer } from '../src/lib/rl/environment/feature-reducer';

// ============================================
// Configuration
// ============================================

const CONFIG = {
  // Data settings
  dataFile: 'data/BTCUSDT_1h.json',
  recentMonths: 6,

  // Entry rules (relaxed for more signals)
  entry: {
    fastEMA: 9,
    slowEMA: 21,
    rsiPeriod: 14,
    rsiLongThreshold: 60,   // RSI < 60 confirms long (relaxed)
    rsiShortThreshold: 40,  // RSI > 40 confirms short (relaxed)
    minBarsBetweenTrades: 2, // Minimum bars between trades
  },

  // Exit agent
  agent: {
    actions: 2, // 0=HOLD, 1=EXIT
    hiddenLayers: [32, 16], // Smaller network for simpler task
    learningRate: 0.001,
    gamma: 0.95,
    epsilonStart: 1.0,
    epsilonEnd: 0.05,
    epsilonDecay: 0.998, // Slower decay for more exploration
    batchSize: 32,
    memorySize: 10000,
    targetUpdateFreq: 100,
    dropout: 0.1, // Light dropout
    l2Regularization: 0.001,
  },

  // Training
  training: {
    episodes: 300,
    maxStepsPerEpisode: 500,
    validationFreq: 25,
    earlyStoppingPatience: 75,
  },

  // Position management
  position: {
    maxHoldBars: 48, // Force exit after 48 bars (2 days)
    stopLossPct: 0.02, // 2% stop loss
    takeProfitPct: 0.04, // 4% take profit
  },

  // Feature reduction
  featureReduction: 'moderate' as const,
};

// ============================================
// Technical Indicators
// ============================================

function calculateEMA(prices: number[], period: number): number[] {
  const ema: number[] = [];
  const multiplier = 2 / (period + 1);

  // Start with SMA
  let sum = 0;
  for (let i = 0; i < period && i < prices.length; i++) {
    sum += prices[i]!;
  }
  ema[period - 1] = sum / period;

  // Calculate EMA
  for (let i = period; i < prices.length; i++) {
    ema[i] = (prices[i]! - ema[i - 1]!) * multiplier + ema[i - 1]!;
  }

  return ema;
}

function calculateRSI(prices: number[], period: number): number[] {
  const rsi: number[] = [];
  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < prices.length; i++) {
    const change = prices[i]! - prices[i - 1]!;
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }

  // First RSI uses SMA
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < prices.length; i++) {
    if (i > period) {
      avgGain = (avgGain * (period - 1) + gains[i - 1]!) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i - 1]!) / period;
    }

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi[i] = 100 - (100 / (1 + rs));
  }

  return rsi;
}

function calculateATR(candles: Candle[], period: number): number[] {
  const atr: number[] = [];
  const tr: number[] = [];

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;
    if (i === 0) {
      tr.push(candle.high - candle.low);
    } else {
      const prev = candles[i - 1]!;
      const trueRange = Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - prev.close),
        Math.abs(candle.low - prev.close)
      );
      tr.push(trueRange);
    }

    if (i >= period - 1) {
      if (i === period - 1) {
        atr[i] = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
      } else {
        atr[i] = (atr[i - 1]! * (period - 1) + tr[i]!) / period;
      }
    }
  }

  return atr;
}

// ============================================
// Entry Signal Generator
// ============================================

interface EntrySignal {
  bar: number;
  direction: 'long' | 'short';
  price: number;
  fastEMA: number;
  slowEMA: number;
  rsi: number;
}

function generateEntrySignals(candles: Candle[]): EntrySignal[] {
  const closes = candles.map(c => c.close);
  const fastEMA = calculateEMA(closes, CONFIG.entry.fastEMA);
  const slowEMA = calculateEMA(closes, CONFIG.entry.slowEMA);
  const rsi = calculateRSI(closes, CONFIG.entry.rsiPeriod);

  const signals: EntrySignal[] = [];
  let lastSignalBar = -CONFIG.entry.minBarsBetweenTrades;

  const startBar = Math.max(CONFIG.entry.slowEMA, CONFIG.entry.rsiPeriod) + 1;

  for (let i = startBar; i < candles.length; i++) {
    // Skip if too soon after last signal
    if (i - lastSignalBar < CONFIG.entry.minBarsBetweenTrades) continue;

    const prevFastEMA = fastEMA[i - 1];
    const prevSlowEMA = slowEMA[i - 1];
    const currFastEMA = fastEMA[i];
    const currSlowEMA = slowEMA[i];
    const currRSI = rsi[i];

    if (prevFastEMA === undefined || prevSlowEMA === undefined ||
        currFastEMA === undefined || currSlowEMA === undefined ||
        currRSI === undefined) continue;

    // Long signal: Fast EMA crosses above Slow EMA (RSI not overbought)
    if (prevFastEMA <= prevSlowEMA && currFastEMA > currSlowEMA &&
        currRSI < CONFIG.entry.rsiLongThreshold) {
      signals.push({
        bar: i,
        direction: 'long',
        price: candles[i]!.close,
        fastEMA: currFastEMA,
        slowEMA: currSlowEMA,
        rsi: currRSI,
      });
      lastSignalBar = i;
    }
    // Short signal: Fast EMA crosses below Slow EMA (RSI not oversold)
    else if (prevFastEMA >= prevSlowEMA && currFastEMA < currSlowEMA &&
             currRSI > CONFIG.entry.rsiShortThreshold) {
      signals.push({
        bar: i,
        direction: 'short',
        price: candles[i]!.close,
        fastEMA: currFastEMA,
        slowEMA: currSlowEMA,
        rsi: currRSI,
      });
      lastSignalBar = i;
    }
    // Additional: Strong RSI signals without crossover
    else if (currRSI < 25 && i - lastSignalBar >= 10) {
      // Oversold - potential long
      signals.push({
        bar: i,
        direction: 'long',
        price: candles[i]!.close,
        fastEMA: currFastEMA,
        slowEMA: currSlowEMA,
        rsi: currRSI,
      });
      lastSignalBar = i;
    }
    else if (currRSI > 75 && i - lastSignalBar >= 10) {
      // Overbought - potential short
      signals.push({
        bar: i,
        direction: 'short',
        price: candles[i]!.close,
        fastEMA: currFastEMA,
        slowEMA: currSlowEMA,
        rsi: currRSI,
      });
      lastSignalBar = i;
    }
  }

  return signals;
}

// ============================================
// Exit State Builder
// ============================================

interface ExitState {
  features: number[];
  entryPrice: number;
  direction: 'long' | 'short';
  barsHeld: number;
  unrealizedPnL: number;
  maxProfit: number;
  maxDrawdown: number;
}

function buildExitState(
  candles: Candle[],
  currentBar: number,
  entryBar: number,
  entryPrice: number,
  direction: 'long' | 'short',
  maxProfit: number,
  maxDrawdown: number,
): ExitState {
  const lookback = 20;
  const startIdx = Math.max(0, currentBar - lookback);
  const recentCandles = candles.slice(startIdx, currentBar + 1);

  const currentPrice = candles[currentBar]!.close;
  const barsHeld = currentBar - entryBar;

  // Calculate unrealized PnL
  const priceDiff = direction === 'long'
    ? currentPrice - entryPrice
    : entryPrice - currentPrice;
  const unrealizedPnL = priceDiff / entryPrice;

  // Price features (normalized)
  const closes = recentCandles.map(c => c.close);
  const atr = calculateATR(recentCandles, 14);
  const currentATR = atr[atr.length - 1] || closes[closes.length - 1]! * 0.01;

  // Build feature vector
  const features: number[] = [];

  // 1. Position state (5 features)
  features.push(direction === 'long' ? 1 : -1);
  features.push(Math.min(barsHeld / CONFIG.position.maxHoldBars, 1)); // Normalized bars held
  features.push(unrealizedPnL * 10); // Scaled PnL
  features.push(maxProfit * 10);
  features.push(maxDrawdown * 10);

  // 2. Price momentum (5 features)
  const returns1 = (closes[closes.length - 1]! - closes[closes.length - 2]!) / currentATR;
  const returns3 = closes.length >= 4
    ? (closes[closes.length - 1]! - closes[closes.length - 4]!) / currentATR
    : 0;
  const returns5 = closes.length >= 6
    ? (closes[closes.length - 1]! - closes[closes.length - 6]!) / currentATR
    : 0;
  features.push(Math.tanh(returns1));
  features.push(Math.tanh(returns3));
  features.push(Math.tanh(returns5));

  // Volatility
  const recentReturns = [];
  for (let i = 1; i < Math.min(10, closes.length); i++) {
    recentReturns.push((closes[closes.length - i]! - closes[closes.length - i - 1]!) / currentATR);
  }
  const volatility = recentReturns.length > 0
    ? Math.sqrt(recentReturns.reduce((a, b) => a + b * b, 0) / recentReturns.length)
    : 0;
  features.push(volatility);

  // Distance from entry (normalized by ATR)
  features.push((currentPrice - entryPrice) / currentATR);

  // 3. Technical indicators (5 features)
  const rsi = calculateRSI(closes, 14);
  const currentRSI = rsi[rsi.length - 1] ?? 50;
  features.push((currentRSI - 50) / 50); // RSI normalized to [-1, 1]

  const fastEMA = calculateEMA(closes, 5);
  const slowEMA = calculateEMA(closes, 12);
  const emaSpread = (fastEMA[fastEMA.length - 1]! - slowEMA[slowEMA.length - 1]!) / currentATR;
  features.push(Math.tanh(emaSpread));

  // Candle patterns
  const currentCandle = candles[currentBar]!;
  const bodySize = Math.abs(currentCandle.close - currentCandle.open) / currentATR;
  const upperWick = (currentCandle.high - Math.max(currentCandle.open, currentCandle.close)) / currentATR;
  const lowerWick = (Math.min(currentCandle.open, currentCandle.close) - currentCandle.low) / currentATR;
  features.push(Math.tanh(bodySize));
  features.push(Math.tanh(upperWick - lowerWick)); // Wick imbalance

  // 4. Risk features (5 features)
  // Distance to stop loss
  const stopPrice = direction === 'long'
    ? entryPrice * (1 - CONFIG.position.stopLossPct)
    : entryPrice * (1 + CONFIG.position.stopLossPct);
  const distToStop = direction === 'long'
    ? (currentPrice - stopPrice) / currentATR
    : (stopPrice - currentPrice) / currentATR;
  features.push(Math.tanh(distToStop));

  // Distance to take profit
  const tpPrice = direction === 'long'
    ? entryPrice * (1 + CONFIG.position.takeProfitPct)
    : entryPrice * (1 - CONFIG.position.takeProfitPct);
  const distToTP = direction === 'long'
    ? (tpPrice - currentPrice) / currentATR
    : (currentPrice - tpPrice) / currentATR;
  features.push(Math.tanh(distToTP));

  // Profit give-back (how much profit lost from max)
  const profitGiveBack = maxProfit > 0 ? (maxProfit - unrealizedPnL) / maxProfit : 0;
  features.push(Math.min(profitGiveBack, 1));

  // Time pressure (approaches 1 as max hold time nears)
  features.push(barsHeld / CONFIG.position.maxHoldBars);

  // Trend alignment (is position aligned with recent trend?)
  const trendAlignment = direction === 'long' ? Math.tanh(returns5) : Math.tanh(-returns5);
  features.push(trendAlignment);

  return {
    features,
    entryPrice,
    direction,
    barsHeld,
    unrealizedPnL,
    maxProfit,
    maxDrawdown,
  };
}

// ============================================
// Training Environment
// ============================================

interface Trade {
  entryBar: number;
  exitBar: number;
  entryPrice: number;
  exitPrice: number;
  direction: 'long' | 'short';
  pnl: number;
  barsHeld: number;
  exitReason: 'agent' | 'stop_loss' | 'take_profit' | 'max_hold';
}

function runEpisode(
  agent: DQNAgent,
  candles: Candle[],
  signals: EntrySignal[],
  featureReducer: FeatureReducer | null,
  training: boolean,
): { trades: Trade[]; totalReward: number } {
  const trades: Trade[] = [];
  let totalReward = 0;

  for (const signal of signals) {
    // Skip if not enough candles after entry
    if (signal.bar + CONFIG.position.maxHoldBars >= candles.length) continue;

    let currentBar = signal.bar;
    let maxProfit = 0;
    let maxDrawdown = 0;
    let episodeReward = 0;

    // Simulate position
    while (currentBar < candles.length - 1) {
      const currentPrice = candles[currentBar]!.close;

      // Calculate current PnL
      const priceDiff = signal.direction === 'long'
        ? currentPrice - signal.price
        : signal.price - currentPrice;
      const unrealizedPnL = priceDiff / signal.price;

      // Track max profit/drawdown
      maxProfit = Math.max(maxProfit, unrealizedPnL);
      maxDrawdown = Math.min(maxDrawdown, unrealizedPnL);

      // Check forced exits
      let exitReason: Trade['exitReason'] | null = null;

      // Stop loss
      if (unrealizedPnL <= -CONFIG.position.stopLossPct) {
        exitReason = 'stop_loss';
      }
      // Take profit
      else if (unrealizedPnL >= CONFIG.position.takeProfitPct) {
        exitReason = 'take_profit';
      }
      // Max hold time
      else if (currentBar - signal.bar >= CONFIG.position.maxHoldBars) {
        exitReason = 'max_hold';
      }

      if (exitReason) {
        trades.push({
          entryBar: signal.bar,
          exitBar: currentBar,
          entryPrice: signal.price,
          exitPrice: currentPrice,
          direction: signal.direction,
          pnl: unrealizedPnL,
          barsHeld: currentBar - signal.bar,
          exitReason,
        });

        // Reward for forced exits
        const reward = unrealizedPnL * 100; // Scale PnL to reward
        totalReward += reward;
        break;
      }

      // Build state for agent
      let state = buildExitState(
        candles, currentBar, signal.bar, signal.price,
        signal.direction, maxProfit, maxDrawdown
      );

      // Apply feature reduction if available
      let stateFeatures = state.features;
      if (featureReducer && featureReducer.isReady()) {
        stateFeatures = featureReducer.transform(stateFeatures);
      }

      // Get agent action
      const action = agent.selectAction(stateFeatures, training);

      // Execute action
      if (action === 1) { // EXIT
        const exitPrice = candles[currentBar + 1]!.open; // Exit at next bar open
        const exitPnL = signal.direction === 'long'
          ? (exitPrice - signal.price) / signal.price
          : (signal.price - exitPrice) / signal.price;

        trades.push({
          entryBar: signal.bar,
          exitBar: currentBar + 1,
          entryPrice: signal.price,
          exitPrice,
          direction: signal.direction,
          pnl: exitPnL,
          barsHeld: currentBar + 1 - signal.bar,
          exitReason: 'agent',
        });

        // Reward for agent exit
        // Strong reward shaping to encourage profitable exits
        let reward = exitPnL * 200; // Base PnL reward (scaled up)

        // Bonus for capturing profit near peak
        if (maxProfit > 0) {
          const profitCapture = exitPnL / maxProfit;
          if (profitCapture > 0.7) reward += 10; // Great exit timing
          else if (profitCapture > 0.4) reward += 5; // Good exit timing
        }

        // Penalty for exiting too early (before 5 bars unless in profit)
        const barsHeld = currentBar + 1 - signal.bar;
        if (barsHeld < 5 && exitPnL < 0) {
          reward -= 5; // Penalty for quick losing exits
        }

        // Bonus for cutting losses quickly when position is deteriorating
        if (exitPnL < -0.005 && maxDrawdown < -0.01) {
          reward += 3; // Good risk management
        }

        if (training) {
          // Get next state for learning (terminal)
          const nextState = new Array(stateFeatures.length).fill(0);
          agent.storeExperience(stateFeatures, action, reward, nextState, true);
          agent.train();
        }

        totalReward += reward;
        episodeReward += reward;
        break;
      }

      // HOLD action - small reward for holding profitable positions
      // Penalty only kicks in after position turns negative or near max hold
      const barsHeld = currentBar - signal.bar;
      const timeRatio = barsHeld / CONFIG.position.maxHoldBars;

      let holdReward: number;
      if (unrealizedPnL > 0) {
        // Reward holding profitable positions (more reward for larger profits)
        holdReward = unrealizedPnL * 10 + 0.1;
      } else if (barsHeld < 5) {
        // Grace period - no penalty for first 5 bars
        holdReward = 0;
      } else {
        // Time penalty increases as we approach max hold
        holdReward = -0.05 * timeRatio;
      }

      if (training) {
        // Build next state
        const nextBar = currentBar + 1;
        const nextPrice = candles[nextBar]!.close;
        const nextPriceDiff = signal.direction === 'long'
          ? nextPrice - signal.price
          : signal.price - nextPrice;
        const nextPnL = nextPriceDiff / signal.price;
        const nextMaxProfit = Math.max(maxProfit, nextPnL);
        const nextMaxDrawdown = Math.min(maxDrawdown, nextPnL);

        let nextState = buildExitState(
          candles, nextBar, signal.bar, signal.price,
          signal.direction, nextMaxProfit, nextMaxDrawdown
        );

        let nextStateFeatures = nextState.features;
        if (featureReducer && featureReducer.isReady()) {
          nextStateFeatures = featureReducer.transform(nextStateFeatures);
        }

        agent.storeExperience(stateFeatures, action, holdReward, nextStateFeatures, false);
        agent.train();
      }

      episodeReward += holdReward;
      currentBar++;
    }
  }

  return { trades, totalReward };
}

// ============================================
// Evaluation Metrics
// ============================================

interface EvalMetrics {
  trades: number;
  winRate: number;
  avgPnL: number;
  totalPnL: number;
  sharpe: number;
  agentExits: number;
  stopLosses: number;
  takeProfits: number;
  maxHolds: number;
  avgBarsHeld: number;
}

function evaluateTrades(trades: Trade[]): EvalMetrics {
  if (trades.length === 0) {
    return {
      trades: 0,
      winRate: 0,
      avgPnL: 0,
      totalPnL: 0,
      sharpe: 0,
      agentExits: 0,
      stopLosses: 0,
      takeProfits: 0,
      maxHolds: 0,
      avgBarsHeld: 0,
    };
  }

  const wins = trades.filter(t => t.pnl > 0).length;
  const pnls = trades.map(t => t.pnl);
  const totalPnL = pnls.reduce((a, b) => a + b, 0);
  const avgPnL = totalPnL / trades.length;

  // Sharpe ratio
  const mean = avgPnL;
  const variance = pnls.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / trades.length;
  const std = Math.sqrt(variance) || 0.0001;
  const sharpe = mean / std * Math.sqrt(252); // Annualized

  return {
    trades: trades.length,
    winRate: wins / trades.length,
    avgPnL,
    totalPnL,
    sharpe,
    agentExits: trades.filter(t => t.exitReason === 'agent').length,
    stopLosses: trades.filter(t => t.exitReason === 'stop_loss').length,
    takeProfits: trades.filter(t => t.exitReason === 'take_profit').length,
    maxHolds: trades.filter(t => t.exitReason === 'max_hold').length,
    avgBarsHeld: trades.reduce((a, b) => a + b.barsHeld, 0) / trades.length,
  };
}

// ============================================
// Main Training Loop
// ============================================

async function main() {
  console.log('============================================================');
  console.log('EXIT AGENT TRAINING');
  console.log('============================================================');
  console.log('');
  console.log('Approach: Rule-based entries + RL-trained exits');
  console.log('Entry rules: EMA crossover + RSI confirmation');
  console.log('Exit agent: 2 actions (HOLD / EXIT)');
  console.log('');

  // Load data
  const dataPath = path.join(process.cwd(), CONFIG.dataFile);
  const rawData = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as Candle[];
  console.log(`Loaded ${rawData.length} candles from ${CONFIG.dataFile}`);

  // Use recent data
  const hoursPerMonth = 24 * 30;
  const recentCandles = rawData.slice(-hoursPerMonth * CONFIG.recentMonths);
  console.log(`Using ${recentCandles.length} recent candles (${CONFIG.recentMonths} months)`);

  // Split into train/val
  const splitIdx = Math.floor(recentCandles.length * 0.8);
  const trainCandles = recentCandles.slice(0, splitIdx);
  const valCandles = recentCandles.slice(splitIdx);

  console.log(`Train: ${trainCandles.length} candles`);
  console.log(`Validation: ${valCandles.length} candles`);

  // Generate entry signals
  const trainSignals = generateEntrySignals(trainCandles);
  const valSignals = generateEntrySignals(valCandles);

  console.log(`\nEntry signals generated:`);
  console.log(`  Train: ${trainSignals.length} signals`);
  console.log(`  Validation: ${valSignals.length} signals`);

  if (trainSignals.length < 10) {
    console.error('Not enough training signals. Adjust entry rules.');
    process.exit(1);
  }

  // Create feature reducer
  const featureReducer = createFeatureReducer(CONFIG.featureReduction);

  // Warm up feature reducer with sample states
  console.log('\nWarming up feature reducer...');
  for (let i = 0; i < Math.min(100, trainSignals.length); i++) {
    const signal = trainSignals[i]!;
    const state = buildExitState(trainCandles, signal.bar + 5, signal.bar, signal.price, signal.direction, 0, 0);
    featureReducer.addSample(state.features);
  }

  // Force fit if not enough samples
  if (!featureReducer.isReady()) {
    console.log('Forcing feature reducer fit...');
    featureReducer.fit();
  }

  const inputSize = featureReducer.getOutputDimension();
  console.log(`Feature reducer: ${buildExitState(trainCandles, trainSignals[0]!.bar + 5, trainSignals[0]!.bar, trainSignals[0]!.price, 'long', 0, 0).features.length} -> ${inputSize} features`);

  // Create agent
  const agentConfig: ExitAgentConfig = {
    inputSize,
    hiddenLayers: CONFIG.agent.hiddenLayers,
    learningRate: CONFIG.agent.learningRate,
    gamma: CONFIG.agent.gamma,
    epsilonStart: CONFIG.agent.epsilonStart,
    epsilonEnd: CONFIG.agent.epsilonEnd,
    epsilonDecay: CONFIG.agent.epsilonDecay,
    batchSize: CONFIG.agent.batchSize,
    memorySize: CONFIG.agent.memorySize,
    targetUpdateFreq: CONFIG.agent.targetUpdateFreq,
    dropout: CONFIG.agent.dropout,
    l2Regularization: CONFIG.agent.l2Regularization,
  };

  const agent = new ExitAgent(agentConfig);
  console.log(`\nAgent created: ${inputSize} inputs, ${CONFIG.agent.actions} outputs`);
  console.log(`Network: [${CONFIG.agent.hiddenLayers.join(', ')}]`);

  // Training
  console.log('\n============================================================');
  console.log('TRAINING');
  console.log('============================================================\n');

  let bestValSharpe = -Infinity;
  let bestEpisode = 0;
  let noImprovementCount = 0;
  let bestWeights: ReturnType<typeof agent.exportWeights> | null = null;

  for (let episode = 1; episode <= CONFIG.training.episodes; episode++) {
    // Shuffle signals for this episode
    const shuffledSignals = [...trainSignals].sort(() => Math.random() - 0.5);

    // Run training episode
    const { trades, totalReward } = runEpisode(
      agent, trainCandles, shuffledSignals, featureReducer, true
    );

    const metrics = evaluateTrades(trades);

    // Log progress
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(
      `[${timestamp}] Ep ${episode.toString().padStart(3)}: ` +
      `Trades=${metrics.trades.toString().padStart(3)} ` +
      `WR=${(metrics.winRate * 100).toFixed(1).padStart(5)}% ` +
      `PnL=${(metrics.totalPnL * 100).toFixed(1).padStart(6)}% ` +
      `AgentExits=${metrics.agentExits} ` +
      `Eps=${agent.epsilon.toFixed(3)}`
    );

    // Validation
    if (episode % CONFIG.training.validationFreq === 0) {
      const { trades: valTrades } = runEpisode(
        agent, valCandles, valSignals, featureReducer, false
      );

      const valMetrics = evaluateTrades(valTrades);

      console.log('');
      console.log(`[VAL] Trades=${valMetrics.trades} WR=${(valMetrics.winRate * 100).toFixed(1)}% ` +
                  `PnL=${(valMetrics.totalPnL * 100).toFixed(2)}% Sharpe=${valMetrics.sharpe.toFixed(2)}`);
      console.log(`      Agent exits: ${valMetrics.agentExits} | SL: ${valMetrics.stopLosses} | ` +
                  `TP: ${valMetrics.takeProfits} | MaxHold: ${valMetrics.maxHolds}`);

      if (valMetrics.sharpe > bestValSharpe && valMetrics.trades >= 5) {
        bestValSharpe = valMetrics.sharpe;
        bestEpisode = episode;
        bestWeights = agent.exportWeights();
        noImprovementCount = 0;

        // Save model
        const modelPath = `models/exit_agent_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
        const modelData = {
          type: 'exit_agent',
          timestamp: new Date().toISOString(),
          episode,
          config: CONFIG,
          agentConfig,
          featureReducerModel: featureReducer.exportModel(),
          validation: valMetrics,
          weights: bestWeights,
        };

        fs.mkdirSync('models', { recursive: true });
        fs.writeFileSync(modelPath, JSON.stringify(modelData, null, 2));
        console.log(`✓ New best model saved: ${modelPath}`);
        console.log(`  Sharpe: ${valMetrics.sharpe.toFixed(2)}, PnL: ${(valMetrics.totalPnL * 100).toFixed(2)}%`);
      } else {
        noImprovementCount++;
      }

      console.log('');

      // Early stopping
      if (noImprovementCount >= CONFIG.training.earlyStoppingPatience / CONFIG.training.validationFreq) {
        console.log(`Early stopping: No improvement for ${noImprovementCount * CONFIG.training.validationFreq} episodes`);
        break;
      }
    }
  }

  // Final evaluation
  console.log('\n============================================================');
  console.log('FINAL EVALUATION');
  console.log('============================================================\n');

  // Load best weights
  if (bestWeights) {
    agent.importWeights(bestWeights);
  }

  const { trades: finalTrades } = runEpisode(
    agent, valCandles, valSignals, featureReducer, false
  );

  const finalMetrics = evaluateTrades(finalTrades);

  console.log('Validation Results:');
  console.log(`  Trades: ${finalMetrics.trades}`);
  console.log(`  Win Rate: ${(finalMetrics.winRate * 100).toFixed(1)}%`);
  console.log(`  Total PnL: ${(finalMetrics.totalPnL * 100).toFixed(2)}%`);
  console.log(`  Sharpe Ratio: ${finalMetrics.sharpe.toFixed(2)}`);
  console.log(`  Avg Bars Held: ${finalMetrics.avgBarsHeld.toFixed(1)}`);
  console.log('');
  console.log('Exit Breakdown:');
  console.log(`  Agent Exits: ${finalMetrics.agentExits} (${(finalMetrics.agentExits / finalMetrics.trades * 100).toFixed(1)}%)`);
  console.log(`  Stop Losses: ${finalMetrics.stopLosses}`);
  console.log(`  Take Profits: ${finalMetrics.takeProfits}`);
  console.log(`  Max Hold: ${finalMetrics.maxHolds}`);
  console.log('');
  console.log('============================================================');
  console.log(`Best model at episode ${bestEpisode} with Sharpe ${bestValSharpe.toFixed(2)}`);
  console.log('============================================================');
}

main().catch(console.error);
