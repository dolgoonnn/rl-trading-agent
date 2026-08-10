#!/usr/bin/env tsx
/**
 * Order-flow collector — pillar-2 data (experiments/practitioner-research.md).
 *
 * Subscribes to Bybit's free L2 orderbook (50 levels) + public trades +
 * liquidations for one or more linear perps on a SINGLE WebSocket client and
 * appends one NDJSON line per second per symbol to data/orderflow/:
 *   { ts, mid, spreadBps, bidDepth5, askDepth5, imb5, imb25,
 *     buyVol, sellVol, tradeCount, liqBuy, liqSell, liqCount }
 *
 * MULTI-SYMBOL IN ONE PROCESS by design: each `npx tsx` runtime costs
 * ~150-250MB RSS, and the 2026-08-04 deploy proved that one-process-per-
 * symbol OOM-killed the container (dashboard died first). Per-symbol state
 * lives in a Map; the marginal cost of an extra symbol is just its book.
 *
 * --with-xaut-options additionally runs the XAUT options-surface poll
 * (collect-xaut-options.ts) inside this process for the same reason.
 *
 * Symbols: ORDERFLOW_SYMBOLS=BTCUSDT,XAGUSDT,XAUTUSDT (comma list; the
 * legacy singular ORDERFLOW_SYMBOL is honored too).
 *
 * This is a COLLECTOR only — analysis comes after days of data accumulate.
 *
 * DISK: daily file rotation at ~13 MB/day/symbol (MEASURED — an earlier note
 * here claimed 1-2 MB/day and was 7-13x low, which is how the archive silently
 * filled the Railway volume on 2026-08-10, killed the CORE trading process with
 * SQLITE_FULL and took the whole book offline). The archive is now bounded by
 * `disk-guard` and refuses to write into the reserve held for the core
 * processes: this collector is research, and research must never be able to
 * stop live trading.
 */

import * as fs from 'fs';
import * as path from 'path';
import { WebsocketClient } from 'bybit-api';
import { pruneArchive, hasHeadroom, diskStatus, ARCHIVE_BUDGET, CORE_RESERVE_BYTES } from '../src/lib/bot/disk-guard';

const OUT_DIR = path.resolve(__dirname, '..', 'data', 'orderflow');
const SYMBOLS = (process.env.ORDERFLOW_SYMBOLS ?? process.env.ORDERFLOW_SYMBOL ?? 'BTCUSDT')
  .split(',').map((s) => s.trim()).filter(Boolean);
const WITH_XAUT_OPTIONS = process.argv.includes('--with-xaut-options');

interface BookSide { [price: string]: number }

interface SymbolState {
  book: { bids: BookSide; asks: BookSide };
  buyVol: number; sellVol: number; tradeCount: number;
  liqBuyVol: number; liqSellVol: number; liqCount: number;
  haveSnapshot: boolean;
}

const states = new Map<string, SymbolState>();
for (const s of SYMBOLS) {
  states.set(s, {
    book: { bids: {}, asks: {} },
    buyVol: 0, sellVol: 0, tradeCount: 0,
    liqBuyVol: 0, liqSellVol: 0, liqCount: 0,
    haveSnapshot: false,
  });
}

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

function snapshotLine(st: SymbolState): string | null {
  const bids = topLevels(st.book.bids, true, 25);
  const asks = topLevels(st.book.asks, false, 25);
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
    mid: Math.round(mid * 10000) / 10000,
    spreadBps: Math.round(((ba - bb) / mid) * 1e6) / 100,
    bidDepth5: Math.round(b5 * 1000) / 1000,
    askDepth5: Math.round(a5 * 1000) / 1000,
    imb5: Math.round(((b5 - a5) / (b5 + a5)) * 1000) / 1000,
    imb25: Math.round(((b25 - a25) / (b25 + a25)) * 1000) / 1000,
    buyVol: Math.round(st.buyVol * 1000) / 1000,
    sellVol: Math.round(st.sellVol * 1000) / 1000,
    tradeCount: st.tradeCount,
    // forced-flow fields (liquidation-fade test, practitioner-mechanisms #3):
    // liqBuy = shorts force-bought, liqSell = longs force-sold (base units)
    liqBuy: Math.round(st.liqBuyVol * 1000) / 1000,
    liqSell: Math.round(st.liqSellVol * 1000) / 1000,
    liqCount: st.liqCount,
  });
  st.buyVol = 0; st.sellVol = 0; st.tradeCount = 0;
  st.liqBuyVol = 0; st.liqSellVol = 0; st.liqCount = 0;
  return line;
}

