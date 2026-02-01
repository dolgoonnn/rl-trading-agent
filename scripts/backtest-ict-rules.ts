#!/usr/bin/env npx tsx
/**
 * Simple Rule-Based ICT Backtest
 * Tests a simple trading rule: Buy on Bullish OB touch, close after N bars
 *
 * This validates if ICT signals have ANY tradeable edge before using RL
 */

import fs from 'fs';
import path from 'path';

import type { Candle } from '@/types';
import { detectOrderBlocks, type OrderBlock } from '@/lib/ict';

interface Trade {
  entryIndex: number;
  entryPrice: number;
  exitIndex: number;
  exitPrice: number;
  type: 'long' | 'short';
  pnl: number;
  pnlPercent: number;
}

interface BacktestResult {
  trades: Trade[];
  totalPnL: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  sharpeRatio: number;
  maxDrawdown: number;
}

function loadCandles(dataPath: string): Candle[] {
  const absolutePath = path.resolve(dataPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Data file not found: ${absolutePath}`);
  }
  const content = fs.readFileSync(absolutePath, 'utf-8');
  return JSON.parse(content) as Candle[];
}

function isPriceInZone(price: number, low: number, high: number): boolean {
  return price >= low && price <= high;
}

function runBacktest(
  candles: Candle[],
  orderBlocks: OrderBlock[],
  holdPeriod: number,
  obType: 'bullish' | 'bearish' | 'both'
): BacktestResult {
  const trades: Trade[] = [];
  const usedOBs = new Set<string>(); // Track which OBs have been traded
  let position: { entryIndex: number; entryPrice: number; type: 'long' | 'short' } | null = null;

  // Filter OBs by type upfront
  const relevantOBs = orderBlocks.filter(ob =>
    obType === 'both' || ob.type === obType
  );

  // Create a map from candle index to OBs that can be triggered there
  const startTimestamp = candles[0]?.timestamp ?? 0;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;

    // If in position, check for exit
    if (position) {
      if (i - position.entryIndex >= holdPeriod) {
        // Exit position
        const exitPrice = candle.close;
        const pnl = position.type === 'long'
          ? exitPrice - position.entryPrice
          : position.entryPrice - exitPrice;
        const pnlPercent = pnl / position.entryPrice * 100;

        trades.push({
          entryIndex: position.entryIndex,
          entryPrice: position.entryPrice,
          exitIndex: i,
          exitPrice,
          type: position.type,
          pnl,
          pnlPercent,
        });

        position = null;
      }
      continue; // Skip entry logic while in position
    }

    // Look for OB entry - check all relevant OBs
    for (const ob of relevantOBs) {
      // Skip if already traded this OB (using unique ID)
      const obId = `${ob.formationTimestamp}_${ob.type}_${ob.high}_${ob.low}`;
      if (usedOBs.has(obId)) continue;

      // Skip if OB formed after this candle
      if (ob.formationTimestamp >= candle.timestamp) continue;

      // Check if price touches OB zone (price enters the zone)
      const touchesZone = candle.low <= ob.high && candle.high >= ob.low;

      if (touchesZone) {
        usedOBs.add(obId);
        position = {
          entryIndex: i,
          entryPrice: candle.close,
          type: ob.type === 'bullish' ? 'long' : 'short',
        };
        break;
      }
    }
  }

  // Close any remaining position
  if (position && candles.length > 0) {
    const exitIndex = candles.length - 1;
    const exitPrice = candles[exitIndex]!.close;
    const pnl = position.type === 'long'
      ? exitPrice - position.entryPrice
      : position.entryPrice - exitPrice;
    const pnlPercent = pnl / position.entryPrice * 100;

    trades.push({
      entryIndex: position.entryIndex,
      entryPrice: position.entryPrice,
      exitIndex,
      exitPrice,
      type: position.type,
      pnl,
      pnlPercent,
    });
  }

  // Calculate metrics
  const wins = trades.filter(t => t.pnlPercent > 0);
  const losses = trades.filter(t => t.pnlPercent <= 0);

  const totalPnL = trades.reduce((sum, t) => sum + t.pnlPercent, 0);
  const winRate = trades.length > 0 ? wins.length / trades.length * 100 : 0;
  const avgWin = wins.length > 0 ? wins.reduce((sum, t) => sum + t.pnlPercent, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((sum, t) => sum + t.pnlPercent, 0) / losses.length : 0;

  // Calculate Sharpe
  const returns = trades.map(t => t.pnlPercent);
  const meanReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 1
    ? returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / (returns.length - 1)
    : 0;
  const stdDev = Math.sqrt(variance);
  const sharpeRatio = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(252) : 0;

  // Calculate max drawdown
  let peak = 0;
  let maxDD = 0;
  let cumReturn = 0;
  for (const t of trades) {
    cumReturn += t.pnlPercent;
    if (cumReturn > peak) peak = cumReturn;
    const dd = peak - cumReturn;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    trades,
    totalPnL,
    winRate,
    avgWin,
    avgLoss,
    sharpeRatio,
    maxDrawdown: maxDD,
  };
}

async function main() {
  console.log('='.repeat(60));
  console.log('ICT Rule-Based Backtest');
  console.log('='.repeat(60));
  console.log();

  // Load BTC data
  console.log('Loading BTC data...');
  const candles = loadCandles('./data/BTCUSDT_1h.json');
  console.log(`Loaded ${candles.length} candles\n`);

  // Detect order blocks
  console.log('Detecting order blocks...');
  const orderBlocks = detectOrderBlocks(candles);
  const bullishOBs = orderBlocks.filter(ob => ob.type === 'bullish');
  const bearishOBs = orderBlocks.filter(ob => ob.type === 'bearish');
  console.log(`Found ${bullishOBs.length} bullish OBs, ${bearishOBs.length} bearish OBs\n`);

  // Test different configurations
  const holdPeriods = [10, 20, 50];
  const obTypes: Array<'bullish' | 'bearish' | 'both'> = ['bullish', 'bearish', 'both'];

  console.log('Strategy     | Hold | Trades | WinRate | Avg Win | Avg Loss | Sharpe | Total PnL');
  console.log('-'.repeat(85));

  for (const obType of obTypes) {
    for (const holdPeriod of holdPeriods) {
      const result = runBacktest(candles, orderBlocks, holdPeriod, obType);

      const typeStr = obType.padEnd(8);
      const holdStr = String(holdPeriod).padStart(4);
      const tradesStr = String(result.trades.length).padStart(6);
      const winRateStr = `${result.winRate.toFixed(1)}%`.padStart(7);
      const avgWinStr = `${result.avgWin.toFixed(2)}%`.padStart(7);
      const avgLossStr = `${result.avgLoss.toFixed(2)}%`.padStart(8);
      const sharpeStr = result.sharpeRatio.toFixed(2).padStart(6);
      const pnlStr = `${result.totalPnL.toFixed(1)}%`.padStart(9);

      const indicator = result.sharpeRatio > 0 ? '✓' : '✗';

      console.log(
        `${typeStr} OB | ${holdStr} | ${tradesStr} | ${winRateStr} | ${avgWinStr} | ${avgLossStr} | ${sharpeStr} | ${pnlStr} ${indicator}`
      );
    }
  }

  console.log('-'.repeat(85));

  // Split test: first 80% train, last 20% test
  console.log('\n=== OUT-OF-SAMPLE TEST (Last 20% of data) ===\n');

  const splitIndex = Math.floor(candles.length * 0.8);
  const testCandles = candles.slice(splitIndex);
  // Use ALL OBs for test - they may have formed earlier but still be valid
  const testOBs = orderBlocks;

  console.log(`Test period: ${testCandles.length} candles`);
  console.log(`Using all ${testOBs.length} OBs (may have formed before test period)\n`);

  console.log('Strategy     | Hold | Trades | WinRate | Avg Win | Avg Loss | Sharpe | Total PnL');
  console.log('-'.repeat(85));

  for (const obType of obTypes) {
    for (const holdPeriod of holdPeriods) {
      const result = runBacktest(testCandles, testOBs, holdPeriod, obType);

      const typeStr = obType.padEnd(8);
      const holdStr = String(holdPeriod).padStart(4);
      const tradesStr = String(result.trades.length).padStart(6);
      const winRateStr = result.trades.length > 0 ? `${result.winRate.toFixed(1)}%`.padStart(7) : 'N/A'.padStart(7);
      const avgWinStr = result.trades.length > 0 ? `${result.avgWin.toFixed(2)}%`.padStart(7) : 'N/A'.padStart(7);
      const avgLossStr = result.trades.length > 0 ? `${result.avgLoss.toFixed(2)}%`.padStart(8) : 'N/A'.padStart(8);
      const sharpeStr = result.sharpeRatio.toFixed(2).padStart(6);
      const pnlStr = result.trades.length > 0 ? `${result.totalPnL.toFixed(1)}%`.padStart(9) : 'N/A'.padStart(9);

      const indicator = result.sharpeRatio > 0 ? '✓' : '✗';

      console.log(
        `${typeStr} OB | ${holdStr} | ${tradesStr} | ${winRateStr} | ${avgWinStr} | ${avgLossStr} | ${sharpeStr} | ${pnlStr} ${indicator}`
      );
    }
  }

  console.log('-'.repeat(85));
  console.log('\n✓ = Positive Sharpe (profitable strategy)');
  console.log('✗ = Negative Sharpe (losing strategy)');
}

main().catch(console.error);
