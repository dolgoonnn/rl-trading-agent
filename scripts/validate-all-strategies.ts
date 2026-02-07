#!/usr/bin/env npx tsx
/**
 * Validate All ICT Strategies
 *
 * Checks that each strategy generates signals correctly and diagnoses any issues
 */

import fs from 'fs';
import type { Candle } from '@/types';
import { analyzeMarketStructure } from '@/lib/ict/market-structure';
import { detectOrderBlocks, checkMitigation } from '@/lib/ict/order-blocks';
import { detectFairValueGaps } from '@/lib/ict/fair-value-gaps';
import {
  OrderBlockStrategy,
  FVGStrategy,
  BOSContinuationStrategy,
  CHoCHReversalStrategy,
  WaitStrategy,
  type ICTStrategyContext,
} from '@/lib/rl/strategies/ict-strategies';

// Load candle data
const dataPath = 'data/BTCUSDT_1h.json';
const rawData = fs.readFileSync(dataPath, 'utf-8');
const candles: Candle[] = JSON.parse(rawData);

// Use recent candles
const recentCandles = candles.slice(-2000);

console.log('='.repeat(70));
console.log('ICT STRATEGY VALIDATION');
console.log('='.repeat(70));
console.log(`\nAnalyzing ${recentCandles.length} candles\n`);

// Calculate ATR
function calculateATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const curr = candles[i]!;
    const prev = candles[i - 1]!;
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
    atrSum += tr;
  }
  return atrSum / period;
}

// Initialize all strategies
const strategies = {
  wait: new WaitStrategy(),
  order_block: new OrderBlockStrategy(),
  fvg: new FVGStrategy(),
  bos_continuation: new BOSContinuationStrategy(),
  choch_reversal: new CHoCHReversalStrategy(),
};

// Track statistics for each strategy
interface StrategyStats {
  signalsGenerated: number;
  longSignals: number;
  shortSignals: number;
  avgConfidence: number;
  avgRiskReward: number;
  confidences: number[];
  riskRewards: number[];
  sampleSignals: Array<{
    index: number;
    direction: string;
    confidence: number;
    riskReward: number;
    reasoning: string[];
  }>;
}

const stats: Record<string, StrategyStats> = {};
for (const name of Object.keys(strategies)) {
  stats[name] = {
    signalsGenerated: 0,
    longSignals: 0,
    shortSignals: 0,
    avgConfidence: 0,
    avgRiskReward: 0,
    confidences: [],
    riskRewards: [],
    sampleSignals: [],
  };
}

// Also track market structure stats
let totalBOS = 0;
let totalCHoCH = 0;
let totalOB = 0;
let totalFVG = 0;
let trendCounts = { bullish: 0, bearish: 0, neutral: 0 };

// Analyze each bar
const lookbackPeriod = 100;
const totalBars = recentCandles.length - lookbackPeriod;

for (let i = lookbackPeriod; i < recentCandles.length; i++) {
  // Build ICT context
  const windowCandles = recentCandles.slice(0, i + 1);
  const structure = analyzeMarketStructure(windowCandles);
  // Detect OBs and update their mitigation status
  const rawOBs = detectOrderBlocks(windowCandles);
  const orderBlocks = rawOBs.map(ob => checkMitigation(ob, windowCandles));
  const fairValueGaps = detectFairValueGaps(windowCandles);
  const atr = calculateATR(windowCandles);

  // Track market structure
  trendCounts[structure.bias]++;
  totalBOS += structure.structureBreaks.filter(sb => sb.type === 'bos' && i - sb.breakIndex <= 20).length > 0 ? 1 : 0;
  totalCHoCH += structure.structureBreaks.filter(sb => sb.type === 'choch' && i - sb.breakIndex <= 20).length > 0 ? 1 : 0;
  totalOB += orderBlocks.filter(ob => ob.status === 'unmitigated' && i - ob.index <= 50).length > 0 ? 1 : 0;
  totalFVG += fairValueGaps.filter(fvg => fvg.status === 'unfilled' && i - fvg.index <= 30).length > 0 ? 1 : 0;

  const ctx: ICTStrategyContext = {
    structure,
    orderBlocks,
    fairValueGaps,
    fvgs: fairValueGaps, // Alias
    atr,
    killZone: null,
    liquidityLevels: [],
  };

  // Test each strategy
  for (const [name, strategy] of Object.entries(strategies)) {
    const signal = strategy.detectEntry(windowCandles, i, ctx);

    if (signal) {
      const s = stats[name]!;
      s.signalsGenerated++;
      if (signal.direction === 'long') s.longSignals++;
      else s.shortSignals++;
      s.confidences.push(signal.confidence);
      s.riskRewards.push(signal.riskReward);

      // Store sample signals
      if (s.sampleSignals.length < 3) {
        s.sampleSignals.push({
          index: i,
          direction: signal.direction,
          confidence: signal.confidence,
          riskReward: signal.riskReward,
          reasoning: signal.reasoning,
        });
      }
    }
  }
}

