#!/usr/bin/env npx tsx
/**
 * Paper Trade Exit Agent
 *
 * Tests the rule-based entry + RL exit strategy on live/recent data.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';
import { ExitAgent, type ExitAgentConfig } from '../src/lib/rl/agent/exit-agent';
import { FeatureReducer } from '../src/lib/rl/environment/feature-reducer';

// ============================================
// Parse args
// ============================================

const args = process.argv.slice(2);
const modelPath = args.find((a, i) => args[i - 1] === '--model') || 'models/exit_agent_2026-02-02T10-35-25.json';
const backtest = parseInt(args.find((a, i) => args[i - 1] === '--backtest') || '0');

// ============================================
// Technical Indicators (same as training)
// ============================================

function calculateEMA(prices: number[], period: number): number[] {
  const ema: number[] = [];
  const multiplier = 2 / (period + 1);

  let sum = 0;
  for (let i = 0; i < period && i < prices.length; i++) {
    sum += prices[i]!;
  }
  ema[period - 1] = sum / period;

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
// Entry Signal Detection
// ============================================

interface EntryConfig {
  fastEMA: number;
  slowEMA: number;
  rsiPeriod: number;
  rsiLongThreshold: number;
  rsiShortThreshold: number;
}

function checkEntrySignal(
  candles: Candle[],
  config: EntryConfig
): { direction: 'long' | 'short'; reason: string } | null {
  if (candles.length < config.slowEMA + 2) return null;

  const closes = candles.map(c => c.close);
  const fastEMA = calculateEMA(closes, config.fastEMA);
  const slowEMA = calculateEMA(closes, config.slowEMA);
  const rsi = calculateRSI(closes, config.rsiPeriod);

  const lastIdx = closes.length - 1;
  const prevIdx = lastIdx - 1;

  const currFastEMA = fastEMA[lastIdx];
  const currSlowEMA = slowEMA[lastIdx];
  const prevFastEMA = fastEMA[prevIdx];
  const prevSlowEMA = slowEMA[prevIdx];
  const currRSI = rsi[lastIdx];

  if (currFastEMA === undefined || currSlowEMA === undefined ||
      prevFastEMA === undefined || prevSlowEMA === undefined ||
      currRSI === undefined) return null;

  // EMA crossover signals
  if (prevFastEMA <= prevSlowEMA && currFastEMA > currSlowEMA && currRSI < config.rsiLongThreshold) {
    return { direction: 'long', reason: 'EMA Cross Up' };
  }

  if (prevFastEMA >= prevSlowEMA && currFastEMA < currSlowEMA && currRSI > config.rsiShortThreshold) {
    return { direction: 'short', reason: 'EMA Cross Down' };
  }

  // RSI extreme signals
  if (currRSI < 25) {
    return { direction: 'long', reason: 'RSI Oversold' };
  }

  if (currRSI > 75) {
    return { direction: 'short', reason: 'RSI Overbought' };
  }

  return null;
}

// ============================================
// State Builder (same as training)
// ============================================

function buildExitState(
  candles: Candle[],
  entryPrice: number,
  direction: 'long' | 'short',
  entryBar: number,
  currentBar: number,
  maxProfit: number,
  maxDrawdown: number,
  config: { maxHoldBars: number; stopLossPct: number; takeProfitPct: number }
): number[] {
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
  features.push(Math.min(barsHeld / config.maxHoldBars, 1));
  features.push(unrealizedPnL * 10);
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

  const recentReturns = [];
  for (let i = 1; i < Math.min(10, closes.length); i++) {
    recentReturns.push((closes[closes.length - i]! - closes[closes.length - i - 1]!) / currentATR);
  }
  const volatility = recentReturns.length > 0
    ? Math.sqrt(recentReturns.reduce((a, b) => a + b * b, 0) / recentReturns.length)
    : 0;
  features.push(volatility);

  features.push((currentPrice - entryPrice) / currentATR);

  // 3. Technical indicators (5 features)
  const rsi = calculateRSI(closes, 14);
  const currentRSI = rsi[rsi.length - 1] ?? 50;
  features.push((currentRSI - 50) / 50);

  const fastEMA = calculateEMA(closes, 5);
  const slowEMA = calculateEMA(closes, 12);
  const emaSpread = (fastEMA[fastEMA.length - 1]! - slowEMA[slowEMA.length - 1]!) / currentATR;
  features.push(Math.tanh(emaSpread));

  const currentCandle = candles[currentBar]!;
  const bodySize = Math.abs(currentCandle.close - currentCandle.open) / currentATR;
  const upperWick = (currentCandle.high - Math.max(currentCandle.open, currentCandle.close)) / currentATR;
  const lowerWick = (Math.min(currentCandle.open, currentCandle.close) - currentCandle.low) / currentATR;
  features.push(Math.tanh(bodySize));
  features.push(Math.tanh(upperWick - lowerWick));

  // 4. Risk features (5 features)
  const stopPrice = direction === 'long'
    ? entryPrice * (1 - config.stopLossPct)
    : entryPrice * (1 + config.stopLossPct);
  const distToStop = direction === 'long'
    ? (currentPrice - stopPrice) / currentATR
    : (stopPrice - currentPrice) / currentATR;
  features.push(Math.tanh(distToStop));

  const tpPrice = direction === 'long'
    ? entryPrice * (1 + config.takeProfitPct)
    : entryPrice * (1 - config.takeProfitPct);
  const distToTP = direction === 'long'
    ? (tpPrice - currentPrice) / currentATR
    : (currentPrice - tpPrice) / currentATR;
  features.push(Math.tanh(distToTP));

  const profitGiveBack = maxProfit > 0 ? (maxProfit - unrealizedPnL) / maxProfit : 0;
  features.push(Math.min(profitGiveBack, 1));

  features.push(barsHeld / config.maxHoldBars);

  const trendAlignment = direction === 'long' ? Math.tanh(returns5) : Math.tanh(-returns5);
  features.push(trendAlignment);

  return features;
}

// ============================================
// Paper Trading Engine
// ============================================

interface Position {
  direction: 'long' | 'short';
  entryPrice: number;
  entryBar: number;
  entryReason: string;
  maxProfit: number;
  maxDrawdown: number;
}

interface Trade {
  direction: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  entryReason: string;
  exitReason: string;
  pnl: number;
  pnlPct: number;
  barsHeld: number;
}

async function main() {
  console.log('======================================================================');
  console.log('EXIT AGENT PAPER TRADING');
  console.log('======================================================================');
  console.log(`Model: ${path.basename(modelPath)}`);
  console.log(`Mode: ${backtest > 0 ? `BACKTEST (${backtest} bars)` : 'Analysis only'}`);
  console.log('----------------------------------------------------------------------');

  // Load model
  console.log('Loading model...');
  const modelData = JSON.parse(fs.readFileSync(modelPath, 'utf-8'));

  const config = modelData.config;
  const agentConfig = modelData.agentConfig as ExitAgentConfig;
  const entryConfig: EntryConfig = {
    fastEMA: config.entry.fastEMA,
    slowEMA: config.entry.slowEMA,
    rsiPeriod: config.entry.rsiPeriod,
    rsiLongThreshold: config.entry.rsiLongThreshold,
    rsiShortThreshold: config.entry.rsiShortThreshold,
  };
  const positionConfig = config.position;

  // Create agent
  const agent = new ExitAgent(agentConfig);
  if (modelData.weights) {
    agent.importWeights(modelData.weights);
    console.log('Model weights loaded.');
  }

  // Create feature reducer
  let featureReducer: FeatureReducer | null = null;
  if (modelData.featureReducerModel) {
    featureReducer = new FeatureReducer();
    featureReducer.importModel(modelData.featureReducerModel);
    console.log('Feature reducer loaded.');
  }

  // Load candles
  const dataPath = path.join(process.cwd(), 'data/BTCUSDT_1h.json');
  const allCandles = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as Candle[];
  console.log(`Loaded ${allCandles.length} candles.`);

  // Use last N bars for backtest
  const testStart = backtest > 0 ? allCandles.length - backtest - 100 : allCandles.length - 500;
  const testCandles = allCandles.slice(testStart);

  console.log(`\nRunning on ${backtest > 0 ? backtest : testCandles.length - 100} bars...`);
  console.log('----------------------------------------------------------------------');

  // Paper trading state
  let position: Position | null = null;
  const trades: Trade[] = [];
  let lastEntryBar = -10;
  const minBarsBetweenTrades = config.entry.minBarsBetweenTrades || 2;

  // Process each bar
  const startBar = 100; // Need lookback
  const endBar = backtest > 0 ? startBar + backtest : testCandles.length;

  for (let i = startBar; i < endBar; i++) {
    const candle = testCandles[i]!;
    const lookbackCandles = testCandles.slice(0, i + 1);
    const currentPrice = candle.close;

    // If in position, check for exits
    if (position) {
      const priceDiff = position.direction === 'long'
        ? currentPrice - position.entryPrice
        : position.entryPrice - currentPrice;
      const unrealizedPnL = priceDiff / position.entryPrice;

      // Update max profit/drawdown
      position.maxProfit = Math.max(position.maxProfit, unrealizedPnL);
      position.maxDrawdown = Math.min(position.maxDrawdown, unrealizedPnL);

      const barsHeld = i - position.entryBar;

      // Check forced exits
      let exitReason: string | null = null;

      if (unrealizedPnL <= -positionConfig.stopLossPct) {
        exitReason = 'Stop Loss';
      } else if (unrealizedPnL >= positionConfig.takeProfitPct) {
        exitReason = 'Take Profit';
      } else if (barsHeld >= positionConfig.maxHoldBars) {
        exitReason = 'Max Hold';
      }

      if (!exitReason) {
        // Ask agent for exit decision
        let state = buildExitState(
          lookbackCandles,
          position.entryPrice,
          position.direction,
          position.entryBar,
          i,
          position.maxProfit,
          position.maxDrawdown,
          positionConfig
        );

        if (featureReducer && featureReducer.isReady()) {
          state = featureReducer.transform(state);
        }

        const action = agent.selectAction(state, false);
        if (action === 1) {
          exitReason = 'Agent Exit';
        }
      }

      if (exitReason) {
        const trade: Trade = {
          direction: position.direction,
          entryPrice: position.entryPrice,
          exitPrice: currentPrice,
          entryReason: position.entryReason,
          exitReason,
          pnl: priceDiff,
          pnlPct: unrealizedPnL * 100,
          barsHeld,
        };
        trades.push(trade);

        console.log(
          `[${new Date(candle.timestamp).toISOString().slice(0, 16)}] ` +
          `EXIT ${position.direction.toUpperCase()} @ ${currentPrice.toFixed(2)} | ` +
          `${exitReason} | PnL: ${trade.pnlPct >= 0 ? '+' : ''}${trade.pnlPct.toFixed(2)}% | ` +
          `Held: ${barsHeld} bars`
        );

        position = null;
        lastEntryBar = i;
      }
    }

    // If not in position, check for entries
    if (!position && i - lastEntryBar >= minBarsBetweenTrades) {
      const signal = checkEntrySignal(lookbackCandles, entryConfig);
      if (signal) {
        position = {
          direction: signal.direction,
          entryPrice: currentPrice,
          entryBar: i,
          entryReason: signal.reason,
          maxProfit: 0,
          maxDrawdown: 0,
        };

        console.log(
          `[${new Date(candle.timestamp).toISOString().slice(0, 16)}] ` +
          `ENTRY ${signal.direction.toUpperCase()} @ ${currentPrice.toFixed(2)} | ${signal.reason}`
        );
      }
    }
  }

  // Close any remaining position
  if (position) {
    const lastCandle = testCandles[endBar - 1]!;
    const priceDiff = position.direction === 'long'
      ? lastCandle.close - position.entryPrice
      : position.entryPrice - lastCandle.close;

    trades.push({
      direction: position.direction,
      entryPrice: position.entryPrice,
      exitPrice: lastCandle.close,
      entryReason: position.entryReason,
      exitReason: 'End of Test',
      pnl: priceDiff,
      pnlPct: (priceDiff / position.entryPrice) * 100,
      barsHeld: endBar - 1 - position.entryBar,
    });

    console.log(
      `[End of Test] EXIT ${position.direction.toUpperCase()} @ ${lastCandle.close.toFixed(2)} | ` +
      `PnL: ${trades[trades.length - 1]!.pnlPct >= 0 ? '+' : ''}${trades[trades.length - 1]!.pnlPct.toFixed(2)}%`
    );
  }

  // Summary
  console.log('\n======================================================================');
  console.log('SUMMARY');
  console.log('======================================================================');

  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl <= 0).length;
  const totalPnLPct = trades.reduce((a, b) => a + b.pnlPct, 0);
  const avgPnLPct = trades.length > 0 ? totalPnLPct / trades.length : 0;
  const winRate = trades.length > 0 ? wins / trades.length : 0;

  console.log(`Total Trades: ${trades.length}`);
  console.log(`Win Rate: ${(winRate * 100).toFixed(1)}% (${wins}W / ${losses}L)`);
  console.log(`Total PnL: ${totalPnLPct >= 0 ? '+' : ''}${totalPnLPct.toFixed(2)}%`);
  console.log(`Avg PnL per Trade: ${avgPnLPct >= 0 ? '+' : ''}${avgPnLPct.toFixed(2)}%`);
  console.log(`Avg Bars Held: ${(trades.reduce((a, b) => a + b.barsHeld, 0) / trades.length).toFixed(1)}`);

  // Exit breakdown
  console.log('\nExit Breakdown:');
  const exitReasons: Record<string, number> = {};
  for (const trade of trades) {
    exitReasons[trade.exitReason] = (exitReasons[trade.exitReason] || 0) + 1;
  }
  for (const [reason, count] of Object.entries(exitReasons)) {
    console.log(`  ${reason}: ${count} (${((count / trades.length) * 100).toFixed(1)}%)`);
  }

  // Long vs Short
  const longs = trades.filter(t => t.direction === 'long');
  const shorts = trades.filter(t => t.direction === 'short');
  console.log('\nBy Direction:');
  console.log(`  Long:  ${longs.length} trades, WR=${((longs.filter(t => t.pnl > 0).length / longs.length) * 100 || 0).toFixed(1)}%, PnL=${longs.reduce((a, b) => a + b.pnlPct, 0).toFixed(2)}%`);
  console.log(`  Short: ${shorts.length} trades, WR=${((shorts.filter(t => t.pnl > 0).length / shorts.length) * 100 || 0).toFixed(1)}%, PnL=${shorts.reduce((a, b) => a + b.pnlPct, 0).toFixed(2)}%`);

  console.log('======================================================================');
}

main().catch(console.error);
