#!/usr/bin/env npx tsx
/**
 * Signal Quality Diagnostic Script
 *
 * Examines the quality of trading signals from the ConfluenceScorer.
 * Core question: Are entries happening at levels where price has ANY
 * favorable movement, or are they immediately going against us?
 *
 * For each signal:
 * - Tracks MFE (Max Favorable Excursion) -- how far price went in our favor
 * - Tracks MAE (Max Adverse Excursion) -- how far price went against us
 * - Simulates SL/TP outcome
 * - Records which confluence factors contributed
 *
 * Aggregate output:
 * - MFE distribution (does price ever go in our direction?)
 * - MAE distribution (how quickly does price go against us?)
 * - Win rate per strategy
 * - Factor breakdown for winning vs losing trades
 */

import fs from 'fs';
import type { Candle } from '@/types';
import {
  ConfluenceScorer,
  PRODUCTION_STRATEGY_CONFIG,
  type ScoredSignal,
} from '../src/lib/rl/strategies/confluence-scorer';

// ============================================
// Types
// ============================================

type TradeOutcome = 'tp_hit' | 'sl_hit' | 'timeout';

interface TradeRecord {
  /** Bar index where the signal was generated */
  entryBar: number;
  /** Entry price from the signal */
  entryPrice: number;
  /** Stop loss price */
  stopLoss: number;
  /** Take profit price */
  takeProfit: number;
  /** Signal direction */
  direction: 'long' | 'short';
  /** Strategy that generated the signal */
  strategy: string;
  /** Risk-to-reward ratio */
  riskReward: number;
  /** Confluence score */
  score: number;
  /** Factor breakdown from the scorer */
  factorBreakdown: Record<string, number>;
  /** Max favorable excursion as R-multiple */
  mfeR: number;
  /** Max adverse excursion as R-multiple */
  maeR: number;
  /** Actual outcome */
  outcome: TradeOutcome;
  /** Bars until exit */
  barsToExit: number;
  /** Actual R achieved (positive for wins, negative for losses) */
  actualR: number;
}

// ============================================
// Configuration
// ============================================

const MAX_HOLD_BARS = 100; // Timeout after 100 bars (~4 days on 1h)
const COOLDOWN_BARS = 5;   // Minimum bars between signals to avoid overlaps

// ============================================
// Load Data
// ============================================

const dataPath = 'data/BTCUSDT_1h.json';
console.log(`Loading data from ${dataPath}...`);
const rawData = fs.readFileSync(dataPath, 'utf-8');
const allCandles: Candle[] = JSON.parse(rawData);

// Use last 2000 candles
const candles = allCandles.slice(-2000);
console.log(`Loaded ${allCandles.length} total candles, using last ${candles.length}`);
console.log(
  `Date range: ${new Date(candles[0]!.timestamp).toISOString()} -> ${new Date(candles[candles.length - 1]!.timestamp).toISOString()}`
);

// ============================================
// Initialize Scorer
// ============================================

const scorer = new ConfluenceScorer({
  minThreshold: 5.0,
  minSignalRR: 2.0,
  strategyConfig: PRODUCTION_STRATEGY_CONFIG,
});

const config = scorer.getConfig();
console.log(`\nScorer config:`);
console.log(`  minThreshold: ${config.minThreshold}`);
console.log(`  minSignalRR: ${config.minSignalRR}`);
console.log(`  weights:`, JSON.stringify(config.weights, null, 2));

// ============================================
// Simulate Trades
// ============================================

