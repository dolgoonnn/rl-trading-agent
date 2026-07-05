#!/usr/bin/env tsx
/**
 * Gold FIX / TIME-WINDOW systems (gold systems-loop — NOT candle patterns).
 *
 * Mechanism edges around the LBMA gold auctions (London local time, DST-aware):
 *  - PM fix 15:00 London (the Caminschi-Heaney informed-flow window)
 *  - AM fix 10:30 London
 * Each "system" = hold a fixed London-clock window in a fixed direction, daily.
 * Known baseline (deployed in METALS BOOK): short 14:00→15:00 (pre-PM-fix drift).
 * New (untested): post-fix continuation 15:00→15:30/16:00, tighter pre-fix,
 * AM-fix windows. Judge on the 2015-19 OOS holdout, net of cost.
 *
 * Reuses the project's londonOffsetHours DST logic (research-gold-fix-overlay.ts).
 */
import { readFileSync } from 'node:fs';

interface C { timestamp: number; close: number }
const SIDE_BP = Number(process.env.SIDE_BP ?? 0.3); // per-side cost in bp (0.3 matches deployed fix-short; try 2 for conservative)

function nthSundayUTC(year: number, month: number, n: number): number {
  if (n > 0) { const dow = new Date(Date.UTC(year, month, 1)).getUTCDay(); return Date.UTC(year, month, 1 + ((7 - dow) % 7) + (n - 1) * 7); }
  const last = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay());
}
function londonOffsetHours(ts: number): number {
  const y = new Date(ts).getUTCFullYear();
  return ts >= nthSundayUTC(y, 2, -1) + 3_600_000 && ts < nthSundayUTC(y, 9, -1) + 3_600_000 ? 1 : 0;
}
function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); }
function sharpe(xs: number[]): number { const s = std(xs); return s === 0 ? 0 : (mean(xs) / s) * Math.sqrt(252); }

// London-local-minute boundaries we sample (last close ≤ boundary that day)
const BOUNDS = [600, 630, 660, 780, 840, 870, 900, 915, 930, 960]; // 10:00..16:00 London
function boundaryCloses(file: string): Map<string, Record<number, number>> {
  const m1 = JSON.parse(readFileSync(file, 'utf8')) as C[];
  const byDay = new Map<string, Record<number, number>>();
  for (const c of m1) {
    if (c.close <= 0) continue;
    const local = c.timestamp + londonOffsetHours(c.timestamp) * 3_600_000;
    const d = new Date(local);
    const lm = d.getUTCHours() * 60 + d.getUTCMinutes();
    const day = d.toISOString().slice(0, 10);
    let rec = byDay.get(day); if (!rec) { rec = {}; byDay.set(day, rec); }
    for (const b of BOUNDS) if (lm <= b) rec[b] = c.close; // last close ≤ boundary
  }
  return byDay;
}

interface Win { label: string; s: number; e: number; sign: number }
const WINDOWS: Win[] = [
  { label: 'pre-fix 14-15 SHORT (deployed)', s: 840, e: 900, sign: -1 },
  { label: 'pre-fix 14:30-15 SHORT', s: 870, e: 900, sign: -1 },
  { label: 'pre-fix 13-15 SHORT', s: 780, e: 900, sign: -1 },
  { label: 'post-fix 15-15:30 LONG', s: 900, e: 930, sign: 1 },
  { label: 'post-fix 15-15:30 SHORT', s: 900, e: 930, sign: -1 },
  { label: 'post-fix 15-16 LONG', s: 900, e: 960, sign: 1 },
  { label: 'post-fix 15-16 SHORT', s: 900, e: 960, sign: -1 },
  { label: 'AM pre-fix 10-10:30 SHORT', s: 600, e: 630, sign: -1 },
  { label: 'AM post-fix 10:30-11 LONG', s: 630, e: 660, sign: 1 },
  { label: 'AM post-fix 10:30-11 SHORT', s: 630, e: 660, sign: -1 },
];

function windowDaily(byDay: Map<string, Record<number, number>>, w: Win): number[] {
  const out: number[] = [];
  for (const [, rec] of byDay) {
    const ps = rec[w.s], pe = rec[w.e];
    if (ps !== undefined && pe !== undefined && ps > 0) out.push(w.sign * Math.log(pe / ps) - 2 * SIDE_BP / 1e4);
  }
  return out;
}

const isB = boundaryCloses('data/XAUUSD_1m.json');
const oosB = boundaryCloses('data/XAUUSD_1m_holdout.json');
console.log(`Gold fix/time-window systems — cost ${SIDE_BP}bp/side (${2 * SIDE_BP}bp RT) · IS 20-26 / OOS 15-19 (DST-aware London)\n`);
console.log('  system                          | IS n | IS bp/d | IS Sharpe | OOS n | OOS bp/d | OOS Sharpe | survive?');
console.log('  --------------------------------|------|---------|-----------|-------|----------|------------|--------');
for (const w of WINDOWS) {
  const is = windowDaily(isB, w), oos = windowDaily(oosB, w);
  const surv = mean(oos) > 0 && sharpe(oos) > 0.5;
  console.log(`  ${w.label.padEnd(31)} | ${String(is.length).padStart(4)} | ${(mean(is) * 1e4).toFixed(2).padStart(7)} | ${sharpe(is).toFixed(2).padStart(9)} | ${String(oos.length).padStart(5)} | ${(mean(oos) * 1e4).toFixed(2).padStart(8)} | ${sharpe(oos).toFixed(2).padStart(10)} | ${surv ? 'YES ✅' : 'no'}`);
}
console.log('\nSURVIVE = OOS bp/d>0 AND OOS Sharpe>0.5. Baseline (14-15 short) should pass (deployed). New edge = a DIFFERENT window also passing OOS.');
