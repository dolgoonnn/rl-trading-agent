#!/usr/bin/env npx tsx
/**
 * Baseline Strategy Verification
 *
 * Tests simple trading strategies on the same data to verify
 * that profitable trading is actually possible.
 *
 * If baselines are unprofitable, the RL model can't be expected to do better.
 * If baselines ARE profitable, we know the data is tradeable.
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';

// Configuration
const SYMBOL = 'BTCUSDT';
const INITIAL_CAPITAL = 10000;
const DATA_DIR = 'data';

// Load candle data from JSON file
function loadSymbolData(symbol: string): Candle[] {
  const filePath = path.join(DATA_DIR, `${symbol}_1h.json`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Data file not found: ${filePath}`);
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Candle[];
}
const POSITION_SIZE = 0.1; // 10% of capital per trade
const COMMISSION = 0.001; // 0.1% per trade (Binance futures)

interface Trade {
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  direction: 'long' | 'short';
  pnl: number;
  pnlPercent: number;
}

interface StrategyResult {
  name: string;
  trades: Trade[];
  winRate: number;
  totalPnL: number;
  sharpeRatio: number;
  maxDrawdown: number;
  avgTradesPerDay: number;
}

// Simple Moving Average calculation
function sma(candles: Candle[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
    } else {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += candles[i - j].close;
      }
      result.push(sum / period);
    }
  }
  return result;
}

// Exponential Moving Average calculation
function ema(candles: Candle[], period: number): number[] {
  const result: number[] = [];
  const multiplier = 2 / (period + 1);

  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      result.push(candles[i].close);
    } else if (i < period) {
      // Use SMA for initial values
      let sum = 0;
      for (let j = 0; j <= i; j++) {
        sum += candles[j].close;
      }
      result.push(sum / (i + 1));
    } else {
      result.push((candles[i].close - result[i - 1]) * multiplier + result[i - 1]);
    }
  }
  return result;
}

// RSI calculation
function rsi(candles: Candle[], period: number = 14): number[] {
  const result: number[] = [];
  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      result.push(50);
      gains.push(0);
      losses.push(0);
      continue;
    }

    const change = candles[i].close - candles[i - 1].close;
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);

    if (i < period) {
      result.push(50);
      continue;
    }

    let avgGain = 0;
    let avgLoss = 0;

    if (i === period) {
      // First calculation - simple average
      for (let j = 1; j <= period; j++) {
        avgGain += gains[j];
        avgLoss += losses[j];
      }
      avgGain /= period;
      avgLoss /= period;
    } else {
      // Smoothed average
      const prevAvgGain = (result[i - 1] === 100) ? 99.99 :
                          (result[i - 1] === 0) ? 0.01 :
                          result[i - 1] / (100 - result[i - 1]);
      avgGain = (prevAvgGain * (period - 1) + gains[i]) / period;
      avgLoss = (1 / prevAvgGain * (period - 1) + losses[i]) / period;
    }

    if (avgLoss === 0) {
      result.push(100);
    } else {
      const rs = avgGain / avgLoss;
      result.push(100 - (100 / (1 + rs)));
    }
  }
  return result;
}

// Calculate strategy metrics
function calculateMetrics(trades: Trade[], candles: Candle[]): Omit<StrategyResult, 'name' | 'trades'> {
  if (trades.length === 0) {
    return {
      winRate: 0,
      totalPnL: 0,
      sharpeRatio: 0,
      maxDrawdown: 0,
      avgTradesPerDay: 0,
    };
  }

  const wins = trades.filter(t => t.pnl > 0).length;
  const winRate = wins / trades.length;
  const totalPnL = trades.reduce((sum, t) => sum + t.pnl, 0);

  // Sharpe ratio (annualized, assuming hourly data)
  const returns = trades.map(t => t.pnlPercent);
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const stdReturn = Math.sqrt(
    returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
  );
  const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(24 * 365) : 0;

  // Max drawdown
  let peak = INITIAL_CAPITAL;
  let maxDrawdown = 0;
  let equity = INITIAL_CAPITAL;

  for (const trade of trades) {
    equity += trade.pnl;
    if (equity > peak) peak = equity;
    const drawdown = (peak - equity) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  // Trades per day
  const totalHours = candles.length;
  const totalDays = totalHours / 24;
  const avgTradesPerDay = trades.length / totalDays;

  return { winRate, totalPnL, sharpeRatio, maxDrawdown, avgTradesPerDay };
}

// Strategy 1: MA Crossover
function maCrossoverStrategy(candles: Candle[], fastPeriod: number, slowPeriod: number): Trade[] {
  const fastMA = sma(candles, fastPeriod);
  const slowMA = sma(candles, slowPeriod);
  const trades: Trade[] = [];

  let position: 'long' | 'short' | null = null;
  let entryPrice = 0;
  let entryTime = 0;

  for (let i = slowPeriod; i < candles.length; i++) {
    const prevFast = fastMA[i - 1];
    const prevSlow = slowMA[i - 1];
    const currFast = fastMA[i];
    const currSlow = slowMA[i];

    // Bullish crossover
    if (prevFast <= prevSlow && currFast > currSlow) {
      // Close short if open
      if (position === 'short') {
        const pnl = (entryPrice - candles[i].close) * POSITION_SIZE * INITIAL_CAPITAL / entryPrice
                    - 2 * COMMISSION * POSITION_SIZE * INITIAL_CAPITAL;
        trades.push({
          entryTime,
          entryPrice,
          exitTime: candles[i].time,
          exitPrice: candles[i].close,
          direction: 'short',
          pnl,
          pnlPercent: pnl / INITIAL_CAPITAL,
        });
      }
      // Open long
      position = 'long';
      entryPrice = candles[i].close;
      entryTime = candles[i].time;
    }

    // Bearish crossover
    if (prevFast >= prevSlow && currFast < currSlow) {
      // Close long if open
      if (position === 'long') {
        const pnl = (candles[i].close - entryPrice) * POSITION_SIZE * INITIAL_CAPITAL / entryPrice
                    - 2 * COMMISSION * POSITION_SIZE * INITIAL_CAPITAL;
        trades.push({
          entryTime,
          entryPrice,
          exitTime: candles[i].time,
          exitPrice: candles[i].close,
          direction: 'long',
          pnl,
          pnlPercent: pnl / INITIAL_CAPITAL,
        });
      }
      // Open short
      position = 'short';
      entryPrice = candles[i].close;
      entryTime = candles[i].time;
    }
  }

  return trades;
}

// Strategy 2: RSI Mean Reversion
function rsiMeanReversionStrategy(candles: Candle[], oversold: number = 30, overbought: number = 70): Trade[] {
  const rsiValues = rsi(candles, 14);
  const trades: Trade[] = [];

  let position: 'long' | 'short' | null = null;
  let entryPrice = 0;
  let entryTime = 0;

  for (let i = 15; i < candles.length; i++) {
    const prevRSI = rsiValues[i - 1];
    const currRSI = rsiValues[i];

    // Oversold bounce - go long
    if (prevRSI < oversold && currRSI >= oversold && position !== 'long') {
      if (position === 'short') {
        const pnl = (entryPrice - candles[i].close) * POSITION_SIZE * INITIAL_CAPITAL / entryPrice
                    - 2 * COMMISSION * POSITION_SIZE * INITIAL_CAPITAL;
        trades.push({
          entryTime,
          entryPrice,
          exitTime: candles[i].time,
          exitPrice: candles[i].close,
          direction: 'short',
          pnl,
          pnlPercent: pnl / INITIAL_CAPITAL,
        });
      }
      position = 'long';
      entryPrice = candles[i].close;
      entryTime = candles[i].time;
    }

    // Overbought rejection - go short
    if (prevRSI > overbought && currRSI <= overbought && position !== 'short') {
      if (position === 'long') {
        const pnl = (candles[i].close - entryPrice) * POSITION_SIZE * INITIAL_CAPITAL / entryPrice
                    - 2 * COMMISSION * POSITION_SIZE * INITIAL_CAPITAL;
        trades.push({
          entryTime,
          entryPrice,
          exitTime: candles[i].time,
          exitPrice: candles[i].close,
          direction: 'long',
          pnl,
          pnlPercent: pnl / INITIAL_CAPITAL,
        });
      }
      position = 'short';
      entryPrice = candles[i].close;
      entryTime = candles[i].time;
    }
  }

  return trades;
}

// Strategy 3: Buy and Hold
function buyAndHoldStrategy(candles: Candle[]): Trade[] {
  const entry = candles[0];
  const exit = candles[candles.length - 1];

  const pnl = (exit.close - entry.close) * POSITION_SIZE * INITIAL_CAPITAL / entry.close
              - 2 * COMMISSION * POSITION_SIZE * INITIAL_CAPITAL;

  return [{
    entryTime: entry.time,
    entryPrice: entry.close,
    exitTime: exit.time,
    exitPrice: exit.close,
    direction: 'long',
    pnl,
    pnlPercent: pnl / INITIAL_CAPITAL,
  }];
}

// Strategy 4: EMA Crossover with trend filter
function emaCrossoverWithTrendStrategy(candles: Candle[]): Trade[] {
  const ema9 = ema(candles, 9);
  const ema21 = ema(candles, 21);
  const ema50 = ema(candles, 50);
  const trades: Trade[] = [];

  let position: 'long' | 'short' | null = null;
  let entryPrice = 0;
  let entryTime = 0;

  for (let i = 50; i < candles.length; i++) {
    const trend = candles[i].close > ema50[i] ? 'bullish' : 'bearish';

    // Only trade with trend
    if (trend === 'bullish' && ema9[i - 1] <= ema21[i - 1] && ema9[i] > ema21[i]) {
      if (position === 'short') {
        const pnl = (entryPrice - candles[i].close) * POSITION_SIZE * INITIAL_CAPITAL / entryPrice
                    - 2 * COMMISSION * POSITION_SIZE * INITIAL_CAPITAL;
        trades.push({
          entryTime,
          entryPrice,
          exitTime: candles[i].time,
          exitPrice: candles[i].close,
          direction: 'short',
          pnl,
          pnlPercent: pnl / INITIAL_CAPITAL,
        });
      }
      position = 'long';
      entryPrice = candles[i].close;
      entryTime = candles[i].time;
    }

    if (trend === 'bearish' && ema9[i - 1] >= ema21[i - 1] && ema9[i] < ema21[i]) {
      if (position === 'long') {
        const pnl = (candles[i].close - entryPrice) * POSITION_SIZE * INITIAL_CAPITAL / entryPrice
                    - 2 * COMMISSION * POSITION_SIZE * INITIAL_CAPITAL;
        trades.push({
          entryTime,
          entryPrice,
          exitTime: candles[i].time,
          exitPrice: candles[i].close,
          direction: 'long',
          pnl,
          pnlPercent: pnl / INITIAL_CAPITAL,
        });
      }
      position = 'short';
      entryPrice = candles[i].close;
      entryTime = candles[i].time;
    }

    // Exit on trend change
    if (position === 'long' && trend === 'bearish') {
      const pnl = (candles[i].close - entryPrice) * POSITION_SIZE * INITIAL_CAPITAL / entryPrice
                  - 2 * COMMISSION * POSITION_SIZE * INITIAL_CAPITAL;
      trades.push({
        entryTime,
        entryPrice,
        exitTime: candles[i].time,
        exitPrice: candles[i].close,
        direction: 'long',
        pnl,
        pnlPercent: pnl / INITIAL_CAPITAL,
      });
      position = null;
    }

    if (position === 'short' && trend === 'bullish') {
      const pnl = (entryPrice - candles[i].close) * POSITION_SIZE * INITIAL_CAPITAL / entryPrice
                  - 2 * COMMISSION * POSITION_SIZE * INITIAL_CAPITAL;
      trades.push({
        entryTime,
        entryPrice,
        exitTime: candles[i].time,
        exitPrice: candles[i].close,
        direction: 'short',
        pnl,
        pnlPercent: pnl / INITIAL_CAPITAL,
      });
      position = null;
    }
  }

  return trades;
}

async function main() {
  console.log('============================================================');
  console.log('Baseline Strategy Verification');
  console.log('============================================================\n');

  // Load data
  const candles = loadSymbolData(SYMBOL);
  console.log(`Loaded ${candles.length} candles for ${SYMBOL}`);

  // Split into train/validation (80/20)
  const splitIdx = Math.floor(candles.length * 0.8);
  const trainCandles = candles.slice(0, splitIdx);
  const valCandles = candles.slice(splitIdx);

  console.log(`Train: ${trainCandles.length} candles`);
  console.log(`Validation: ${valCandles.length} candles\n`);

  // Test strategies on both sets
  const strategies = [
    { name: 'Buy & Hold', fn: buyAndHoldStrategy },
    { name: 'MA Crossover (10/30)', fn: (c: Candle[]) => maCrossoverStrategy(c, 10, 30) },
    { name: 'MA Crossover (20/50)', fn: (c: Candle[]) => maCrossoverStrategy(c, 20, 50) },
    { name: 'RSI Mean Reversion', fn: rsiMeanReversionStrategy },
    { name: 'EMA Crossover + Trend', fn: emaCrossoverWithTrendStrategy },
  ];

  console.log('=== TRAINING SET RESULTS ===');
  console.log('| Strategy                  | Win Rate | Sharpe |   PnL   | Max DD | Trades/Day |');
  console.log('|---------------------------|----------|--------|---------|--------|------------|');

  for (const strat of strategies) {
    const trades = strat.fn(trainCandles);
    const metrics = calculateMetrics(trades, trainCandles);
    console.log(
      `| ${strat.name.padEnd(25)} | ${(metrics.winRate * 100).toFixed(1).padStart(6)}% | ${metrics.sharpeRatio.toFixed(2).padStart(6)} | ${metrics.totalPnL.toFixed(0).padStart(7)} | ${(metrics.maxDrawdown * 100).toFixed(1).padStart(5)}% | ${metrics.avgTradesPerDay.toFixed(2).padStart(10)} |`
    );
  }

  console.log('\n=== VALIDATION SET RESULTS ===');
  console.log('| Strategy                  | Win Rate | Sharpe |   PnL   | Max DD | Trades/Day |');
  console.log('|---------------------------|----------|--------|---------|--------|------------|');

  for (const strat of strategies) {
    const trades = strat.fn(valCandles);
    const metrics = calculateMetrics(trades, valCandles);
    console.log(
      `| ${strat.name.padEnd(25)} | ${(metrics.winRate * 100).toFixed(1).padStart(6)}% | ${metrics.sharpeRatio.toFixed(2).padStart(6)} | ${metrics.totalPnL.toFixed(0).padStart(7)} | ${(metrics.maxDrawdown * 100).toFixed(1).padStart(5)}% | ${metrics.avgTradesPerDay.toFixed(2).padStart(10)} |`
    );
  }

  console.log('\n============================================================');
  console.log('INTERPRETATION:');
  console.log('- If all strategies have negative Sharpe on validation,');
  console.log('  the data period may be unfavorable for trading.');
  console.log('- If some strategies have positive Sharpe, RL should be');
  console.log('  able to learn at least as well as the best baseline.');
  console.log('============================================================\n');
}

main().catch(console.error);
