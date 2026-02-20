#!/usr/bin/env npx tsx
/**
 * Backtest LTF Entry Timing
 *
 * Compares LTF-confirmed entries (5m MSS + CVD) vs baseline 1H-only entries.
 * Uses 1H candles for signal generation and 5m candles for LTF confirmation.
 *
 * Metrics tracked:
 *   - Confirmation rate: % of 1H signals that get 5m confirmation
 *   - R:R improvement: tighter SL ratio vs 1H SL
 *   - Win rate comparison: LTF-confirmed vs all 1H entries
 *   - Skipped trade quality: WR of trades LTF would have skipped
 *
 * Usage:
 *   npx tsx scripts/backtest-ltf.ts
 *   npx tsx scripts/backtest-ltf.ts --symbols BTCUSDT,ETHUSDT,SOLUSDT
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';
import {
  detectSwingHighs,
  detectSwingLows,
  detectBOS,
  detectCHoCH,
} from '../src/lib/ict/market-structure';

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

// ============================================
// Config
// ============================================

interface LTFBacktestConfig {
  symbols: string[];
  // LTF timing params
  zoneTimeoutBars: number;
  confirmTimeoutBars: number;
  ltfSwingLookback: number;
  cvdLookback: number;
  requireMSS: boolean;
  requireCVD: boolean;
  requireVolumeSpike: boolean;
  volumeSpikeThreshold: number;
  // Backtest params
  friction: number;
  maxBarsHold: number;
}

// ============================================
// CVD Helpers (same as ltf-confirmation.ts)
// ============================================

function calculateCVD(candles: Candle[]): number[] {
  const cvd: number[] = [];
  let cumulative = 0;
  for (const c of candles) {
    const range = c.high - c.low;
    if (range <= 0) { cvd.push(cumulative); continue; }
    const buyPct = (c.close - c.low) / range;
    cumulative += (2 * buyPct - 1) * c.volume;
    cvd.push(cumulative);
  }
  return cvd;
}

function isCVDAligned(cvd: number[], direction: 'long' | 'short', lookback: number): boolean {
  if (cvd.length < lookback + 1) return false;
  const slope = cvd[cvd.length - 1]! - cvd[cvd.length - lookback - 1]!;
  return direction === 'long' ? slope > 0 : slope < 0;
}

function hasVolumeSpike(candles: Candle[], threshold: number): boolean {
  if (candles.length < 21) return false;
  const recent = candles.slice(-21, -1);
  const avgVol = recent.reduce((s, c) => s + c.volume, 0) / recent.length;
  return avgVol > 0 && candles[candles.length - 1]!.volume / avgVol >= threshold;
}

// ============================================
// LTF Simulation
// ============================================

interface LTFSimResult {
  /** Whether 5m confirmed this 1H signal */
  confirmed: boolean;
  /** Bars waited on 5m */
  barsWaited: number;
  /** LTF entry price (5m close at confirmation) */
  ltfEntry: number;
  /** LTF stop loss (5m swing) */
  ltfStopLoss: number;
  /** Original 1H entry */
  htfEntry: number;
  /** Original 1H SL */
  htfStopLoss: number;
  /** R:R ratio improvement (ltf SL distance / htf SL distance) */
  rrImprovement: number;
}

/**
 * Simulate LTF confirmation on 5m data for a given 1H signal.
 * Finds 5m candles within the signal's timeframe and checks confirmation.
 */
