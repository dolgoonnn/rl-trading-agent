#!/usr/bin/env npx tsx
/**
 * Regime-Aware Training Script
 *
 * Key insights from baseline analysis:
 * 1. Training data (Feb 2023 - Jun 2025) is +350% bull run
 * 2. Validation data (Jun 2025 - Feb 2026) is -26% bear market
 * 3. Models learn bull patterns that fail in bear markets
 *
 * Solution approaches:
 * A. Walk-forward validation with regime matching
 * B. Use only recent data with similar volatility regime
 * C. Add regime as explicit input feature
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import { MultiSymbolTrainer } from '../src/lib/rl/training';
import { DQNAgent } from '../src/lib/rl/agent/dqn-agent';
import { SYMBOLS, normalizeSymbolName } from '../src/lib/rl/config/symbols';

// ============================================
// Regime Detection
// ============================================

interface RegimeInfo {
  type: 'bull' | 'bear' | 'sideways';
  strength: number; // 0-1
  volatility: number; // ATR as % of price
}

function detectRegime(candles: Candle[], lookback: number = 100): RegimeInfo {
  if (candles.length < lookback) {
    return { type: 'sideways', strength: 0.5, volatility: 0.01 };
  }

  const slice = candles.slice(-lookback);
  const startPrice = slice[0].close;
  const endPrice = slice[slice.length - 1].close;
  const change = (endPrice - startPrice) / startPrice;

  // Calculate ATR
  let atr = 0;
  for (let i = 1; i < slice.length; i++) {
    const tr = Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i - 1].close),
      Math.abs(slice[i].low - slice[i - 1].close)
    );
    atr += tr;
  }
  atr /= (slice.length - 1);
  const volatility = atr / endPrice;

  // Determine regime
  if (change > 0.1) {
    return { type: 'bull', strength: Math.min(1, change / 0.3), volatility };
  } else if (change < -0.1) {
    return { type: 'bear', strength: Math.min(1, -change / 0.3), volatility };
  } else {
    return { type: 'sideways', strength: 1 - Math.abs(change) / 0.1, volatility };
  }
}

// ============================================
// Data Preparation with Regime Filtering
// ============================================

function loadAndFilterByRegime(
  symbol: string,
  targetRegime: 'bull' | 'bear' | 'sideways' | 'any',
  minVolatility: number = 0,
  maxVolatility: number = 1
): { train: Candle[]; val: Candle[] } | null {
  const filePath = path.join('data', `${symbol}_1h.json`);

  if (!fs.existsSync(filePath)) {
    console.warn(`[Data] File not found: ${filePath}`);
    return null;
  }

  const allCandles = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Candle[];
  console.log(`[Data] Loaded ${symbol}: ${allCandles.length} candles total`);

  // Analyze regime across time windows
  const windowSize = 500; // ~20 days
  const regimes: Array<{ start: number; end: number; regime: RegimeInfo }> = [];

  for (let i = 0; i < allCandles.length - windowSize; i += windowSize) {
    const window = allCandles.slice(i, i + windowSize);
    const regime = detectRegime(window, windowSize);
    regimes.push({ start: i, end: i + windowSize, regime });
  }

  console.log(`[Data] Detected ${regimes.length} regime windows`);

  // Filter windows by target regime
  let filteredCandles: Candle[] = [];

  for (const r of regimes) {
    if (targetRegime === 'any' ||
        r.regime.type === targetRegime) {
      if (r.regime.volatility >= minVolatility && r.regime.volatility <= maxVolatility) {
        filteredCandles.push(...allCandles.slice(r.start, r.end));
      }
    }
  }

  if (filteredCandles.length < 2000) {
    console.warn(`[Data] Not enough candles for ${targetRegime} regime (${filteredCandles.length})`);

    // Fallback: use recent 6 months for more stable regime
    console.log('[Data] Fallback: using recent 6 months for similar regime');
    const recentMonths = 6 * 30 * 24; // ~6 months in hourly candles
    filteredCandles = allCandles.slice(-Math.min(recentMonths, allCandles.length));
  }

  // Split 80/20
  const splitIdx = Math.floor(filteredCandles.length * 0.8);

  return {
    train: filteredCandles.slice(0, splitIdx),
    val: filteredCandles.slice(splitIdx),
  };
}

// Alternative: Walk-forward split
function walkForwardSplit(
  candles: Candle[],
  trainMonths: number = 3,
  valMonths: number = 1
): Array<{ train: Candle[]; val: Candle[] }> {
  const hoursPerMonth = 30 * 24;
  const trainSize = trainMonths * hoursPerMonth;
  const valSize = valMonths * hoursPerMonth;
  const stepSize = valSize; // Non-overlapping validation

  const folds: Array<{ train: Candle[]; val: Candle[] }> = [];

  for (let i = 0; i + trainSize + valSize <= candles.length; i += stepSize) {
    folds.push({
      train: candles.slice(i, i + trainSize),
      val: candles.slice(i + trainSize, i + trainSize + valSize),
    });
  }

  return folds;
}

// ============================================
// Main Training
// ============================================

async function main() {
  console.log('============================================================');
  console.log('Regime-Aware RL Training');
  console.log('============================================================\n');

  const symbol = 'BTCUSDT';

  // Method 1: Use recent data only (similar regime)
  console.log('=== Method 1: Recent Data Training ===\n');

  const data = loadAndFilterByRegime(symbol, 'any');
  if (!data) {
    console.error('Failed to load data');
    process.exit(1);
  }

  console.log(`Train candles: ${data.train.length}`);
  console.log(`Val candles: ${data.val.length}`);

  // Detect regimes
  const trainRegime = detectRegime(data.train, Math.min(500, data.train.length));
  const valRegime = detectRegime(data.val, Math.min(500, data.val.length));

  console.log(`\nTrain regime: ${trainRegime.type} (strength: ${trainRegime.strength.toFixed(2)}, vol: ${(trainRegime.volatility * 100).toFixed(2)}%)`);
  console.log(`Val regime: ${valRegime.type} (strength: ${valRegime.strength.toFixed(2)}, vol: ${(valRegime.volatility * 100).toFixed(2)}%)`);

  // Train with regime-aware features
  const symbolsData: Record<string, Candle[]> = { [symbol]: data.train };

  // Pass only recent data (both train and val will be in similar regime)
  const recentMonths = 6;
  const hoursPerMonth = 30 * 24;
  const recentData = data.train.slice(-recentMonths * hoursPerMonth);
  console.log(`\nUsing recent ${recentMonths} months: ${recentData.length} candles`);

  const recentSymbolsData: Record<string, Candle[]> = { [symbol]: recentData };

  const trainer = new MultiSymbolTrainer(
    recentSymbolsData,
    {
      episodes: 200,
      maxStepsPerEpisode: 1000,
      evalInterval: 20,
      logInterval: 10,
      earlyStoppingPatience: 50,
      validateOnAllSymbols: true,
      shuffleSymbols: false,
      balancedSampling: true,
      trainFrequency: 4,
      trainSplit: 0.8, // 80/20 split on recent data
    },
    {
      initialCapital: 10000,
      positionSizePct: 0.1,
    },
    {
      // Simpler model to avoid overfitting
      hiddenLayers: [32, 16],
      learningRate: 0.0005,
      dropout: 0.5,
      l2Regularization: 0.1,
      gamma: 0.95,
      epsilon: 1.0,
      epsilonDecay: 0.995,
      epsilonMin: 0.1,
      batchSize: 64,
      replayBufferSize: 20000,
      targetUpdateFreq: 500,
    }
  );

  const result = await trainer.train();

  console.log('\n============================================================');
  console.log('REGIME-AWARE TRAINING RESULTS');
  console.log('============================================================\n');

  // Save model if results are promising
  const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const modelPath = `models/model_regime_${now}.json`;
  const reportPath = `models/report_regime_${now}.json`;

  if (result.agent) {
    const weights = await result.agent.serialize();
    fs.writeFileSync(modelPath, JSON.stringify(weights));
    console.log(`Model saved to: ${modelPath}`);
  }

  fs.writeFileSync(reportPath, JSON.stringify({
    method: 'regime-aware',
    trainRegime,
    valRegime,
    metrics: result.metrics,
  }, null, 2));
  console.log(`Report saved to: ${reportPath}`);
}

main().catch(console.error);
