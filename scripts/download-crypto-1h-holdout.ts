#!/usr/bin/env tsx
/**
 * Download pre-2023 Bybit 1h history as a HOLDOUT for the crypto 21-23h
 * session strategy (experiments/calendar-research.md). Range ends where the
 * existing {sym}_1h.json files begin (2023-02-24) so there is zero overlap
 * with the selection data, and starts as early as Bybit linear has data
 * (BTC/ETH ~2020-03, SOL ~2021-10).
 *
 * Output: data/{sym}_1h_holdout.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { RestClientV5 } from 'bybit-api';
import type { Candle } from '../src/types/candle';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const END = Date.UTC(2023, 1, 24); // existing 1h files start 2023-02-24
const START = Date.UTC(2020, 2, 1);
const HOUR_MS = 3_600_000;

async function downloadHourly(symbol: string): Promise<Candle[]> {
  const client = new RestClientV5({});
  const all = new Map<number, Candle>();
  let cursor = END;
  let requests = 0;

  while (cursor > START) {
    const resp = await client.getKline({
      category: 'linear',
      symbol,
      interval: '60',
      limit: 1000,
      end: cursor,
    });
    requests++;
    const rows = resp.result?.list ?? [];
    if (rows.length === 0) break;

    for (const row of rows) {
      const ts = parseInt(row[0]!, 10);
      if (ts < START || ts >= END) continue;
      all.set(ts, {
        timestamp: ts,
        open: parseFloat(row[1]!),
        high: parseFloat(row[2]!),
        low: parseFloat(row[3]!),
        close: parseFloat(row[4]!),
        volume: parseFloat(row[5]!),
      });
    }

    const oldest = Math.min(...rows.map((r) => parseInt(r[0]!, 10)));
    if (oldest >= cursor) break; // no progress — out of history
    cursor = oldest - HOUR_MS;
    await new Promise((r) => setTimeout(r, 250));
  }

  const candles = [...all.values()].sort((a, b) => a.timestamp - b.timestamp);
  console.log(`  ${symbol}: ${candles.length.toLocaleString()} bars, ${requests} requests, ` +
    `${candles.length ? new Date(candles[0]!.timestamp).toISOString().slice(0, 10) : '—'} → ` +
    `${candles.length ? new Date(candles[candles.length - 1]!.timestamp).toISOString().slice(0, 10) : '—'}`);
  return candles;
}

async function main(): Promise<void> {
  console.log('Downloading Bybit 1h holdout (→ 2023-02-24)...');
  for (const sym of SYMBOLS) {
    const candles = await downloadHourly(sym);
    if (candles.length === 0) { console.log(`  ${sym}: no data, skipped`); continue; }
    const out = path.resolve(__dirname, '..', 'data', `${sym}_1h_holdout.json`);
    fs.writeFileSync(out, JSON.stringify(candles));
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error('Holdout download failed:', err);
  process.exit(1);
});