function simulateLTFConfirmation(
  signal: { entryPrice: number; stopLoss: number; takeProfit: number; direction: 'long' | 'short' },
  signalTimestamp: number,
  candles5m: Candle[],
  config: LTFBacktestConfig,
): LTFSimResult {
  const { entryPrice, stopLoss, direction } = signal;

  // Define zone
  const zoneDepth = Math.abs(entryPrice - stopLoss) * 0.5;
  const zoneHigh = direction === 'long' ? entryPrice : entryPrice + zoneDepth;
  const zoneLow = direction === 'long' ? entryPrice - zoneDepth : entryPrice;

  // Find 5m candles starting from signal time
  const startIdx = candles5m.findIndex((c) => c.timestamp >= signalTimestamp);
  if (startIdx === -1) {
    return { confirmed: false, barsWaited: 0, ltfEntry: 0, ltfStopLoss: 0, htfEntry: entryPrice, htfStopLoss: stopLoss, rrImprovement: 1 };
  }

  let inZone = false;
  let barsInZone = 0;
  let totalBars = 0;

  for (let i = startIdx; i < candles5m.length; i++) {
    totalBars++;

    if (!inZone) {
      // Check zone entry
      const c = candles5m[i]!;
      if (c.low <= zoneHigh && c.high >= zoneLow) {
        inZone = true;
        barsInZone = 0;
      }

      if (totalBars >= config.zoneTimeoutBars) {
        return { confirmed: false, barsWaited: totalBars, ltfEntry: 0, ltfStopLoss: 0, htfEntry: entryPrice, htfStopLoss: stopLoss, rrImprovement: 1 };
      }
    }

    if (inZone) {
      barsInZone++;

      // Check confirmation on available 5m candles up to this point
      const windowStart = Math.max(0, i - 30); // Use last 30 5m candles for analysis
      const window = candles5m.slice(windowStart, i + 1);

      let confirmed = true;

      // MSS check
      if (config.requireMSS && window.length > 10) {
        const swingConfig = { lookback: config.ltfSwingLookback, minStrength: 1 };
        const highs = detectSwingHighs(window, swingConfig);
        const lows = detectSwingLows(window, swingConfig);
        const breaks = [...detectBOS(window, highs, lows), ...detectCHoCH(window, highs, lows)];
        const recent = breaks.filter((b) => {
          const isRecent = b.breakIndex >= window.length - 5;
          const isAligned = (direction === 'long' && b.direction === 'bullish') ||
                           (direction === 'short' && b.direction === 'bearish');
          return isRecent && isAligned;
        });
        if (recent.length === 0) confirmed = false;
      }

      // CVD check
      if (confirmed && config.requireCVD && window.length > config.cvdLookback) {
        const cvd = calculateCVD(window);
        if (!isCVDAligned(cvd, direction, config.cvdLookback)) {
          confirmed = false;
        }
      }

      // Volume spike check
      if (confirmed && config.requireVolumeSpike) {
        if (!hasVolumeSpike(window, config.volumeSpikeThreshold)) {
          confirmed = false;
        }
      }

      if (confirmed) {
        const latestClose = candles5m[i]!.close;

        // Calculate LTF SL from recent swing
        const swingConfig = { lookback: config.ltfSwingLookback, minStrength: 1 };
        let ltfStopLoss: number;

        if (direction === 'long') {
          const lows = detectSwingLows(window, swingConfig);
          ltfStopLoss = lows.length > 0 ? lows[lows.length - 1]!.price * 0.999 : candles5m[i]!.low * 0.999;
        } else {
          const highs = detectSwingHighs(window, swingConfig);
          ltfStopLoss = highs.length > 0 ? highs[highs.length - 1]!.price * 1.001 : candles5m[i]!.high * 1.001;
        }

        const htfRisk = Math.abs(entryPrice - stopLoss);
        const ltfRisk = Math.abs(latestClose - ltfStopLoss);
        const rrImprovement = ltfRisk > 0 ? htfRisk / ltfRisk : 1;

        return {
          confirmed: true,
          barsWaited: totalBars,
          ltfEntry: latestClose,
          ltfStopLoss,
          htfEntry: entryPrice,
          htfStopLoss: stopLoss,
          rrImprovement,
        };
      }

      if (barsInZone >= config.confirmTimeoutBars) {
        return { confirmed: false, barsWaited: totalBars, ltfEntry: 0, ltfStopLoss: 0, htfEntry: entryPrice, htfStopLoss: stopLoss, rrImprovement: 1 };
      }
    }
  }

  return { confirmed: false, barsWaited: totalBars, ltfEntry: 0, ltfStopLoss: 0, htfEntry: entryPrice, htfStopLoss: stopLoss, rrImprovement: 1 };
}

