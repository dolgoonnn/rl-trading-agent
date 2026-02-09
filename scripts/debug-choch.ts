#!/usr/bin/env npx tsx
/**
 * Debug CHoCH Signal Generation
 *
 * Diagnoses why CHoCH signals are never being selected by the agent
 */

import fs from 'fs';
import type { Candle } from '@/types';
import { analyzeMarketStructure } from '@/lib/ict/market-structure';
import { detectOrderBlocks } from '@/lib/ict/order-blocks';
import { detectFairValueGaps } from '@/lib/ict/fair-value-gaps';
import { CHoCHReversalStrategy } from '@/lib/rl/strategies/ict-strategies';

// Load candle data
const dataPath = 'data/BTCUSDT_1h.json';
const rawData = fs.readFileSync(dataPath, 'utf-8');
const candles: Candle[] = JSON.parse(rawData);

// Use recent 2000 candles (similar to training)
const recentCandles = candles.slice(-2000);

console.log('='.repeat(60));
console.log('CHoCH SIGNAL DEBUG');
console.log('='.repeat(60));
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

// Initialize strategy
const chochStrategy = new CHoCHReversalStrategy();

// Track statistics
let totalBars = 0;
let barsWithChoch = 0;
let chochSignalsGenerated = 0;
let signalsByDirection: { long: number; short: number } = { long: 0, short: 0 };
let trendCounts: { bullish: number; bearish: number; neutral: number } = { bullish: 0, bearish: 0, neutral: 0 };
let blockReasons: Record<string, number> = {
  'no_choch_events': 0,
  'choch_too_old': 0,
  'low_confidence': 0,
  'no_ob_no_recent': 0,
  'rr_too_low': 0,
  'signal_generated': 0,
};

// Sample CHoCH events for inspection
const sampleChochEvents: Array<{
  index: number;
  type: string;
  direction: string;
  confidence: number;
  trend: string;
}> = [];

// Analyze each bar
const lookbackPeriod = 100;
for (let i = lookbackPeriod; i < recentCandles.length; i++) {
  totalBars++;

  // Build ICT context
  const windowCandles = recentCandles.slice(0, i + 1);
  const structure = analyzeMarketStructure(windowCandles);
  const orderBlocks = detectOrderBlocks(windowCandles, structure.swingHighs, structure.swingLows);
  const fairValueGaps = detectFairValueGaps(windowCandles);
  const atr = calculateATR(windowCandles);

  // Track trend distribution
  trendCounts[structure.bias]++;

  // Check for CHoCH events in this window
  const recentChochs = structure.structureBreaks.filter(
    sb => sb.type === 'choch' && i - sb.breakIndex <= 30 && sb.confidence >= 0.4
  );

  if (recentChochs.length > 0) {
    barsWithChoch++;

    // Sample some for inspection
    if (sampleChochEvents.length < 10) {
      const choch = recentChochs[recentChochs.length - 1]!;
      sampleChochEvents.push({
        index: i,
        type: choch.type,
        direction: choch.direction,
        confidence: choch.confidence,
        trend: structure.bias,
      });
    }
  }

  // Try to generate signal
  const ctx = {
    structure,
    orderBlocks,
    fairValueGaps,
    atr,
    killZone: null,
    liquidityLevels: [],
  };

  const signal = chochStrategy.detectEntry(windowCandles, i, ctx);

  if (signal) {
    chochSignalsGenerated++;
    signalsByDirection[signal.direction]++;
    blockReasons['signal_generated']++;
  } else {
    // Diagnose why no signal
    if (recentChochs.length === 0) {
      const anyChochs = structure.structureBreaks.filter(sb => sb.type === 'choch');
      if (anyChochs.length === 0) {
        blockReasons['no_choch_events']++;
      } else {
        // Check if too old or low confidence
        const mostRecent = anyChochs[anyChochs.length - 1]!;
        if (i - mostRecent.breakIndex > 30) {
          blockReasons['choch_too_old']++;
        } else if (mostRecent.confidence < 0.4) {
          blockReasons['low_confidence']++;
        }
      }
    } else {
      // CHoCH exists but no signal - check entry conditions
      blockReasons['no_ob_no_recent']++;
    }
  }
}

