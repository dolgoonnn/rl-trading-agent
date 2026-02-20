#!/usr/bin/env npx tsx
/**
 * Download 5m candles from Bybit for LTF backtest.
 *
 * Uses the same Bybit REST API as the scalp data downloader.
 *
 * Usage:
 *   npx tsx scripts/download-5m-data.ts
 *   npx tsx scripts/download-5m-data.ts --symbol ETHUSDT --months 6
 */

import * as fs from 'fs';
import * as path from 'path';
import { RestClientV5 } from 'bybit-api';
import type { Candle } from '../src/types/candle';

const BYBIT_MAX_LIMIT = 200;

function getArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return undefined;
}

async function download5mCandles(
  symbol: string,
  months: number,
): Promise<Candle[]> {
  const client = new RestClientV5({});
  const endTime = Date.now();
  const startTime = endTime - months * 30 * 24 * 60 * 60 * 1000;

  const allCandles: Candle[] = [];
  let cursor = endTime;
  let requestCount = 0;

  while (cursor > startTime) {
    const response = await client.getKline({
      category: 'linear',
      symbol,
      interval: '5',
      limit: BYBIT_MAX_LIMIT,
      end: cursor,
    });

    if (response.retCode !== 0) {
      throw new Error(`Bybit API error: ${response.retMsg}`);
    }

    const rawCandles = response.result.list;
    if (!rawCandles || rawCandles.length === 0) break;

    const candles: Candle[] = rawCandles
      .map((row) => ({
        timestamp: parseInt(row[0], 10),
        open: parseFloat(row[1]),
        high: parseFloat(row[2]),
        low: parseFloat(row[3]),
        close: parseFloat(row[4]),
        volume: parseFloat(row[5]),
      }))
      .reverse();

    allCandles.unshift(...candles);
    cursor = candles[0]!.timestamp - 1;
    requestCount++;

    if (requestCount % 10 === 0) {
      const oldest = new Date(allCandles[0]!.timestamp).toISOString().slice(0, 10);
      process.stdout.write(
        `\r  Requests: ${requestCount} | Candles: ${allCandles.length.toLocaleString()} | Oldest: ${oldest}`,
      );
    }

    // Rate limit
    await new Promise((r) => setTimeout(r, 100));
  }

  // Deduplicate by timestamp
  const seen = new Set<number>();
  const deduped = allCandles.filter((c) => {
    if (seen.has(c.timestamp)) return false;
    seen.add(c.timestamp);
    return true;
  });

  return deduped.sort((a, b) => a.timestamp - b.timestamp);
}

async function main(): Promise<void> {
  const symbol = getArg('symbol') ?? 'BTCUSDT';
  const months = parseInt(getArg('months') ?? '6', 10);

  console.log(`Downloading ${symbol} 5m candles — ${months} months`);
  console.log('');

  const candles = await download5mCandles(symbol, months);

  console.log('\n');
  console.log(`Total candles: ${candles.length.toLocaleString()}`);

  if (candles.length > 0) {
    const start = new Date(candles[0]!.timestamp).toISOString();
    const end = new Date(candles[candles.length - 1]!.timestamp).toISOString();
    console.log(`Range: ${start} → ${end}`);
  }

  // Save
  const dataDir = path.resolve(__dirname, '../data');
  const outPath = path.join(dataDir, `${symbol}_5m.json`);
  fs.writeFileSync(outPath, JSON.stringify(candles));
  console.log(`Saved to ${outPath}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
