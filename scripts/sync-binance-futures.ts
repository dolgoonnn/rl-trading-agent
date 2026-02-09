#!/usr/bin/env npx tsx
/**
 * Sync Binance Futures Data
 *
 * Backfills historical futures data (funding rates, open interest, long/short ratio)
 * and saves aligned hourly snapshots for each symbol.
 *
 * Usage:
 *   npx tsx scripts/sync-binance-futures.ts --symbol BTCUSDT --months 18
 *   npx tsx scripts/sync-binance-futures.ts --all --months 18
 *   npx tsx scripts/sync-binance-futures.ts --verify
 */

import fs from 'fs';
import path from 'path';
import {
  fetchFundingRates,
  fetchOpenInterestHistory,
  fetchLongShortRatio,
  alignToHourlySnapshots,
  type FuturesSnapshot,
} from '../src/lib/data/binance-futures-api';

// ============================================
// Config
// ============================================

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const DATA_DIR = path.join(process.cwd(), 'data');

// ============================================
// CLI Parsing
// ============================================

interface CLIArgs {
  symbols: string[];
  months: number;
  verify: boolean;
}

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  const result: CLIArgs = {
    symbols: [],
    months: 18,
    verify: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--symbol':
        result.symbols = [args[++i] ?? 'BTCUSDT'];
        break;
      case '--all':
        result.symbols = [...DEFAULT_SYMBOLS];
        break;
      case '--months':
        result.months = parseInt(args[++i] ?? '18', 10);
        break;
      case '--verify':
        result.verify = true;
        break;
    }
  }

  if (result.symbols.length === 0 && !result.verify) {
    result.symbols = [...DEFAULT_SYMBOLS];
  }

  return result;
}

// ============================================
// Sync Logic
// ============================================