console.log('TREND DISTRIBUTION:');
console.log(`  Bullish: ${trendCounts.bullish} bars (${(trendCounts.bullish/totalBars*100).toFixed(1)}%)`);
console.log(`  Bearish: ${trendCounts.bearish} bars (${(trendCounts.bearish/totalBars*100).toFixed(1)}%)`);
console.log(`  Neutral: ${trendCounts.neutral} bars (${(trendCounts.neutral/totalBars*100).toFixed(1)}%)`);

console.log('\nCHoCH DETECTION:');
console.log(`  Total bars analyzed: ${totalBars}`);
console.log(`  Bars with valid CHoCH in window: ${barsWithChoch} (${(barsWithChoch/totalBars*100).toFixed(1)}%)`);
console.log(`  CHoCH signals generated: ${chochSignalsGenerated} (${(chochSignalsGenerated/totalBars*100).toFixed(2)}%)`);
console.log(`    Long signals: ${signalsByDirection.long}`);
console.log(`    Short signals: ${signalsByDirection.short}`);

console.log('\nBLOCK REASONS:');
const totalBlocks = Object.values(blockReasons).reduce((a, b) => a + b, 0) - blockReasons['signal_generated'];
for (const [reason, count] of Object.entries(blockReasons)) {
  if (reason !== 'signal_generated') {
    console.log(`  ${reason}: ${count} (${(count/totalBars*100).toFixed(1)}%)`);
  }
}

if (sampleChochEvents.length > 0) {
  console.log('\nSAMPLE CHoCH EVENTS:');
  for (const event of sampleChochEvents) {
    console.log(`  Bar ${event.index}: ${event.direction} CHoCH, conf=${event.confidence.toFixed(2)}, trend=${event.trend}`);
  }
}

// Now check if the strategy generates ANY signals on this data
console.log('\n' + '='.repeat(60));
console.log('STRATEGY COMPARISON');
console.log('='.repeat(60));

// Also check other strategies for comparison
import { OrderBlockStrategy, FVGStrategy, BOSContinuationStrategy } from '@/lib/rl/strategies/ict-strategies';

const obStrategy = new OrderBlockStrategy();
const fvgStrategy = new FVGStrategy();
const bosStrategy = new BOSContinuationStrategy();

let obSignals = 0, fvgSignals = 0, bosSignals = 0;

for (let i = lookbackPeriod; i < recentCandles.length; i += 10) { // Sample every 10 bars for speed
  const windowCandles = recentCandles.slice(0, i + 1);
  const structure = analyzeMarketStructure(windowCandles);
  const orderBlocks = detectOrderBlocks(windowCandles, structure.swingHighs, structure.swingLows);
  const fairValueGaps = detectFairValueGaps(windowCandles);
  const atr = calculateATR(windowCandles);

  const ctx = {
    structure,
    orderBlocks,
    fairValueGaps,
    atr,
    killZone: null,
    liquidityLevels: [],
  };

  if (obStrategy.detectEntry(windowCandles, i, ctx)) obSignals++;
  if (fvgStrategy.detectEntry(windowCandles, i, ctx)) fvgSignals++;
  if (bosStrategy.detectEntry(windowCandles, i, ctx)) bosSignals++;
}

const sampleBars = Math.floor((recentCandles.length - lookbackPeriod) / 10);
console.log(`\nSignals per ${sampleBars} sampled bars:`);
console.log(`  OrderBlock: ${obSignals} (${(obSignals/sampleBars*100).toFixed(1)}%)`);
console.log(`  FVG: ${fvgSignals} (${(fvgSignals/sampleBars*100).toFixed(1)}%)`);
console.log(`  BOS: ${bosSignals} (${(bosSignals/sampleBars*100).toFixed(1)}%)`);
console.log(`  CHoCH: ${chochSignalsGenerated} / ${totalBars} (${(chochSignalsGenerated/totalBars*100).toFixed(2)}%)`);

console.log('\n' + '='.repeat(60));
console.log('DIAGNOSIS COMPLETE');
console.log('='.repeat(60));
