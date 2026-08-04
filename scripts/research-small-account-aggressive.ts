#!/usr/bin/env tsx
/**
 * Small-account aggressive sizing — the "barrier option" thesis, quantified.
 *
 * Owner thesis: risk a big part of a SMALL account; capped downside
 * (the deposit), high WR => long-term profitable via redeposit cycles.
 *
 * ARM A — the influencer model, replayed on real gold 1m (2020-2026):
 *   Grid-fade shorts exactly as the ochiroo.ot / Tur screenshots show:
 *   sell 0.05 lot each time price rises $STEP from the last entry, no stop,
 *   basket TP when price retraces $STEP below avg entry. Deriv-style specs:
 *   $1,300 account, 1:500 leverage, 50% stop-out, $0.30/oz round-trip spread.
 *   On stop-out: redeposit $1,300 and continue. Withdraw half when balance
 *   doubles (how "flippers" bank profit). Long side symmetric variant too.
 *
 * ARM B — the same aggressive structure on the PROVEN edge:
 *   Close-flow silver trades (p95/250d, 4bp RT — the deployed rule) with
 *   leverage L on each 1-hour event. Bootstrap 2-year paths; liquidation if
 *   the levered intra-event excursion (1.5x the close loss) <= -95%.
 *   Reports the growth/ruin frontier over L.
 *
 * Usage: NODE_OPTIONS=--max-old-space-size=12288 npx tsx scripts/research-small-account-aggressive.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';

function nthSundayUTC(year: number, month: number, n: number): number {
  const dow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return Date.UTC(year, month, 1 + ((7 - dow) % 7) + (n - 1) * 7);
}
function nyOffsetHours(ts: number): number {
  const y = new Date(ts).getUTCFullYear();
  const start = nthSundayUTC(y, 2, 2) + 7 * 3_600_000;
  const end = nthSundayUTC(y, 10, 1) + 6 * 3_600_000;
  return ts >= start && ts < end ? -4 : -5;
}
function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
}
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const loadCandles = (names: string[]): Candle[] => {
  let out: Candle[] = [];
  for (const nm of names) out = out.concat(JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', nm), 'utf-8')) as Candle[]);
  return out.sort((a, b) => a.timestamp - b.timestamp);
};

// ================================================================= ARM A
interface GridResult {
  deposits: number; withdrawn: number; finalBalance: number;
  basketWins: number; stopOuts: number; lifetimesDays: number[];
}

function runGrid(candles: Candle[], opts: {
  deposit: number; lot: number; stepUsd: number; retraceUsd: number;
  leverage: number; spreadUsd: number; stopOutLevel: number; side: 'short' | 'long';
}): GridResult {
  const OZ = opts.lot * 100; // 0.05 lot = 5 oz
  let balance = opts.deposit;
  let deposits = 1;
  let withdrawn = 0;
  let basketWins = 0;
  let stopOuts = 0;
  const lifetimes: number[] = [];
  let cycleStartTs = candles[0]!.timestamp;

  let entries: number[] = []; // entry prices
  let anchor = candles[0]!.close; // rolling extreme since flat

  const sgn = opts.side === 'short' ? 1 : -1; // short: fade rises

  for (const c of candles) {
    const px = c.close;
    if (entries.length === 0) {
      // track adverse extreme; open first position after STEP move against the fade
      if (opts.side === 'short') anchor = Math.min(anchor, px);
      else anchor = Math.max(anchor, px);
      if (sgn * (px - anchor) >= opts.stepUsd) {
        entries.push(px);
        anchor = px;
      }
      continue;
    }
    const last = entries[entries.length - 1]!;
    // add against the move
    if (sgn * (px - last) >= opts.stepUsd) {
      const usedMargin = ((entries.length + 1) * OZ * px) / opts.leverage;
      const floating = entries.reduce((s, e) => s + sgn * (e - px) * OZ, 0) - entries.length * opts.spreadUsd * OZ;
      if (balance + floating - usedMargin > 0) entries.push(px); // margin permitting
    }
    const avg = mean(entries);
    const floating = entries.reduce((s, e) => s + sgn * (e - px) * OZ, 0) - entries.length * opts.spreadUsd * OZ;
    const equity = balance + floating;
    const usedMargin = (entries.length * OZ * px) / opts.leverage;

    // stop-out
    if (usedMargin > 0 && equity / usedMargin <= opts.stopOutLevel) {
      stopOuts++;
      lifetimes.push((c.timestamp - cycleStartTs) / 86_400_000);
      cycleStartTs = c.timestamp;
      balance = opts.deposit; // redeposit
      deposits++;
      entries = [];
      anchor = px;
      continue;
    }
    // basket TP: price retraced past avg by retraceUsd
    if (sgn * (avg - px) >= opts.retraceUsd) {
      balance = equity;
      basketWins++;
      entries = [];
      anchor = px;
      if (balance >= 2 * opts.deposit) {
        const w = balance - opts.deposit;
        withdrawn += w;
        balance = opts.deposit;
      }
    }
  }
  // close residual at end
  if (entries.length) {
    const px = candles[candles.length - 1]!.close;
    balance += entries.reduce((s, e) => s + sgn * (e - px) * OZ, 0) - entries.length * opts.spreadUsd * OZ;
  }
  return { deposits, withdrawn, finalBalance: balance, basketWins, stopOuts, lifetimesDays: lifetimes };
}

// ================================================================= ARM B
function closeFlowTrades(candles: Candle[], costRT = 0.0004, pctile = 0.95, lookback = 250, since = '2024-01-01'): number[] {
  const byDay = new Map<string, { m1500?: number; m1600?: number }>();
  for (const c of candles) {
    const local = c.timestamp + nyOffsetHours(c.timestamp) * 3_600_000;
    const d = new Date(local);
    const lm = d.getUTCHours() * 60 + d.getUTCMinutes();
    const day = d.toISOString().slice(0, 10);
    let rec = byDay.get(day);
    if (!rec) { rec = {}; byDay.set(day, rec); }
    if (lm <= 900 && lm > 870) rec.m1500 = c.close;
    if (lm <= 960 && lm > 930) rec.m1600 = c.close;
  }
  const days = [...byDay.keys()].sort();
  const out: number[] = [];
  const absHist: number[] = [];
  let prev1600: number | undefined;
  for (const day of days) {
    const rec = byDay.get(day)!;
    if (prev1600 && rec.m1500 && rec.m1600) {
      const sig = Math.log(rec.m1500 / prev1600);
      if (isFinite(sig) && sig !== 0) {
        if (absHist.length >= lookback) {
          const thr = quantile(absHist.slice(-lookback), pctile);
          if (Math.abs(sig) >= thr && day >= since) out.push(Math.sign(sig) * Math.log(rec.m1600 / rec.m1500) - costRT);
        }
        absHist.push(Math.abs(sig));
      }
    }
    if (rec.m1600) prev1600 = rec.m1600;
  }
  return out;
}

async function main(): Promise<void> {
  console.log('Loading gold + silver 1m...');
  const gold = loadCandles(['XAUUSD_1m.json']); // 2020-2026 (grid replay era)
  const silver = loadCandles(['XAGUSD_1m_holdout.json', 'XAGUSD_1m.json']);

  console.log('\n================ ARM A: influencer grid on real gold 1m 2020-2026 ================');
  console.log('$1,300 account, 0.05 lot adds, 1:500 leverage, 50% stop-out, $0.30/oz spread,');
  console.log('redeposit on blowout, withdraw half at 2x. Both grid spacings from the screenshots.\n');
  for (const side of ['short', 'long'] as const) {
    for (const step of [3, 0.5]) {
      const r = runGrid(gold, { deposit: 1300, lot: 0.05, stepUsd: step, retraceUsd: step, leverage: 500, spreadUsd: 0.30, stopOutLevel: 0.5, side });
      const totalIn = r.deposits * 1300;
      const totalOut = r.withdrawn + Math.max(0, r.finalBalance);
      const winPct = r.basketWins + r.stopOuts > 0 ? (r.basketWins / (r.basketWins + r.stopOuts)) * 100 : 0;
      console.log(`${side.padEnd(5)} grid, $${step} step: basketWins=${r.basketWins.toLocaleString()} stopOuts=${r.stopOuts} | cycle WR ${winPct.toFixed(1)}% | median acct lifetime ${median(r.lifetimesDays).toFixed(0)}d | deposited $${totalIn.toLocaleString()} -> got back $${Math.round(totalOut).toLocaleString()} | NET ${totalOut >= totalIn ? '+' : ''}$${Math.round(totalOut - totalIn).toLocaleString()}`);
    }
  }

  console.log('\n================ ARM B: aggressive small account on the PROVEN close-flow edge ================');
  const trades = closeFlowTrades(silver);
  console.log(`silver close-flow trades 2024+ (deployed rule): n=${trades.length}, mean ${(mean(trades) * 1e4).toFixed(1)}bp, WR ${((trades.filter((x) => x > 0).length / trades.length) * 100).toFixed(0)}%`);
  console.log('Bootstrap 2-year paths (~' + Math.round((trades.length / 2.4)) + ' events/yr), liquidation if levered 1.5x-excursion <= -95%:\n');
  console.log('leverage | median 2yr | p10..p90            | P(ruin) | P(>=10x)');
  const rand = lcg(99);
  const perYear = trades.length / 2.4; // sample window ~2.4yr
  for (const L of [1, 3, 5, 10, 20, 30, 50]) {
    const finals: number[] = [];
    let ruins = 0;
    let tenx = 0;
    for (let it = 0; it < 5000; it++) {
      let eq = 1;
      let dead = false;
      const n = Math.round(perYear * 2);
      for (let i = 0; i < n; i++) {
        const r = trades[Math.floor(rand() * trades.length)]!;
        const excursion = r < 0 ? r * 1.5 : r; // intra-hour worst ~1.5x the closing loss
        if (L * excursion <= -0.95) { eq = 0; dead = true; break; }
        eq *= 1 + Math.max(-0.95, L * r);
        if (eq <= 0.02) { eq = 0; dead = true; break; }
      }
      finals.push(eq);
      if (dead) ruins++;
      if (eq >= 10) tenx++;
    }
    console.log(`  ${String(L).padStart(4)}x   | ${median(finals).toFixed(2).padStart(7)}x   | ${quantile(finals, 0.1).toFixed(2)}x .. ${quantile(finals, 0.9).toFixed(2).padStart(6)}x | ${((ruins / 5000) * 100).toFixed(1).padStart(5)}%  | ${((tenx / 5000) * 100).toFixed(1)}%`);
  }
  console.log('\nNOTE: Arm B assumes the 2024+ edge persists and excursions are only 1.5x closing losses —');
  console.log('both generous. Real tail days on top-5% move days can gap harder.');
}

main().catch((err) => { console.error('small-account-aggressive failed:', err); process.exit(1); });
