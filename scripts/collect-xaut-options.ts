#!/usr/bin/env tsx
/**
 * XAUT options surface collector — the unbackfillable data moat.
 *
 * Bybit launched the only listed tokenized-gold options (Jun 12, 2026) and
 * publishes NO historical IV (the hist-vol endpoint returns [] for XAUT).
 * No vendor covers it. Every snapshot not recorded is lost forever — so this
 * archives the full surface from a free unauthenticated REST endpoint.
 *
 * Every 5 minutes: GET /v5/market/tickers?category=option&baseCoin=XAUT →
 * one NDJSON line per instrument with the fields that matter (quotes, IVs,
 * greeks, OI, volume, underlying). Also captures the XAUTUSDT perp ticker as
 * the hedge-leg reference. Daily files under data/options/ (Railway volume).
 *
 * Non-fatal fleet process — mirrors collect-btc-orderflow.ts conventions.
 *
 * Usage: npx tsx scripts/collect-xaut-options.ts [--once]
 */

import * as fs from 'fs';
import * as path from 'path';

const OUT_DIR = path.resolve(__dirname, '..', 'data', 'options');
export const XAUT_OPTIONS_INTERVAL_MS = 5 * 60_000;
const once = process.argv.includes('--once');

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

interface OptionTicker {
  symbol: string;
  bid1Price: string; bid1Size: string; bid1Iv: string;
  ask1Price: string; ask1Size: string; ask1Iv: string;
  markPrice: string; markIv: string;
  underlyingPrice: string; indexPrice: string;
  openInterest: string; volume24h: string; turnover24h: string;
  delta: string; gamma: string; vega: string; theta: string;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) return null;
    return await resp.json() as T;
  } catch {
    return null;
  }
}

export async function snapshotXautOptions(): Promise<void> {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);

  const opt = await fetchJson<{ result?: { list?: OptionTicker[] } }>(
    'https://api.bybit.com/v5/market/tickers?category=option&baseCoin=XAUT',
  );
  const perp = await fetchJson<{ result?: { list?: Array<{ symbol: string; bid1Price: string; ask1Price: string; lastPrice: string; openInterest: string; fundingRate: string }> } }>(
    'https://api.bybit.com/v5/market/tickers?category=linear&symbol=XAUTUSDT',
  );

  const list = opt?.result?.list ?? [];
  if (!list.length) { log('empty option surface (API hiccup?) — skipping snapshot'); return; }

  const lines: string[] = [];
  for (const t of list) {
    lines.push(JSON.stringify({
      ts: now, sym: t.symbol,
      bp: +t.bid1Price || 0, bs: +t.bid1Size || 0, biv: +t.bid1Iv || 0,
      ap: +t.ask1Price || 0, as: +t.ask1Size || 0, aiv: +t.ask1Iv || 0,
      mp: +t.markPrice || 0, miv: +t.markIv || 0,
      u: +t.underlyingPrice || 0,
      oi: +t.openInterest || 0, v24: +t.volume24h || 0, to24: +t.turnover24h || 0,
      d: +t.delta || 0, g: +t.gamma || 0, vg: +t.vega || 0, th: +t.theta || 0,
    }));
  }
  const p = perp?.result?.list?.[0];
  if (p) {
    lines.push(JSON.stringify({
      ts: now, sym: 'XAUTUSDT.PERP',
      bp: +p.bid1Price || 0, ap: +p.ask1Price || 0, mp: +p.lastPrice || 0,
      oi: +p.openInterest || 0, fr: +p.fundingRate || 0,
    }));
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.appendFileSync(path.resolve(OUT_DIR, `XAUT_options_${day}.ndjson`), lines.join('\n') + '\n');
  log(`surface snapshot: ${list.length} instruments${p ? ' + perp' : ''}`);
}

async function main(): Promise<void> {
  log(`XAUT options surface collector starting → ${OUT_DIR} (every ${XAUT_OPTIONS_INTERVAL_MS / 60000}m)`);
  if (once) { await snapshotXautOptions(); return; }
  for (;;) {
    try { await snapshotXautOptions(); } catch (err) { log(`snapshot error: ${err}`); }
    await new Promise((r) => setTimeout(r, XAUT_OPTIONS_INTERVAL_MS));
  }
}

// Importable module (the unified collector runs the poll in-process to save a
// runtime); only self-start when invoked directly.
if (require.main === module) {
  main().catch((err) => { console.error('XAUT options collector crashed:', err); process.exit(1); });
}