// Calculate averages
for (const [name, s] of Object.entries(stats)) {
  if (s.confidences.length > 0) {
    s.avgConfidence = s.confidences.reduce((a, b) => a + b, 0) / s.confidences.length;
    s.avgRiskReward = s.riskRewards.reduce((a, b) => a + b, 0) / s.riskRewards.length;
  }
}

// Print results
console.log('MARKET STRUCTURE AVAILABILITY:');
console.log('-'.repeat(50));
console.log(`  Trend Distribution:`);
console.log(`    Bullish: ${trendCounts.bullish} bars (${(trendCounts.bullish/totalBars*100).toFixed(1)}%)`);
console.log(`    Bearish: ${trendCounts.bearish} bars (${(trendCounts.bearish/totalBars*100).toFixed(1)}%)`);
console.log(`    Neutral: ${trendCounts.neutral} bars (${(trendCounts.neutral/totalBars*100).toFixed(1)}%)`);
console.log(`  Structure Events (bars with recent events):`);
console.log(`    BOS available: ${totalBOS} bars (${(totalBOS/totalBars*100).toFixed(1)}%)`);
console.log(`    CHoCH available: ${totalCHoCH} bars (${(totalCHoCH/totalBars*100).toFixed(1)}%)`);
console.log(`    Order Blocks available: ${totalOB} bars (${(totalOB/totalBars*100).toFixed(1)}%)`);
console.log(`    FVGs available: ${totalFVG} bars (${(totalFVG/totalBars*100).toFixed(1)}%)`);

console.log('\n' + '='.repeat(70));
console.log('STRATEGY SIGNAL GENERATION:');
console.log('='.repeat(70));

for (const [name, s] of Object.entries(stats)) {
  const pct = (s.signalsGenerated / totalBars * 100).toFixed(2);
  const status = s.signalsGenerated > 0 ? '✓' : '✗';

  console.log(`\n${status} ${name.toUpperCase()}`);
  console.log('-'.repeat(50));
  console.log(`  Signals: ${s.signalsGenerated} (${pct}% of bars)`);
  console.log(`  Long: ${s.longSignals}, Short: ${s.shortSignals}`);

  if (s.signalsGenerated > 0) {
    console.log(`  Avg Confidence: ${s.avgConfidence.toFixed(3)}`);
    console.log(`  Avg R:R: ${s.avgRiskReward.toFixed(2)}`);
    console.log(`  Confidence Range: ${Math.min(...s.confidences).toFixed(2)} - ${Math.max(...s.confidences).toFixed(2)}`);
    console.log(`  R:R Range: ${Math.min(...s.riskRewards).toFixed(2)} - ${Math.max(...s.riskRewards).toFixed(2)}`);

    if (s.sampleSignals.length > 0) {
      console.log(`  Sample Signals:`);
      for (const sig of s.sampleSignals.slice(0, 2)) {
        console.log(`    Bar ${sig.index}: ${sig.direction} conf=${sig.confidence.toFixed(2)} rr=${sig.riskReward.toFixed(2)}`);
        console.log(`      Reasoning: ${sig.reasoning.slice(0, 2).join(', ')}`);
      }
    }
  } else {
    console.log(`  ⚠️  NO SIGNALS GENERATED - Strategy may have issues`);
  }
}

// Summary
console.log('\n' + '='.repeat(70));
console.log('SUMMARY');
console.log('='.repeat(70));

const working = Object.entries(stats).filter(([_, s]) => s.signalsGenerated > 0);
const notWorking = Object.entries(stats).filter(([_, s]) => s.signalsGenerated === 0);

console.log(`\n✓ Working strategies: ${working.map(([n]) => n).join(', ') || 'None'}`);
console.log(`✗ Not working: ${notWorking.map(([n]) => n).join(', ') || 'None'}`);

// Recommendations
console.log('\n' + '='.repeat(70));
console.log('RECOMMENDATIONS');
console.log('='.repeat(70));

if (trendCounts.neutral / totalBars > 0.4) {
  console.log(`\n⚠️  High neutral trend (${(trendCounts.neutral/totalBars*100).toFixed(1)}%)`);
  console.log(`   - CHoCH requires non-neutral trend to detect reversals`);
  console.log(`   - Consider adjusting swing detection sensitivity`);
}

if (stats.choch_reversal && stats.choch_reversal.signalsGenerated < totalBars * 0.01) {
  console.log(`\n⚠️  Low CHoCH signal rate (${(stats.choch_reversal.signalsGenerated/totalBars*100).toFixed(2)}%)`);
  console.log(`   - CHoCH events exist: ${(totalCHoCH/totalBars*100).toFixed(1)}% of bars`);
  console.log(`   - May need to loosen entry conditions`);
}

if (stats.bos_continuation && stats.bos_continuation.signalsGenerated < totalBars * 0.01) {
  console.log(`\n⚠️  Low BOS signal rate (${(stats.bos_continuation.signalsGenerated/totalBars*100).toFixed(2)}%)`);
  console.log(`   - BOS events exist: ${(totalBOS/totalBars*100).toFixed(1)}% of bars`);
  console.log(`   - May need to loosen entry conditions`);
}

console.log('\n' + '='.repeat(70));
console.log('VALIDATION COMPLETE');
console.log('='.repeat(70));
