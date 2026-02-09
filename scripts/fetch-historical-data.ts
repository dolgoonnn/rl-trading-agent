#!/usr/bin/env npx tsx
/**
 * Fetch Historical Data
 * Downloads OHLCV data from multiple sources for RL training
 *
 * Supported providers:
 * - Binance: Crypto pairs (BTCUSDT, ETHUSDT, etc.)
 * - Yahoo Finance: Forex and commodities (EURUSD=X, GC=F, etc.)
 *
 * Usage:
 *   npx tsx scripts/fetch-historical-data.ts --symbol BTCUSDT --timeframe 1h --days 365
 *   npx tsx scripts/fetch-historical-data.ts --symbol EURUSD=X --timeframe 1h --days 365
 *   npx tsx scripts/fetch-historical-data.ts --all --timeframe 1h --days 365
 */

import fs from 'fs';
import path from 'path';
import { SYMBOLS, normalizeSymbolName } from '../src/lib/rl/config/symbols';

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface DataProviderInterface {
  name: string;
  supportedSymbols: string[];
  fetchCandles(symbol: string, timeframe: string, days: number): Promise<Candle[]>;
}

// ============================================
// Binance Provider
// ============================================

const BINANCE_API = 'https://api.binance.com/api/v3';

const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
};

async function fetchBinanceKlines(
  symbol: string,
  interval: string,
  startTime: number,
  endTime: number,
  limit: number = 1000
): Promise<Candle[]> {
  const params = new URLSearchParams({
    symbol,
    interval,
    startTime: startTime.toString(),
    endTime: endTime.toString(),
    limit: limit.toString(),
  });

  const url = `${BINANCE_API}/klines?${params}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Binance API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as (string | number)[][];

  return data.map((k) => ({
    timestamp: k[0] as number,
    open: parseFloat(k[1] as string),
    high: parseFloat(k[2] as string),
    low: parseFloat(k[3] as string),
    close: parseFloat(k[4] as string),
    volume: parseFloat(k[5] as string),
    takerBuyVolume: parseFloat(k[9] as string) || 0,
  }));
}

const BinanceProvider: DataProviderInterface = {
  name: 'Binance',
  supportedSymbols: Object.entries(SYMBOLS)
    .filter(([_, cfg]) => cfg.provider === 'binance')
    .map(([sym]) => sym),

  async fetchCandles(symbol: string, timeframe: string, days: number): Promise<Candle[]> {
    const intervalMs = TIMEFRAME_MS[timeframe];
    if (!intervalMs) {
      throw new Error(`Invalid timeframe: ${timeframe}`);
    }

    const endTime = Date.now();
    const startTime = endTime - days * 24 * 60 * 60 * 1000;

    const allCandles: Candle[] = [];
    let currentStart = startTime;

    while (currentStart < endTime) {
      const batchEnd = Math.min(currentStart + 1000 * intervalMs, endTime);
      console.log(`  [Binance] ${new Date(currentStart).toISOString().slice(0, 10)} to ${new Date(batchEnd).toISOString().slice(0, 10)}`);

      const candles = await fetchBinanceKlines(symbol, timeframe, currentStart, batchEnd);
      allCandles.push(...candles);
      currentStart = batchEnd;

      // Rate limiting
      await sleep(200);
    }

    return deduplicateAndSort(allCandles);
  },
};

// ============================================
// Yahoo Finance Provider
// ============================================

const YAHOO_INTERVALS: Record<string, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '1h', // Yahoo doesn't support 4h, we'll aggregate
  '1d': '1d',
  '1w': '1wk',
};

async function fetchYahooData(
  symbol: string,
  interval: string,
  period1: number,
  period2: number
): Promise<Candle[]> {
  // Yahoo Finance URL
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&period1=${Math.floor(period1 / 1000)}&period2=${Math.floor(period2 / 1000)}`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    },
  });

  if (!response.ok) {
    throw new Error(`Yahoo API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: {
          quote?: Array<{
            open?: (number | null)[];
            high?: (number | null)[];
            low?: (number | null)[];
            close?: (number | null)[];
            volume?: (number | null)[];
          }>;
        };
      }>;
      error?: { code: string; description: string };
    };
  };

  if (data.chart?.error) {
    throw new Error(`Yahoo API error: ${data.chart.error.description}`);
  }

  const result = data.chart?.result?.[0];
  if (!result || !result.timestamp || !result.indicators?.quote?.[0]) {
    throw new Error('Invalid Yahoo response format');
  }

  const timestamps = result.timestamp;
  const quote = result.indicators.quote[0];
  const candles: Candle[] = [];

  for (let i = 0; i < timestamps.length; i++) {
    const open = quote.open?.[i];
    const high = quote.high?.[i];
    const low = quote.low?.[i];
    const close = quote.close?.[i];
    const volume = quote.volume?.[i];

    // Skip null values (market closed)
    if (open != null && high != null && low != null && close != null) {
      candles.push({
        timestamp: timestamps[i]! * 1000, // Convert to ms
        open,
        high,
        low,
        close,
        volume: volume ?? 0,
      });
    }
  }

  return candles;
}

const YahooProvider: DataProviderInterface = {
  name: 'Yahoo Finance',
  supportedSymbols: Object.entries(SYMBOLS)
    .filter(([_, cfg]) => cfg.provider === 'yahoo')
    .map(([sym]) => sym),

  async fetchCandles(symbol: string, timeframe: string, days: number): Promise<Candle[]> {
    const yahooInterval = YAHOO_INTERVALS[timeframe];
    if (!yahooInterval) {
      throw new Error(`Unsupported timeframe for Yahoo: ${timeframe}`);
    }

    const endTime = Date.now();
    const startTime = endTime - days * 24 * 60 * 60 * 1000;

    // Yahoo has limits on how far back you can go for intraday data
    // For 1h data, max is about 730 days
    const allCandles: Candle[] = [];

    // Fetch in chunks of 30 days for intraday
    const chunkSize = timeframe === '1d' || timeframe === '1w' ? days : 30;
    const chunkMs = chunkSize * 24 * 60 * 60 * 1000;
    let currentStart = startTime;

    while (currentStart < endTime) {
      const chunkEnd = Math.min(currentStart + chunkMs, endTime);
      console.log(`  [Yahoo] ${new Date(currentStart).toISOString().slice(0, 10)} to ${new Date(chunkEnd).toISOString().slice(0, 10)}`);

      try {
        const candles = await fetchYahooData(symbol, yahooInterval, currentStart, chunkEnd);
        allCandles.push(...candles);
      } catch (error) {
        console.warn(`  Warning: Failed to fetch chunk: ${error}`);
      }

      currentStart = chunkEnd;
      await sleep(500); // Be nice to Yahoo
    }

    // Aggregate to 4h if needed
    if (timeframe === '4h') {
      return aggregateCandles(allCandles, 4);
    }

    return deduplicateAndSort(allCandles);
  },
};

// ============================================
// Helper Functions
// ============================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deduplicateAndSort(candles: Candle[]): Candle[] {
  return Array.from(
    new Map(candles.map((c) => [c.timestamp, c])).values()
  ).sort((a, b) => a.timestamp - b.timestamp);
}

function aggregateCandles(candles: Candle[], hoursPerCandle: number): Candle[] {
  if (candles.length === 0) return [];

  const msPerCandle = hoursPerCandle * 60 * 60 * 1000;
  const aggregated: Candle[] = [];
  let bucket: Candle[] = [];
  let bucketStart = Math.floor(candles[0]!.timestamp / msPerCandle) * msPerCandle;

  for (const candle of candles) {
    const candleBucket = Math.floor(candle.timestamp / msPerCandle) * msPerCandle;

    if (candleBucket !== bucketStart && bucket.length > 0) {
      // Aggregate bucket
      aggregated.push({
        timestamp: bucketStart,
        open: bucket[0]!.open,
        high: Math.max(...bucket.map((c) => c.high)),
        low: Math.min(...bucket.map((c) => c.low)),
        close: bucket[bucket.length - 1]!.close,
        volume: bucket.reduce((sum, c) => sum + c.volume, 0),
      });
      bucket = [];
      bucketStart = candleBucket;
    }

    bucket.push(candle);
  }

  // Last bucket
  if (bucket.length > 0) {
    aggregated.push({
      timestamp: bucketStart,
      open: bucket[0]!.open,
      high: Math.max(...bucket.map((c) => c.high)),
      low: Math.min(...bucket.map((c) => c.low)),
      close: bucket[bucket.length - 1]!.close,
      volume: bucket.reduce((sum, c) => sum + c.volume, 0),
    });
  }

  return aggregated;
}

function getProviderForSymbol(symbol: string): DataProviderInterface {
  const config = SYMBOLS[symbol];
  if (!config) {
    // Try to guess based on symbol format
    if (symbol.endsWith('=X') || symbol.endsWith('=F')) {
      return YahooProvider;
    }
    return BinanceProvider;
  }

  return config.provider === 'binance' ? BinanceProvider : YahooProvider;
}

async function fetchAndSaveSymbol(
  symbol: string,
  timeframe: string,
  days: number,
  outputDir: string
): Promise<void> {
  const provider = getProviderForSymbol(symbol);
  const config = SYMBOLS[symbol];
  const displayName = config?.name ?? symbol;

  console.log(`\nFetching ${displayName} (${symbol}) from ${provider.name}...`);

  try {
    const candles = await provider.fetchCandles(symbol, timeframe, days);

    if (candles.length === 0) {
      console.warn(`  No data fetched for ${symbol}`);
      return;
    }

    // Save to file
    const fileName = `${normalizeSymbolName(symbol)}_${timeframe}.json`;
    const outputPath = path.join(outputDir, fileName);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(candles, null, 2));

    // Print summary
    const firstCandle = candles[0]!;
    const lastCandle = candles[candles.length - 1]!;
    console.log(`  Saved ${candles.length} candles to ${fileName}`);
    console.log(`  Period: ${new Date(firstCandle.timestamp).toISOString().slice(0, 10)} to ${new Date(lastCandle.timestamp).toISOString().slice(0, 10)}`);
    console.log(`  Price range: ${Math.min(...candles.map((c) => c.low)).toFixed(4)} - ${Math.max(...candles.map((c) => c.high)).toFixed(4)}`);
  } catch (error) {
    console.error(`  Error fetching ${symbol}: ${error}`);
  }
}

// ============================================
// CLI
// ============================================

function parseArgs(): { symbol?: string; all: boolean; timeframe: string; days: number; output: string; includeMinute: boolean } {
  const args = process.argv.slice(2);
  const options: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all') {
      options['all'] = 'true';
    } else if (arg === '--include-minute') {
      options['includeMinute'] = 'true';
    } else if (arg?.startsWith('--')) {
      const key = arg.replace(/^--/, '');
      const value = args[i + 1];
      if (value && !value.startsWith('--')) {
        options[key] = value;
        i++;
      }
    }
  }

  return {
    symbol: options['symbol'],
    all: options['all'] === 'true',
    timeframe: options['timeframe'] || '1h',
    days: parseInt(options['days'] || '1095', 10), // Default to 3 years
    output: options['output'] || 'data',
    includeMinute: options['includeMinute'] === 'true',
  };
}

async function main() {
  const { symbol, all, timeframe, days, output, includeMinute } = parseArgs();

  console.log('='.repeat(60));
  console.log('ICT Trading - Historical Data Fetcher');
  console.log('='.repeat(60));

  if (!symbol && !all) {
    console.log('\nUsage:');
    console.log('  npx tsx scripts/fetch-historical-data.ts --symbol BTCUSDT --timeframe 1h --days 1095');
    console.log('  npx tsx scripts/fetch-historical-data.ts --all --timeframe 1h --days 1095');
    console.log('  npx tsx scripts/fetch-historical-data.ts --symbol BTCUSDT --include-minute --days 30');
    console.log('\nOptions:');
    console.log('  --days N          Number of days to fetch (default: 1095 = 3 years)');
    console.log('  --include-minute  Also fetch 1m data for DARL augmentation (Binance only, max 30 days)');
    console.log('\nSupported symbols:');
    for (const [sym, cfg] of Object.entries(SYMBOLS)) {
      console.log(`  ${sym.padEnd(12)} (${cfg.provider}) - ${cfg.name ?? sym}`);
    }
    return;
  }

  console.log(`\nTimeframe: ${timeframe}`);
  console.log(`Days: ${days}`);
  console.log(`Output: ${output}/`);
  if (includeMinute) {
    console.log('Include minute data: Yes (for DARL augmentation)');
  }

  if (all) {
    // Fetch all supported symbols
    console.log(`\nFetching all ${Object.keys(SYMBOLS).length} supported symbols...`);
    for (const sym of Object.keys(SYMBOLS)) {
      await fetchAndSaveSymbol(sym, timeframe, days, output);

      // Fetch minute data for Binance symbols if requested
      if (includeMinute && SYMBOLS[sym]?.provider === 'binance') {
        const minuteDays = Math.min(30, days); // Binance limits minute data
        console.log(`  Also fetching 1m data (${minuteDays} days) for DARL...`);
        await fetchAndSaveSymbol(sym, '1m', minuteDays, output);
      }

      await sleep(1000); // Pause between symbols
    }
  } else if (symbol) {
    await fetchAndSaveSymbol(symbol, timeframe, days, output);

    // Fetch minute data if requested
    if (includeMinute) {
      const config = SYMBOLS[symbol];
      if (config?.provider === 'binance') {
        const minuteDays = Math.min(30, days);
        console.log(`\nAlso fetching 1m data (${minuteDays} days) for DARL...`);
        await fetchAndSaveSymbol(symbol, '1m', minuteDays, output);
      } else {
        console.log('\nNote: Minute data only available for Binance symbols');
      }
    }
  }

  console.log('\nDone!');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
