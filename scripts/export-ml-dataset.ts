#!/usr/bin/env npx tsx
/**
 * Export ML Dataset
 * Extracts state vectors and labels from the RL environment for ML training
 *
 * Labels are based on future price movement (simplified version of reward function):
 * - 0: HOLD (no significant movement)
 * - 1: BUY (price increases significantly)
 * - 2: SELL (price decreases significantly)
 *
 * Usage:
 *   npx tsx scripts/export-ml-dataset.ts --symbol BTCUSDT --output ./data/ml_dataset.json
 *   npx tsx scripts/export-ml-dataset.ts --all --output ./data/ml_dataset.json
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '../src/types';
import { TradingEnvironment } from '../src/lib/rl/environment/trading-env';
import { SYMBOLS, normalizeSymbolName, getEnvConfigForSymbol } from '../src/lib/rl/config/symbols';

interface DataPoint {
  features: number[];
  label: number; // 0=HOLD, 1=BUY, 2=SELL
  futureReturn: number;
  symbol: string;
  timestamp: number;
}

interface MLDataset {
  trainData: DataPoint[];
  valData: DataPoint[];
  metadata: {
    featureSize: number;
    trainSamples: number;
    valSamples: number;
    symbols: string[];
    labelDistribution: { hold: number; buy: number; sell: number };
    exportedAt: string;
  };
}

function loadCandles(symbol: string): Candle[] | null {
  const fileName = `${normalizeSymbolName(symbol)}_1h.json`;
  const dataPath = path.join(process.cwd(), 'data', fileName);

  if (!fs.existsSync(dataPath)) {
    console.warn(`  [SKIP] Data file not found: ${dataPath}`);
    return null;
  }

  return JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as Candle[];
}

/**
 * Calculate future return for labeling
 * Look-ahead period determines the prediction horizon
 */
function calculateFutureReturn(
  candles: Candle[],
  currentIndex: number,
  lookAheadPeriod: number = 10
): number {
  if (currentIndex + lookAheadPeriod >= candles.length) {
    return 0;
  }

  const currentPrice = candles[currentIndex]!.close;
  const futurePrice = candles[currentIndex + lookAheadPeriod]!.close;

  return (futurePrice - currentPrice) / currentPrice;
}

/**
 * Convert future return to action label
 * Using thresholds based on transaction costs + minimum profit target
 */
function returnToLabel(
  futureReturn: number,
  buyThreshold: number = 0.005, // 0.5% profit target
  sellThreshold: number = -0.005 // 0.5% loss target for shorts
): number {
  if (futureReturn > buyThreshold) {
    return 1; // BUY
  } else if (futureReturn < sellThreshold) {
    return 2; // SELL
  }
  return 0; // HOLD
}

function extractDataFromSymbol(
  symbol: string,
  trainRatio: number = 0.8,
  lookAheadPeriod: number = 10
): { train: DataPoint[]; val: DataPoint[] } | null {
  const candles = loadCandles(symbol);
  if (!candles || candles.length < 200) {
    return null;
  }

  const envConfig = {
    ...getEnvConfigForSymbol(symbol),
    initialCapital: 10000,
    lookbackPeriod: 60,
  };

  const env = new TradingEnvironment(candles, envConfig);

  const train: DataPoint[] = [];
  const val: DataPoint[] = [];

  // Skip first lookback period and last look-ahead period
  const startIndex = 60;
  const endIndex = candles.length - lookAheadPeriod - 1;
  const splitIndex = Math.floor((endIndex - startIndex) * trainRatio) + startIndex;

  for (let i = startIndex; i < endIndex; i++) {
    // Reset environment to this point
    const state = env.getStateAt(i);
    if (!state) continue;

    const futureReturn = calculateFutureReturn(candles, i, lookAheadPeriod);
    const label = returnToLabel(futureReturn);

    const dataPoint: DataPoint = {
      features: state.features,
      label,
      futureReturn,
      symbol,
      timestamp: candles[i]!.timestamp,
    };

    if (i < splitIndex) {
      train.push(dataPoint);
    } else {
      val.push(dataPoint);
    }
  }

  console.log(`  [OK] ${symbol}: ${train.length} train, ${val.length} val samples`);
  return { train, val };
}

