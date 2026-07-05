#!/usr/bin/env tsx
/**
 * Deriv tick-gap analysis — resolves the ONE unknown that decides whether the
 * Range Break mean-reversion edge survives execution: how big is a single tick?
 *
 * WHY THIS IS THE RIGHT MEASUREMENT
 * ---------------------------------
 * A market STOP order fills at the FIRST available price after the stop level is
 * crossed — i.e. the NEXT TICK after the trigger. It does NOT fill at the bottom
 * of the break. So the realized slippage on a stop-out is (next_tick - stop),
 * which is bounded by the single-tick jump size — NOT by how far the whole break
 * eventually runs.
 *
 * Our 1m-bar backtest could only bracket this with `--slip` (0 = fill at stop,
 * 1.0 = fill at the bar's adverse extreme = bottom of the entire break). slip 1.0
 * is therefore a WILD over-estimate for a market stop. The truth is the per-tick
 * gap, which this script measures directly from real Deriv ticks.
 *
 * Range Break is a STEP process (bounded per-tick moves) — hypothesis: its ticks
 * are small and uniform (low slip, edge survives). Contrast: Boom/Crash produce a
 * single huge spike tick (high slip, edge dies). We measure both to confirm.
 *
 * OUTPUT: the consecutive-tick |Δ| distribution, expressed both in price and as a
 * fraction of the 1m ATR (the stop is slAtr×ATR away), so the percentiles read
 * directly as "effective slip in ATR units" on a stop-out.
 *
 *   npx tsx scripts/deriv-tick-gap-analysis.ts RB200 RB100 BOOM1000 stpRNG
 */
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Candle } from '@/types/candle';
import { atrSeries } from '@/lib/deriv/scalp-strategy';

const SYMBOLS = process.argv.slice(2).length ? process.argv.slice(2) : ['RB200', 'RB100', 'BOOM1000', 'stpRNG'];
const TARGET_TICKS = 50_000;
const MAX_PER_REQ = 5000;
const APP_ID = '1089';

interface TickHistory { history?: { prices: number[]; times: number[] }; error?: { message: string }; req_id?: number; }

function connect(): Promise<WebSocket> {
  const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Pull ~TARGET_TICKS most-recent ticks, paginating backward via `end`. */
async function fetchTicks(ws: WebSocket, symbol: string): Promise<number[]> {
  const byTime = new Map<number, number>();
  let end: number | 'latest' = 'latest';
  let reqId = 1;
  let prevOldest = Number.POSITIVE_INFINITY;

  while (byTime.size < TARGET_TICKS) {
    const id = reqId++;
    const res: TickHistory = await new Promise((resolve, reject) => {
      const onMsg = (d: WebSocket.RawData) => {
        const p = JSON.parse(d.toString()) as TickHistory;
        if (p.req_id !== id) return;
        ws.off('message', onMsg);
        resolve(p);
      };
      ws.on('message', onMsg);
      const timer = setTimeout(() => { ws.off('message', onMsg); reject(new Error('timeout')); }, 30_000);
      timer.unref?.();
      ws.send(JSON.stringify({
        ticks_history: symbol, style: 'ticks', count: MAX_PER_REQ,
        end: end === 'latest' ? 'latest' : String(end), req_id: id,
      }));
    });
    if (res.error) throw new Error(`${symbol}: ${res.error.message}`);
    const h = res.history;
    if (!h || h.times.length === 0) break;
    for (let i = 0; i < h.times.length; i++) byTime.set(h.times[i]!, h.prices[i]!);
    const oldest = h.times[0]!;
    if (oldest >= prevOldest) break; // retention limit
    prevOldest = oldest;
    end = oldest - 1;
    await new Promise((r) => { const t = setTimeout(r, 400); t.unref?.(); });
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

/** Median 1m ATR (price units) from the cached candle file, for ATR-normalisation. */
function medianAtr(symbol: string): number | null {
  try {
    const raw = readFileSync(join(process.cwd(), 'data', `${symbol}_1m.json`), 'utf8');
    const candles = JSON.parse(raw) as Candle[];
    const atr = atrSeries(candles, 14).filter((x) => x > 0).sort((a, b) => a - b);
    return atr.length ? atr[Math.floor(atr.length / 2)]! : null;
  } catch {
    return null;
  }
}

async function main() {
  const ws = await connect();
  console.log(`Deriv tick-gap analysis — single-tick |Δ| = realized slip on a market stop\n`);
  console.log(
    'symbol'.padEnd(10),
    'ticks'.padStart(7),
    'med|Δ|'.padStart(9),
    'p90'.padStart(9),
    'p99'.padStart(9),
    'p99.9'.padStart(9),
    'max'.padStart(9),
    '| in ATR: med / p99 / max'.padStart(10),
  );
  try {
    for (const sym of SYMBOLS) {
      const prices = await fetchTicks(ws, sym);
      if (prices.length < 2) { console.log(`${sym.padEnd(10)} — no ticks`); continue; }
      const gaps: number[] = [];
      for (let i = 1; i < prices.length; i++) gaps.push(Math.abs(prices[i]! - prices[i - 1]!));
      gaps.sort((a, b) => a - b);
      const atr = medianAtr(sym);
      const inAtr = (g: number) => (atr ? (g / atr).toFixed(3) : 'n/a');
      const med = pct(gaps, 50), p99 = pct(gaps, 99), max = gaps[gaps.length - 1]!;
      console.log(
        sym.padEnd(10),
        String(prices.length).padStart(7),
        med.toPrecision(4).padStart(9),
        pct(gaps, 90).toPrecision(4).padStart(9),
        p99.toPrecision(4).padStart(9),
        pct(gaps, 99.9).toPrecision(4).padStart(9),
        max.toPrecision(4).padStart(9),
        ` | ${inAtr(med)} / ${inAtr(p99)} / ${inAtr(max)}`,
      );
    }
  } finally {
    ws.close();
  }
  console.log(
    `\nRead "in ATR" as effective slip on a stop-out (stop sits slAtr≈3-4 ATR away):` +
    `\n  med  ≈ slip on a normal stop trigger (should be ~0 for a step process)` +
    `\n  max  ≈ worst single-tick gap = worst-case slip when a break tick hits your stop`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
