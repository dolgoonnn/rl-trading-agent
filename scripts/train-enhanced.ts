#!/usr/bin/env npx tsx
/**
 * Enhanced Minimal Training
 *
 * Builds on train-minimal.ts success (0.15 Sharpe) with:
 * 1. Better features - momentum, volume, higher timeframe
 * 2. Dynamic exits - learn when to close instead of fixed 20 bars
 * 3. More validation data
 */

import fs from 'fs';
import path from 'path';
import * as tf from '@tensorflow/tfjs';
import type { Candle } from '@/types';
import { ReplayBuffer } from '../src/lib/rl/agent/replay-buffer';

// Configuration
const SYMBOL = 'BTCUSDT';
const INITIAL_CAPITAL = 10000;
const POSITION_SIZE = 0.1;
const COMMISSION = 0.0004;
const SPREAD = 0.0001;

// Enhanced features
const FEATURE_COUNT = 25; // More features but still manageable

// Training config
const EPISODES = 400;
const EPISODE_LENGTH = 500;
const GAMMA = 0.95;
const LR = 0.0005;
const EPSILON_START = 1.0;
const EPSILON_END = 0.05;
const EPSILON_DECAY = 0.997;
const BATCH_SIZE = 64;
const BUFFER_SIZE = 20000;
const TARGET_UPDATE = 500;

// ============================================
// Enhanced Feature Extraction
// ============================================

function extractEnhancedFeatures(
  candles: Candle[],
  positionDir: number,
  positionPnL: number,
  holdingPeriod: number,
  entryPrice: number
): number[] {
  if (candles.length < 50) return new Array(FEATURE_COUNT).fill(0);

  const closes = candles.slice(-50).map(c => c.close);
  const highs = candles.slice(-50).map(c => c.high);
  const lows = candles.slice(-50).map(c => c.low);
  const volumes = candles.slice(-50).map(c => c.volume);
  const currentPrice = closes[closes.length - 1]!;

  const features: number[] = [];

  // 1. Multi-timeframe returns (6 values)
  const periods = [1, 3, 5, 10, 20, 50];
  for (const p of periods) {
    const ret = (closes[closes.length - 1]! - closes[closes.length - 1 - p]!) / closes[closes.length - 1 - p]!;
    features.push(Math.max(-0.2, Math.min(0.2, ret)) * 5);
  }

  // 2. Volatility metrics (3 values)
  const returns = closes.slice(1).map((c, i) => (c - closes[i]!) / closes[i]!);
  const vol5 = Math.sqrt(returns.slice(-5).reduce((a, r) => a + r * r, 0) / 5);
  const vol20 = Math.sqrt(returns.slice(-20).reduce((a, r) => a + r * r, 0) / 20);
  const volRatio = vol20 > 0 ? vol5 / vol20 : 1;
  features.push(Math.min(1, vol5 * 30));
  features.push(Math.min(1, vol20 * 30));
  features.push(Math.min(2, volRatio) - 1);

  // 3. RSI (1 value)
  let gains = 0, losses = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    if (change > 0) gains += change;
    else losses -= change;
  }
  const rs = losses > 0 ? gains / losses : 100;
  const rsi = 100 - (100 / (1 + rs));
  features.push((rsi - 50) / 50);

  // 4. MACD (2 values)
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  const macd = (ema12 - ema26) / currentPrice;
  const signal = (calculateEMA(closes.slice(-9), 9) - ema26) / currentPrice;
  features.push(Math.max(-1, Math.min(1, macd * 100)));
  features.push(Math.max(-1, Math.min(1, (macd - signal) * 100)));

  // 5. Price position (3 values)
  const high20 = Math.max(...highs.slice(-20));
  const low20 = Math.min(...lows.slice(-20));
  const range20 = high20 - low20;
  features.push(range20 > 0 ? (currentPrice - low20) / range20 : 0.5);
  features.push(range20 > 0 ? (high20 - currentPrice) / range20 : 0.5);

  const high50 = Math.max(...highs);
  const low50 = Math.min(...lows);
  const range50 = high50 - low50;
  features.push(range50 > 0 ? (currentPrice - low50) / range50 : 0.5);

  // 6. Volume features (2 values)
  const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const recentVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  features.push(Math.min(3, recentVol / avgVol) - 1);
  features.push(Math.min(1, Math.abs(volumes[volumes.length - 1]! - avgVol) / avgVol));

  // 7. Trend strength (2 values)
  const ema10 = calculateEMA(closes, 10);
  const ema30 = calculateEMA(closes.slice(-30), 30);
  features.push(Math.max(-1, Math.min(1, (ema10 - ema30) / currentPrice * 50)));

  // Higher highs/lower lows
  const recentHighs = highs.slice(-10);
  const recentLows = lows.slice(-10);
  const hhCount = recentHighs.filter((h, i) => i > 0 && h > recentHighs[i - 1]!).length / 9;
  const llCount = recentLows.filter((l, i) => i > 0 && l < recentLows[i - 1]!).length / 9;
  features.push(hhCount - llCount);

  // 8. Position features (6 values)
  features.push(positionDir);
  features.push(Math.max(-1, Math.min(1, positionPnL / 100)));
  features.push(Math.min(1, holdingPeriod / 30));
  features.push(positionDir !== 0 ? 1 : 0);

  // Distance from entry
  if (entryPrice > 0 && positionDir !== 0) {
    const distFromEntry = (currentPrice - entryPrice) / entryPrice * positionDir;
    features.push(Math.max(-1, Math.min(1, distFromEntry * 20)));
  } else {
    features.push(0);
  }

  // Unrealized P&L trend (is it improving or worsening?)
  features.push(positionDir !== 0 && holdingPeriod > 1 ? Math.sign(positionPnL) : 0);

  return features;
}

