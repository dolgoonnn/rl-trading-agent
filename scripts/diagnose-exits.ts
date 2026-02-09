#!/usr/bin/env npx tsx
/**
 * Exit-Type Diagnostic Script (Iteration 9)
 *
 * Extends the backtest to capture per-trade exit reason and realized R:R.
 * Finds the hidden -0.38% per-trade PnL leak by breaking down:
 *
 * 1. Exit reason distribution (SL / TP / max-bars / end-of-window)
 * 2. Max-bars exit deep dive (PnL distribution, are they sitting at breakeven?)
 * 3. SL/TP same-candle conflicts (SL checked first → artificial loss bias)
 * 4. Realized R:R by exit type
 * 5. Confluence score vs outcome (is there a WR inflection point?)
 * 6. Regime × exit type cross-tab
 *
 * Usage:
 *   npx tsx scripts/diagnose-exits.ts
 *   npx tsx scripts/diagnose-exits.ts --symbols BTCUSDT
 *   npx tsx scripts/diagnose-exits.ts --threshold 3.5
 *   npx tsx scripts/diagnose-exits.ts --strategy ob
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import {
  ConfluenceScorer,
  type ConfluenceScorerResult,
  type ConfluenceConfig,
  DEFAULT_CONFLUENCE_CONFIG,
  PRODUCTION_STRATEGY_CONFIG,
} from '../src/lib/rl/strategies/confluence-scorer';
import {
  detectRegime,
  regimeLabel,
} from '../src/lib/ict/regime-detector';
import type { StrategyName, SLPlacementMode } from '../src/lib/rl/strategies/ict-strategies';

// ============================================
// Types
// ============================================

type ExitReason = 'stop_loss' | 'take_profit' | 'max_bars' | 'end_of_window';

interface DiagnosticTrade {
  entryPrice: number;
  exitPrice: number;
  direction: 'long' | 'short';
  pnlPercent: number;
  strategy: string;
  exitReason: ExitReason;
  barsHeld: number;
  slPrice: number;
  tpPrice: number;
  /** |actual PnL| / riskDistance, negative if loss */
  realizedRR: number;
  confluenceScore: number;
  factorBreakdown: Record<string, number>;
  regimeAtEntry: string;
  /** Max favorable excursion as % of entry price */
  mfePercent: number;
  /** Max adverse excursion as % of entry price */
  maePercent: number;
  /** Did SL and TP both get hit on the same candle? */
  sameCandleSLTP: boolean;
  /** Entry timestamp for debugging */
  entryTimestamp: number;
  symbol: string;
}

interface SimulatedPosition {
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  direction: 'long' | 'short';
  entryIndex: number;
  entryTimestamp: number;
  strategy: string;
  confluenceScore: number;
  factorBreakdown: Record<string, number>;
}

// ============================================
// Constants
// ============================================

const MAX_POSITION_BARS = 100;
const DEFAULT_COMMISSION = 0.001;
const DEFAULT_SLIPPAGE = 0.0005;
let FRICTION_PER_SIDE = DEFAULT_COMMISSION + DEFAULT_SLIPPAGE;

// ============================================
// Position Simulation (Extended with exit reason tracking)
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

/**
 * Extended position simulation that tracks exit reason, MFE, MAE, and same-candle SL/TP conflicts.
 */
