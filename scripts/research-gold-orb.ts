#!/usr/bin/env tsx
/**
 * Opening Range Breakout (ORB) on gold — faithful port of Zarattini & Aziz
 * (2023, SSRN 4416622): direction = sign of the first N-minute bar of the
 * session; enter at the start of the next bar; SL at the first bar's opposite
 * extreme; TP at 10R; flat at session close if neither hit.
 *
 * Variants: anchor ∈ {08:20 ET (COMEX pit open), 09:30 ET (equity open)},
 * N ∈ {5, 15, 30} minutes. Session close 17:00 ET. Friction 0.5bp/side.
 * 11.4 years of 1m XAUUSD, split halves, per-year table for the best cell.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';

const FRICTION = 0.00005;
const TP_R = 10;

function nthSundayUTC(year: number, month: number, n: number): number {
  if (n > 0) {
    const dow = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return Date.UTC(year, month, 1 + ((7 - dow) % 7) + (n - 1) * 7);
  }
  const last = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay());
}
function nyOffsetHours(ts: number): number {
  const y = new Date(ts).getUTCFullYear();
  const start = nthSundayUTC(y, 2, 2) + 7 * 3_600_000;
  const end = nthSundayUTC(y, 10, 1) + 6 * 3_600_000;
  return ts >= start && ts < end ? -4 : -5;
}

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function sharpe(xs: number[]): number { const s = std(xs); return s > 0 ? (mean(xs) / s) * Math.sqrt(252) : 0; }
function fmt(x: number, dp = 2): number { const f = 10 ** dp; return Math.round(x * f) / f; }

interface OrbTrade { ts: number; ret: number; exit: 'sl' | 'tp' | 'eod'; rv: number }

function runOrb(daysBars: Map<string, Candle[]>, anchorMin: number, rangeMin: number): OrbTrade[] {
  const trades: OrbTrade[] = [];
  // Trailing 20-day average of opening-window volume for the in-play (RV) gate
  const recentVols: number[] = [];
  for (const [, bars] of [...daysBars.entries()].sort((a, b) => a[1][0]!.timestamp - b[1][0]!.timestamp)) {
    // locate bars by NY minute-of-day
    const lm = (c: Candle): number => {
      const d = new Date(c.timestamp + nyOffsetHours(c.timestamp) * 3_600_000);
      return d.getUTCHours() * 60 + d.getUTCMinutes();
    };
    const session = bars.filter((c) => lm(c) >= anchorMin && lm(c) < 1020); // → 17:00 ET
    if (session.length < 200) continue;

    const rangeBars = session.filter((c) => lm(c) < anchorMin + rangeMin);
    if (rangeBars.length < Math.max(3, rangeMin * 0.5)) continue;

    // Relative volume of the opening window vs trailing 20-day average
    const winVol = rangeBars.reduce((s, c) => s + c.volume, 0);
    const avgVol = recentVols.length >= 10 ? recentVols.reduce((s, x) => s + x, 0) / recentVols.length : 0;
    const rv = avgVol > 0 ? winVol / avgVol : 0;
    recentVols.push(winVol);
    if (recentVols.length > 20) recentVols.shift();
    if (rv === 0) continue; // warmup days

    const rOpen = rangeBars[0]!.open;
    const rClose = rangeBars[rangeBars.length - 1]!.close;
    const rHigh = Math.max(...rangeBars.map((c) => c.high));
    const rLow = Math.min(...rangeBars.map((c) => c.low));

    const move = Math.log(rClose / rOpen);
    if (Math.abs(move) < 0.00005) continue; // doji — no trade (paper rule)
    const dir: 1 | -1 = move > 0 ? 1 : -1;

    const after = session.filter((c) => lm(c) >= anchorMin + rangeMin);
    if (after.length < 30) continue;
    const entry = after[0]!.open;
    const stop = dir === 1 ? rLow : rHigh;
    const risk = dir === 1 ? entry - stop : stop - entry;
    if (risk <= 0) continue;
    const target = dir === 1 ? entry + TP_R * risk : entry - TP_R * risk;

    let exitPrice = after[after.length - 1]!.close;
    let exitKind: OrbTrade['exit'] = 'eod';
    for (const c of after) {
      if (dir === 1 ? c.low <= stop : c.high >= stop) { exitPrice = stop; exitKind = 'sl'; break; }
      if (dir === 1 ? c.high >= target : c.low <= target) { exitPrice = target; exitKind = 'tp'; break; }
    }
    const raw = dir === 1 ? Math.log(exitPrice / entry) : Math.log(entry / exitPrice);
    trades.push({ ts: session[0]!.timestamp, ret: raw - 2 * FRICTION, exit: exitKind, rv });
  }
  return trades.sort((a, b) => a.ts - b.ts);
}

async function main(): Promise<void> {
  console.log('Loading gold 1m (2015–2026)...');
  let candles: Candle[] = [];
  for (const f of ['XAUUSD_1m_holdout.json', 'XAUUSD_1m.json']) {
    candles = candles.concat(JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', f), 'utf-8')) as Candle[]);
  }
  candles.sort((a, b) => a.timestamp - b.timestamp);

  const daysBars = new Map<string, Candle[]>();
  for (const c of candles) {
    const key = new Date(c.timestamp + nyOffsetHours(c.timestamp) * 3_600_000).toISOString().slice(0, 10);
    let arr = daysBars.get(key);
    if (!arr) { arr = []; daysBars.set(key, arr); }
    arr.push(c);
  }
  console.log(`  ${daysBars.size} NY-days\n`);

  const splitTs = Date.UTC(2020, 0, 1);
  console.log('anchor | range | n | WR% | tp/sl/eod | total% | sharpe | halves%');
  let best: { label: string; trades: OrbTrade[]; total: number } | null = null;

  for (const anchor of [{ label: '08:20ET', min: 500 }, { label: '09:30ET', min: 570 }]) {
    for (const rangeMin of [5, 15, 30]) {
      const trades = runOrb(daysBars, anchor.min, rangeMin);
      const rets = trades.map((t) => t.ret);
      const total = rets.reduce((s, x) => s + x, 0);
      const wr = (rets.filter((x) => x > 0).length / Math.max(1, rets.length)) * 100;
      const kinds = { sl: 0, tp: 0, eod: 0 };
      for (const t of trades) kinds[t.exit]++;
      const h1 = trades.filter((t) => t.ts < splitTs).map((t) => t.ret).reduce((s, x) => s + x, 0);
      const h2 = trades.filter((t) => t.ts >= splitTs).map((t) => t.ret).reduce((s, x) => s + x, 0);
      console.log(
        `${anchor.label} | ${String(rangeMin).padStart(3)}m | ${rets.length} | ${wr.toFixed(1)} | ${kinds.tp}/${kinds.sl}/${kinds.eod} | ${String(fmt(total * 100, 1)).padStart(7)} | ${fmt(sharpe(rets))} | ${fmt(h1 * 100, 1)}/${fmt(h2 * 100, 1)}`,
      );
      if (!best || total > best.total) best = { label: `${anchor.label}/${rangeMin}m`, trades, total };
    }
  }

  // In-play (relative volume) gates on the two structurally sensible cells
  console.log('\nIn-play RV gates:');
  console.log('cell | RV gate | n | WR% | total% | sharpe | halves%');
  for (const cell of [{ label: '09:30ET/30m', min: 570, range: 30 }, { label: '08:20ET/15m', min: 500, range: 15 }]) {
    const all = runOrb(daysBars, cell.min, cell.range);
    for (const gate of [1.5, 2.0]) {
      const sel = all.filter((t) => t.rv >= gate);
      const rets = sel.map((t) => t.ret);
      const total = rets.reduce((s, x) => s + x, 0);
      const h1 = sel.filter((t) => t.ts < splitTs).reduce((s, t) => s + t.ret, 0);
      const h2 = sel.filter((t) => t.ts >= splitTs).reduce((s, t) => s + t.ret, 0);
      console.log(
        `${cell.label} | ≥${gate} | ${rets.length} | ${((rets.filter((x) => x > 0).length / Math.max(1, rets.length)) * 100).toFixed(1)} | ${fmt(total * 100, 1)} | ${fmt(sharpe(rets))} | ${fmt(h1 * 100, 1)}/${fmt(h2 * 100, 1)}`,
      );
    }
  }

  if (best) {
    console.log(`\nPer-year (best cell: ${best.label}):`);
    const perYear = new Map<string, number>();
    for (const t of best.trades) {
      const y = new Date(t.ts).toISOString().slice(0, 4);
      perYear.set(y, (perYear.get(y) ?? 0) + t.ret);
    }
    for (const [y, v] of [...perYear.entries()].sort()) console.log(`  ${y}: ${fmt(v * 100, 1)}%`);
  }
}

main().catch((err) => { console.error('ORB study failed:', err); process.exit(1); });
