#!/usr/bin/env tsx
/**
 * Download funding history + spot/perp basis for the crypto panel — to test a CROSS-SECTIONAL
 * funding carry honestly (needs per-coin funding AND basis MtM, not funding-only).
 *
 * Per coin: data/{SYM}_basis_1h.json [{timestamp,spot,perp,basis}] + data/{SYM}_funding.json
 * [{timestamp,fundingRate}] (8h settlements). Coins without a Bybit spot pair are logged & skipped
 * for basis (no silent drops). Universe = 19-coin panel (MATIC dropped: POL rebrand truncates 2024-09).
 * Usage: npx tsx scripts/download-xs-carry-data.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { RestClientV5 } from 'bybit-api';

const UNIVERSE = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT',
  'LINKUSDT', 'DOTUSDT', 'LTCUSDT', 'ATOMUSDT', 'UNIUSDT', 'AAVEUSDT', 'NEARUSDT', 'APTUSDT', 'ARBUSDT', 'FILUSDT', 'ICPUSDT'];
const HOUR = 3_600_000;
const START = Date.UTC(2023, 1, 1);
const client = new RestClientV5({});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function klines(symbol: string, category: 'spot' | 'linear'): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  let end = Date.now();
  for (;;) {
    const resp = await client.getKline({ category, symbol, interval: '60', end, limit: 1000 });
    if (resp.retCode !== 0) { if (category === 'spot') return out; throw new Error(`${category} ${symbol}: ${resp.retMsg}`); }
    const list = (resp.result.list ?? []) as string[][];
    if (list.length === 0) break;
    for (const row of list) { const ts = Number(row[0]), close = Number(row[4]); if (close > 0) out.set(ts, close); }
    const oldest = Math.min(...list.map((r) => Number(r[0])));
    if (oldest <= START || list.length < 1000) break;
    end = oldest - HOUR;
    await sleep(100);
  }
  return out;
}

async function funding(symbol: string): Promise<{ timestamp: number; fundingRate: number }[]> {
  const out: { timestamp: number; fundingRate: number }[] = [];
  let endTime = Date.now();
  for (;;) {
    const resp = await client.getFundingRateHistory({ category: 'linear', symbol, endTime, limit: 200 });
    if (resp.retCode !== 0) throw new Error(`funding ${symbol}: ${resp.retMsg}`);
    const list = resp.result.list ?? [];
    if (list.length === 0) break;
    for (const r of list) out.push({ timestamp: Number(r.fundingRateTimestamp), fundingRate: Number(r.fundingRate) });
    const oldest = Math.min(...list.map((r) => Number(r.fundingRateTimestamp)));
    if (oldest <= START || list.length < 200) break;
    endTime = oldest - 1;
    await sleep(100);
  }
  return out.filter((r) => r.timestamp >= START).sort((a, b) => a.timestamp - b.timestamp);
}

async function main(): Promise<void> {
  const summary: string[] = [];
  for (const symbol of UNIVERSE) {
    process.stdout.write(`${symbol}: funding…`);
    const fund = await funding(symbol);
    fs.writeFileSync(path.resolve(__dirname, '..', 'data', `${symbol}_funding.json`), JSON.stringify(fund));
    process.stdout.write(` ${fund.length} | spot…`);
    const spot = await klines(symbol, 'spot');
    if (spot.size === 0) { summary.push(`${symbol}: NO SPOT PAIR — funding only (${fund.length})`); console.log(' none ⚠️'); continue; }
    process.stdout.write(` ${spot.size} | perp…`);
    const perp = await klines(symbol, 'linear');
    const rows: { timestamp: number; spot: number; perp: number; basis: number }[] = [];
    for (const [ts, sp] of [...spot.entries()].sort((a, b) => a[0] - b[0])) {
      const pp = perp.get(ts);
      if (pp !== undefined && ts >= START) rows.push({ timestamp: ts, spot: sp, perp: pp, basis: pp / sp - 1 });
    }
    fs.writeFileSync(path.resolve(__dirname, '..', 'data', `${symbol}_basis_1h.json`), JSON.stringify(rows));
    const fmean = fund.length ? fund.reduce((a, x) => a + x.fundingRate, 0) / fund.length : 0;
    summary.push(`${symbol}: basis ${rows.length}h, funding ${fund.length} (mean ${(fmean * 100).toFixed(4)}%/8h)`);
    console.log(` ${perp.size} ✓`);
  }
  console.log('\n=== summary ===');
  for (const s of summary) console.log('  ' + s);
}

main().catch((err) => { console.error('\nDownload failed:', err); process.exit(1); });
