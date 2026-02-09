#!/usr/bin/env npx tsx
/**
 * Multi-Timeframe Backtest: 1H Structure + 15m Entry
 *
 * Strategy:
 * 1. Aggregate 15m candles → 1H candles for structure detection (OBs, swings, regime)
 * 2. On each 15m candle, check if price is in a valid 1H OB zone
 * 3. If yes, run 15m-level entry logic (reaction confirmation on 15m candle)
 * 4. SL/TP based on 1H structural levels, but entry on 15m (better timing → tighter risk)
 *
 * Benefits over single-TF:
 * - Better entry timing: enter within 15m of OB touch
 * - Tighter effective SL: entry closer to OB boundary → less risk distance → higher R:R
 * - 1H structural integrity: OBs detected on 1H (proven to work at that TF)
 *
 * Usage:
 *   npx tsx scripts/backtest-mtf.ts
 *   npx tsx scripts/backtest-mtf.ts --symbols BTCUSDT
 *   npx tsx scripts/backtest-mtf.ts --sl-mode entry_based --friction 0.0007
 *   npx tsx scripts/backtest-mtf.ts --suppress-regime "ranging+normal,ranging+high"
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import {
  PRODUCTION_STRATEGY_CONFIG,
} from '../src/lib/rl/strategies/confluence-scorer';
import {
  detectRegime,
  regimeLabel,
} from '../src/lib/ict/regime-detector';
import { aggregateCandles, getBucketTimestamp } from '../src/lib/ict/candle-aggregator';
import { detectOrderBlocks } from '../src/lib/ict/order-blocks';
import type { OrderBlock } from '@/types';
import type { SLPlacementMode } from '../src/lib/rl/strategies/ict-strategies';

// ============================================
// Types
// ============================================

type ExitReason = 'stop_loss' | 'take_profit' | 'max_bars' | 'end_of_data';

interface MTFTrade {
  entryPrice: number;
  exitPrice: number;
  direction: 'long' | 'short';
  pnlPercent: number;
  exitReason: ExitReason;
  barsHeld: number; // in 15m bars
  slPrice: number;
  tpPrice: number;
  realizedRR: number;
  regimeAtEntry: string;
  entryTimestamp: number;
  symbol: string;
  /** The 1H OB that triggered this entry */
  obType: 'bullish' | 'bearish';
  obHigh: number;
  obLow: number;
  /** Was entry at a better price than 1H close would give? */
  entryImprovement: number; // % improvement vs 1H entry
}

interface MTFPosition {
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  direction: 'long' | 'short';
  entryIndex15m: number;
  entryTimestamp: number;
  strategy: string;
  obHigh: number;
  obLow: number;
  obType: 'bullish' | 'bearish';
  /** What the 1H candle close entry would have been */
  hypothetical1HEntry: number;
}

// ============================================
// Constants
// ============================================

const MAX_POSITION_BARS_15M = 400; // 100 hours = same as 100 bars at 1H
const DEFAULT_COMMISSION = 0.001;
const DEFAULT_SLIPPAGE = 0.0005;
let FRICTION_PER_SIDE = DEFAULT_COMMISSION + DEFAULT_SLIPPAGE;
const ATR_PERIOD = 14;
const OB_LOOKBACK_1H = 200; // 1H candles for OB detection lookback

// ============================================
// ATR Calculation
// ============================================

function calculateATR(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return candles.length > 0 ? candles[candles.length - 1]!.high - candles[candles.length - 1]!.low : 0;

  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i]!.high;
    const low = candles[i]!.low;
    const prevClose = candles[i - 1]?.close ?? candles[i]!.open;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    sum += tr;
  }

  return sum / period;
}

// ============================================
// SL/TP Calculation (mirrors ict-strategies.ts logic)
// ============================================

function calculateLongSLTP(
  entryPrice: number,
  obBoundary: number,
  atr: number,
  slMultiple: number,
  tpMultiple: number,
  mode: SLPlacementMode,
): { stopLoss: number; takeProfit: number } {
  switch (mode) {
    case 'entry_based':
      return {
        stopLoss: entryPrice - atr * slMultiple,
        takeProfit: entryPrice + atr * tpMultiple,
      };
    case 'dynamic_rr': {
      const stopLoss = obBoundary - atr * slMultiple;
      const risk = entryPrice - stopLoss;
      const targetRR = tpMultiple / slMultiple;
      return { stopLoss, takeProfit: entryPrice + risk * targetRR };
    }
    case 'ob_based':
    default:
      return {
        stopLoss: obBoundary - atr * slMultiple,
        takeProfit: entryPrice + atr * tpMultiple,
      };
  }
}

