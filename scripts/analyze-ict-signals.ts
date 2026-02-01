#!/usr/bin/env npx tsx
/**
 * ICT Signal Predictive Value Analysis
 * Tests if ICT signals (OB, FVG, BOS, CHoCH, Sweeps) actually predict price movement
 *
 * This answers the critical question: Do ICT concepts have real predictive power?
 */

import fs from 'fs';
import path from 'path';

import type { Candle } from '@/types';
import {
  detectSwingHighs,
  detectSwingLows,
  detectBOS,
  detectCHoCH,
  detectOrderBlocks,
  detectFairValueGaps,
} from '@/lib/ict';

interface SignalResult {
  totalSignals: number;
  positiveReturns: number; // Price moved in expected direction
  avgReturn: number;
  avgReturnPositive: number;
  avgReturnNegative: number;
  hitRate: number; // % of signals that worked
  returns: number[];
}

interface AnalysisResult {
  symbol: string;
  candles: number;
  bullishOB: SignalResult;
  bearishOB: SignalResult;
  bullishFVG: SignalResult;
  bearishFVG: SignalResult;
  bullishBOS: SignalResult;
  bearishBOS: SignalResult;
  bullishCHoCH: SignalResult;
  bearishCHoCH: SignalResult;
}

function loadCandles(dataPath: string): Candle[] {
  const absolutePath = path.resolve(dataPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Data file not found: ${absolutePath}`);
  }
  const content = fs.readFileSync(absolutePath, 'utf-8');
  return JSON.parse(content) as Candle[];
}

function calculateForwardReturn(
  candles: Candle[],
  entryIndex: number,
  lookforward: number,
  direction: 'bullish' | 'bearish'
): number {
  const entry = candles[entryIndex];
  const exit = candles[Math.min(entryIndex + lookforward, candles.length - 1)];

  if (!entry || !exit) return 0;

  const ret = (exit.close - entry.close) / entry.close;

  // For bullish signals, positive return = success
  // For bearish signals, negative return = success
  return direction === 'bullish' ? ret : -ret;
}

function initSignalResult(): SignalResult {
  return {
    totalSignals: 0,
    positiveReturns: 0,
    avgReturn: 0,
    avgReturnPositive: 0,
    avgReturnNegative: 0,
    hitRate: 0,
    returns: [],
  };
}

function analyzeSymbol(candles: Candle[], lookforward: number = 20): Partial<AnalysisResult> {
  console.log(`  Detecting ICT structures...`);

  // Detect all ICT structures
  const swingHighs = detectSwingHighs(candles, { lookback: 5, minStrength: 2 });
  const swingLows = detectSwingLows(candles, { lookback: 5, minStrength: 2 });
  console.log(`  Found ${swingHighs.length} swing highs, ${swingLows.length} swing lows`);
  const bosBreaks = detectBOS(candles, swingHighs, swingLows);
  const chochBreaks = detectCHoCH(candles, swingHighs, swingLows);
  const orderBlocks = detectOrderBlocks(candles);
  const fvgs = detectFairValueGaps(candles);

  // Initialize results
  const results: Record<string, SignalResult> = {
    bullishOB: initSignalResult(),
    bearishOB: initSignalResult(),
    bullishFVG: initSignalResult(),
    bearishFVG: initSignalResult(),
    bullishBOS: initSignalResult(),
    bearishBOS: initSignalResult(),
    bullishCHoCH: initSignalResult(),
    bearishCHoCH: initSignalResult(),
  };

  // Create index for candle timestamps
  const timestampToIndex = new Map<number, number>();
  candles.forEach((c, i) => timestampToIndex.set(c.timestamp, i));

  // Analyze Order Blocks
  console.log(`  Analyzing ${orderBlocks.length} order blocks...`);
  for (const ob of orderBlocks) {
    const key = ob.type === 'bullish' ? 'bullishOB' : 'bearishOB';
    const direction = ob.type === 'bullish' ? 'bullish' : 'bearish';

    // Find when price touches the OB
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i]!;
      if (c.timestamp <= ob.formationTimestamp) continue;

      // Check if price is in OB zone
      const inZone = c.low <= ob.high && c.high >= ob.low;
      if (inZone && !ob.mitigated) {
        const ret = calculateForwardReturn(candles, i, lookforward, direction);
        results[key]!.returns.push(ret);
        results[key]!.totalSignals++;
        if (ret > 0) results[key]!.positiveReturns++;
        break; // Only count first touch
      }
    }
  }

  // Analyze FVGs
  console.log(`  Analyzing ${fvgs.length} fair value gaps...`);
  for (const fvg of fvgs) {
    const key = fvg.type === 'bullish' ? 'bullishFVG' : 'bearishFVG';
    const direction = fvg.type === 'bullish' ? 'bullish' : 'bearish';

    // Find when price fills the FVG
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i]!;
      if (c.timestamp <= fvg.timestamp) continue;

      // Check if price fills gap
      const fillsBullish = fvg.type === 'bullish' && c.low <= fvg.high;
      const fillsBearish = fvg.type === 'bearish' && c.high >= fvg.low;

      if (fillsBullish || fillsBearish) {
        const ret = calculateForwardReturn(candles, i, lookforward, direction);
        results[key]!.returns.push(ret);
        results[key]!.totalSignals++;
        if (ret > 0) results[key]!.positiveReturns++;
        break; // Only count first fill
      }
    }
  }

  // Analyze BOS breaks
  console.log(`  Analyzing ${bosBreaks.length} BOS breaks...`);
  for (const sb of bosBreaks) {
    const key = sb.direction === 'bullish' ? 'bullishBOS' : 'bearishBOS';
    const direction: 'bullish' | 'bearish' = sb.direction === 'bullish' ? 'bullish' : 'bearish';

    const entryIndex = sb.breakIndex;
    if (entryIndex !== undefined && entryIndex < candles.length - lookforward) {
      const ret = calculateForwardReturn(candles, entryIndex, lookforward, direction);
      results[key]!.returns.push(ret);
      results[key]!.totalSignals++;
      if (ret > 0) results[key]!.positiveReturns++;
    }
  }

  // Analyze CHoCH breaks
  console.log(`  Analyzing ${chochBreaks.length} CHoCH breaks...`);
  for (const sb of chochBreaks) {
    const key = sb.direction === 'bullish' ? 'bullishCHoCH' : 'bearishCHoCH';
    const direction: 'bullish' | 'bearish' = sb.direction === 'bullish' ? 'bullish' : 'bearish';

    const entryIndex = sb.breakIndex;
    if (entryIndex !== undefined && entryIndex < candles.length - lookforward) {
      const ret = calculateForwardReturn(candles, entryIndex, lookforward, direction);
      results[key]!.returns.push(ret);
      results[key]!.totalSignals++;
      if (ret > 0) results[key]!.positiveReturns++;
    }
  }

  // Calculate statistics for each signal type
  for (const key of Object.keys(results)) {
    const r = results[key]!;
    if (r.returns.length > 0) {
      r.avgReturn = r.returns.reduce((a, b) => a + b, 0) / r.returns.length;
      r.hitRate = r.positiveReturns / r.totalSignals;

      const positive = r.returns.filter(x => x > 0);
      const negative = r.returns.filter(x => x < 0);

      r.avgReturnPositive = positive.length > 0
        ? positive.reduce((a, b) => a + b, 0) / positive.length
        : 0;
      r.avgReturnNegative = negative.length > 0
        ? negative.reduce((a, b) => a + b, 0) / negative.length
        : 0;
    }
  }

  return results;
}

function printResults(symbol: string, results: Partial<AnalysisResult>): void {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`ICT Signal Analysis: ${symbol}`);
  console.log(`${'='.repeat(70)}\n`);

  console.log('Signal Type        | Count | Hit Rate | Avg Ret | Avg Win | Avg Loss | Edge');
  console.log('-'.repeat(70));

  const signalNames: Record<string, string> = {
    bullishOB: 'Bullish OB',
    bearishOB: 'Bearish OB',
    bullishFVG: 'Bullish FVG',
    bearishFVG: 'Bearish FVG',
    bullishBOS: 'Bullish BOS',
    bearishBOS: 'Bearish BOS',
    bullishCHoCH: 'Bullish CHoCH',
    bearishCHoCH: 'Bearish CHoCH',
  };

  let totalSignals = 0;
  let totalEdge = 0;
  let signalsWithEdge = 0;

  for (const [key, name] of Object.entries(signalNames)) {
    const r = results[key as keyof typeof results] as SignalResult | undefined;
    if (!r || r.totalSignals === 0) {
      console.log(`${name.padEnd(18)} | ${'-'.padStart(5)} | ${'N/A'.padStart(8)} | ${'N/A'.padStart(7)} | ${'N/A'.padStart(7)} | ${'N/A'.padStart(8)} | N/A`);
      continue;
    }

    // Edge = Expected value = hitRate * avgWin + (1-hitRate) * avgLoss
    const edge = r.hitRate * r.avgReturnPositive + (1 - r.hitRate) * r.avgReturnNegative;

    const hitRateStr = `${(r.hitRate * 100).toFixed(1)}%`;
    const avgRetStr = `${(r.avgReturn * 100).toFixed(2)}%`;
    const avgWinStr = `${(r.avgReturnPositive * 100).toFixed(2)}%`;
    const avgLossStr = `${(r.avgReturnNegative * 100).toFixed(2)}%`;
    const edgeStr = `${(edge * 100).toFixed(2)}%`;
    const edgeIndicator = edge > 0 ? '✓' : '✗';

    console.log(
      `${name.padEnd(18)} | ${String(r.totalSignals).padStart(5)} | ${hitRateStr.padStart(8)} | ${avgRetStr.padStart(7)} | ${avgWinStr.padStart(7)} | ${avgLossStr.padStart(8)} | ${edgeStr} ${edgeIndicator}`
    );

    totalSignals += r.totalSignals;
    totalEdge += edge * r.totalSignals;
    if (edge > 0) signalsWithEdge++;
  }

  console.log('-'.repeat(70));
  const weightedEdge = totalSignals > 0 ? totalEdge / totalSignals : 0;
  console.log(`\nWeighted Average Edge: ${(weightedEdge * 100).toFixed(3)}%`);
  console.log(`Signals with Positive Edge: ${signalsWithEdge} / ${Object.keys(signalNames).length}`);

  // Interpretation
  console.log('\n--- INTERPRETATION ---');
  if (weightedEdge > 0.001) { // > 0.1% edge
    console.log('✓ ICT signals show POSITIVE edge. RL should be able to learn.');
  } else if (weightedEdge > -0.001) {
    console.log('~ ICT signals show NEUTRAL edge. RL may struggle to find alpha.');
  } else {
    console.log('✗ ICT signals show NEGATIVE edge. RL cannot learn profitable patterns.');
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log('ICT Signal Predictive Value Analysis');
  console.log('='.repeat(70));
  console.log('\nThis tests if ICT concepts actually predict price movement.\n');

  // Find data files
  const dataDir = path.resolve('./data');
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json'));

  if (files.length === 0) {
    console.error('No data files found in ./data/');
    process.exit(1);
  }

  console.log(`Found ${files.length} data files.\n`);

  const lookforwards = [10, 20, 50]; // Test different forward windows

  for (const lookforward of lookforwards) {
    console.log(`\n${'#'.repeat(70)}`);
    console.log(`# LOOKFORWARD PERIOD: ${lookforward} BARS`);
    console.log(`${'#'.repeat(70)}`);

    for (const file of files.slice(0, 3)) { // Analyze first 3 files
      console.log(`\nLoading ${file}...`);
      const candles = loadCandles(path.join(dataDir, file));
      console.log(`  ${candles.length} candles loaded`);

      const symbol = file.replace('.json', '').replace('_1h', '');
      const results = analyzeSymbol(candles, lookforward);
      printResults(symbol, results);
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('Analysis Complete');
  console.log('='.repeat(70));
}

main().catch(console.error);
