#!/usr/bin/env tsx
/**
 * Refresh data/{sym}_1h.json to the present — appends Bybit linear 1h candles
 * from each file's last timestamp to now (drops the still-open current bar).
 *
 * Run before re-validating Run 20 (CMA-ES params are data-window-sensitive;
 * the Run 18→20 lesson) and before a paper-trading period starts counting.
 *
 * Usage: npx tsx scripts/refresh-crypto-1h.ts [--symbols BTCUSDT,ETHUSDT,SOLUSDT]
 */

import * as fs from 'fs';
import * as path from 'path';
import { RestClientV5 } from 'bybit-api';
import type { Candle } from '../src/types/candle';

const HOUR_MS = 3_600_000;

async function refresh(symbol: string): Promise<void> {
  const file = path.resolve(__dirname, '..', 'data', `${symbol}_1h.json`);
  const existing: Candle[] = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const last = existing[existing.length - 1]!.timestamp;
  // exclude the still-forming bar (look-ahead canon: closed bars only)
  const closedEnd = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS;

  const client = new RestClientV5({});
  const fresh = new Map<number, Candle>();
  let cursor = closedEnd + HOUR_MS;
  while (cursor > last + HOUR_MS) {
    const resp = await client.getKline({
      category: 'linear', symbol, interval: '60', limit: 1000, end: cursor,
    });
    const rows = resp.result?.list ?? [];
    if (rows.length === 0) break;
    for (const row of rows) {
      const ts = parseInt(row[0]!, 10);
      if (ts <= last || ts > closedEnd) continue;
      fresh.set(ts, {
        timestamp: ts,
        open: parseFloat(row[1]!),
        high: parseFloat(row[2]!),
        low: parseFloat(row[3]!),
        close: parseFloat(row[4]!),
        volume: parseFloat(row[5]!),
      });
    }
    const oldest = Math.min(...rows.map((r) => parseInt(r[0]!, 10)));
    if (oldest >= cursor) break;
    cursor = oldest;
    await new Promise((r) => setTimeout(r, 250));
  }

  const appended = [...fresh.values()].sort((a, b) => a.timestamp - b.timestamp);
  if (appended.length === 0) {
    console.log(`${symbol}: already current (last ${new Date(last).toISOString()})`);
    return;
  }
  const merged = existing.concat(appended);
  fs.writeFileSync(file, JSON.stringify(merged));
  console.log(`${symbol}: +${appended.length} bars → ${merged.length.toLocaleString()} total, ` +
    `last ${new Date(merged[merged.length - 1]!.timestamp).toISOString()}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const symbols = args.includes('--symbols')
    ? args[args.indexOf('--symbols') + 1]!.split(',')
    : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  for (const s of symbols) await refresh(s);
}

main().catch((err) => { console.error('Refresh failed:', err); process.exit(1); });