function simulatePositionDiagnostic(
  position: SimulatedPosition,
  candles: Candle[],
  startIndex: number,
  regimeAtEntry: string,
  symbol: string,
): DiagnosticTrade | null {
  const adjustedEntry = applyEntryFriction(position.entryPrice, position.direction);
  const riskDistance = Math.abs(position.entryPrice - position.stopLoss);

  let mfeRaw = 0; // max favorable excursion (raw price distance)
  let maeRaw = 0; // max adverse excursion (raw price distance)
  let sameCandleSLTPCount = 0;

  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;

    const barsHeld = i - position.entryIndex;

    // Track MFE/MAE
    if (position.direction === 'long') {
      const favorable = candle.high - position.entryPrice;
      const adverse = position.entryPrice - candle.low;
      if (favorable > mfeRaw) mfeRaw = favorable;
      if (adverse > maeRaw) maeRaw = adverse;
    } else {
      const favorable = position.entryPrice - candle.low;
      const adverse = candle.high - position.entryPrice;
      if (favorable > mfeRaw) mfeRaw = favorable;
      if (adverse > maeRaw) maeRaw = adverse;
    }

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

    // Track same-candle conflicts
    if (slHit && tpHit) {
      sameCandleSLTPCount++;
    }

    // Exit logic: SL checked first (current behavior)
    if (slHit) {
      const adjustedExit = applyExitFriction(position.stopLoss, position.direction);
      const pnlPercent = calculatePnlPercent(adjustedEntry, adjustedExit, position.direction);
      const realizedRR = riskDistance > 0 ? pnlPercent * position.entryPrice / riskDistance : 0;

      return {
        entryPrice: adjustedEntry,
        exitPrice: adjustedExit,
        direction: position.direction,
        pnlPercent,
        strategy: position.strategy,
        exitReason: 'stop_loss',
        barsHeld,
        slPrice: position.stopLoss,
        tpPrice: position.takeProfit,
        realizedRR,
        confluenceScore: position.confluenceScore,
        factorBreakdown: position.factorBreakdown,
        regimeAtEntry,
        mfePercent: mfeRaw / position.entryPrice,
        maePercent: maeRaw / position.entryPrice,
        sameCandleSLTP: slHit && tpHit,
        entryTimestamp: position.entryTimestamp,
        symbol,
      };
    }

    if (tpHit) {
      const adjustedExit = applyExitFriction(position.takeProfit, position.direction);
      const pnlPercent = calculatePnlPercent(adjustedEntry, adjustedExit, position.direction);
      const realizedRR = riskDistance > 0 ? pnlPercent * position.entryPrice / riskDistance : 0;

      return {
        entryPrice: adjustedEntry,
        exitPrice: adjustedExit,
        direction: position.direction,
        pnlPercent,
        strategy: position.strategy,
        exitReason: 'take_profit',
        barsHeld,
        slPrice: position.stopLoss,
        tpPrice: position.takeProfit,
        realizedRR,
        confluenceScore: position.confluenceScore,
        factorBreakdown: position.factorBreakdown,
        regimeAtEntry,
        mfePercent: mfeRaw / position.entryPrice,
        maePercent: maeRaw / position.entryPrice,
        sameCandleSLTP: false,
        entryTimestamp: position.entryTimestamp,
        symbol,
      };
    }

    // Max bars exit
    if (barsHeld >= MAX_POSITION_BARS) {
      const adjustedExit = applyExitFriction(candle.close, position.direction);
      const pnlPercent = calculatePnlPercent(adjustedEntry, adjustedExit, position.direction);
      const realizedRR = riskDistance > 0 ? pnlPercent * position.entryPrice / riskDistance : 0;

      return {
        entryPrice: adjustedEntry,
        exitPrice: adjustedExit,
        direction: position.direction,
        pnlPercent,
        strategy: position.strategy,
        exitReason: 'max_bars',
        barsHeld,
        slPrice: position.stopLoss,
        tpPrice: position.takeProfit,
        realizedRR,
        confluenceScore: position.confluenceScore,
        factorBreakdown: position.factorBreakdown,
        regimeAtEntry,
        mfePercent: mfeRaw / position.entryPrice,
        maePercent: maeRaw / position.entryPrice,
        sameCandleSLTP: false,
        entryTimestamp: position.entryTimestamp,
        symbol,
      };
    }
  }

  // End-of-window exit
  const lastCandle = candles[candles.length - 1];
  if (!lastCandle) return null;

  const adjustedExit = applyExitFriction(lastCandle.close, position.direction);
  const pnlPercent = calculatePnlPercent(adjustedEntry, adjustedExit, position.direction);
  const realizedRR = riskDistance > 0 ? pnlPercent * position.entryPrice / riskDistance : 0;

  return {
    entryPrice: adjustedEntry,
    exitPrice: adjustedExit,
    direction: position.direction,
    pnlPercent,
    strategy: position.strategy,
    exitReason: 'end_of_window',
    barsHeld: candles.length - 1 - position.entryIndex,
    slPrice: position.stopLoss,
    tpPrice: position.takeProfit,
    realizedRR,
    confluenceScore: position.confluenceScore,
    factorBreakdown: position.factorBreakdown,
    regimeAtEntry,
    mfePercent: mfeRaw / position.entryPrice,
    maePercent: maeRaw / position.entryPrice,
    sameCandleSLTP: false,
    entryTimestamp: position.entryTimestamp,
    symbol,
  };
}

// ============================================
// Run Diagnostic Backtest
// ============================================