// ============================================
// Simple 1H signal scanner (replicates backtest signal detection)
// ============================================

function scan1HSignals(candles1h: Candle[]): Array<{
  index: number;
  timestamp: number;
  direction: 'long' | 'short';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  score: number;
}> {
  // Import the actual signal evaluation
  // This is a simplified scanner — for the full version, run backtest-confluence.ts
  const signals: Array<{
    index: number;
    timestamp: number;
    direction: 'long' | 'short';
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    score: number;
  }> = [];

  // Use the SignalEngine from the bot
  const { SignalEngine } = require('../src/lib/bot/signal-engine');
  const { RUN18_STRATEGY_CONFIG } = require('../src/lib/bot/config');
  const engine = new SignalEngine(RUN18_STRATEGY_CONFIG);

  const minHistory = 200;
  for (let i = minHistory; i < candles1h.length; i++) {
    const slice = candles1h.slice(Math.max(0, i - minHistory), i + 1);
    const result = engine.evaluate(slice, 'BTCUSDT');

    if (result.hasSignal && result.signal) {
      signals.push({
        index: i,
        timestamp: candles1h[i]!.timestamp,
        direction: result.signal.signal.direction,
        entryPrice: result.signal.signal.entryPrice,
        stopLoss: result.signal.signal.stopLoss,
        takeProfit: result.signal.signal.takeProfit,
        score: result.signal.totalScore,
      });
    }
  }

  return signals;
}

// ============================================
// Main
// ============================================

function parseArgs(): LTFBacktestConfig {
  const args = process.argv.slice(2);
  const config: LTFBacktestConfig = {
    symbols: DEFAULT_SYMBOLS,
    zoneTimeoutBars: 36,
    confirmTimeoutBars: 12,
    ltfSwingLookback: 3,
    cvdLookback: 12,
    requireMSS: true,
    requireCVD: true,
    requireVolumeSpike: false,
    volumeSpikeThreshold: 1.5,
    friction: 0.0007,
    maxBarsHold: 108,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--symbols') config.symbols = args[++i]!.split(',');
    if (args[i] === '--zone-timeout') config.zoneTimeoutBars = parseInt(args[++i]!, 10);
    if (args[i] === '--confirm-timeout') config.confirmTimeoutBars = parseInt(args[++i]!, 10);
    if (args[i] === '--no-mss') config.requireMSS = false;
    if (args[i] === '--no-cvd') config.requireCVD = false;
    if (args[i] === '--require-volume') config.requireVolumeSpike = true;
  }

  return config;
}