function countLabelDistribution(data: DataPoint[]): { hold: number; buy: number; sell: number } {
  let hold = 0, buy = 0, sell = 0;
  for (const d of data) {
    if (d.label === 0) hold++;
    else if (d.label === 1) buy++;
    else sell++;
  }
  return { hold, buy, sell };
}

async function exportDataset(
  symbols: string[],
  outputPath: string,
  trainRatio: number = 0.8,
  lookAheadPeriod: number = 10
): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log('ML Dataset Export');
  console.log(`${'='.repeat(60)}\n`);

  console.log(`Symbols: ${symbols.join(', ')}`);
  console.log(`Train/Val split: ${trainRatio * 100}%/${(1 - trainRatio) * 100}%`);
  console.log(`Look-ahead period: ${lookAheadPeriod} candles\n`);

  const allTrain: DataPoint[] = [];
  const allVal: DataPoint[] = [];
  const processedSymbols: string[] = [];
  let featureSize = 0;

  for (const symbol of symbols) {
    const result = extractDataFromSymbol(symbol, trainRatio, lookAheadPeriod);
    if (result) {
      allTrain.push(...result.train);
      allVal.push(...result.val);
      processedSymbols.push(symbol);
      featureSize = result.train[0]?.features.length ?? 0;
    }
  }

  if (allTrain.length === 0) {
    throw new Error('No data extracted. Run fetch-historical-data.ts first.');
  }

  // Shuffle training data
  for (let i = allTrain.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allTrain[i], allTrain[j]] = [allTrain[j]!, allTrain[i]!];
  }

  const labelDist = countLabelDistribution(allTrain);

  const dataset: MLDataset = {
    trainData: allTrain,
    valData: allVal,
    metadata: {
      featureSize,
      trainSamples: allTrain.length,
      valSamples: allVal.length,
      symbols: processedSymbols,
      labelDistribution: labelDist,
      exportedAt: new Date().toISOString(),
    },
  };

  // Save to file
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(outputPath, JSON.stringify(dataset, null, 2));

  console.log(`\n${'='.repeat(60)}`);
  console.log('EXPORT SUMMARY');
  console.log(`${'='.repeat(60)}`);
  console.log(`Feature size: ${featureSize}`);
  console.log(`Train samples: ${allTrain.length}`);
  console.log(`Validation samples: ${allVal.length}`);
  console.log(`\nLabel distribution (train):`);
  console.log(`  HOLD: ${labelDist.hold} (${((labelDist.hold / allTrain.length) * 100).toFixed(1)}%)`);
  console.log(`  BUY:  ${labelDist.buy} (${((labelDist.buy / allTrain.length) * 100).toFixed(1)}%)`);
  console.log(`  SELL: ${labelDist.sell} (${((labelDist.sell / allTrain.length) * 100).toFixed(1)}%)`);
  console.log(`\nDataset saved to: ${outputPath}`);
}

// CLI
function parseArgs(): { symbols: string[]; output: string } {
  const args = process.argv.slice(2);
  const options: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all') {
      options['all'] = 'true';
    } else if (arg?.startsWith('--')) {
      const key = arg.replace(/^--/, '');
      const value = args[i + 1];
      if (value && !value.startsWith('--')) {
        options[key] = value;
        i++;
      }
    }
  }

  let symbols: string[];
  if (options['all'] === 'true') {
    symbols = Object.keys(SYMBOLS);
  } else if (options['symbol']) {
    symbols = [options['symbol']];
  } else {
    // Default: crypto only for larger dataset
    symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  }

  return {
    symbols,
    output: options['output'] || './data/ml_dataset.json',
  };
}

async function main() {
  const { symbols, output } = parseArgs();

  try {
    await exportDataset(symbols, output);
    console.log('\nDone!');
  } catch (error) {
    console.error('\nExport error:', error);
    process.exit(1);
  }
}

main();
