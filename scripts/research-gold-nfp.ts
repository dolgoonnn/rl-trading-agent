#!/usr/bin/env tsx
/**
 * NFP event study on gold (first Friday of month, 08:30 ET release).
 *
 * Mechanism-class event window: scheduled macro release with documented gold
 * reaction. Tests on 11.4yr of 1m data (NY clock, DST-aware):
 *
 *  E1) Release move size: |08:30→08:35| and |08:30→09:00| on NFP vs ordinary Fridays
 *  E2) Pre-release drift: 07:00→08:25 ET on NFP days (pre-announcement premium?)
 *  E3) Post-release momentum: sign(08:30→08:35) → 08:35→09:30 (signed continuation)
 *  E4) Post-release momentum, slower: sign(08:30→09:00) → 09:00→12:00
 *  E5) Fade-the-spike: sign(08:30→08:35) → 08:35→17:00 (negative = reversion)
 *
 * Controls: same stats on non-NFP Fridays. Split halves for stability.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';

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
function firstFriday(year: number, month: number): string {
  const dow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const day = 1 + ((5 - dow + 7) % 7);
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function tStat(xs: number[]): number { const s = std(xs); return s > 0 ? mean(xs) / (s / Math.sqrt(xs.length)) : 0; }
function line(xs: number[]): string {
  if (!xs.length) return 'n=0';
  return `n=${xs.length} mean=${(mean(xs) * 1e4).toFixed(2)}bps t=${tStat(xs).toFixed(2)} wr=${((xs.filter((x) => x > 0).length / xs.length) * 100).toFixed(1)}%`;
}

interface FridayDay {
  date: string;
  ts: number;
  isNFP: boolean;
  pre: number;       // 07:00→08:25
  spike5: number;    // 08:30→08:35
  spike30: number;   // 08:30→09:00
  follow60: number;  // 08:35→09:30
  followPM: number;  // 09:00→12:00
  fadeAll: number;   // 08:35→17:00
}

async function main(): Promise<void> {
  console.log('Loading gold 1m (2015–2026)...');
  let candles: Candle[] = [];
  for (const f of ['XAUUSD_1m_holdout.json', 'XAUUSD_1m.json']) {
    candles = candles.concat(JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', f), 'utf-8')) as Candle[]);
  }
  candles.sort((a, b) => a.timestamp - b.timestamp);

  // NFP dates from the calendar
  const nfpDates = new Set<string>();
  for (let y = 2015; y <= 2026; y++) for (let m = 0; m < 12; m++) nfpDates.add(firstFriday(y, m));

  // Group Friday bars by NY-date
  const byDay = new Map<string, Candle[]>();
  for (const c of candles) {
    const local = c.timestamp + nyOffsetHours(c.timestamp) * 3_600_000;
    const d = new Date(local);
    if (d.getUTCDay() !== 5) continue;
    const key = d.toISOString().slice(0, 10);
    let arr = byDay.get(key);
    if (!arr) { arr = []; byDay.set(key, arr); }
    arr.push(c);
  }

  const days: FridayDay[] = [];
  for (const [date, bars] of byDay) {
    if (bars.length < 500) continue;
    const at = (min: number): number | undefined => {
      // last close at/before the minute mark
      let best: number | undefined;
      for (const c of bars) {
        const d = new Date(c.timestamp + nyOffsetHours(c.timestamp) * 3_600_000);
        const lm = d.getUTCHours() * 60 + d.getUTCMinutes();
        if (lm <= min) best = c.close;
        else break;
      }
      return best;
    };
    const p0700 = at(420), p0825 = at(505), p0830 = at(510), p0835 = at(515);
    const p0900 = at(540), p0930 = at(570), p1200 = at(720), p1700 = at(1020);
    if (!p0700 || !p0825 || !p0830 || !p0835 || !p0900 || !p0930 || !p1200 || !p1700) continue;
    days.push({
      date,
      ts: bars[0]!.timestamp,
      isNFP: nfpDates.has(date),
      pre: Math.log(p0825 / p0700),
      spike5: Math.log(p0835 / p0830),
      spike30: Math.log(p0900 / p0830),
      follow60: Math.log(p0930 / p0835),
      followPM: Math.log(p1200 / p0900),
      fadeAll: Math.log(p1700 / p0835),
    });
  }

  const nfp = days.filter((d) => d.isNFP);
  const ctrl = days.filter((d) => !d.isNFP);
  console.log(`  Fridays: ${days.length} (NFP=${nfp.length}, control=${ctrl.length})\n`);

  console.log('=== E1. Release move magnitude (|bps|) ===');
  for (const [label, get] of [['08:30→08:35', (d: FridayDay) => d.spike5], ['08:30→09:00', (d: FridayDay) => d.spike30]] as const) {
    const a = nfp.map((d) => Math.abs(get(d)) * 1e4);
    const b = ctrl.map((d) => Math.abs(get(d)) * 1e4);
    console.log(`  ${label}: NFP mean=${mean(a).toFixed(1)}bps vs ctrl ${mean(b).toFixed(1)}bps (ratio ${(mean(a) / mean(b)).toFixed(1)}x)`);
  }

  console.log('\n=== E2. Pre-release drift 07:00→08:25 ET ===');
  console.log(`  NFP : ${line(nfp.map((d) => d.pre))}`);
  console.log(`  ctrl: ${line(ctrl.map((d) => d.pre))}`);

  const splitTs = Date.UTC(2020, 0, 1);
  const conds: Array<{ name: string; sig: (d: FridayDay) => number; out: (d: FridayDay) => number }> = [
    { name: 'E3. sign(spike5) → 08:35→09:30', sig: (d) => d.spike5, out: (d) => d.follow60 },
    { name: 'E4. sign(spike30) → 09:00→12:00', sig: (d) => d.spike30, out: (d) => d.followPM },
    { name: 'E5. sign(spike5) → 08:35→17:00', sig: (d) => d.spike5, out: (d) => d.fadeAll },
  ];
  for (const c of conds) {
    console.log(`\n=== ${c.name} (signed by spike direction) ===`);
    for (const [label, pool] of [['NFP ', nfp], ['ctrl', ctrl]] as const) {
      const xs = pool.filter((d) => c.sig(d) !== 0).map((d) => Math.sign(c.sig(d)) * c.out(d));
      const h1 = pool.filter((d) => d.ts < splitTs && c.sig(d) !== 0).map((d) => Math.sign(c.sig(d)) * c.out(d));
      const h2 = pool.filter((d) => d.ts >= splitTs && c.sig(d) !== 0).map((d) => Math.sign(c.sig(d)) * c.out(d));
      console.log(`  ${label}: ${line(xs)} | halves: ${(mean(h1) * 1e4).toFixed(1)} / ${(mean(h2) * 1e4).toFixed(1)}bps`);
    }
  }
}

main().catch((err) => { console.error('NFP study failed:', err); process.exit(1); });
