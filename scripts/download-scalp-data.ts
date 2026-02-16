#!/usr/bin/env tsx
/**
 * Download 1m BTCUSDT candles from Bybit for scalp backtesting.
 *
 * Usage:
 *   npx tsx scripts/download-scalp-data.ts
 *   npx tsx scripts/download-scalp-data.ts --months 9 --symbol ETHUSDT
 */

import * as fs from 'fs';
import * as path from 'path';
import { downloadCandles1m, validateCandles } from '../src/lib/scalp/data/downloader';

const ONE_MINUTE_MS = 60_000;

function getArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return undefined;
}

async function main(): Promise<void> {
  const symbol = getArg('symbol') ?? 'BTCUSDT';
  const months = parseInt(getArg('months') ?? '8', 10);

  console.log(`Downloading ${symbol} 1m candles — ${months} months of history`);
  console.log('This will make many API requests. Please be patient...\n');

  const candles = await downloadCandles1m(symbol, months, (progress) => {
    const oldest = new Date(progress.oldestTimestamp).toISOString().slice(0, 10);
    const newest = new Date(progress.newestTimestamp).toISOString().slice(0, 10);
    process.stdout.write(
      `\r  Requests: ${progress.requestCount} | Candles: ${progress.totalCandles.toLocaleString()} | Range: ${oldest} → ${newest}`,
    );
  });

  console.log('\n');

  // Validate
  const validation = validateCandles(candles, ONE_MINUTE_MS);
  console.log('=== Data Quality Report ===');
  console.log(`  Total candles: ${validation.totalCandles.toLocaleString()}`);
  console.log(`  Date range: ${validation.startDate} → ${validation.endDate}`);
  console.log(`  OHLC errors: ${validation.ohlcErrors}`);
  console.log(`  Gaps found: ${validation.gaps.length}`);
  if (validation.gaps.length > 0) {
    const totalMissing = validation.gaps.reduce((s, g) => s + g.missing, 0);
    console.log(`  Total missing bars: ${totalMissing} (${(totalMissing / validation.totalCandles * 100).toFixed(2)}%)`);
    // Show largest 5 gaps
    const sorted = [...validation.gaps].sort((a, b) => b.missing - a.missing);
    console.log('  Largest gaps:');
    for (const gap of sorted.slice(0, 5)) {
      const after = new Date(gap.after).toISOString();
      console.log(`    ${after} — ${gap.missing} bars missing`);
    }
  }
  console.log(`  Valid: ${validation.valid ? 'YES' : 'NO'}`);

  // Save
  const outPath = path.resolve(__dirname, '..', 'data', `${symbol}_1m.json`);
  fs.writeFileSync(outPath, JSON.stringify(candles));
  const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
  console.log(`\nSaved to ${outPath} (${sizeMB} MB)`);
}

main().catch((err) => {
  console.error('Download failed:', err);
  process.exit(1);
});