async function syncSymbol(symbol: string, months: number): Promise<void> {
  const endTime = Date.now();
  const startTime = endTime - months * 30 * 24 * 60 * 60 * 1000;

  // Binance /futures/data/ endpoints only keep ~30 days of data
  const maxOILookback = 29 * 24 * 60 * 60 * 1000; // 29 days in ms
  const oiStartTime = Math.max(startTime, endTime - maxOILookback);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Syncing ${symbol} futures data (${months} months)`);
  console.log(`  Funding:   ${new Date(startTime).toISOString().slice(0, 10)} → now`);
  console.log(`  OI & L/S:  ${new Date(oiStartTime).toISOString().slice(0, 10)} → now (30-day API limit)`);
  console.log('='.repeat(60));

  // Load candle timestamps for alignment
  const candlePath = path.join(DATA_DIR, `${symbol}_1h.json`);
  if (!fs.existsSync(candlePath)) {
    console.error(`[Error] Candle file not found: ${candlePath}`);
    console.error('  Run: npx tsx scripts/fetch-historical-data.ts --symbol', symbol, '--timeframe 1h first');
    return;
  }

  interface CandleData { timestamp: number }
  const candles: CandleData[] = JSON.parse(fs.readFileSync(candlePath, 'utf-8'));
  const timestamps = candles
    .filter((c) => c.timestamp >= startTime && c.timestamp <= endTime)
    .map((c) => c.timestamp);

  console.log(`[Data] ${timestamps.length} hourly candle timestamps to align to`);

  // Fetch funding rates — deep history available (every 8h, 18 months)
  console.log('[Fetch] Funding rates...');
  const fundingRates = await fetchFundingRates(symbol, startTime, endTime);
  console.log(`  → ${fundingRates.length} entries`);

  // Fetch OI — only last 30 days available (non-fatal if it fails)
  let openInterest: Awaited<ReturnType<typeof fetchOpenInterestHistory>> = [];
  try {
    console.log('[Fetch] Open interest (last 30 days)...');
    openInterest = await fetchOpenInterestHistory(symbol, '1h', oiStartTime, endTime);
    console.log(`  → ${openInterest.length} entries`);
  } catch (err) {
    console.warn(`  → [Warning] OI fetch failed, continuing without it: ${(err as Error).message}`);
  }

  // Fetch L/S ratio — only last 30 days available (non-fatal if it fails)
  let longShortRatios: Awaited<ReturnType<typeof fetchLongShortRatio>> = [];
  try {
    console.log('[Fetch] Long/Short ratio (last 30 days)...');
    longShortRatios = await fetchLongShortRatio(symbol, '1h', oiStartTime, endTime);
    console.log(`  → ${longShortRatios.length} entries`);
  } catch (err) {
    console.warn(`  → [Warning] L/S fetch failed, continuing without it: ${(err as Error).message}`);
  }

  // Align to hourly snapshots
  console.log('[Align] Building hourly snapshots...');
  const snapshots = alignToHourlySnapshots(timestamps, fundingRates, openInterest, longShortRatios);
  console.log(`  → ${snapshots.length} aligned snapshots`);

  // Validate
  const nonZeroFunding = snapshots.filter((s) => s.fundingRate !== 0).length;
  const nonZeroOI = snapshots.filter((s) => s.openInterest > 0).length;
  const nonZeroLS = snapshots.filter((s) => s.longShortRatio !== 1.0).length;

  console.log(`[Quality] Non-zero funding: ${nonZeroFunding}/${snapshots.length} (${((nonZeroFunding / snapshots.length) * 100).toFixed(1)}%)`);
  console.log(`[Quality] Non-zero OI: ${nonZeroOI}/${snapshots.length} (${((nonZeroOI / snapshots.length) * 100).toFixed(1)}%)`);
  console.log(`[Quality] Non-neutral L/S: ${nonZeroLS}/${snapshots.length} (${((nonZeroLS / snapshots.length) * 100).toFixed(1)}%)`);

  // Save
  const outputPath = path.join(DATA_DIR, `${symbol}_futures_1h.json`);
  fs.writeFileSync(outputPath, JSON.stringify(snapshots, null, 0));
  const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
  console.log(`[Save] ${outputPath} (${sizeMB} MB)`);
}

// ============================================
// Verify Mode
// ============================================

function verifyData(): void {
  console.log('\nVerifying futures data files...\n');

  for (const symbol of DEFAULT_SYMBOLS) {
    const filePath = path.join(DATA_DIR, `${symbol}_futures_1h.json`);

    if (!fs.existsSync(filePath)) {
      console.log(`[${symbol}] ❌ Not found: ${filePath}`);
      continue;
    }

    const data: FuturesSnapshot[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const first = data[0];
    const last = data[data.length - 1];

    if (!first || !last) {
      console.log(`[${symbol}] ❌ Empty file`);
      continue;
    }

    // Check data quality
    const nonZeroFunding = data.filter((s) => s.fundingRate !== 0).length;
    const nonZeroOI = data.filter((s) => s.openInterest > 0).length;
    const avgFunding = data.reduce((sum, s) => sum + s.fundingRate, 0) / data.length;
    const avgOI = data.reduce((sum, s) => sum + s.openInterest, 0) / data.length;

    console.log(`[${symbol}] ✅ ${data.length} snapshots`);
    console.log(`  Range: ${new Date(first.timestamp).toISOString().slice(0, 10)} → ${new Date(last.timestamp).toISOString().slice(0, 10)}`);
    console.log(`  Funding: ${nonZeroFunding}/${data.length} non-zero, avg=${(avgFunding * 100).toFixed(4)}%`);
    console.log(`  OI: ${nonZeroOI}/${data.length} non-zero, avg=$${(avgOI / 1e9).toFixed(2)}B`);
    console.log();
  }
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.verify) {
    verifyData();
    return;
  }

  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  for (const symbol of args.symbols) {
    try {
      await syncSymbol(symbol, args.months);
    } catch (error) {
      console.error(`[Error] Failed to sync ${symbol}:`, error);
    }
  }

  console.log('\nDone. Run with --verify to check data quality.');
}

main().catch(console.error);