function calculateEMA(values: number[], period: number): number {
  const mult = 2 / (period + 1);
  let ema = values[0]!;
  for (let i = 1; i < values.length; i++) {
    ema = values[i]! * mult + ema * (1 - mult);
  }
  return ema;
}

// ============================================
// Network with Dueling Architecture
// ============================================

function createNetwork(inputSize: number): tf.Sequential {
  // Simple but effective network
  const model = tf.sequential();

  model.add(tf.layers.dense({
    inputShape: [inputSize],
    units: 64,
    activation: 'relu',
    kernelRegularizer: tf.regularizers.l2({ l2: 0.01 }),
  }));

  model.add(tf.layers.dropout({ rate: 0.2 }));

  model.add(tf.layers.dense({
    units: 32,
    activation: 'relu',
    kernelRegularizer: tf.regularizers.l2({ l2: 0.01 }),
  }));

  model.add(tf.layers.dropout({ rate: 0.1 }));

  model.add(tf.layers.dense({
    units: 4,
    activation: 'linear',
  }));

  model.compile({
    optimizer: tf.train.adam(LR),
    loss: 'meanSquaredError',
  });

  return model;
}

// ============================================
// Trading Environment
// ============================================

interface EnvState {
  candles: Candle[];
  step: number;
  position: { dir: number; entryPrice: number; size: number } | null;
  capital: number;
  trades: Array<{ pnl: number; holdTime: number }>;
  holdingPeriod: number;
}

function envReset(candles: Candle[]): EnvState {
  return {
    candles,
    step: 50,
    position: null,
    capital: INITIAL_CAPITAL,
    trades: [],
    holdingPeriod: 0,
  };
}

function envStep(state: EnvState, action: number): {
  nextState: EnvState;
  reward: number;
  done: boolean;
} {
  const candle = state.candles[state.step]!;
  const price = candle.close;
  let reward = 0;

  const newState: EnvState = {
    ...state,
    step: state.step + 1,
    holdingPeriod: state.holdingPeriod + 1,
    trades: [...state.trades],
  };

  // Max holding period for forced exit
  const MAX_HOLDING = 30;
  if (state.position && state.holdingPeriod >= MAX_HOLDING) {
    action = 3;
  }

  if (action === 1 && !state.position) {
    // BUY
    const cost = price * (1 + SPREAD + COMMISSION);
    const size = (POSITION_SIZE * state.capital) / cost;
    newState.position = { dir: 1, entryPrice: cost, size };
    newState.holdingPeriod = 0;
  } else if (action === 2 && !state.position) {
    // SELL
    const cost = price * (1 - SPREAD + COMMISSION);
    const size = (POSITION_SIZE * state.capital) / price;
    newState.position = { dir: -1, entryPrice: cost, size };
    newState.holdingPeriod = 0;
  } else if (action === 3 && state.position) {
    // CLOSE
    const exitPrice = state.position.dir === 1
      ? price * (1 - SPREAD - COMMISSION)
      : price * (1 + SPREAD + COMMISSION);

    const pnl = state.position.dir === 1
      ? (exitPrice - state.position.entryPrice) * state.position.size
      : (state.position.entryPrice - exitPrice) * state.position.size;

    newState.capital = state.capital + pnl;
    newState.trades.push({ pnl, holdTime: state.holdingPeriod });
    newState.position = null;
    newState.holdingPeriod = 0;

    // Main reward: tanh of PnL percentage
    const pnlPct = pnl / INITIAL_CAPITAL;
    reward = Math.tanh(pnlPct * 30);

    // Bonus for quick profitable exits
    if (pnl > 0 && state.holdingPeriod < 10) {
      reward += 0.1;
    }
    // Penalty for slow losing exits
    if (pnl < 0 && state.holdingPeriod > 20) {
      reward -= 0.1;
    }
  }

  // Small penalty for not having position (opportunity cost)
  if (!newState.position && state.holdingPeriod > 10) {
    reward -= 0.005;
  }

  // Small reward for being in profit while holding
  if (newState.position && state.position) {
    const unrealized = newState.position.dir === 1
      ? (price - newState.position.entryPrice) * newState.position.size
      : (newState.position.entryPrice - price) * newState.position.size;
    if (unrealized > 0) {
      reward += 0.01;
    }
  }

  const done = newState.step >= state.candles.length - 1;

  return { nextState: newState, reward, done };
}