function runDiagnosticBacktest(
  candles: Candle[],
  symbol: string,
  threshold: number,
  scorerConfig: Partial<ConfluenceConfig>,
): DiagnosticTrade[] {
  const scorer = new ConfluenceScorer({
    minThreshold: threshold,
    ...scorerConfig,
  });

  const trades: DiagnosticTrade[] = [];
  let currentPosition: SimulatedPosition | null = null;
  let positionExitIndex = -1;

  // Start after enough lookback for structure detection
  const startIndex = 200;

  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;

    // If in position, skip until it closes
    if (currentPosition !== null && i <= positionExitIndex) {
      continue;
    }
    currentPosition = null;

    // Evaluate confluence
    const result: ConfluenceScorerResult = scorer.evaluate(candles, i);

    if (result.action === 'trade' && result.selectedSignal !== null) {
      const signal = result.selectedSignal.signal;

      const position: SimulatedPosition = {
        entryPrice: signal.entryPrice,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        direction: signal.direction,
        entryIndex: i,
        entryTimestamp: candle.timestamp,
        strategy: signal.strategy,
        confluenceScore: result.selectedSignal.totalScore,
        factorBreakdown: { ...result.selectedSignal.factorBreakdown },
      };

      // Detect regime at entry
      const regime = detectRegime(candles, i);
      const regimeStr = regimeLabel(regime);

      // Simulate the trade
      const trade = simulatePositionDiagnostic(position, candles, i + 1, regimeStr, symbol);

      if (trade) {
        trades.push(trade);

        // Skip to exit bar
        let exitIdx = i + 1;
        for (let j = i + 1; j < candles.length; j++) {
          const c = candles[j];
          if (c && c.timestamp >= trade.entryTimestamp + trade.barsHeld * 3600000) {
            exitIdx = j;
            break;
          }
        }
        // Simpler: just skip by barsHeld
        positionExitIndex = i + trade.barsHeld;
        currentPosition = position;
      }
    }
  }

  return trades;
}

// ============================================
// Analysis & Reporting
// ============================================