function calculateShortSLTP(
  entryPrice: number,
  obBoundary: number,
  atr: number,
  slMultiple: number,
  tpMultiple: number,
  mode: SLPlacementMode,
): { stopLoss: number; takeProfit: number } {
  switch (mode) {
    case 'entry_based':
      return {
        stopLoss: entryPrice + atr * slMultiple,
        takeProfit: entryPrice - atr * tpMultiple,
      };
    case 'dynamic_rr': {
      const stopLoss = obBoundary + atr * slMultiple;
      const risk = stopLoss - entryPrice;
      const targetRR = tpMultiple / slMultiple;
      return { stopLoss, takeProfit: entryPrice - risk * targetRR };
    }
    case 'ob_based':
    default:
      return {
        stopLoss: obBoundary + atr * slMultiple,
        takeProfit: entryPrice - atr * tpMultiple,
      };
  }
}

// ============================================
// Friction helpers
// ============================================

function applyEntryFriction(price: number, direction: 'long' | 'short'): number {
  return direction === 'long'
    ? price * (1 + FRICTION_PER_SIDE)
    : price * (1 - FRICTION_PER_SIDE);
}

function applyExitFriction(price: number, direction: 'long' | 'short'): number {
  return direction === 'long'
    ? price * (1 - FRICTION_PER_SIDE)
    : price * (1 + FRICTION_PER_SIDE);
}

function calculatePnlPercent(adjustedEntry: number, adjustedExit: number, direction: 'long' | 'short'): number {
  return direction === 'long'
    ? (adjustedExit - adjustedEntry) / adjustedEntry
    : (adjustedEntry - adjustedExit) / adjustedEntry;
}

// ============================================
// 1H Structure Detection
// ============================================

interface StructureSnapshot {
  orderBlocks: OrderBlock[];
  atr: number;
  regime: string;
  /** 1H candle close (hypothetical entry for comparison) */
  closePrice: number;
}

/**
 * Build a map of 1H bucket timestamp → detected structure (OBs, ATR, regime).
 * Pre-computed once so we don't re-detect on every 15m bar.
 */
function buildStructureMap(
  candles1H: Candle[],
): Map<number, StructureSnapshot> {
  const structureMap = new Map<number, StructureSnapshot>();

  for (let i = OB_LOOKBACK_1H; i < candles1H.length; i++) {
    const candle1H = candles1H[i]!;
    const lookback = candles1H.slice(Math.max(0, i - OB_LOOKBACK_1H), i + 1);

    // Detect OBs on 1H lookback
    const obs = detectOrderBlocks(lookback);

    // Calculate 1H ATR
    const atrSlice = candles1H.slice(Math.max(0, i - ATR_PERIOD), i + 1);
    const atr = calculateATR(atrSlice, ATR_PERIOD);

    // Detect regime at this 1H bar
    const regime = detectRegime(candles1H, i);
    const regimeStr = regimeLabel(regime);

    structureMap.set(candle1H.timestamp, {
      orderBlocks: obs,
      atr,
      regime: regimeStr,
      closePrice: candle1H.close,
    });
  }

  return structureMap;
}

// ============================================
// 15m Entry Logic
// ============================================

/**
 * Check if a 15m candle qualifies for entry based on 1H OB zones.
 *
 * For bullish OB:
 *   - Price must touch OB zone (candle.low <= ob.high)
 *   - Reaction confirmation: candle closes above OB midpoint with 40% body conviction
 *
 * For bearish OB:
 *   - Price must touch OB zone (candle.high >= ob.low)
 *   - Reaction confirmation: candle closes below OB midpoint with 40% body conviction
 */