function simulateTrade(
  signal: ScoredSignal,
  entryBarIndex: number,
): TradeRecord {
  const { entryPrice, stopLoss, takeProfit, direction, strategy, riskReward } =
    signal.signal;
  const risk = Math.abs(entryPrice - stopLoss);

  let mfeR = 0; // Max favorable excursion in R-multiples
  let maeR = 0; // Max adverse excursion in R-multiples
  let outcome: TradeOutcome = 'timeout';
  let barsToExit = MAX_HOLD_BARS;
  let actualR = 0;

  for (let offset = 1; offset <= MAX_HOLD_BARS; offset++) {
    const barIdx = entryBarIndex + offset;
    if (barIdx >= candles.length) {
      barsToExit = offset;
      outcome = 'timeout';
      // Calculate R at last available bar
      const lastBar = candles[candles.length - 1]!;
      const exitPrice = lastBar.close;
      actualR =
        direction === 'long'
          ? (exitPrice - entryPrice) / risk
          : (entryPrice - exitPrice) / risk;
      break;
    }

    const bar = candles[barIdx]!;

    // Calculate favorable and adverse excursion for this bar
    let favorablePrice: number;
    let adversePrice: number;

    if (direction === 'long') {
      favorablePrice = bar.high;
      adversePrice = bar.low;
    } else {
      favorablePrice = bar.low;
      adversePrice = bar.high;
    }

    const favorableR =
      direction === 'long'
        ? (favorablePrice - entryPrice) / risk
        : (entryPrice - favorablePrice) / risk;

    const adverseR =
      direction === 'long'
        ? (entryPrice - adversePrice) / risk
        : (adversePrice - entryPrice) / risk;

    if (favorableR > mfeR) mfeR = favorableR;
    if (adverseR > maeR) maeR = adverseR;

    // Check SL hit (use high/low to simulate intra-bar)
    const slHit =
      direction === 'long' ? bar.low <= stopLoss : bar.high >= stopLoss;

    // Check TP hit
    const tpHit =
      direction === 'long' ? bar.high >= takeProfit : bar.low <= takeProfit;

    if (slHit && tpHit) {
      // Both hit in same bar -- assume SL hit first if open is closer to SL
      // (conservative assumption: assume the worse outcome)
      outcome = 'sl_hit';
      barsToExit = offset;
      actualR = -1.0;
      break;
    } else if (slHit) {
      outcome = 'sl_hit';
      barsToExit = offset;
      actualR = -1.0;
      break;
    } else if (tpHit) {
      outcome = 'tp_hit';
      barsToExit = offset;
      actualR = riskReward;
      break;
    }
  }

  // If timeout, calculate R at close of last bar in hold window
  if (outcome === 'timeout') {
    const timeoutIdx = Math.min(entryBarIndex + MAX_HOLD_BARS, candles.length - 1);
    const timeoutBar = candles[timeoutIdx]!;
    actualR =
      direction === 'long'
        ? (timeoutBar.close - entryPrice) / risk
        : (entryPrice - timeoutBar.close) / risk;
  }

  return {
    entryBar: entryBarIndex,
    entryPrice,
    stopLoss,
    takeProfit,
    direction,
    strategy,
    riskReward,
    score: signal.totalScore,
    factorBreakdown: { ...signal.factorBreakdown },
    mfeR,
    maeR,
    outcome,
    barsToExit,
    actualR,
  };
}

// ============================================
// Run Signal Generation + Simulation
// ============================================

console.log('\n' + '='.repeat(70));
console.log('SCANNING FOR SIGNALS...');
console.log('='.repeat(70));

const trades: TradeRecord[] = [];
let lastTradeBar = -COOLDOWN_BARS; // Allow immediate first trade
let totalBarsScanned = 0;
let signalsRejectedCooldown = 0;

// Start scanning after enough lookback for structure detection
const START_INDEX = 200;

for (let i = START_INDEX; i < candles.length - MAX_HOLD_BARS; i++) {
  totalBarsScanned++;

  const result = scorer.evaluate(candles, i);

  if (result.action === 'trade' && result.selectedSignal) {
    // Enforce cooldown
    if (i - lastTradeBar < COOLDOWN_BARS) {
      signalsRejectedCooldown++;
      continue;
    }

    const trade = simulateTrade(result.selectedSignal, i);
    trades.push(trade);
    lastTradeBar = i;
  }
}

