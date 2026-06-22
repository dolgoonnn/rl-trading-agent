#!/usr/bin/env tsx
/**
 * US500 overnight vs intraday decomposition (Cooper-Cliff-Gulen family claim:
 * the equity premium accrues close→open; open→close is ~zero).
 *
 * Legs tested on 11.4yr of 1m US500 CFD data (NY clock, DST-aware):
 *   overnight: long 16:01 ET → 09:31 ET next trading day (incl. weekend hold)
 *   intraday:  long 09:31 ET → 16:01 ET same day (the contrast)
 * Friction 0.5bp/side (ES futures tier ~0.2-0.5bp). Halves + per-year.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';

const FRICTION = 0.00005;

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
function maxDD(xs: number[]): number {
  let eq = 0, pk = 0, dd = 0;
  for (const r of xs) { eq += r; if (eq > pk) pk = eq; if (pk - eq > dd) dd = pk - eq; }
  return dd;
}
function fmt(x: number, dp = 2): number { const f = 10 ** dp; return Math.round(x * f) / f; }

async function main(): Promise<void> {
  console.log('Loading US500 1m...');
  const candles: Candle[] = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', 'US500_1m.json'), 'utf-8'));
  console.log(`  ${candles.length.toLocaleString()} candles\n`);

  // Per NY trading day: price at 09:31 (first bar >= 09:31's open proxy = last close <= 09:31 after 09:30)
  // and at 16:01. Use last close at-or-before the mark, requiring a bar within 10 min after market events.
  interface DayMarks { open931?: number; close1601?: number }
  const byDay = new Map<string, DayMarks>();
  for (const c of candles) {
    const local = c.timestamp + nyOffsetHours(c.timestamp) * 3_600_000;
    const d = new Date(local);
    const lm = d.getUTCHours() * 60 + d.getUTCMinutes();
    const day = d.toISOString().slice(0, 10);
    let rec = byDay.get(day);
    if (!rec) { rec = {}; byDay.set(day, rec); }
    if (lm >= 565 && lm <= 575) rec.open931 = c.close;   // 09:25–09:35 window, last wins ≈ 09:35
    if (lm >= 955 && lm <= 965) rec.close1601 = c.close; // 15:55–16:05 window
  }

  const days = [...byDay.entries()].filter(([, r]) => r.open931 && r.close1601).sort((a, b) => a[0].localeCompare(b[0]));
  console.log(`  ${days.length} trading days with both marks`);

  const overnight: Array<{ day: string; ret: number }> = [];
  const intraday: Array<{ day: string; ret: number }> = [];
  for (let i = 0; i < days.length; i++) {
    const [day, rec] = days[i]!;
    intraday.push({ day, ret: Math.log(rec.close1601! / rec.open931!) - 2 * FRICTION });
    if (i + 1 < days.length) {
      const [nday, nrec] = days[i + 1]!;
      overnight.push({ day: nday, ret: Math.log(nrec.open931! / rec.close1601!) - 2 * FRICTION });
    }
  }

  const split = '2020-01-01';
  const report = (label: string, xs: Array<{ day: string; ret: number }>): void => {
    const rets = xs.map((x) => x.ret);
    const h1 = xs.filter((x) => x.day < split).reduce((s, x) => s + x.ret, 0);
    const h2 = xs.filter((x) => x.day >= split).reduce((s, x) => s + x.ret, 0);
    console.log(
      `  ${label.padEnd(10)} n=${rets.length} total=${fmt(rets.reduce((s, x) => s + x, 0) * 100, 1)}% ` +
      `sharpe=${fmt(sharpe(rets))} maxDD=${fmt(maxDD(rets) * 100, 1)}% halves=${fmt(h1 * 100, 1)}/${fmt(h2 * 100, 1)}`,
    );
  };

  console.log('\n=== US500 close→open vs open→close (0.5bp/side) ===');
  report('overnight', overnight);
  report('intraday', intraday);

  console.log('\n  Per-year (overnight / intraday):');
  const py = new Map<string, { o: number; i: number }>();
  for (const x of overnight) { const y = x.day.slice(0, 4); const r = py.get(y) ?? { o: 0, i: 0 }; r.o += x.ret; py.set(y, r); }
  for (const x of intraday) { const y = x.day.slice(0, 4); const r = py.get(y) ?? { o: 0, i: 0 }; r.i += x.ret; py.set(y, r); }
  for (const [y, r] of [...py.entries()].sort()) console.log(`    ${y}: ${fmt(r.o * 100, 1)}% / ${fmt(r.i * 100, 1)}%`);
}

main().catch((err) => { console.error('US500 study failed:', err); process.exit(1); });
