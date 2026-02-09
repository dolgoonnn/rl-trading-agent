#!/usr/bin/env npx tsx
/**
 * Minimal Feature Training
 *
 * Hypothesis: 104 features with 3456 training samples causes overfitting.
 * Solution: Use only ~15 essential features:
 * - Recent returns (5 values)
 * - Volatility, ATR, RSI, MACD (4 values)
 * - Price position (2 values)
 * - Position state (4 values)
 *
 * This gives ~15 features vs 104, much better sample-to-feature ratio.
 */

import fs from 'fs';
import path from 'path';
import * as tf from '@tensorflow/tfjs';
import type { Candle } from '@/types';
import { ReplayBuffer } from '../src/lib/rl/agent/replay-buffer';

// ============================================
// Configuration
// ============================================

const SYMBOL = 'BTCUSDT';
const INITIAL_CAPITAL = 10000;
const POSITION_SIZE = 0.1;
const COMMISSION = 0.0004; // 0.04% (Binance maker fee with BNB discount)
const SPREAD = 0.0001; // Tighter spread for BTC

// Minimal feature count
const LOOKBACK = 5; // Only 5 recent returns
const FEATURE_COUNT = 15; // Very small feature set

// Training config
const EPISODES = 500;
const EPISODE_LENGTH = 500;
const GAMMA = 0.95;
const LR = 0.001;
const EPSILON_START = 1.0;
const EPSILON_END = 0.1;
const EPSILON_DECAY = 0.995;
const BATCH_SIZE = 32;
const BUFFER_SIZE = 10000;
const TARGET_UPDATE = 200;

// ============================================
// Minimal Feature Extraction
// ============================================

function extractMinimalFeatures(
  candles: Candle[],
  positionDir: number, // -1, 0, 1
  positionPnL: number,
  holdingPeriod: number
): number[] {
  if (candles.length < 30) return new Array(FEATURE_COUNT).fill(0);

  const closes = candles.slice(-30).map(c => c.close);
  const highs = candles.slice(-30).map(c => c.high);
  const lows = candles.slice(-30).map(c => c.low);

  const features: number[] = [];

  // 1. Recent returns (5 values)
  for (let i = 1; i <= LOOKBACK; i++) {
    const ret = (closes[closes.length - i]! - closes[closes.length - i - 1]!) / closes[closes.length - i - 1]!;
    features.push(Math.max(-0.1, Math.min(0.1, ret)) * 10); // Normalize to [-1, 1]
  }

  // 2. Volatility (1 value)
  const returns = closes.slice(1).map((c, i) => (c - closes[i]!) / closes[i]!);
  const avgRet = returns.reduce((a, b) => a + b, 0) / returns.length;
  const vol = Math.sqrt(returns.reduce((a, r) => a + Math.pow(r - avgRet, 2), 0) / returns.length);
  features.push(Math.min(1, vol * 50)); // Normalize volatility

  // 3. ATR as % of price (1 value)
  let atr = 0;
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i]! - lows[i]!,
      Math.abs(highs[i]! - closes[i - 1]!),
      Math.abs(lows[i]! - closes[i - 1]!)
    );
    atr += tr;
  }
  atr /= (closes.length - 1);
  features.push(Math.min(1, (atr / closes[closes.length - 1]!) * 100));

  // 4. RSI (1 value)
  let gains = 0, losses = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    if (change > 0) gains += change;
    else losses -= change;
  }
  const rs = losses > 0 ? gains / losses : 100;
  const rsi = 100 - (100 / (1 + rs));
  features.push((rsi - 50) / 50); // Normalize to [-1, 1]

  // 5. MACD signal (1 value)
  const ema12 = closes.slice(-12).reduce((a, b, i) => {
    const mult = 2 / (12 + 1);
    return i === 0 ? b : b * mult + a * (1 - mult);
  }, closes[closes.length - 12]!);
  const ema26 = closes.slice(-26).reduce((a, b, i) => {
    const mult = 2 / (26 + 1);
    return i === 0 ? b : b * mult + a * (1 - mult);
  }, closes[closes.length - 26]!);
  const macd = (ema12 - ema26) / closes[closes.length - 1]!;
  features.push(Math.max(-1, Math.min(1, macd * 100)));

  // 6. Price position in range (2 values)
  const recentHigh = Math.max(...highs.slice(-20));
  const recentLow = Math.min(...lows.slice(-20));
  const range = recentHigh - recentLow;
  const currentPrice = closes[closes.length - 1]!;
  features.push(range > 0 ? (currentPrice - recentLow) / range : 0.5); // 0-1
  features.push(range > 0 ? (recentHigh - currentPrice) / range : 0.5); // 0-1

  // 7. Position features (4 values)
  features.push(positionDir); // -1, 0, 1
  features.push(Math.max(-1, Math.min(1, positionPnL / 100))); // Normalize PnL
  features.push(Math.min(1, holdingPeriod / 50)); // Normalize holding period
  features.push(positionDir !== 0 ? 1 : 0); // Has position flag

  return features;
}