console.log(`\nBars scanned: ${totalBarsScanned}`);
console.log(`Signals generated: ${trades.length}`);
console.log(`Signals rejected (cooldown): ${signalsRejectedCooldown}`);
console.log(
  `Signal frequency: 1 per ${trades.length > 0 ? Math.round(totalBarsScanned / trades.length) : 'N/A'} bars`
);

if (trades.length === 0) {
  console.log('\nNo signals generated. Check scorer config / threshold.');
  process.exit(0);
}

// ============================================
// Aggregate Statistics
// ============================================

console.log('\n' + '='.repeat(70));
console.log('OVERALL RESULTS');
console.log('='.repeat(70));

const wins = trades.filter((t) => t.outcome === 'tp_hit');
const losses = trades.filter((t) => t.outcome === 'sl_hit');
const timeouts = trades.filter((t) => t.outcome === 'timeout');

const winRate = (wins.length / trades.length) * 100;
const longs = trades.filter((t) => t.direction === 'long');
const shorts = trades.filter((t) => t.direction === 'short');

console.log(`\nTotal trades: ${trades.length}`);
console.log(`  Wins (TP hit):  ${wins.length} (${winRate.toFixed(1)}%)`);
console.log(
  `  Losses (SL hit): ${losses.length} (${((losses.length / trades.length) * 100).toFixed(1)}%)`
);
console.log(
  `  Timeouts:        ${timeouts.length} (${((timeouts.length / trades.length) * 100).toFixed(1)}%)`
);
console.log(`  Longs: ${longs.length} | Shorts: ${shorts.length}`);

// Average R
const avgWinR =
  wins.length > 0 ? wins.reduce((s, t) => s + t.actualR, 0) / wins.length : 0;
const avgLossR =
  losses.length > 0
    ? losses.reduce((s, t) => s + t.actualR, 0) / losses.length
    : 0;
const avgAllR = trades.reduce((s, t) => s + t.actualR, 0) / trades.length;

console.log(`\nAverage R (wins):   +${avgWinR.toFixed(2)}R`);
console.log(`Average R (losses): ${avgLossR.toFixed(2)}R`);
console.log(`Average R (all):    ${avgAllR >= 0 ? '+' : ''}${avgAllR.toFixed(3)}R`);

// Expected value per trade
const ev = (winRate / 100) * avgWinR + ((100 - winRate) / 100) * avgLossR;
console.log(`Expected value:     ${ev >= 0 ? '+' : ''}${ev.toFixed(3)}R per trade`);

// Time in trades
const avgBarsWin =
  wins.length > 0
    ? wins.reduce((s, t) => s + t.barsToExit, 0) / wins.length
    : 0;
const avgBarsLoss =
  losses.length > 0
    ? losses.reduce((s, t) => s + t.barsToExit, 0) / losses.length
    : 0;

console.log(`\nAvg bars to exit (wins):   ${avgBarsWin.toFixed(1)} bars`);
console.log(`Avg bars to exit (losses): ${avgBarsLoss.toFixed(1)} bars`);

// ============================================
// MFE Analysis (Does price EVER go in our direction?)
// ============================================

console.log('\n' + '='.repeat(70));
console.log('MFE ANALYSIS (Max Favorable Excursion)');
console.log('Does price ever go in our direction before SL hit?');
console.log('='.repeat(70));

const mfeValues = trades.map((t) => t.mfeR);
mfeValues.sort((a, b) => a - b);

const mfeBuckets = [0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, Infinity];
console.log('\nMFE Distribution (R-multiples):');
for (let b = 0; b < mfeBuckets.length - 1; b++) {
  const lo = mfeBuckets[b]!;
  const hi = mfeBuckets[b + 1]!;
  const count = trades.filter(
    (t) => t.mfeR >= lo && t.mfeR < hi,
  ).length;
  const pct = ((count / trades.length) * 100).toFixed(1);
  const bar = '#'.repeat(Math.round((count / trades.length) * 50));
  const label = hi === Infinity ? `${lo.toFixed(2)}+` : `${lo.toFixed(2)}-${hi.toFixed(2)}`;
  console.log(`  ${label.padEnd(12)} ${String(count).padStart(4)} (${pct.padStart(5)}%) ${bar}`);
}