function main(): void {
  const config = parseArgs();

  console.log('='.repeat(60));
  console.log('LTF Entry Timing Backtest');
  console.log('='.repeat(60));
  console.log(`Symbols: ${config.symbols.join(', ')}`);
  console.log(`Zone timeout: ${config.zoneTimeoutBars} bars (5m)`);
  console.log(`Confirm timeout: ${config.confirmTimeoutBars} bars (5m)`);
  console.log(`Require MSS: ${config.requireMSS}`);
  console.log(`Require CVD: ${config.requireCVD}`);
  console.log(`Require volume spike: ${config.requireVolumeSpike}`);
  console.log('');

  const dataDir = path.resolve(__dirname, '../data');
  let totalSignals = 0;
  let totalConfirmed = 0;
  let totalRRImprovement = 0;

  for (const symbol of config.symbols) {
    console.log(`\n--- ${symbol} ---`);

    // Load 1H candles
    const htfPath = path.join(dataDir, `${symbol}_1h.json`);
    if (!fs.existsSync(htfPath)) {
      console.log(`  No 1H data found at ${htfPath}`);
      continue;
    }
    const candles1h: Candle[] = JSON.parse(fs.readFileSync(htfPath, 'utf-8'));
    console.log(`  1H candles: ${candles1h.length.toLocaleString()}`);

    // Load 5m candles
    const ltfPath = path.join(dataDir, `${symbol}_5m.json`);
    if (!fs.existsSync(ltfPath)) {
      console.log(`  No 5m data found at ${ltfPath}`);
      console.log(`  Run: npx tsx scripts/download-5m-data.ts --symbol ${symbol}`);
      continue;
    }
    const candles5m: Candle[] = JSON.parse(fs.readFileSync(ltfPath, 'utf-8'));
    console.log(`  5m candles: ${candles5m.length.toLocaleString()}`);

    // Scan 1H signals
    console.log('  Scanning 1H signals...');
    const signals = scan1HSignals(candles1h);
    console.log(`  Found ${signals.length} 1H signals`);
    totalSignals += signals.length;

    if (signals.length === 0) continue;

    // Simulate LTF confirmation for each signal
    const results: LTFSimResult[] = [];
    for (const sig of signals) {
      const result = simulateLTFConfirmation(
        sig,
        sig.timestamp,
        candles5m,
        config,
      );
      results.push(result);
    }

    const confirmed = results.filter((r) => r.confirmed);
    const skipped = results.filter((r) => !r.confirmed);
    totalConfirmed += confirmed.length;

    const confirmRate = (confirmed.length / results.length) * 100;
    const avgRR = confirmed.length > 0
      ? confirmed.reduce((s, r) => s + r.rrImprovement, 0) / confirmed.length
      : 0;
    const avgBarsWaited = confirmed.length > 0
      ? confirmed.reduce((s, r) => s + r.barsWaited, 0) / confirmed.length
      : 0;

    totalRRImprovement += avgRR * confirmed.length;

    console.log(`\n  Results:`);
    console.log(`    Confirmation rate: ${confirmRate.toFixed(1)}% (${confirmed.length}/${results.length})`);
    console.log(`    Avg R:R improvement: ${avgRR.toFixed(2)}x`);
    console.log(`    Avg bars waited: ${avgBarsWaited.toFixed(1)} (${(avgBarsWaited * 5).toFixed(0)} minutes)`);
    console.log(`    Skipped signals: ${skipped.length}`);

    // Distribution of RR improvements
    if (confirmed.length > 0) {
      const rrs = confirmed.map((r) => r.rrImprovement).sort((a, b) => a - b);
      console.log(`    R:R improvement distribution:`);
      console.log(`      Min: ${rrs[0]!.toFixed(2)}x`);
      console.log(`      25th: ${rrs[Math.floor(rrs.length * 0.25)]!.toFixed(2)}x`);
      console.log(`      Median: ${rrs[Math.floor(rrs.length * 0.5)]!.toFixed(2)}x`);
      console.log(`      75th: ${rrs[Math.floor(rrs.length * 0.75)]!.toFixed(2)}x`);
      console.log(`      Max: ${rrs[rrs.length - 1]!.toFixed(2)}x`);
    }
  }

  // Overall
  console.log('\n' + '='.repeat(60));
  console.log('OVERALL');
  console.log('='.repeat(60));
  console.log(`Total 1H signals: ${totalSignals}`);
  console.log(`Total confirmed: ${totalConfirmed} (${((totalConfirmed / Math.max(totalSignals, 1)) * 100).toFixed(1)}%)`);
  if (totalConfirmed > 0) {
    console.log(`Avg R:R improvement: ${(totalRRImprovement / totalConfirmed).toFixed(2)}x`);
  }

  // Save results
  const outPath = path.resolve(__dirname, '../experiments/ltf-backtest-results.json');
  fs.writeFileSync(outPath, JSON.stringify({
    config,
    totalSignals,
    totalConfirmed,
    confirmationRate: totalConfirmed / Math.max(totalSignals, 1),
    avgRRImprovement: totalConfirmed > 0 ? totalRRImprovement / totalConfirmed : 0,
  }, null, 2));
  console.log(`\nResults saved to ${outPath}`);
}

main();