// ============================================
// Simple DQN Network
// ============================================

function createNetwork(inputSize: number): tf.Sequential {
  const model = tf.sequential();

  model.add(tf.layers.dense({
    inputShape: [inputSize],
    units: 32,
    activation: 'relu',
    kernelRegularizer: tf.regularizers.l2({ l2: 0.01 }),
  }));

  model.add(tf.layers.dropout({ rate: 0.3 }));

  model.add(tf.layers.dense({
    units: 16,
    activation: 'relu',
    kernelRegularizer: tf.regularizers.l2({ l2: 0.01 }),
  }));

  model.add(tf.layers.dense({
    units: 4, // HOLD, BUY, SELL, CLOSE
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
  trades: Array<{ pnl: number }>;
  holdingPeriod: number;
}

function envReset(candles: Candle[]): EnvState {
  return {
    candles,
    step: 30, // Start after warmup
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
  info: { pnl: number; trade?: { pnl: number } };
} {
  const candle = state.candles[state.step]!;
  const price = candle.close;
  let reward = 0;
  let tradeClosed: { pnl: number } | undefined;

  const newState = { ...state, step: state.step + 1, holdingPeriod: state.holdingPeriod + 1 };

  // Force close after max holding period (prevent eternal holds)
  const MAX_HOLDING = 20;
  if (state.position && state.holdingPeriod >= MAX_HOLDING) {
    action = 3; // Force close
  }

  // Action: 0=HOLD, 1=BUY, 2=SELL, 3=CLOSE
  if (action === 1 && !state.position) {
    // BUY
    const cost = price * (1 + SPREAD + COMMISSION);
    const size = (POSITION_SIZE * state.capital) / cost;
    newState.position = { dir: 1, entryPrice: cost, size };
    newState.holdingPeriod = 0;
  } else if (action === 2 && !state.position) {
    // SELL (short)
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
    newState.trades = [...state.trades, { pnl }];
    newState.position = null;
    newState.holdingPeriod = 0;

    // Reward: tanh of PnL percentage
    const pnlPct = pnl / INITIAL_CAPITAL;
    reward = Math.tanh(pnlPct * 50);
    tradeClosed = { pnl };
  }

  // CRITICAL: Add opportunity cost for not having a position
  // This encourages the model to always be trading
  if (!newState.position && state.holdingPeriod > 5) {
    // Small penalty for staying out too long
    reward -= 0.01;
  }

  // Reward small positive movement in our direction while in position
  if (newState.position && state.position) {
    const priceChange = (price - state.candles[state.step - 1]?.close!) / state.candles[state.step - 1]?.close!;
    const signedReturn = newState.position.dir * priceChange;
    reward += signedReturn * 0.5; // Small dense signal for being on the right side
  }

  // Update unrealized PnL
  let unrealizedPnL = 0;
  if (newState.position) {
    const currentPrice = state.candles[newState.step]?.close ?? price;
    unrealizedPnL = newState.position.dir === 1
      ? (currentPrice - newState.position.entryPrice) * newState.position.size
      : (newState.position.entryPrice - currentPrice) * newState.position.size;
  }

  const done = newState.step >= state.candles.length - 1;

  return {
    nextState: newState,
    reward,
    done,
    info: { pnl: unrealizedPnL, trade: tradeClosed },
  };
}

function getStateFeatures(state: EnvState): number[] {
  let positionPnL = 0;
  let positionDir = 0;

  if (state.position) {
    positionDir = state.position.dir;
    const currentPrice = state.candles[state.step]?.close ?? 0;
    positionPnL = state.position.dir === 1
      ? (currentPrice - state.position.entryPrice) * state.position.size
      : (state.position.entryPrice - currentPrice) * state.position.size;
  }

  return extractMinimalFeatures(
    state.candles.slice(0, state.step + 1),
    positionDir,
    positionPnL,
    state.holdingPeriod
  );
}

// ============================================
// Training Loop
// ============================================

async function train() {
  console.log('============================================================');
  console.log('Minimal Feature DQN Training');
  console.log('============================================================\n');

  // Load data
  const filePath = path.join('data', `${SYMBOL}_1h.json`);
  const allCandles = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Candle[];
  console.log(`Loaded ${allCandles.length} candles`);

  // Use recent 6 months for regime consistency
  const recentCandles = allCandles.slice(-6 * 30 * 24);
  const splitIdx = Math.floor(recentCandles.length * 0.8);
  const trainCandles = recentCandles.slice(0, splitIdx);
  const valCandles = recentCandles.slice(splitIdx);

  console.log(`Train: ${trainCandles.length}, Val: ${valCandles.length}`);
  console.log(`Features: ${FEATURE_COUNT} (minimal set)\n`);

  // Create networks
  const qNetwork = createNetwork(FEATURE_COUNT);
  const targetNetwork = createNetwork(FEATURE_COUNT);

  // Copy weights to target
  const weights = qNetwork.getWeights();
  targetNetwork.setWeights(weights);

  // Replay buffer
  const buffer = new ReplayBuffer({ capacity: BUFFER_SIZE, minExperience: BATCH_SIZE });

  let epsilon = EPSILON_START;
  let totalSteps = 0;
  let bestValSharpe = -Infinity;

  for (let episode = 1; episode <= EPISODES; episode++) {
    // Random start position in training data
    const startIdx = Math.floor(Math.random() * (trainCandles.length - EPISODE_LENGTH - 50));
    const episodeCandles = trainCandles.slice(startIdx, startIdx + EPISODE_LENGTH + 50);

    let state = envReset(episodeCandles);
    let episodeReward = 0;
    let episodeTrades = 0;

    for (let step = 0; step < EPISODE_LENGTH && !envStep(state, 0).done; step++) {
      const features = getStateFeatures(state);

      // Epsilon-greedy action selection with action masking
      let action: number;

      // Determine valid actions
      const hasPosition = state.position !== null;
      const validActions = hasPosition
        ? [0, 3] // HOLD or CLOSE when in position
        : [1, 2]; // BUY or SELL when no position (force trading!)

      if (Math.random() < epsilon) {
        // Random from valid actions only
        action = validActions[Math.floor(Math.random() * validActions.length)]!;
      } else {
        const qValues = qNetwork.predict(tf.tensor2d([features])) as tf.Tensor;
        const qData = qValues.dataSync() as Float32Array;
        qValues.dispose();

        // Find best action among valid ones
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

      // Store transition
      buffer.store(features, action, reward, nextFeatures, done);

      episodeReward += reward;
      if (action === 3 && state.position) episodeTrades++;

      state = nextState;
      totalSteps++;

      // Train every 4 steps
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
            : batch[i]!.reward + GAMMA * GAMMA * GAMMA * Math.max(...nextQsData[i]!);
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

      // Update target network
      if (totalSteps % TARGET_UPDATE === 0) {
        targetNetwork.setWeights(qNetwork.getWeights());
      }
    }

    // Epsilon decay
    epsilon = Math.max(EPSILON_END, epsilon * EPSILON_DECAY);

    // Logging
    if (episode % 10 === 0) {
      const winRate = state.trades.filter(t => t.pnl > 0).length / Math.max(1, state.trades.length);
      const totalPnL = state.trades.reduce((a, t) => a + t.pnl, 0);
      console.log(`Episode ${episode}: Reward=${episodeReward.toFixed(2)}, Trades=${state.trades.length}, WinRate=${(winRate * 100).toFixed(1)}%, PnL=${totalPnL.toFixed(0)}, Epsilon=${epsilon.toFixed(3)}`);
    }

    // Validation
    if (episode % 20 === 0) {
      let valState = envReset(valCandles);

      while (valState.step < valCandles.length - 1) {
        const features = getStateFeatures(valState);

        // Action masking in validation too
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

      // Calculate Sharpe
      const returns = valState.trades.map(t => t.pnl / INITIAL_CAPITAL);
      const avgRet = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
      const stdRet = returns.length > 1
        ? Math.sqrt(returns.reduce((a, r) => a + Math.pow(r - avgRet, 2), 0) / returns.length)
        : 1;
      const sharpe = stdRet > 0 ? (avgRet / stdRet) * Math.sqrt(252 * 24) : 0;

      console.log(`[VAL] Trades=${valState.trades.length}, WinRate=${(valWinRate * 100).toFixed(1)}%, PnL=${valPnL.toFixed(0)}, Sharpe=${sharpe.toFixed(2)}`);

      if (sharpe > bestValSharpe) {
        bestValSharpe = sharpe;
        console.log(`  *** New best validation Sharpe: ${sharpe.toFixed(2)} ***`);

        // Save best model
        const weights = qNetwork.getWeights().map(w => w.arraySync());
        const modelData = {
          sharpe,
          winRate: valWinRate,
          pnl: valPnL,
          trades: valState.trades.length,
          episode,
          weights,
        };
        fs.writeFileSync('models/best_minimal_model.json', JSON.stringify(modelData));
        console.log(`  Model saved to models/best_minimal_model.json`);
      }

      // Early stopping if we've achieved good Sharpe
      if (bestValSharpe >= 0.5) {
        console.log(`\n*** Target Sharpe 0.5 achieved! Stopping early. ***`);
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