const mfeMedian = mfeValues[Math.floor(mfeValues.length / 2)] ?? 0;
const mfeMean = mfeValues.reduce((s, v) => s + v, 0) / mfeValues.length;
const mfeUnder025 = trades.filter((t) => t.mfeR < 0.25).length;
const mfeUnder050 = trades.filter((t) => t.mfeR < 0.5).length;

console.log(`\nMFE Mean:   ${mfeMean.toFixed(3)}R`);
console.log(`MFE Median: ${mfeMedian.toFixed(3)}R`);
console.log(
  `MFE < 0.25R: ${mfeUnder025} (${((mfeUnder025 / trades.length) * 100).toFixed(1)}%) -- price barely moved in our favor`
);
console.log(
  `MFE < 0.50R: ${mfeUnder050} (${((mfeUnder050 / trades.length) * 100).toFixed(1)}%) -- never reached half TP`
);

// MFE for losses specifically -- did we have a chance?
const lossMFEs = losses.map((t) => t.mfeR);
if (lossMFEs.length > 0) {
  const lossMfeMean = lossMFEs.reduce((s, v) => s + v, 0) / lossMFEs.length;
  const lossMfeOver050 = lossMFEs.filter((v) => v >= 0.5).length;
  const lossMfeOver100 = lossMFEs.filter((v) => v >= 1.0).length;
  console.log(`\nLosing trades MFE mean: ${lossMfeMean.toFixed(3)}R`);
  console.log(
    `  Losses that reached 0.5R+ before SL: ${lossMfeOver050} (${((lossMfeOver050 / losses.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `  Losses that reached 1.0R+ before SL: ${lossMfeOver100} (${((lossMfeOver100 / losses.length) * 100).toFixed(1)}%)`
  );
}

// ============================================
// MAE Analysis (How quickly does price go against us?)
// ============================================

console.log('\n' + '='.repeat(70));
console.log('MAE ANALYSIS (Max Adverse Excursion)');
console.log('How far does price go against us?');
console.log('='.repeat(70));

const maeValues = trades.map((t) => t.maeR);
maeValues.sort((a, b) => a - b);

console.log('\nMAE Distribution (R-multiples):');
for (let b = 0; b < mfeBuckets.length - 1; b++) {
  const lo = mfeBuckets[b]!;
  const hi = mfeBuckets[b + 1]!;
  const count = trades.filter(
    (t) => t.maeR >= lo && t.maeR < hi,
  ).length;
  const pct = ((count / trades.length) * 100).toFixed(1);
  const bar = '#'.repeat(Math.round((count / trades.length) * 50));
  const label = hi === Infinity ? `${lo.toFixed(2)}+` : `${lo.toFixed(2)}-${hi.toFixed(2)}`;
  console.log(`  ${label.padEnd(12)} ${String(count).padStart(4)} (${pct.padStart(5)}%) ${bar}`);
}

const maeMean = maeValues.reduce((s, v) => s + v, 0) / maeValues.length;
const maeMedian = maeValues[Math.floor(maeValues.length / 2)] ?? 0;
const maeOver075 = trades.filter((t) => t.maeR >= 0.75).length;

console.log(`\nMAE Mean:   ${maeMean.toFixed(3)}R`);
console.log(`MAE Median: ${maeMedian.toFixed(3)}R`);
console.log(
  `MAE > 0.75R: ${maeOver075} (${((maeOver075 / trades.length) * 100).toFixed(1)}%) -- SL nearly hit before any win`
);

// ============================================
// Win Rate Per Strategy
// ============================================

console.log('\n' + '='.repeat(70));
console.log('WIN RATE PER STRATEGY');
console.log('='.repeat(70));

const strategies = [...new Set(trades.map((t) => t.strategy))];

for (const strat of strategies) {
  const stratTrades = trades.filter((t) => t.strategy === strat);
  const stratWins = stratTrades.filter((t) => t.outcome === 'tp_hit');
  const stratLosses = stratTrades.filter((t) => t.outcome === 'sl_hit');
  const stratTimeouts = stratTrades.filter((t) => t.outcome === 'timeout');
  const stratWR = stratTrades.length > 0
    ? ((stratWins.length / stratTrades.length) * 100).toFixed(1)
    : '0.0';
  const stratAvgR =
    stratTrades.length > 0
      ? stratTrades.reduce((s, t) => s + t.actualR, 0) / stratTrades.length
      : 0;
  const stratAvgScore =
    stratTrades.length > 0
      ? stratTrades.reduce((s, t) => s + t.score, 0) / stratTrades.length
      : 0;
  const stratMfeMean =
    stratTrades.length > 0
      ? stratTrades.reduce((s, t) => s + t.mfeR, 0) / stratTrades.length
      : 0;

  console.log(`\n  ${strat.toUpperCase()}`);
  console.log(`    Trades: ${stratTrades.length} (W:${stratWins.length} L:${stratLosses.length} T:${stratTimeouts.length})`);
  console.log(`    Win rate: ${stratWR}%`);
  console.log(`    Avg R: ${stratAvgR >= 0 ? '+' : ''}${stratAvgR.toFixed(3)}R`);
  console.log(`    Avg score: ${stratAvgScore.toFixed(2)}`);
  console.log(`    Avg MFE: ${stratMfeMean.toFixed(3)}R`);

  // Direction breakdown
  const stratLongs = stratTrades.filter((t) => t.direction === 'long');
  const stratShorts = stratTrades.filter((t) => t.direction === 'short');
  const longWR = stratLongs.length > 0
    ? ((stratLongs.filter((t) => t.outcome === 'tp_hit').length / stratLongs.length) * 100).toFixed(1)
    : 'N/A';
  const shortWR = stratShorts.length > 0
    ? ((stratShorts.filter((t) => t.outcome === 'tp_hit').length / stratShorts.length) * 100).toFixed(1)
    : 'N/A';
  console.log(`    Long WR: ${longWR}% (${stratLongs.length}) | Short WR: ${shortWR}% (${stratShorts.length})`);
}

// ============================================
// Factor Analysis: Winning vs Losing Trades
// ============================================

console.log('\n' + '='.repeat(70));
console.log('FACTOR ANALYSIS: WINNERS vs LOSERS');
console.log('Which confluence factors are present in wins vs losses?');
console.log('='.repeat(70));

// Collect all factor names
const allFactors = [
  'structureAlignment',
  'killZoneActive',
  'liquiditySweep',
  'obProximity',
  'fvgAtCE',
  'recentBOS',
  'rrRatio',
  'oteZone',
  'breakerConfluence',
  'obFvgConfluence',
];

console.log(
  `\n  ${'Factor'.padEnd(22)} ${'Win Avg'.padStart(8)} ${'Loss Avg'.padStart(9)} ${'Delta'.padStart(8)} ${'Win%>0'.padStart(8)} ${'Loss%>0'.padStart(9)}`
);
console.log('  ' + '-'.repeat(68));

for (const factor of allFactors) {
  const winAvg =
    wins.length > 0
      ? wins.reduce((s, t) => s + (t.factorBreakdown[factor] ?? 0), 0) /
        wins.length
      : 0;
  const lossAvg =
    losses.length > 0
      ? losses.reduce(
          (s, t) => s + (t.factorBreakdown[factor] ?? 0),
          0,
        ) / losses.length
      : 0;
  const delta = winAvg - lossAvg;

  // Percentage of trades where this factor was active (> 0)
  const winActive =
    wins.length > 0
      ? (wins.filter((t) => (t.factorBreakdown[factor] ?? 0) > 0).length /
          wins.length) *
        100
      : 0;
  const lossActive =
    losses.length > 0
      ? (losses.filter((t) => (t.factorBreakdown[factor] ?? 0) > 0).length /
          losses.length) *
        100
      : 0;

  const deltaStr = delta >= 0 ? `+${delta.toFixed(3)}` : delta.toFixed(3);
  console.log(
    `  ${factor.padEnd(22)} ${winAvg.toFixed(3).padStart(8)} ${lossAvg.toFixed(3).padStart(9)} ${deltaStr.padStart(8)} ${winActive.toFixed(0).padStart(7)}% ${lossActive.toFixed(0).padStart(8)}%`
  );
}

// ============================================
// Score Distribution: Winners vs Losers
// ============================================

console.log('\n' + '='.repeat(70));
console.log('SCORE DISTRIBUTION');
console.log('='.repeat(70));

const scoreBuckets = [5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, Infinity];

console.log(
  `\n  ${'Score Range'.padEnd(14)} ${'Trades'.padStart(7)} ${'Win%'.padStart(7)} ${'Avg MFE'.padStart(9)} ${'Avg R'.padStart(8)}`
);
console.log('  ' + '-'.repeat(50));

for (let b = 0; b < scoreBuckets.length - 1; b++) {
  const lo = scoreBuckets[b]!;
  const hi = scoreBuckets[b + 1]!;
  const bucket = trades.filter((t) => t.score >= lo && t.score < hi);
  if (bucket.length === 0) continue;

  const bucketWR =
    ((bucket.filter((t) => t.outcome === 'tp_hit').length / bucket.length) * 100).toFixed(1);
  const bucketMFE =
    bucket.reduce((s, t) => s + t.mfeR, 0) / bucket.length;
  const bucketR = bucket.reduce((s, t) => s + t.actualR, 0) / bucket.length;

  const label = hi === Infinity ? `${lo.toFixed(1)}+` : `${lo.toFixed(1)}-${hi.toFixed(1)}`;
  console.log(
    `  ${label.padEnd(14)} ${String(bucket.length).padStart(7)} ${(bucketWR + '%').padStart(7)} ${bucketMFE.toFixed(3).padStart(9)} ${(bucketR >= 0 ? '+' : '') + bucketR.toFixed(3)}`.padStart(8)
  );
}

// ============================================
// First-Bar Analysis (Immediate Direction)
// ============================================

console.log('\n' + '='.repeat(70));
console.log('FIRST-BAR ANALYSIS');
console.log('Does price go in our direction on the very first bar after entry?');
console.log('='.repeat(70));

let firstBarFavorable = 0;
let firstBarAdverse = 0;

for (const trade of trades) {
  const nextBar = candles[trade.entryBar + 1];
  if (!nextBar) continue;

  const entryPrice = trade.entryPrice;
  const risk = Math.abs(entryPrice - trade.stopLoss);

  let favorableMove: number;
  let adverseMove: number;

  if (trade.direction === 'long') {
    favorableMove = (nextBar.high - entryPrice) / risk;
    adverseMove = (entryPrice - nextBar.low) / risk;
  } else {
    favorableMove = (entryPrice - nextBar.low) / risk;
    adverseMove = (nextBar.high - entryPrice) / risk;
  }

  if (favorableMove > adverseMove) {
    firstBarFavorable++;
  } else {
    firstBarAdverse++;
  }
}

const firstBarTotal = firstBarFavorable + firstBarAdverse;
console.log(`\nFirst bar goes in our direction: ${firstBarFavorable}/${firstBarTotal} (${firstBarTotal > 0 ? ((firstBarFavorable / firstBarTotal) * 100).toFixed(1) : 0}%)`);
console.log(`First bar goes against us:       ${firstBarAdverse}/${firstBarTotal} (${firstBarTotal > 0 ? ((firstBarAdverse / firstBarTotal) * 100).toFixed(1) : 0}%)`);
console.log(`\nIf first bar is ~50/50, entries have NO directional edge.`);
console.log(`If < 50%, entries are counter-directional (worse than random).`);

// ============================================
// Sample Trade Log (last 20 trades)
// ============================================

console.log('\n' + '='.repeat(70));
console.log('SAMPLE TRADES (last 20)');
console.log('='.repeat(70));

const sampleTrades = trades.slice(-20);
console.log(
  `\n  ${'Date'.padEnd(20)} ${'Strategy'.padEnd(18)} ${'Dir'.padEnd(6)} ${'Score'.padStart(6)} ${'MFE'.padStart(7)} ${'MAE'.padStart(7)} ${'Outcome'.padStart(8)} ${'Bars'.padStart(5)} ${'R'.padStart(7)}`
);
console.log('  ' + '-'.repeat(90));

for (const trade of sampleTrades) {
  const date = new Date(candles[trade.entryBar]!.timestamp)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 16);

  console.log(
    `  ${date.padEnd(20)} ${trade.strategy.padEnd(18)} ${trade.direction.padEnd(6)} ${trade.score.toFixed(2).padStart(6)} ${trade.mfeR.toFixed(2).padStart(6)}R ${trade.maeR.toFixed(2).padStart(6)}R ${trade.outcome.padStart(8)} ${String(trade.barsToExit).padStart(5)} ${(trade.actualR >= 0 ? '+' : '') + trade.actualR.toFixed(2) + 'R'}`
  );
}

// ============================================
// Diagnosis Summary
// ============================================

console.log('\n' + '='.repeat(70));
console.log('DIAGNOSIS');
console.log('='.repeat(70));

const immediatelyAgainst = trades.filter((t) => t.mfeR < 0.25).length;
const immediatelyAgainstPct = (immediatelyAgainst / trades.length) * 100;
const neverReachHalfTP = trades.filter((t) => t.mfeR < 0.5).length;
const neverReachHalfTPPct = (neverReachHalfTP / trades.length) * 100;

console.log(`\n1. ENTRY QUALITY:`);
if (immediatelyAgainstPct > 40) {
  console.log(
    `   [PROBLEM] ${immediatelyAgainstPct.toFixed(0)}% of entries never see 0.25R favorable movement.`
  );
  console.log(
    `   Entries are NOT at reversal levels -- price immediately goes against.`
  );
} else {
  console.log(
    `   ${immediatelyAgainstPct.toFixed(0)}% of entries see < 0.25R favorable -- entries have SOME directional edge.`
  );
}

console.log(`\n2. TP REACHABILITY:`);
if (neverReachHalfTPPct > 60) {
  console.log(
    `   [PROBLEM] ${neverReachHalfTPPct.toFixed(0)}% of trades never reach half their TP.`
  );
  console.log(`   TP targets are too ambitious relative to entry quality.`);
} else {
  console.log(
    `   ${neverReachHalfTPPct.toFixed(0)}% never reach half TP -- TP targets are ${neverReachHalfTPPct > 40 ? 'marginal' : 'reasonable'}.`
  );
}

console.log(`\n3. SL PLACEMENT:`);
const quickSLHits = losses.filter((t) => t.barsToExit <= 3).length;
const quickSLPct = losses.length > 0 ? (quickSLHits / losses.length) * 100 : 0;
if (quickSLPct > 50) {
  console.log(
    `   [PROBLEM] ${quickSLPct.toFixed(0)}% of losses hit SL within 3 bars.`
  );
  console.log(`   Stops are too tight or entries are at the wrong level.`);
} else {
  console.log(
    `   ${quickSLPct.toFixed(0)}% of losses hit SL within 3 bars -- SL placement is ${quickSLPct > 30 ? 'marginal' : 'reasonable'}.`
  );
}

console.log(`\n4. FIRST-BAR EDGE:`);
const firstBarPct = firstBarTotal > 0 ? (firstBarFavorable / firstBarTotal) * 100 : 50;
if (firstBarPct < 50) {
  console.log(
    `   [PROBLEM] First bar goes against us ${(100 - firstBarPct).toFixed(0)}% of the time.`
  );
  console.log(`   Entries have NEGATIVE directional edge (worse than random).`);
} else if (firstBarPct < 55) {
  console.log(
    `   First bar is essentially coin-flip (${firstBarPct.toFixed(0)}% favorable).`
  );
  console.log(`   Entries have NO meaningful directional edge.`);
} else {
  console.log(
    `   First bar favors us ${firstBarPct.toFixed(0)}% -- entries have a directional edge.`
  );
}

console.log(`\n5. EXPECTED VALUE:`);
if (ev < 0) {
  console.log(`   [PROBLEM] EV is ${ev.toFixed(3)}R per trade -- net negative.`);
  console.log(`   Even with correct R:R targets, win rate is too low.`);
} else {
  console.log(`   EV is +${ev.toFixed(3)}R per trade -- positive edge.`);
}

console.log('\n' + '='.repeat(70));
console.log('RECOMMENDATIONS');
console.log('='.repeat(70));

const recommendations: string[] = [];

if (immediatelyAgainstPct > 40) {
  recommendations.push(
    'Entry levels need work: strategies are triggering where price has no support/resistance. Consider tighter proximity filters for OBs and FVGs.'
  );
}

if (neverReachHalfTPPct > 50) {
  recommendations.push(
    'TP targets are too aggressive. Consider reducing takeProfitATRMultiple from 3.0 to 2.0 or using structure-based TPs.'
  );
}

if (quickSLPct > 40) {
  recommendations.push(
    'SL is getting hit too quickly. Consider increasing stopLossATRMultiple from 1.5 to 2.0, or adding a buffer below/above the entry zone.'
  );
}

if (firstBarPct < 52) {
  recommendations.push(
    'No first-bar edge suggests entries are not timed well. Consider requiring stronger confluence (raise minThreshold) or adding a momentum confirmation filter.'
  );
}

// Find worst strategy
const stratStats = strategies.map((s) => {
  const st = trades.filter((t) => t.strategy === s);
  const wr = st.length > 0 ? st.filter((t) => t.outcome === 'tp_hit').length / st.length : 0;
  return { name: s, count: st.length, winRate: wr };
});
const worstStrat = stratStats.filter((s) => s.count >= 3).sort((a, b) => a.winRate - b.winRate)[0];
if (worstStrat && worstStrat.winRate < 0.2) {
  recommendations.push(
    `Strategy "${worstStrat.name}" has ${(worstStrat.winRate * 100).toFixed(0)}% win rate over ${worstStrat.count} trades. Consider disabling or reworking it.`
  );
}

// Find least useful factor
const factorDiffs = allFactors.map((f) => {
  const wAvg = wins.length > 0 ? wins.reduce((s, t) => s + (t.factorBreakdown[f] ?? 0), 0) / wins.length : 0;
  const lAvg = losses.length > 0 ? losses.reduce((s, t) => s + (t.factorBreakdown[f] ?? 0), 0) / losses.length : 0;
  return { name: f, delta: wAvg - lAvg };
});
const negativeFactors = factorDiffs.filter((f) => f.delta < 0);
if (negativeFactors.length > 0) {
  const worst = negativeFactors.sort((a, b) => a.delta - b.delta)[0]!;
  recommendations.push(
    `Factor "${worst.name}" has HIGHER scores in losing trades (delta: ${worst.delta.toFixed(3)}). It may be misleading the scorer. Consider reducing its weight.`
  );
}

if (recommendations.length === 0) {
  console.log('\nNo critical issues detected. Signal quality appears reasonable.');
} else {
  recommendations.forEach((r, i) => {
    console.log(`\n${i + 1}. ${r}`);
  });
}

console.log('\n');
