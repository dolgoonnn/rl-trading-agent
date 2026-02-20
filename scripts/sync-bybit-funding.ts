#!/usr/bin/env npx tsx
/**
 * Sync Bybit Funding Rate History
 *
 * Downloads funding rate history from Bybit API for specified symbols.
 * Saves to data/{SYMBOL}_funding_rates.json.
 *
 * Usage:
 *   npx tsx scripts/sync-bybit-funding.ts
 *   npx tsx scripts/sync-bybit-funding.ts --symbols BTCUSDT,ETHUSDT,SOLUSDT
 *   npx tsx scripts/sync-bybit-funding.ts --days 365
 */

import * as fs from 'fs';
import * as path from 'path';
import { FundingDataFeed } from '../src/lib/bot/funding-data-feed';

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const DEFAULT_DAYS = 365;

function parseArgs(): { symbols: string[]; days: number } {
  const args = process.argv.slice(2);
  let symbols = DEFAULT_SYMBOLS;
  let days = DEFAULT_DAYS;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--symbols') {
      symbols = args[++i]!.split(',');
    } else if (args[i] === '--days') {
      days = parseInt(args[++i]!, 10);
    }
  }

  return { symbols, days };
}

async function main(): Promise<void> {
  const { symbols, days } = parseArgs();
  const feed = new FundingDataFeed();
  const dataDir = path.resolve(__dirname, '../data');

  const endTime = Date.now();
  const startTime = endTime - days * 24 * 60 * 60 * 1000;

  console.log(`Syncing funding rates for ${symbols.join(', ')}`);
  console.log(`Period: ${new Date(startTime).toISOString()} → ${new Date(endTime).toISOString()}`);
  console.log('');

  for (const symbol of symbols) {
    console.log(`Fetching ${symbol}...`);

    const records = await feed.fetchFullFundingHistory(
      symbol,
      startTime,
      endTime,
    );

    console.log(`  Got ${records.length} funding rate records`);

    if (records.length === 0) {
      console.log(`  Skipping ${symbol} — no data`);
      continue;
    }

    // Stats
    const rates = records.map((r) => r.fundingRate);
    const avgRate = rates.reduce((s, r) => s + r, 0) / rates.length;
    const maxRate = Math.max(...rates);
    const minRate = Math.min(...rates);
    const positiveCount = rates.filter((r) => r > 0).length;

    console.log(`  Avg rate: ${(avgRate * 100).toFixed(6)}% per 8h`);
    console.log(`  Range: ${(minRate * 100).toFixed(6)}% to ${(maxRate * 100).toFixed(6)}%`);
    console.log(`  Positive: ${((positiveCount / rates.length) * 100).toFixed(1)}%`);
    console.log(`  Annualized avg: ${(avgRate * 3 * 365 * 100).toFixed(2)}% APR`);

    // Save to file
    const outPath = path.join(dataDir, `${symbol}_funding_rates.json`);
    fs.writeFileSync(outPath, JSON.stringify(records, null, 2));
    console.log(`  Saved to ${outPath}`);
    console.log('');
  }

  console.log('Done!');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