function printExitReasonDistribution(trades: DiagnosticTrade[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('1. EXIT REASON DISTRIBUTION');
  console.log('='.repeat(80));

  const reasons: ExitReason[] = ['stop_loss', 'take_profit', 'max_bars', 'end_of_window'];

  console.log(
    `\n  ${'Exit Reason'.padEnd(18)} ${'Count'.padStart(6)} ${'%'.padStart(7)} ${'Avg PnL%'.padStart(10)} ${'Total PnL%'.padStart(12)} ${'Avg R:R'.padStart(8)} ${'Avg Bars'.padStart(9)}`
  );
  console.log('  ' + '-'.repeat(75));

  for (const reason of reasons) {
    const subset = trades.filter((t) => t.exitReason === reason);
    if (subset.length === 0) continue;

    const pct = (subset.length / trades.length) * 100;
    const avgPnl = subset.reduce((s, t) => s + t.pnlPercent, 0) / subset.length;
    const totalPnl = subset.reduce((s, t) => s + t.pnlPercent, 0);
    const avgRR = subset.reduce((s, t) => s + t.realizedRR, 0) / subset.length;
    const avgBars = subset.reduce((s, t) => s + t.barsHeld, 0) / subset.length;

    console.log(
      `  ${reason.padEnd(18)} ${subset.length.toString().padStart(6)} ${pct.toFixed(1).padStart(6)}% ${(avgPnl * 100).toFixed(3).padStart(9)}% ${(totalPnl * 100).toFixed(2).padStart(11)}% ${avgRR.toFixed(3).padStart(8)} ${avgBars.toFixed(1).padStart(9)}`
    );
  }

  // Totals
  const totalPnl = trades.reduce((s, t) => s + t.pnlPercent, 0);
  const avgPnl = trades.length > 0 ? totalPnl / trades.length : 0;
  console.log('  ' + '-'.repeat(75));
  console.log(
    `  ${'TOTAL'.padEnd(18)} ${trades.length.toString().padStart(6)} ${'100.0'.padStart(6)}% ${(avgPnl * 100).toFixed(3).padStart(9)}% ${(totalPnl * 100).toFixed(2).padStart(11)}%`
  );
}

function printMaxBarsDeepDive(trades: DiagnosticTrade[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('2. MAX-BARS EXIT DEEP DIVE');
  console.log('='.repeat(80));

  const maxBarsTrades = trades.filter((t) => t.exitReason === 'max_bars');
  if (maxBarsTrades.length === 0) {
    console.log('\n  No max-bars exits found.');
    return;
  }

  console.log(`\n  Total max-bars exits: ${maxBarsTrades.length} (${((maxBarsTrades.length / trades.length) * 100).toFixed(1)}% of all trades)`);

  // PnL distribution of max-bars exits
  const pnls = maxBarsTrades.map((t) => t.pnlPercent * 100);
  pnls.sort((a, b) => a - b);

  const positive = maxBarsTrades.filter((t) => t.pnlPercent > 0).length;
  const negative = maxBarsTrades.filter((t) => t.pnlPercent < 0).length;
  const nearZero = maxBarsTrades.filter((t) => Math.abs(t.pnlPercent) < 0.002).length;

  console.log(`  Positive PnL: ${positive} (${((positive / maxBarsTrades.length) * 100).toFixed(1)}%)`);
  console.log(`  Negative PnL: ${negative} (${((negative / maxBarsTrades.length) * 100).toFixed(1)}%)`);
  console.log(`  Near-zero (<0.2%): ${nearZero} (${((nearZero / maxBarsTrades.length) * 100).toFixed(1)}%)`);

  const avgPnl = pnls.reduce((s, v) => s + v, 0) / pnls.length;
  const medianPnl = pnls[Math.floor(pnls.length / 2)] ?? 0;
  const totalPnl = pnls.reduce((s, v) => s + v, 0);

  console.log(`\n  Avg PnL:    ${avgPnl.toFixed(3)}%`);
  console.log(`  Median PnL: ${medianPnl.toFixed(3)}%`);
  console.log(`  Total PnL:  ${totalPnl.toFixed(2)}%`);

  // MFE analysis for max-bars exits
  const avgMFE = maxBarsTrades.reduce((s, t) => s + t.mfePercent, 0) / maxBarsTrades.length;
  const mfeOverTP = maxBarsTrades.filter((t) => {
    const tpDistance = Math.abs(t.tpPrice - t.entryPrice) / t.entryPrice;
    return t.mfePercent >= tpDistance;
  }).length;

  console.log(`\n  Avg MFE: ${(avgMFE * 100).toFixed(3)}%`);
  console.log(`  Reached TP level before timeout: ${mfeOverTP} (${((mfeOverTP / maxBarsTrades.length) * 100).toFixed(1)}%)`);
  console.log('  ^ These are trades where TP WAS reachable but we timed out — potential trailing stop opportunity');
}

function printSameCandleConflicts(trades: DiagnosticTrade[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('3. SL/TP SAME-CANDLE CONFLICTS');
  console.log('   (Both SL and TP hit on same candle — current code picks SL)');
  console.log('='.repeat(80));

  const conflicts = trades.filter((t) => t.sameCandleSLTP);
  console.log(`\n  Same-candle SL/TP conflicts: ${conflicts.length} (${((conflicts.length / trades.length) * 100).toFixed(1)}% of all trades)`);

  if (conflicts.length === 0) {
    console.log('  No conflicts — SL-first bias is not a factor.');
    return;
  }

  // All of these were resolved as SL hits. How much PnL would change if 50% were TP instead?
  const slPnlTotal = conflicts.reduce((s, t) => s + t.pnlPercent, 0);
  console.log(`\n  Current PnL impact (all counted as SL): ${(slPnlTotal * 100).toFixed(2)}%`);

  // Estimate: if 50% were TP hits, what would the PnL be?
  let estimatedPnl = 0;
  for (const t of conflicts) {
    // 50% SL, 50% TP
    const slResult = t.pnlPercent; // current (SL)
    const tpPnl = calculatePnlPercent(
      t.entryPrice,
      applyExitFriction(t.tpPrice, t.direction),
      t.direction,
    );
    estimatedPnl += (slResult + tpPnl) / 2;
  }

  console.log(`  Estimated PnL (50/50 resolution): ${(estimatedPnl * 100).toFixed(2)}%`);
  console.log(`  PnL LEAK from SL-first bias: ${((slPnlTotal - estimatedPnl) * 100).toFixed(2)}%`);

  // Distance-based resolution estimate: whichever is closer to candle open
  console.log('\n  Per-conflict detail (first 20):');
  console.log(`  ${'Direction'.padEnd(7)} ${'RiskDist'.padStart(9)} ${'SL PnL%'.padStart(9)} ${'TP PnL%'.padStart(9)} ${'Regime'.padEnd(18)}`);
  console.log('  ' + '-'.repeat(55));

  const sample = conflicts.slice(0, 20);
  for (const t of sample) {
    const riskDist = Math.abs(t.slPrice - t.entryPrice);
    const tpPnl = calculatePnlPercent(
      t.entryPrice,
      applyExitFriction(t.tpPrice, t.direction),
      t.direction,
    );
    console.log(
      `  ${t.direction.padEnd(7)} ${(riskDist / t.entryPrice * 100).toFixed(3).padStart(8)}% ${(t.pnlPercent * 100).toFixed(3).padStart(8)}% ${(tpPnl * 100).toFixed(3).padStart(8)}% ${t.regimeAtEntry.padEnd(18)}`
    );
  }
}

function printRealizedRRByExitType(trades: DiagnosticTrade[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('4. REALIZED R:R BY EXIT TYPE');
  console.log('   (Target is 2.0R for TP, -1.0R for SL)');
  console.log('='.repeat(80));

  const reasons: ExitReason[] = ['stop_loss', 'take_profit', 'max_bars', 'end_of_window'];

  console.log(
    `\n  ${'Exit Reason'.padEnd(18)} ${'Count'.padStart(6)} ${'Avg R:R'.padStart(8)} ${'Min R:R'.padStart(8)} ${'Max R:R'.padStart(8)} ${'Median R:R'.padStart(10)}`
  );
  console.log('  ' + '-'.repeat(60));

  for (const reason of reasons) {
    const subset = trades.filter((t) => t.exitReason === reason);
    if (subset.length === 0) continue;

    const rrs = subset.map((t) => t.realizedRR).sort((a, b) => a - b);
    const avg = rrs.reduce((s, v) => s + v, 0) / rrs.length;
    const min = rrs[0] ?? 0;
    const max = rrs[rrs.length - 1] ?? 0;
    const median = rrs[Math.floor(rrs.length / 2)] ?? 0;

    console.log(
      `  ${reason.padEnd(18)} ${subset.length.toString().padStart(6)} ${avg.toFixed(3).padStart(8)} ${min.toFixed(3).padStart(8)} ${max.toFixed(3).padStart(8)} ${median.toFixed(3).padStart(10)}`
    );
  }

  // Friction analysis
  const targetRR = 2.0; // TP at 4×ATR, SL at 2×ATR → 2:1
  const frictionCost = 2 * FRICTION_PER_SIDE; // 0.3% round-trip
  const tpTrades = trades.filter((t) => t.exitReason === 'take_profit');
  if (tpTrades.length > 0) {
    const avgTPRR = tpTrades.reduce((s, t) => s + t.realizedRR, 0) / tpTrades.length;
    const rrDegradation = targetRR - avgTPRR;
    console.log(`\n  Target TP R:R: ${targetRR.toFixed(1)} | Realized: ${avgTPRR.toFixed(3)} | Degradation: ${rrDegradation.toFixed(3)}`);
    console.log(`  Round-trip friction: ${(frictionCost * 100).toFixed(2)}% → effective R:R reduced by ~${(frictionCost / (tpTrades[0]?.slPrice ? Math.abs(tpTrades[0].entryPrice - tpTrades[0].slPrice) / tpTrades[0].entryPrice : 0.02) || 0).toFixed(2)}R`);
  }
}

function printConfluenceScoreVsOutcome(trades: DiagnosticTrade[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('5. CONFLUENCE SCORE vs OUTCOME');
  console.log('   (Is there a score threshold where WR flips positive?)');
  console.log('='.repeat(80));

  // Score buckets
  const buckets = [
    { min: 3.0, max: 4.0 },
    { min: 4.0, max: 5.0 },
    { min: 5.0, max: 6.0 },
    { min: 6.0, max: 7.0 },
    { min: 7.0, max: 8.0 },
    { min: 8.0, max: 12.0 },
  ];

  console.log(
    `\n  ${'Score Range'.padEnd(14)} ${'Trades'.padStart(7)} ${'TP Hit'.padStart(7)} ${'SL Hit'.padStart(7)} ${'MaxBars'.padStart(8)} ${'WR%'.padStart(7)} ${'Avg PnL%'.padStart(10)} ${'Total PnL%'.padStart(12)}`
  );
  console.log('  ' + '-'.repeat(85));

  for (const bucket of buckets) {
    const subset = trades.filter((t) => t.confluenceScore >= bucket.min && t.confluenceScore < bucket.max);
    if (subset.length === 0) continue;

    const tp = subset.filter((t) => t.exitReason === 'take_profit').length;
    const sl = subset.filter((t) => t.exitReason === 'stop_loss').length;
    const mb = subset.filter((t) => t.exitReason === 'max_bars').length;
    const wr = subset.length > 0 ? (subset.filter((t) => t.pnlPercent > 0).length / subset.length) * 100 : 0;
    const avgPnl = subset.reduce((s, t) => s + t.pnlPercent, 0) / subset.length;
    const totalPnl = subset.reduce((s, t) => s + t.pnlPercent, 0);

    const label = `${bucket.min.toFixed(1)}-${bucket.max.toFixed(1)}`;
    console.log(
      `  ${label.padEnd(14)} ${subset.length.toString().padStart(7)} ${tp.toString().padStart(7)} ${sl.toString().padStart(7)} ${mb.toString().padStart(8)} ${wr.toFixed(1).padStart(6)}% ${(avgPnl * 100).toFixed(3).padStart(9)}% ${(totalPnl * 100).toFixed(2).padStart(11)}%`
    );
  }
}

function printRegimeExitCrossTab(trades: DiagnosticTrade[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('6. REGIME x EXIT TYPE CROSS-TAB');
  console.log('   (Which regimes produce the most max-bars exits?)');
  console.log('='.repeat(80));

  // Collect unique regimes
  const regimes = [...new Set(trades.map((t) => t.regimeAtEntry))].sort();

  console.log(
    `\n  ${'Regime'.padEnd(20)} ${'Total'.padStart(6)} ${'SL'.padStart(5)} ${'TP'.padStart(5)} ${'Max'.padStart(5)} ${'EoW'.padStart(5)} ${'WR%'.padStart(7)} ${'Avg PnL%'.padStart(10)} ${'Total PnL%'.padStart(12)}`
  );
  console.log('  ' + '-'.repeat(85));

  for (const regime of regimes) {
    const subset = trades.filter((t) => t.regimeAtEntry === regime);
    const sl = subset.filter((t) => t.exitReason === 'stop_loss').length;
    const tp = subset.filter((t) => t.exitReason === 'take_profit').length;
    const mb = subset.filter((t) => t.exitReason === 'max_bars').length;
    const eow = subset.filter((t) => t.exitReason === 'end_of_window').length;
    const wr = subset.length > 0 ? (subset.filter((t) => t.pnlPercent > 0).length / subset.length) * 100 : 0;
    const avgPnl = subset.reduce((s, t) => s + t.pnlPercent, 0) / subset.length;
    const totalPnl = subset.reduce((s, t) => s + t.pnlPercent, 0);

    console.log(
      `  ${regime.padEnd(20)} ${subset.length.toString().padStart(6)} ${sl.toString().padStart(5)} ${tp.toString().padStart(5)} ${mb.toString().padStart(5)} ${eow.toString().padStart(5)} ${wr.toFixed(1).padStart(6)}% ${(avgPnl * 100).toFixed(3).padStart(9)}% ${(totalPnl * 100).toFixed(2).padStart(11)}%`
    );
  }
}

function printFrictionAnalysis(trades: DiagnosticTrade[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('7. FRICTION ANALYSIS');
  console.log('   (How much does commission+slippage degrade the P&L?)');
  console.log('='.repeat(80));

  const roundTripFriction = 2 * FRICTION_PER_SIDE; // 0.3%
  const totalFrictionCost = trades.length * roundTripFriction;
  const totalPnl = trades.reduce((s, t) => s + t.pnlPercent, 0);

  console.log(`\n  Trades: ${trades.length}`);
  console.log(`  Per-side friction: ${(FRICTION_PER_SIDE * 100).toFixed(2)}%`);
  console.log(`  Round-trip friction: ${(roundTripFriction * 100).toFixed(2)}%`);
  console.log(`  Total friction cost: ${(totalFrictionCost * 100).toFixed(2)}%`);
  console.log(`  Actual total PnL (after friction): ${(totalPnl * 100).toFixed(2)}%`);
  console.log(`  Estimated PnL without friction: ${((totalPnl + totalFrictionCost) * 100).toFixed(2)}%`);
  console.log(`  Friction as % of total loss: ${totalPnl < 0 ? ((totalFrictionCost / Math.abs(totalPnl)) * 100).toFixed(1) : 'N/A'}%`);
}

function printDirectionAnalysis(trades: DiagnosticTrade[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('8. DIRECTION ANALYSIS');
  console.log('='.repeat(80));

  for (const dir of ['long', 'short'] as const) {
    const subset = trades.filter((t) => t.direction === dir);
    if (subset.length === 0) continue;

    const wr = (subset.filter((t) => t.pnlPercent > 0).length / subset.length) * 100;
    const avgPnl = subset.reduce((s, t) => s + t.pnlPercent, 0) / subset.length;
    const totalPnl = subset.reduce((s, t) => s + t.pnlPercent, 0);
    const sl = subset.filter((t) => t.exitReason === 'stop_loss').length;
    const tp = subset.filter((t) => t.exitReason === 'take_profit').length;
    const mb = subset.filter((t) => t.exitReason === 'max_bars').length;

    console.log(`\n  ${dir.toUpperCase()}: ${subset.length} trades`);
    console.log(`    WR: ${wr.toFixed(1)}% | Avg PnL: ${(avgPnl * 100).toFixed(3)}% | Total PnL: ${(totalPnl * 100).toFixed(2)}%`);
    console.log(`    SL: ${sl} | TP: ${tp} | MaxBars: ${mb}`);
  }
}

function printBarsHeldDistribution(trades: DiagnosticTrade[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('9. BARS HELD DISTRIBUTION');
  console.log('='.repeat(80));

  const buckets = [
    { min: 0, max: 5, label: '0-5' },
    { min: 5, max: 10, label: '5-10' },
    { min: 10, max: 20, label: '10-20' },
    { min: 20, max: 50, label: '20-50' },
    { min: 50, max: 75, label: '50-75' },
    { min: 75, max: 100, label: '75-100' },
    { min: 100, max: Infinity, label: '100+' },
  ];

  console.log(
    `\n  ${'Bars'.padEnd(10)} ${'Count'.padStart(6)} ${'%'.padStart(7)} ${'WR%'.padStart(7)} ${'Avg PnL%'.padStart(10)}`
  );
  console.log('  ' + '-'.repeat(45));

  for (const b of buckets) {
    const subset = trades.filter((t) => t.barsHeld >= b.min && t.barsHeld < b.max);
    if (subset.length === 0) continue;

    const pct = (subset.length / trades.length) * 100;
    const wr = (subset.filter((t) => t.pnlPercent > 0).length / subset.length) * 100;
    const avgPnl = subset.reduce((s, t) => s + t.pnlPercent, 0) / subset.length;

    console.log(
      `  ${b.label.padEnd(10)} ${subset.length.toString().padStart(6)} ${pct.toFixed(1).padStart(6)}% ${wr.toFixed(1).padStart(6)}% ${(avgPnl * 100).toFixed(3).padStart(9)}%`
    );
  }
}

function printSummary(trades: DiagnosticTrade[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('LEAK SUMMARY');
  console.log('='.repeat(80));

  const totalPnl = trades.reduce((s, t) => s + t.pnlPercent, 0);
  const avgPnl = trades.length > 0 ? totalPnl / trades.length : 0;
  const wr = trades.length > 0 ? (trades.filter((t) => t.pnlPercent > 0).length / trades.length) * 100 : 0;

  // Calculate expected PnL at 41% WR with 2:1 R:R
  const expectedAvgPnl = (wr / 100) * 2.0 * 0.02 - ((100 - wr) / 100) * 1.0 * 0.02; // 2% risk per trade
  const actualAvgPnl = avgPnl;
  const leak = expectedAvgPnl - actualAvgPnl;

  console.log(`\n  Total trades: ${trades.length}`);
  console.log(`  Win rate: ${wr.toFixed(1)}%`);
  console.log(`  Avg PnL: ${(avgPnl * 100).toFixed(3)}%`);
  console.log(`  Total PnL: ${(totalPnl * 100).toFixed(2)}%`);

  // Breakdown by source of PnL drag
  const slTrades = trades.filter((t) => t.exitReason === 'stop_loss');
  const tpTrades = trades.filter((t) => t.exitReason === 'take_profit');
  const mbTrades = trades.filter((t) => t.exitReason === 'max_bars');
  const conflictTrades = trades.filter((t) => t.sameCandleSLTP);
  const frictionTotal = trades.length * 2 * FRICTION_PER_SIDE;

  console.log('\n  PnL BREAKDOWN BY SOURCE:');
  console.log(`    SL exits:       ${(slTrades.reduce((s, t) => s + t.pnlPercent, 0) * 100).toFixed(2)}% (${slTrades.length} trades)`);
  console.log(`    TP exits:       ${(tpTrades.reduce((s, t) => s + t.pnlPercent, 0) * 100).toFixed(2)}% (${tpTrades.length} trades)`);
  console.log(`    Max-bars exits: ${(mbTrades.reduce((s, t) => s + t.pnlPercent, 0) * 100).toFixed(2)}% (${mbTrades.length} trades)`);
  console.log(`    SL/TP conflicts:${conflictTrades.length} trades affected`);
  console.log(`    Total friction: ${(frictionTotal * 100).toFixed(2)}%`);

  // Per-regime PnL contribution
  const regimes = [...new Set(trades.map((t) => t.regimeAtEntry))].sort();
  console.log('\n  PnL BY REGIME:');
  for (const regime of regimes) {
    const subset = trades.filter((t) => t.regimeAtEntry === regime);
    const regPnl = subset.reduce((s, t) => s + t.pnlPercent, 0);
    console.log(`    ${regime.padEnd(20)} ${(regPnl * 100).toFixed(2).padStart(8)}% (${subset.length} trades)`);
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

const STRATEGY_SHORTHAND: Record<string, StrategyName> = {
  ob: 'order_block',
  order_block: 'order_block',
  fvg: 'fvg',
  bos: 'bos_continuation',
  choch: 'choch_reversal',
};

function parseStrategyArg(arg: string): StrategyName[] {
  return arg.split(',').map((s) => {
    const key = s.trim().toLowerCase();
    const mapped = STRATEGY_SHORTHAND[key];
    if (!mapped) {
      throw new Error(`Unknown strategy shorthand: "${key}". Valid: ${Object.keys(STRATEGY_SHORTHAND).join(', ')}`);
    }
    return mapped;
  });
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
  const thresholdArg = getArg('threshold');
  const symbolsArg = getArg('symbols');
  const strategyArg = getArg('strategy');
  const suppressRegimeArg = getArg('suppress-regime');
  const timeframeArg = getArg('timeframe');
  const frictionArg = getArg('friction');
  const slModeArg = getArg('sl-mode');

  const threshold = thresholdArg ? parseFloat(thresholdArg) : DEFAULT_CONFLUENCE_CONFIG.minThreshold;
  const timeframe = timeframeArg ?? '1h';
  const symbols = symbolsArg
    ? symbolsArg.split(',').map((s) => s.trim())
    : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  const activeStrategies = strategyArg ? parseStrategyArg(strategyArg) : undefined;
  const suppressedRegimes = suppressRegimeArg
    ? suppressRegimeArg.split(',').map((s) => s.trim())
    : [];

  // Apply friction override
  if (frictionArg) {
    FRICTION_PER_SIDE = parseFloat(frictionArg);
    if (Number.isNaN(FRICTION_PER_SIDE) || FRICTION_PER_SIDE < 0) {
      console.error('Error: --friction must be a non-negative number (per-side fraction, e.g., 0.0007)');
      process.exit(1);
    }
  }

  // Parse SL placement mode
  const slPlacementMode: SLPlacementMode = (['ob_based', 'entry_based', 'dynamic_rr'] as const).includes(
    slModeArg as SLPlacementMode
  ) ? (slModeArg as SLPlacementMode) : 'ob_based';

  const scorerConfig: Partial<ConfluenceConfig> = {
    minSignalRR: 1.5,
    strategyConfig: { ...PRODUCTION_STRATEGY_CONFIG, slPlacementMode },
    ...(activeStrategies ? { activeStrategies } : {}),
    ...(suppressedRegimes.length > 0 ? { suppressedRegimes } : {}),
  };

  console.log('='.repeat(80));
  console.log('ITERATION 10: EXIT-TYPE DIAGNOSTICS');
  console.log('='.repeat(80));
  console.log(`Threshold:  ${threshold}`);
  console.log(`Symbols:    ${symbols.join(', ')}`);
  console.log(`Strategies: ${activeStrategies ? activeStrategies.join(', ') : 'default (ob, fvg)'}`);
  console.log(`Suppress:   ${suppressedRegimes.length > 0 ? suppressedRegimes.join(', ') : 'none'}`);
  console.log(`SL mode:    ${slPlacementMode}`);
  console.log(`Timeframe:  ${timeframe}`);
  console.log(`Max bars:   ${MAX_POSITION_BARS}`);
  console.log(`Friction:   ${(FRICTION_PER_SIDE * 100).toFixed(3)}% per side (${(FRICTION_PER_SIDE * 2 * 100).toFixed(3)}% RT)`);

  const allTrades: DiagnosticTrade[] = [];

  for (const symbol of symbols) {
    const dataPath = path.join('data', `${symbol}_${timeframe}.json`);
    if (!fs.existsSync(dataPath)) {
      console.error(`Data file not found: ${dataPath}`);
      continue;
    }

    console.log(`\nLoading ${symbol}...`);
    const candles: Candle[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    console.log(`  ${candles.length} candles`);

    const trades = runDiagnosticBacktest(candles, symbol, threshold, scorerConfig);
    console.log(`  ${trades.length} trades generated`);
    allTrades.push(...trades);
  }

  if (allTrades.length === 0) {
    console.log('\nNo trades generated. Check configuration.');
    process.exit(0);
  }

  console.log(`\nTotal trades across all symbols: ${allTrades.length}`);

  // Run all analysis reports
  printExitReasonDistribution(allTrades);
  printMaxBarsDeepDive(allTrades);
  printSameCandleConflicts(allTrades);
  printRealizedRRByExitType(allTrades);
  printConfluenceScoreVsOutcome(allTrades);
  printRegimeExitCrossTab(allTrades);
  printFrictionAnalysis(allTrades);
  printDirectionAnalysis(allTrades);
  printBarsHeldDistribution(allTrades);
  printSummary(allTrades);

  // Per-symbol summary
  for (const symbol of symbols) {
    const symbolTrades = allTrades.filter((t) => t.symbol === symbol);
    if (symbolTrades.length === 0) continue;

    console.log(`\n${'='.repeat(40)}`);
    console.log(`SYMBOL: ${symbol}`);
    console.log(`${'='.repeat(40)}`);

    const wr = (symbolTrades.filter((t) => t.pnlPercent > 0).length / symbolTrades.length) * 100;
    const totalPnl = symbolTrades.reduce((s, t) => s + t.pnlPercent, 0);
    const conflicts = symbolTrades.filter((t) => t.sameCandleSLTP).length;
    const mbExits = symbolTrades.filter((t) => t.exitReason === 'max_bars').length;

    console.log(`  Trades: ${symbolTrades.length} | WR: ${wr.toFixed(1)}% | Total PnL: ${(totalPnl * 100).toFixed(2)}%`);
    console.log(`  SL/TP conflicts: ${conflicts} | Max-bars exits: ${mbExits}`);
  }

  console.log('\n');
}

main().catch((err: unknown) => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});