function check15mEntry(
  candle: Candle,
  obs: OrderBlock[],
  atr: number,
  slMode: SLPlacementMode,
  slMultiple: number,
  tpMultiple: number,
  proximity: number,
  minReactionBodyPercent: number,
): { position: Omit<MTFPosition, 'entryIndex15m' | 'entryTimestamp' | 'hypothetical1HEntry'> } | null {
  const price = candle.close;
  const bodySize = Math.abs(candle.close - candle.open);
  const candleRange = candle.high - candle.low;
  const bodyRatio = candleRange > 0 ? bodySize / candleRange : 0;

  // Check bullish OBs
  for (const ob of obs) {
    if (ob.type !== 'bullish' || ob.status !== 'unmitigated') continue;

    // Price must be within proximity of OB zone
    const obMid = (ob.high + ob.low) / 2;
    if (candle.low > ob.high * (1 + proximity)) continue; // Too far above
    if (candle.close < ob.low * (1 - proximity)) continue; // Too far below

    // Reaction confirmation: close above OB midpoint with body conviction
    if (candle.close <= obMid) continue;
    if (bodyRatio < minReactionBodyPercent) continue;
    if (candle.close <= candle.open) continue; // Must be bullish candle

    const { stopLoss, takeProfit } = calculateLongSLTP(
      price, ob.low, atr, slMultiple, tpMultiple, slMode,
    );

    // Sanity: SL must be below entry
    if (stopLoss >= price) continue;

    return {
      position: {
        entryPrice: price,
        stopLoss,
        takeProfit,
        direction: 'long',
        strategy: 'mtf_ob',
        obHigh: ob.high,
        obLow: ob.low,
        obType: 'bullish',
      },
    };
  }

  // Check bearish OBs
  for (const ob of obs) {
    if (ob.type !== 'bearish' || ob.status !== 'unmitigated') continue;

    const obMid = (ob.high + ob.low) / 2;
    if (candle.high < ob.low * (1 - proximity)) continue; // Too far below
    if (candle.close > ob.high * (1 + proximity)) continue; // Too far above

    // Reaction confirmation: close below OB midpoint with body conviction
    if (candle.close >= obMid) continue;
    if (bodyRatio < minReactionBodyPercent) continue;
    if (candle.close >= candle.open) continue; // Must be bearish candle

    const { stopLoss, takeProfit } = calculateShortSLTP(
      price, ob.high, atr, slMultiple, tpMultiple, slMode,
    );

    // Sanity: SL must be above entry
    if (stopLoss <= price) continue;

    return {
      position: {
        entryPrice: price,
        stopLoss,
        takeProfit,
        direction: 'short',
        strategy: 'mtf_ob',
        obHigh: ob.high,
        obLow: ob.low,
        obType: 'bearish',
      },
    };
  }

  return null;
}

// ============================================
// Trade Simulation on 15m candles
// ============================================

