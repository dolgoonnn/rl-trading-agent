#!/usr/bin/env tsx
/**
 * Gold event-anomaly research: London fix drift + intraday momentum.
 *
 * Tests two documented anomaly families on 1m XAUUSD (2015–2026, both files):
 *
 *  A. LONDON FIX DRIFT (Caminschi & Heaney 2014; LBMA reviews): price moves
 *     tending down into the 15:00-London PM fix. We measure mean cumulative
 *     1m log-return profiles around the AM (10:30 London) and PM (15:00) fixes,
 *     plus t-stats for candidate trade windows, split 2015–19 / 2020–26.
 *
 *  B. INTRADAY MOMENTUM (Gao-Han-Li-Zhou JFE 2018): first half-hour return
 *     predicts last half-hour return. Gold adaptation in NY time: "day" =
 *     08:00–17:00 NY (US active session). Sign of r(08:00–08:30 NY) →
 *     conditional mean of r(16:30–17:00 NY). Also the equity-clock variant
 *     (09:30 first30, 16:30–17:00 last30).
 *
 * DST-aware London/NY clocks (approximate civil rules, fine at daily horizon).
 * Output: console + experiments/runs/gold-events-research.json
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';

const FILES = ['XAUUSD_1m_holdout.json', 'XAUUSD_1m.json'];

// ---------------------------------------------------------------------------
// Timezone helpers (approximate DST rules — last Sun Mar/Oct for London,
// 2nd Sun Mar / 1st Sun Nov for NY)
// ---------------------------------------------------------------------------

function nthSundayUTC(year: number, month: number, n: number): number {
  // n>0: nth Sunday of month; n=-1: last Sunday
  if (n > 0) {
    const first = Date.UTC(year, month, 1);
    const dow = new Date(first).getUTCDay();
    const day = 1 + ((7 - dow) % 7) + (n - 1) * 7;
    return Date.UTC(year, month, day);
  }
  const last = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay());
}

function londonOffsetHours(ts: number): number {
  const y = new Date(ts).getUTCFullYear();
  const start = nthSundayUTC(y, 2, -1) + 1 * 3_600_000;  // last Sun Mar 01:00 UTC
  const end = nthSundayUTC(y, 9, -1) + 1 * 3_600_000;    // last Sun Oct 01:00 UTC
  return ts >= start && ts < end ? 1 : 0;
}

function nyOffsetHours(ts: number): number {
  const y = new Date(ts).getUTCFullYear();
  const start = nthSundayUTC(y, 2, 2) + 7 * 3_600_000;   // 2nd Sun Mar 02:00 local ≈ 07:00 UTC
  const end = nthSundayUTC(y, 10, 1) + 6 * 3_600_000;    // 1st Sun Nov
  return ts >= start && ts < end ? -4 : -5;
}

/** Minutes since local midnight in the given zone */
function localMinutes(ts: number, zone: 'london' | 'ny'): number {
  const off = zone === 'london' ? londonOffsetHours(ts) : nyOffsetHours(ts);
  const local = ts + off * 3_600_000;
  const d = new Date(local);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

function tStat(xs: number[]): number {
  const s = std(xs);
  return s > 0 ? mean(xs) / (s / Math.sqrt(xs.length)) : 0;
}

function statLine(xs: number[]): { n: number; meanBps: number; t: number; wr: number } {
  return {
    n: xs.length,
    meanBps: Math.round(mean(xs) * 1e6) / 100,
    t: Math.round(tStat(xs) * 100) / 100,
    wr: Math.round((xs.filter((x) => x > 0).length / Math.max(1, xs.length)) * 1000) / 10,
  };
}

/** Per-day log return between two local-clock minute marks (same zone). */
function windowReturns(
  candles: Candle[],
  zone: 'london' | 'ny',
  fromMin: number,
  toMin: number,
): Array<{ day: string; ret: number }> {
  // Walk once; capture last close at/before each mark per day
  const byDay = new Map<string, { atFrom?: number; atTo?: number }>();
  for (const c of candles) {
    const lm = localMinutes(c.timestamp, zone);
    const off = zone === 'london' ? londonOffsetHours(c.timestamp) : nyOffsetHours(c.timestamp);
    const day = new Date(c.timestamp + off * 3_600_000).toISOString().slice(0, 10);
    let rec = byDay.get(day);
    if (!rec) { rec = {}; byDay.set(day, rec); }
    if (lm <= fromMin) rec.atFrom = c.close;
    if (lm <= toMin) rec.atTo = c.close;
  }
  const out: Array<{ day: string; ret: number }> = [];
  for (const [day, rec] of byDay) {
    if (rec.atFrom !== undefined && rec.atTo !== undefined && rec.atFrom > 0) {
      out.push({ day, ret: Math.log(rec.atTo / rec.atFrom) });
    }
  }
  return out;
}

async function main(): Promise<void> {
  console.log('Loading 1m XAUUSD (2015–2026)...');
  let candles: Candle[] = [];
  for (const f of FILES) {
    const part: Candle[] = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', f), 'utf-8'));
    candles = candles.concat(part);
  }
  candles.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`  ${candles.length.toLocaleString()} candles\n`);

  const splitTs = Date.UTC(2020, 0, 1);
  const halves: Array<{ label: string; data: Candle[] }> = [
    { label: '2015-19', data: candles.filter((c) => c.timestamp < splitTs) },
    { label: '2020-26', data: candles.filter((c) => c.timestamp >= splitTs) },
    { label: 'all', data: candles },
  ];

  // ----- A. Fix windows (London clock) -----
  // AM fix 10:30 (=630), PM fix 15:00 (=900)
  const fixWindows = [
    { name: 'pre-AM-fix 09:30→10:30', from: 570, to: 630 },
    { name: 'post-AM-fix 10:30→11:30', from: 630, to: 690 },
    { name: 'into-PM-fix 13:00→15:00', from: 780, to: 900 },
    { name: 'pre-PM-fix 14:00→15:00', from: 840, to: 900 },
    { name: 'post-PM-fix 15:00→16:00', from: 900, to: 960 },
    { name: 'PM-fix→NY-close 15:00→21:00', from: 900, to: 1260 },
  ];

  console.log('=== A. London fix windows (mean bps / t / WR%) ===');
  const fixResults: Record<string, Record<string, ReturnType<typeof statLine>>> = {};
  for (const w of fixWindows) {
    fixResults[w.name] = {};
    const row: string[] = [];
    for (const h of halves) {
      const rets = windowReturns(h.data, 'london', w.from, w.to).map((r) => r.ret);
      const s = statLine(rets);
      fixResults[w.name]![h.label] = s;
      row.push(`${h.label}: ${s.meanBps}bps t=${s.t} wr=${s.wr}% n=${s.n}`);
    }
    console.log(`  ${w.name}\n    ${row.join(' | ')}`);
  }

  // ----- B. Intraday momentum (NY clock) -----
  console.log('\n=== B. Intraday momentum (sign of first30 → last30 16:30→17:00 NY) ===');
  const variants = [
    { name: 'gold-day 08:00-08:30 NY', f1: 480, f2: 510 },
    { name: 'equity-clock 09:30-10:00 NY', f1: 570, f2: 600 },
  ];
  const momResults: Record<string, Record<string, { up: ReturnType<typeof statLine>; down: ReturnType<typeof statLine>; follow: ReturnType<typeof statLine> }>> = {};

  for (const v of variants) {
    momResults[v.name] = {};
    for (const h of halves) {
      const first = new Map(windowReturns(h.data, 'ny', v.f1, v.f2).map((r) => [r.day, r.ret]));
      const last = windowReturns(h.data, 'ny', 990, 1020); // 16:30→17:00 NY
      const up: number[] = [];
      const down: number[] = [];
      const follow: number[] = []; // last30 signed by sign(first30)
      for (const l of last) {
        const f = first.get(l.day);
        if (f === undefined || f === 0) continue;
        if (f > 0) up.push(l.ret); else down.push(l.ret);
        follow.push(Math.sign(f) * l.ret);
      }
      momResults[v.name]![h.label] = { up: statLine(up), down: statLine(down), follow: statLine(follow) };
      const fl = statLine(follow);
      console.log(
        `  ${v.name} [${h.label}]: follow ${fl.meanBps}bps t=${fl.t} wr=${fl.wr}% n=${fl.n} ` +
        `(up-days last30: ${statLine(up).meanBps}bps, down-days: ${statLine(down).meanBps}bps)`,
      );
    }
  }

  const outPath = path.resolve(__dirname, '..', 'experiments', 'runs', 'gold-events-research.json');
  fs.writeFileSync(outPath, JSON.stringify({ fixResults, momResults }, null, 2));
  console.log(`\nSaved → ${outPath}`);
}

main().catch((err) => {
  console.error('Event research failed:', err);
  process.exit(1);
});
