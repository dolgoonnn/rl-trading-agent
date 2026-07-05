#!/usr/bin/env tsx
/**
 * Download Binance USDⓈ-M perp 1h klines + funding history (public fapi, no key) for the
 * 19-coin panel — to pair with Bybit data for a CROSS-EXCHANGE funding arb (both legs perps,
 * no spot borrow). Saves data/{SYM}_binance_perp_1h.json [{timestamp,close}] and
 * data/{SYM}_binance_funding.json [{timestamp,fundingRate}] (raw settlements; analysis buckets
 * Binance 4h/8h funding into Bybit 8h windows). Coins missing on Binance are logged & skipped.
 */
import * as fs from 'fs';
import * as path from 'path';

const UNIVERSE = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT',
  'LINKUSDT', 'DOTUSDT', 'LTCUSDT', 'ATOMUSDT', 'UNIUSDT', 'AAVEUSDT', 'NEARUSDT', 'APTUSDT', 'ARBUSDT', 'FILUSDT', 'ICPUSDT'];
const FAPI = 'https://fapi.binance.com';
const HOUR = 3_600_000;
const START = Date.UTC(2023, 1, 1);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function getJSON(url: string): Promise<unknown> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const resp = await fetch(url);
    if (resp.ok) return resp.json();
    if (resp.status === 429 || resp.status === 418) { await sleep(2000 * (attempt + 1)); continue; }
    if (resp.status === 400) return null; // bad symbol / no data
    await sleep(500);
  }
  throw new Error(`fetch failed: ${url}`);
}

// Binance returns records ASCENDING from startTime → paginate FORWARD.
async function klines(symbol: string): Promise<{ timestamp: number; close: number }[]> {
  const out = new Map<number, number>();
  let start = START;
  const now = Date.now();
  for (;;) {
    const data = await getJSON(`${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=1500&startTime=${start}`) as unknown[][] | null;
    if (!data || data.length === 0) break;
    for (const row of data) { const ts = Number(row[0]), close = Number(row[4]); if (close > 0) out.set(ts, close); }
    const newest = Math.max(...data.map((r) => Number(r[0])));
    if (newest >= now - HOUR || data.length < 1500) break;
    start = newest + HOUR;
    await sleep(150);
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([timestamp, close]) => ({ timestamp, close }));
}

async function funding(symbol: string): Promise<{ timestamp: number; fundingRate: number }[]> {
  const out = new Map<number, number>();
  let start = START;
  const now = Date.now();
  for (;;) {
    const data = await getJSON(`${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&limit=1000&startTime=${start}`) as { fundingTime: number; fundingRate: string }[] | null;
    if (!data || data.length === 0) break;
    for (const r of data) out.set(Number(r.fundingTime), Number(r.fundingRate));
    const newest = Math.max(...data.map((r) => Number(r.fundingTime)));
    if (newest >= now - 9 * HOUR || data.length < 1000) break;
    start = newest + 1;
    await sleep(150);
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([timestamp, fundingRate]) => ({ timestamp, fundingRate }));
}

async function main(): Promise<void> {
  const summary: string[] = [];
  for (const symbol of UNIVERSE) {
    process.stdout.write(`${symbol}: funding…`);
    const fund = await funding(symbol);
    if (fund.length === 0) { summary.push(`${symbol}: NOT ON BINANCE — skip`); console.log(' none ⚠️'); continue; }
    fs.writeFileSync(path.resolve(__dirname, '..', 'data', `${symbol}_binance_funding.json`), JSON.stringify(fund));
    process.stdout.write(` ${fund.length} | klines…`);
    const kl = await klines(symbol);
    fs.writeFileSync(path.resolve(__dirname, '..', 'data', `${symbol}_binance_perp_1h.json`), JSON.stringify(kl));
    // detect funding interval (median gap in hours)
    const gaps = fund.slice(1).map((r, i) => (r.timestamp - fund[i]!.timestamp) / HOUR);
    gaps.sort((a, b) => a - b);
    const medGap = gaps[Math.floor(gaps.length / 2)] ?? 8;
    const fmean = fund.reduce((a, x) => a + x.fundingRate, 0) / fund.length;
    summary.push(`${symbol}: klines ${kl.length}, funding ${fund.length} (~${medGap}h interval, mean ${(fmean * 100).toFixed(4)}%)`);
    console.log(` ${kl.length} ✓`);
  }
  console.log('\n=== summary ===');
  for (const s of summary) console.log('  ' + s);
}

main().catch((err) => { console.error('\nDownload failed:', err); process.exit(1); });