function getStateFeatures(state: EnvState): number[] {
  return extractEnhancedFeatures(
    state.candles.slice(0, state.step + 1),
    state.position?.dir ?? 0,
    state.position ? (state.candles[state.step]!.close - state.position.entryPrice) * state.position.size * state.position.dir : 0,
    state.holdingPeriod,
    state.position?.entryPrice ?? 0
  );
}

// ============================================
// Training Loop
// ============================================

async function train() {
  console.log('============================================================');
  console.log('Enhanced Minimal DQN Training');
  console.log('============================================================\n');

  // Load data - use more data for better validation
  const filePath = path.join('data', `${SYMBOL}_1h.json`);
  const allCandles = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Candle[];
  console.log(`Loaded ${allCandles.length} candles`);

  // Use recent 9 months for regime consistency
  const recentCandles = allCandles.slice(-9 * 30 * 24);
  const splitIdx = Math.floor(recentCandles.length * 0.8);
  const trainCandles = recentCandles.slice(0, splitIdx);
  const valCandles = recentCandles.slice(splitIdx);

  console.log(`Train: ${trainCandles.length}, Val: ${valCandles.length}`);
  console.log(`Features: ${FEATURE_COUNT} (enhanced set)\n`);

  // Create networks
  const qNetwork = createNetwork(FEATURE_COUNT);
  const targetNetwork = createNetwork(FEATURE_COUNT);
  targetNetwork.setWeights(qNetwork.getWeights());

  const buffer = new ReplayBuffer({ capacity: BUFFER_SIZE, minExperience: BATCH_SIZE });

  let epsilon = EPSILON_START;
  let totalSteps = 0;
  let bestValSharpe = -Infinity;

  for (let episode = 1; episode <= EPISODES; episode++) {
    const startIdx = Math.floor(Math.random() * (trainCandles.length - EPISODE_LENGTH - 60));
    const episodeCandles = trainCandles.slice(startIdx, startIdx + EPISODE_LENGTH + 60);

    let state = envReset(episodeCandles);
    let episodeReward = 0;

    for (let step = 0; step < EPISODE_LENGTH && !envStep(state, 0).done; step++) {
      const features = getStateFeatures(state);

      // Action masking
      const hasPosition = state.position !== null;
      const validActions = hasPosition ? [0, 3] : [1, 2];

      let action: number;
      if (Math.random() < epsilon) {
        action = validActions[Math.floor(Math.random() * validActions.length)]!;
      } else {
        const qValues = qNetwork.predict(tf.tensor2d([features])) as tf.Tensor;
        const qData = qValues.dataSync() as Float32Array;
        qValues.dispose();

        let bestAction = validActions[0]!;
        let bestQ = qData[bestAction]!;
        for (const a of validActions) {
          if (qData[a]! > bestQ) {
            bestQ = qData[a]!;
            bestAction = a;
          }
        }
        action = bestAction;
      }

      const { nextState, reward, done } = envStep(state, action);
      const nextFeatures = getStateFeatures(nextState);

      buffer.store(features, action, reward, nextFeatures, done);

      episodeReward += reward;
      state = nextState;
      totalSteps++;

      // Train
      if (totalSteps % 4 === 0 && buffer.getSize() >= BATCH_SIZE) {
        const batch = buffer.sample(BATCH_SIZE);

        const states = tf.tensor2d(batch.map(t => t.state));
        const nextStates = tf.tensor2d(batch.map(t => t.nextState));

        const currentQs = qNetwork.predict(states) as tf.Tensor2D;
        const nextQs = targetNetwork.predict(nextStates) as tf.Tensor2D;

        const currentQsData = currentQs.arraySync() as number[][];
        const nextQsData = nextQs.arraySync() as number[][];

        for (let i = 0; i < batch.length; i++) {
          const target = batch[i]!.done
            ? batch[i]!.reward
            : batch[i]!.reward + GAMMA * Math.max(...nextQsData[i]!);
          currentQsData[i]![batch[i]!.action] = target;
        }

        const targetTensor = tf.tensor2d(currentQsData);
        await qNetwork.fit(states, targetTensor, { epochs: 1, verbose: 0 });

        states.dispose();
        nextStates.dispose();
        currentQs.dispose();
        nextQs.dispose();
        targetTensor.dispose();
      }

      if (totalSteps % TARGET_UPDATE === 0) {
        targetNetwork.setWeights(qNetwork.getWeights());
      }
    }

    epsilon = Math.max(EPSILON_END, epsilon * EPSILON_DECAY);

    // Logging
    if (episode % 10 === 0) {
      const winRate = state.trades.filter(t => t.pnl > 0).length / Math.max(1, state.trades.length);
      const totalPnL = state.trades.reduce((a, t) => a + t.pnl, 0);
      console.log(`Episode ${episode}: Reward=${episodeReward.toFixed(2)}, Trades=${state.trades.length}, WinRate=${(winRate * 100).toFixed(1)}%, PnL=${totalPnL.toFixed(0)}, Eps=${epsilon.toFixed(3)}`);
    }

    // Validation
    if (episode % 20 === 0) {
      let valState = envReset(valCandles);

      while (valState.step < valCandles.length - 1) {
        const features = getStateFeatures(valState);
        const hasPosition = valState.position !== null;
        const validActions = hasPosition ? [0, 3] : [1, 2];

        const qValues = qNetwork.predict(tf.tensor2d([features])) as tf.Tensor;
        const qData = qValues.dataSync() as Float32Array;
        qValues.dispose();

        let bestAction = validActions[0]!;
        let bestQ = qData[bestAction]!;
        for (const a of validActions) {
          if (qData[a]! > bestQ) {
            bestQ = qData[a]!;
            bestAction = a;
          }
        }

        const result = envStep(valState, bestAction);
        valState = result.nextState;
      }

      const valPnL = valState.trades.reduce((a, t) => a + t.pnl, 0);
      const valWinRate = valState.trades.filter(t => t.pnl > 0).length / Math.max(1, valState.trades.length);

      const returns = valState.trades.map(t => t.pnl / INITIAL_CAPITAL);
      const avgRet = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
      const stdRet = returns.length > 1
        ? Math.sqrt(returns.reduce((a, r) => a + Math.pow(r - avgRet, 2), 0) / returns.length)
        : 1;
      const sharpe = stdRet > 0 ? (avgRet / stdRet) * Math.sqrt(252) : 0;

      console.log(`[VAL] Trades=${valState.trades.length}, WinRate=${(valWinRate * 100).toFixed(1)}%, PnL=${valPnL.toFixed(0)}, Sharpe=${sharpe.toFixed(2)}`);

      if (sharpe > bestValSharpe) {
        bestValSharpe = sharpe;
        console.log(`  *** New best validation Sharpe: ${sharpe.toFixed(2)} ***`);

        const weights = qNetwork.getWeights().map(w => w.arraySync());
        fs.writeFileSync('models/best_enhanced_model.json', JSON.stringify({
          sharpe, winRate: valWinRate, pnl: valPnL, trades: valState.trades.length, episode, weights
        }));
      }

      if (bestValSharpe >= 0.5) {
        console.log(`\n*** Target Sharpe 0.5 achieved! ***`);
        break;
      }
    }
  }

  console.log('\n============================================================');
  console.log('TRAINING COMPLETE');
  console.log(`Best Validation Sharpe: ${bestValSharpe.toFixed(2)}`);
  console.log('============================================================');
}

train().catch(console.error);