function simulateTrade(
  position: MTFPosition,
  candles15m: Candle[],
  startIndex: number,
  regimeAtEntry: string,
  symbol: string,
): MTFTrade | null {
  const adjustedEntry = applyEntryFriction(position.entryPrice, position.direction);
  const riskDistance = Math.abs(position.entryPrice - position.stopLoss);

  for (let i = startIndex; i < candles15m.length; i++) {
    const candle = candles15m[i];
    if (!candle) continue;

    const barsHeld = i - position.entryIndex15m;

    // Check SL/TP
    let slHit = false;
    let tpHit = false;

    if (position.direction === 'long') {
      slHit = candle.low <= position.stopLoss;
      tpHit = candle.high >= position.takeProfit;
    } else {
      slHit = candle.high >= position.stopLoss;
      tpHit = candle.low <= position.takeProfit;
    }

    if (slHit) {
      const adjustedExit = applyExitFriction(position.stopLoss, position.direction);
      const pnlPercent = calculatePnlPercent(adjustedEntry, adjustedExit, position.direction);
      const realizedRR = riskDistance > 0 ? pnlPercent * position.entryPrice / riskDistance : 0;
      const entryImprovement = position.hypothetical1HEntry > 0
        ? Math.abs(position.entryPrice - position.hypothetical1HEntry) / position.hypothetical1HEntry
        : 0;

      return {
        entryPrice: adjustedEntry, exitPrice: adjustedExit, direction: position.direction,
        pnlPercent, exitReason: 'stop_loss', barsHeld,
        slPrice: position.stopLoss, tpPrice: position.takeProfit, realizedRR,
        regimeAtEntry, entryTimestamp: position.entryTimestamp, symbol,
        obType: position.obType, obHigh: position.obHigh, obLow: position.obLow,
        entryImprovement,
      };
    }

    if (tpHit) {
      const adjustedExit = applyExitFriction(position.takeProfit, position.direction);
      const pnlPercent = calculatePnlPercent(adjustedEntry, adjustedExit, position.direction);
      const realizedRR = riskDistance > 0 ? pnlPercent * position.entryPrice / riskDistance : 0;
      const entryImprovement = position.hypothetical1HEntry > 0
        ? Math.abs(position.entryPrice - position.hypothetical1HEntry) / position.hypothetical1HEntry
        : 0;

      return {
        entryPrice: adjustedEntry, exitPrice: adjustedExit, direction: position.direction,
        pnlPercent, exitReason: 'take_profit', barsHeld,
        slPrice: position.stopLoss, tpPrice: position.takeProfit, realizedRR,
        regimeAtEntry, entryTimestamp: position.entryTimestamp, symbol,
        obType: position.obType, obHigh: position.obHigh, obLow: position.obLow,
        entryImprovement,
      };
    }

    if (barsHeld >= MAX_POSITION_BARS_15M) {
      const adjustedExit = applyExitFriction(candle.close, position.direction);
      const pnlPercent = calculatePnlPercent(adjustedEntry, adjustedExit, position.direction);
      const realizedRR = riskDistance > 0 ? pnlPercent * position.entryPrice / riskDistance : 0;
      const entryImprovement = position.hypothetical1HEntry > 0
        ? Math.abs(position.entryPrice - position.hypothetical1HEntry) / position.hypothetical1HEntry
        : 0;

      return {
        entryPrice: adjustedEntry, exitPrice: adjustedExit, direction: position.direction,
        pnlPercent, exitReason: 'max_bars', barsHeld,
        slPrice: position.stopLoss, tpPrice: position.takeProfit, realizedRR,
        regimeAtEntry, entryTimestamp: position.entryTimestamp, symbol,
        obType: position.obType, obHigh: position.obHigh, obLow: position.obLow,
        entryImprovement,
      };
    }
  }

  // End of data
  const lastCandle = candles15m[candles15m.length - 1];
  if (!lastCandle) return null;

  const adjustedExit = applyExitFriction(lastCandle.close, position.direction);
  const pnlPercent = calculatePnlPercent(adjustedEntry, adjustedExit, position.direction);
  const realizedRR = riskDistance > 0 ? pnlPercent * position.entryPrice / riskDistance : 0;
  const entryImprovement = position.hypothetical1HEntry > 0
    ? Math.abs(position.entryPrice - position.hypothetical1HEntry) / position.hypothetical1HEntry
    : 0;

  return {
    entryPrice: adjustedEntry, exitPrice: adjustedExit, direction: position.direction,
    pnlPercent, exitReason: 'end_of_data',
    barsHeld: candles15m.length - 1 - position.entryIndex15m,
    slPrice: position.stopLoss, tpPrice: position.takeProfit, realizedRR,
    regimeAtEntry, entryTimestamp: position.entryTimestamp, symbol,
    obType: position.obType, obHigh: position.obHigh, obLow: position.obLow,
    entryImprovement,
  };
}

// ============================================
// Main MTF Backtest Loop
// ============================================

