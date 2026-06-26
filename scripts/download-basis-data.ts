#!/usr/bin/env tsx
/**
 * Download Bybit SPOT + linear PERP 1h klines to measure the perp basis (perp/spot − 1).
 * The basis is the missing ingredient for an HONEST funding-carry test: the delta-neutral
 * carry (long spot / short perp) earns funding but its mark-to-market P&L vol comes from the
 * basis moving — which the funding-rate-only "pulse" ignored (the Sharpe-16 artifact).
 *
 * Output per symbol: data/{SYM}_basis_1h.json = [{ timestamp, spot, perp, basis }]
 * Usage: npx tsx scripts/download-basis-data.ts            (BTC/ETH/SOL, ~since 2023-02)
 */
import * as fs from 'fs';
import * as path from 'path';
import { RestClientV5 } from 'bybit-api';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const HOUR = 3_600_000;
const START = Date.UTC(2023, 1, 1); // 2023-02-01, matches funding data start
const client = new RestClientV5({});

async function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

// paginate backwards from now to START; Bybit returns ≤1000, newest first
async function klines(symbol: string, category: 'spot' | 'linear'): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  let end = Date.now();
  let req = 0;
  for (;;) {
    const resp = await client.getKline({ category, symbol, interval: '60', end, limit: 1000 });
    if (resp.retCode !== 0) throw new Error(`${category} ${symbol}: ${resp.retMsg} (${resp.retCode})`);
    const list = resp.result.list as string[][]; // [start, open, high, low, close, volume, turnover]
    if (!list || list.length === 0) break;
    for (const row of list) {
      const ts = Number(row[0]);
      const close = Number(row[4]);
      if (close > 0) out.set(ts, close);
    }
    const oldest = Math.min(...list.map((r) => Number(r[0])));
    process.stdout.write(`\r  ${category} ${symbol}: req ${++req} | ${out.size} bars | oldest ${new Date(oldest).toISOString().slice(0, 10)}   `);
    if (oldest <= START || list.length < 1000) break;
    end = oldest - HOUR;
    await sleep(120);
  }
  console.log('');
  return out;
}

async function main(): Promise<void> {
  for (const symbol of SYMBOLS) {
    const spot = await klines(symbol, 'spot');
    const perp = await klines(symbol, 'linear');
    const rows: { timestamp: number; spot: number; perp: number; basis: number }[] = [];
    for (const [ts, sp] of [...spot.entries()].sort((a, b) => a[0] - b[0])) {
      const pp = perp.get(ts);
      if (pp !== undefined && ts >= START) rows.push({ timestamp: ts, spot: sp, perp: pp, basis: pp / sp - 1 });
    }
    const outPath = path.resolve(__dirname, '..', 'data', `${symbol}_basis_1h.json`);
    fs.writeFileSync(outPath, JSON.stringify(rows));
    const bps = rows.map((r) => r.basis * 1e4);
    const mean = bps.reduce((a, x) => a + x, 0) / bps.length;
    const sd = Math.sqrt(bps.reduce((a, x) => a + (x - mean) ** 2, 0) / bps.length);
    console.log(`  → ${symbol}: ${rows.length} aligned bars, basis mean ${mean.toFixed(2)}bp std ${sd.toFixed(1)}bp, saved ${outPath}\n`);
  }
}

main().catch((err) => { console.error('\nBasis download failed:', err); process.exit(1); });