/** Symbol = last dot-segment of a v5 topic (orderbook.50.BTCUSDT etc). */
function topicSymbol(topic: string): string {
  const parts = topic.split('.');
  return parts[parts.length - 1] ?? '';
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  log(`order-flow collector starting → ${OUT_DIR} [${SYMBOLS.join(', ')}]${WITH_XAUT_OPTIONS ? ' + XAUT options poll' : ''}`);

  const ws = new WebsocketClient({ market: 'v5' });

  ws.on('update', (msg: { topic?: string; type?: string; data?: unknown }) => {
    if (!msg.topic) return;
    const st = states.get(topicSymbol(msg.topic));
    if (!st) return;
    if (msg.topic.startsWith('orderbook')) {
      const data = msg.data as { b: Array<[string, string]>; a: Array<[string, string]> };
      if (msg.type === 'snapshot') {
        st.book.bids = {}; st.book.asks = {};
        st.haveSnapshot = true;
      }
      applyDelta(st.book.bids, data.b ?? []);
      applyDelta(st.book.asks, data.a ?? []);
    } else if (msg.topic.startsWith('publicTrade')) {
      const trades = msg.data as Array<{ S: 'Buy' | 'Sell'; v: string }>;
      for (const t of trades) {
        const v = parseFloat(t.v);
        if (t.S === 'Buy') st.buyVol += v; else st.sellVol += v;
        st.tradeCount++;
      }
    } else if (msg.topic.startsWith('allLiquidation')) {
      const liqs = msg.data as Array<{ S: 'Buy' | 'Sell'; v: string }>;
      for (const l of liqs) {
        const v = parseFloat(l.v);
        if (l.S === 'Buy') st.liqBuyVol += v; else st.liqSellVol += v;
        st.liqCount++;
      }
    }
  });

  // bybit-api's WS event map doesn't declare 'error'; narrow the emitter interface
  (ws as unknown as { on(event: 'error', cb: (e: unknown) => void): void })
    .on('error', (err) => log(`ws error: ${JSON.stringify(err).slice(0, 200)}`));

  const topics = SYMBOLS.flatMap((s) => [`orderbook.50.${s}`, `publicTrade.${s}`, `allLiquidation.${s}`]);
  ws.subscribeV5(topics, 'linear');

  // Prune BEFORE the first write so a redeploy onto a full volume heals itself
  // rather than needing someone to shell in and delete files by hand.
  const prune = (): void => {
    const r = pruneArchive(OUT_DIR, ARCHIVE_BUDGET);
    const d = diskStatus(OUT_DIR);
    if (r.deleted.length > 0) {
      log(`pruned ${r.deleted.length} archive files, freed ${(r.freedBytes / 1e6).toFixed(0)}MB ` +
        `(archive now ${(r.remainingBytes / 1e6).toFixed(0)}MB)`);
    }
    if (Number.isFinite(d.freeBytes)) {
      log(`disk: ${(d.freeBytes / 1e6).toFixed(0)}MB free of ${(d.totalBytes / 1e6).toFixed(0)}MB`);
    }
  };
  prune();
  setInterval(prune, 60 * 60 * 1000);

  // Latch so a full disk logs once, not once per second.
  let paused = false;
  setInterval(() => {
    // The reserve belongs to the trading processes. Collection stops at the
    // fence; it does not get to spend the last bytes the book needs to save
    // state. Re-checked each tick so it resumes on its own once pruning frees
    // space — no restart required.
    if (!hasHeadroom(OUT_DIR, CORE_RESERVE_BYTES)) {
      if (!paused) {
        log(`PAUSED — free space under the ${(CORE_RESERVE_BYTES / 1e6).toFixed(0)}MB core reserve; not writing`);
        paused = true;
        prune();
      }
      return;
    }
    if (paused) { log('resumed — free space recovered'); paused = false; }

    const day = new Date().toISOString().slice(0, 10);
    for (const [symbol, st] of states) {
      if (!st.haveSnapshot) continue;
      const line = snapshotLine(st);
      if (!line) continue;
      try {
        fs.appendFileSync(path.resolve(OUT_DIR, `${symbol}_${day}.ndjson`), line + '\n');
      } catch (err) {
        // A failed research write must never propagate — it used to reach the
        // top level as ENOSPC and kill the process, restarting the container.
        log(`write failed (${(err as { code?: string }).code ?? 'unknown'}) — skipping this snapshot`);
        paused = true;
      }
    }
  }, 1000);

  if (WITH_XAUT_OPTIONS) {
    const { snapshotXautOptions, XAUT_OPTIONS_INTERVAL_MS } = await import('./collect-xaut-options');
    const poll = async (): Promise<void> => {
      try { await snapshotXautOptions(); } catch (err) { log(`options poll error: ${err}`); }
    };
    void poll();
    setInterval(() => { void poll(); }, XAUT_OPTIONS_INTERVAL_MS);
  }

  log(`subscribed ${topics.length} topics; writing 1s snapshots`);
}

main().catch((err) => {
  console.error('Collector crashed:', err);
  process.exit(1);
});