function runMTFBacktest(
  candles15m: Candle[],
  symbol: string,
  slMode: SLPlacementMode,
  slMultiple: number,
  tpMultiple: number,
  suppressedRegimes: string[],
  proximity: number,
  minReactionBodyPercent: number,
  cooldownBars15m: number,
): MTFTrade[] {
  // 1. Aggregate 15m → 1H (timestamp-aligned)
  const candles1H = aggregateCandles(candles15m, 60);
  console.log(`  Aggregated ${candles15m.length} 15m candles → ${candles1H.length} 1H candles`);

  // 2. Build 1H structure map
  const structureMap = buildStructureMap(candles1H);
  console.log(`  Built structure map: ${structureMap.size} 1H snapshots`);

  const trades: MTFTrade[] = [];
  let lastTradeExitIndex = -1;
  let lastTradeBar = -1;

  // 3. Iterate over 15m candles
  // Start after enough 1H bars have accumulated for OB detection
  const min15mIndex = OB_LOOKBACK_1H * 4; // ~800 15m bars

  for (let i = min15mIndex; i < candles15m.length; i++) {
    const candle = candles15m[i]!;

    // Skip if still in position
    if (i <= lastTradeExitIndex) continue;

    // Cooldown check
    if (lastTradeBar >= 0 && (i - lastTradeBar) < cooldownBars15m) continue;

    // Find parent 1H bucket
    const bucket1HTs = getBucketTimestamp(candle.timestamp, 60);
    const structure = structureMap.get(bucket1HTs);
    if (!structure) continue;

    // Regime suppression
    if (suppressedRegimes.includes(structure.regime)) continue;

    // Check for 15m entry signal within 1H OB zones
    const entryResult = check15mEntry(
      candle, structure.orderBlocks, structure.atr,
      slMode, slMultiple, tpMultiple, proximity, minReactionBodyPercent,
    );

    if (!entryResult) continue;

    const position: MTFPosition = {
      ...entryResult.position,
      entryIndex15m: i,
      entryTimestamp: candle.timestamp,
      hypothetical1HEntry: structure.closePrice,
    };

    // Simulate trade on 15m candles
    const trade = simulateTrade(position, candles15m, i + 1, structure.regime, symbol);

    if (trade) {
      trades.push(trade);
      lastTradeExitIndex = i + trade.barsHeld;
      lastTradeBar = i;
    }
  }

  return trades;
}

// ============================================
// Reporting
// ============================================

