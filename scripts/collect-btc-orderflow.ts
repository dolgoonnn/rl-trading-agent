#!/usr/bin/env tsx
/**
 * BTC order-flow collector — pillar-2 data (experiments/practitioner-research.md).
 *
 * Subscribes to Bybit's free L2 orderbook (50 levels) + public trades for
 * BTCUSDT and appends one NDJSON line per second to data/orderflow/:
 *   { ts, mid, spreadBps, bidDepth5, askDepth5, imb5, imb25,
 *     buyVol, sellVol, tradeCount }   (volumes = since previous snapshot)
 *
 * This is a COLLECTOR only — analysis comes after days of data accumulate.
 * Daily file rotation; ~1-2 MB/day. PM2-compatible.
 */

import * as fs from 'fs';
import * as path from 'path';
import { WebsocketClient } from 'bybit-api';

const OUT_DIR = path.resolve(__dirname, '..', 'data', 'orderflow');
// Symbol via env so the entrypoint can run one isolated instance per market
// (BTCUSDT since Jun-2026; XAGUSDT/XAUTUSDT added Aug-2026 for close-flow
// entry-timing research — see gold-scalp-deep-dig memory).
const SYMBOL = process.env.ORDERFLOW_SYMBOL ?? 'BTCUSDT';

interface BookSide { [price: string]: number }

const book = { bids: {} as BookSide, asks: {} as BookSide };
let buyVol = 0;
let sellVol = 0;
let tradeCount = 0;
let liqBuyVol = 0;
let liqSellVol = 0;
let liqCount = 0;
let haveSnapshot = false;

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function applyDelta(side: BookSide, rows: Array<[string, string]>): void {
  for (const [p, s] of rows) {
    const size = parseFloat(s);
    if (size === 0) delete side[p];
    else side[p] = size;
  }
}

function topLevels(side: BookSide, desc: boolean, n: number): Array<{ p: number; s: number }> {
  return Object.entries(side)
    .map(([p, s]) => ({ p: parseFloat(p), s }))
    .sort((a, b) => (desc ? b.p - a.p : a.p - b.p))
    .slice(0, n);
}

function snapshotLine(): string | null {
  const bids = topLevels(book.bids, true, 25);
  const asks = topLevels(book.asks, false, 25);
  if (bids.length < 5 || asks.length < 5) return null;
  const bb = bids[0]!.p;
  const ba = asks[0]!.p;
  if (ba <= bb) return null;
  const mid = (bb + ba) / 2;
  const sum = (xs: Array<{ p: number; s: number }>, n: number): number =>
    xs.slice(0, n).reduce((acc, x) => acc + x.s, 0);
  const b5 = sum(bids, 5), a5 = sum(asks, 5);
  const b25 = sum(bids, 25), a25 = sum(asks, 25);
  const line = JSON.stringify({
    ts: Date.now(),
    mid: Math.round(mid * 100) / 100,
    spreadBps: Math.round(((ba - bb) / mid) * 1e6) / 100,
    bidDepth5: Math.round(b5 * 1000) / 1000,
    askDepth5: Math.round(a5 * 1000) / 1000,
    imb5: Math.round(((b5 - a5) / (b5 + a5)) * 1000) / 1000,
    imb25: Math.round(((b25 - a25) / (b25 + a25)) * 1000) / 1000,
    buyVol: Math.round(buyVol * 1000) / 1000,
    sellVol: Math.round(sellVol * 1000) / 1000,
    tradeCount,
    // forced-flow fields (liquidation-fade test, practitioner-mechanisms #3):
    // liqBuy = shorts force-bought, liqSell = longs force-sold (BTC units)
    liqBuy: Math.round(liqBuyVol * 1000) / 1000,
    liqSell: Math.round(liqSellVol * 1000) / 1000,
    liqCount,
  });
  buyVol = 0; sellVol = 0; tradeCount = 0;
  liqBuyVol = 0; liqSellVol = 0; liqCount = 0;
  return line;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  log(`BTC order-flow collector starting → ${OUT_DIR}`);

  const ws = new WebsocketClient({ market: 'v5' });

  ws.on('update', (msg: { topic?: string; type?: string; data?: unknown }) => {
    if (!msg.topic) return;
    if (msg.topic.startsWith('orderbook')) {
      const data = msg.data as { b: Array<[string, string]>; a: Array<[string, string]> };
      if (msg.type === 'snapshot') {
        book.bids = {}; book.asks = {};
        haveSnapshot = true;
      }
      applyDelta(book.bids, data.b ?? []);
      applyDelta(book.asks, data.a ?? []);
    } else if (msg.topic.startsWith('publicTrade')) {
      const trades = msg.data as Array<{ S: 'Buy' | 'Sell'; v: string }>;
      for (const t of trades) {
        const v = parseFloat(t.v);
        if (t.S === 'Buy') buyVol += v; else sellVol += v;
        tradeCount++;
      }
    } else if (msg.topic.startsWith('allLiquidation')) {
      const liqs = msg.data as Array<{ S: 'Buy' | 'Sell'; v: string }>;
      for (const l of liqs) {
        const v = parseFloat(l.v);
        if (l.S === 'Buy') liqBuyVol += v; else liqSellVol += v;
        liqCount++;
      }
    }
  });

  // bybit-api's WS event map doesn't declare 'error'; narrow the emitter interface
  (ws as unknown as { on(event: 'error', cb: (e: unknown) => void): void })
    .on('error', (err) => log(`ws error: ${JSON.stringify(err).slice(0, 200)}`));

  ws.subscribeV5([`orderbook.50.${SYMBOL}`, `publicTrade.${SYMBOL}`, `allLiquidation.${SYMBOL}`], 'linear');

  setInterval(() => {
    if (!haveSnapshot) return;
    const line = snapshotLine();
    if (!line) return;
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.resolve(OUT_DIR, `${SYMBOL}_${day}.ndjson`), line + '\n');
  }, 1000);

  log('subscribed; writing 1s snapshots');
}

main().catch((err) => {
  console.error('Collector crashed:', err);
  process.exit(1);
});