function printSummary(trades: MTFTrade[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('MTF BACKTEST SUMMARY');
  console.log('='.repeat(80));

  const wins = trades.filter((t) => t.pnlPercent > 0).length;
  const losses = trades.filter((t) => t.pnlPercent <= 0).length;
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
  const totalPnl = trades.reduce((s, t) => s + t.pnlPercent, 0);
  const avgPnl = trades.length > 0 ? totalPnl / trades.length : 0;

  const tpTrades = trades.filter((t) => t.exitReason === 'take_profit');
  const avgTPRR = tpTrades.length > 0
    ? tpTrades.reduce((s, t) => s + t.realizedRR, 0) / tpTrades.length
    : 0;

  const avgBars = trades.length > 0
    ? trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length
    : 0;

  console.log(`\n  Total trades:    ${trades.length}`);
  console.log(`  Win rate:        ${winRate.toFixed(1)}% (${wins}W / ${losses}L)`);
  console.log(`  Total PnL:       ${(totalPnl * 100).toFixed(2)}%`);
  console.log(`  Avg PnL/trade:   ${(avgPnl * 100).toFixed(3)}%`);
  console.log(`  Avg TP R:R:      ${avgTPRR.toFixed(3)}`);
  console.log(`  Avg bars held:   ${avgBars.toFixed(1)} (15m bars, = ${(avgBars / 4).toFixed(1)} hours)`);

  // Friction impact
  const frictionPerTrade = FRICTION_PER_SIDE * 2; // round-trip
  const totalFriction = frictionPerTrade * trades.length;
  console.log(`  Total friction:  ${(totalFriction * 100).toFixed(2)}%`);
}

function printExitDistribution(trades: MTFTrade[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('EXIT REASON DISTRIBUTION');
  console.log('='.repeat(80));

  const reasons: ExitReason[] = ['stop_loss', 'take_profit', 'max_bars', 'end_of_data'];

  console.log(
    `\n  ${'Exit Reason'.padEnd(16)} ${'Count'.padStart(6)} ${'%'.padStart(7)} ${'Avg PnL%'.padStart(10)} ${'Total PnL%'.padStart(12)} ${'Avg R:R'.padStart(8)}`
  );
  console.log('  ' + '-'.repeat(65));

  for (const reason of reasons) {
    const subset = trades.filter((t) => t.exitReason === reason);
    if (subset.length === 0) continue;

    const pct = (subset.length / trades.length) * 100;
    const avgPnl = subset.reduce((s, t) => s + t.pnlPercent, 0) / subset.length;
    const totalPnl = subset.reduce((s, t) => s + t.pnlPercent, 0);
    const avgRR = subset.reduce((s, t) => s + t.realizedRR, 0) / subset.length;

    console.log(
      `  ${reason.padEnd(16)} ${subset.length.toString().padStart(6)} ${pct.toFixed(1).padStart(6)}% ${(avgPnl * 100).toFixed(3).padStart(9)}% ${(totalPnl * 100).toFixed(2).padStart(11)}% ${avgRR.toFixed(3).padStart(8)}`
    );
  }

  const totalPnl = trades.reduce((s, t) => s + t.pnlPercent, 0);
  console.log('  ' + '-'.repeat(65));
  console.log(
    `  ${'TOTAL'.padEnd(16)} ${trades.length.toString().padStart(6)} ${'100.0'.padStart(6)}% ${trades.length > 0 ? ((totalPnl / trades.length) * 100).toFixed(3).padStart(9) : '0'.padStart(9)}% ${(totalPnl * 100).toFixed(2).padStart(11)}%`
  );
}

function printRegimeBreakdown(trades: MTFTrade[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('REGIME BREAKDOWN');
  console.log('='.repeat(80));

  const regimeGroups = new Map<string, MTFTrade[]>();
  for (const t of trades) {
    const existing = regimeGroups.get(t.regimeAtEntry);
    if (existing) existing.push(t);
    else regimeGroups.set(t.regimeAtEntry, [t]);
  }

  console.log(
    `\n  ${'Regime'.padEnd(22)} ${'Trades'.padStart(7)} ${'WR%'.padStart(7)} ${'Total PnL%'.padStart(12)} ${'Avg PnL%'.padStart(10)}`
  );
  console.log('  ' + '-'.repeat(62));

  const sorted = [...regimeGroups.entries()].sort((a, b) => {
    const pnlA = a[1].reduce((s, t) => s + t.pnlPercent, 0);
    const pnlB = b[1].reduce((s, t) => s + t.pnlPercent, 0);
    return pnlB - pnlA;
  });

  for (const [regime, rTrades] of sorted) {
    const wins = rTrades.filter((t) => t.pnlPercent > 0).length;
    const wr = (wins / rTrades.length) * 100;
    const totalPnl = rTrades.reduce((s, t) => s + t.pnlPercent, 0);
    const avgPnl = totalPnl / rTrades.length;

    console.log(
      `  ${regime.padEnd(22)} ${rTrades.length.toString().padStart(7)} ${wr.toFixed(1).padStart(6)}% ${(totalPnl * 100).toFixed(2).padStart(11)}% ${(avgPnl * 100).toFixed(3).padStart(9)}%`
    );
  }
}

function printEntryImprovementAnalysis(trades: MTFTrade[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('15m ENTRY IMPROVEMENT vs 1H CLOSE ENTRY');
  console.log('='.repeat(80));

  const improvements = trades.map((t) => t.entryImprovement * 100);
  const avgImprovement = improvements.reduce((s, v) => s + v, 0) / improvements.length;
  const maxImprovement = Math.max(...improvements);

  const longTrades = trades.filter((t) => t.direction === 'long');
  const shortTrades = trades.filter((t) => t.direction === 'short');

  console.log(`\n  Avg entry improvement:  ${avgImprovement.toFixed(3)}%`);
  console.log(`  Max entry improvement:  ${maxImprovement.toFixed(3)}%`);
  console.log(`  Long trades:  ${longTrades.length}`);
  console.log(`  Short trades: ${shortTrades.length}`);

  // What this means for R:R
  if (trades.length > 0) {
    const avgRiskDistance = trades.reduce((s, t) => {
      return s + Math.abs(t.entryPrice - t.slPrice);
    }, 0) / trades.length;
    const avgEntryPrice = trades.reduce((s, t) => s + t.entryPrice, 0) / trades.length;
    const improvementInRisk = (avgImprovement / 100 * avgEntryPrice) / avgRiskDistance;

    console.log(`\n  Avg improvement in risk terms: ${(improvementInRisk * 100).toFixed(1)}% of SL distance`);
    console.log('  → This much less risk per trade from 15m timing vs 1H close entry');
  }
}

function printDirectionBreakdown(trades: MTFTrade[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('DIRECTION BREAKDOWN');
  console.log('='.repeat(80));

  for (const dir of ['long', 'short'] as const) {
    const subset = trades.filter((t) => t.direction === dir);
    if (subset.length === 0) continue;

    const wins = subset.filter((t) => t.pnlPercent > 0).length;
    const wr = (wins / subset.length) * 100;
    const totalPnl = subset.reduce((s, t) => s + t.pnlPercent, 0);

    console.log(`\n  ${dir.toUpperCase()}: ${subset.length} trades, WR ${wr.toFixed(1)}%, PnL ${(totalPnl * 100).toFixed(2)}%`);
  }
}

// ============================================
// CLI
// ============================================

function getArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return undefined;
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
  const symbolsArg = getArg('symbols');
  const slModeArg = getArg('sl-mode');
  const frictionArg = getArg('friction');
  const suppressRegimeArg = getArg('suppress-regime');
  const slMultipleArg = getArg('sl-multiple');
  const tpMultipleArg = getArg('tp-multiple');

  const symbols = symbolsArg
    ? symbolsArg.split(',').map((s) => s.trim())
    : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

  const slMode: SLPlacementMode = (['ob_based', 'entry_based', 'dynamic_rr'] as const).includes(
    slModeArg as SLPlacementMode
  ) ? (slModeArg as SLPlacementMode) : 'ob_based';

  const slMultiple = slMultipleArg ? parseFloat(slMultipleArg) : 2.0;
  const tpMultiple = tpMultipleArg ? parseFloat(tpMultipleArg) : 4.0;

  const suppressedRegimes = suppressRegimeArg
    ? suppressRegimeArg.split(',').map((s) => s.trim())
    : [];

  if (frictionArg) {
    FRICTION_PER_SIDE = parseFloat(frictionArg);
    if (Number.isNaN(FRICTION_PER_SIDE) || FRICTION_PER_SIDE < 0) {
      console.error('Error: --friction must be a non-negative number (per-side fraction, e.g., 0.0007)');
      process.exit(1);
    }
  }

  // Config from PRODUCTION + iter 7 OB reaction confirmation defaults
  const proximity = PRODUCTION_STRATEGY_CONFIG.proximityPercent ?? 0.005;
  const minReactionBodyPercent = 0.4; // iter 7 default
  const cooldownBars15m = 24; // 6 hours = 6×4 15m bars

  console.log('='.repeat(80));
  console.log('MTF BACKTEST: 1H STRUCTURE + 15m ENTRY');
  console.log('='.repeat(80));
  console.log(`Symbols:          ${symbols.join(', ')}`);
  console.log(`SL mode:          ${slMode}`);
  console.log(`SL multiple:      ${slMultiple}×ATR`);
  console.log(`TP multiple:      ${tpMultiple}×ATR`);
  console.log(`Friction:         ${(FRICTION_PER_SIDE * 100).toFixed(3)}%/side (${(FRICTION_PER_SIDE * 2 * 100).toFixed(3)}% RT)`);
  console.log(`Suppress:         ${suppressedRegimes.length > 0 ? suppressedRegimes.join(', ') : 'none'}`);
  console.log(`OB proximity:     ${(proximity * 100).toFixed(1)}%`);
  console.log(`Reaction body:    ${(minReactionBodyPercent * 100).toFixed(0)}%`);
  console.log(`Cooldown:         ${cooldownBars15m} bars (15m) = ${cooldownBars15m / 4} hours`);
  console.log(`Max hold:         ${MAX_POSITION_BARS_15M} bars (15m) = ${MAX_POSITION_BARS_15M / 4} hours`);

  const allTrades: MTFTrade[] = [];

  for (const symbol of symbols) {
    const dataPath = path.join('data', `${symbol}_15m.json`);
    if (!fs.existsSync(dataPath)) {
      console.error(`\nData file not found: ${dataPath}`);
      continue;
    }

    console.log(`\nLoading ${symbol} 15m data...`);
    const candles15m: Candle[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    console.log(`  ${candles15m.length} 15m candles`);

    const trades = runMTFBacktest(
      candles15m, symbol, slMode, slMultiple, tpMultiple,
      suppressedRegimes, proximity, minReactionBodyPercent, cooldownBars15m,
    );

    console.log(`  ${trades.length} trades generated`);
    allTrades.push(...trades);
  }

  if (allTrades.length === 0) {
    console.log('\nNo trades generated. Check configuration.');
    process.exit(0);
  }

  console.log(`\nTotal trades across all symbols: ${allTrades.length}`);

  // Reports
  printSummary(allTrades);
  printExitDistribution(allTrades);
  printRegimeBreakdown(allTrades);
  printEntryImprovementAnalysis(allTrades);
  printDirectionBreakdown(allTrades);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
