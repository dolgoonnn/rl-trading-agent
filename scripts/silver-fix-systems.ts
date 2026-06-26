#!/usr/bin/env tsx
/**
 * Silver FIX / TIME-WINDOW systems (systems-loop — silver analog of gold-fix-systems.ts).
 *
 * Silver has its OWN LBMA auction: the Silver Price fix at 12:00 London (distinct from
 * gold's 10:30/15:00). METALS BOOK already deploys "Ag fix-short 11-12 Ldn" (pre-fix short).
 * UNTESTED on silver: the tighter pre-fix window + post-fix bounce structure that survived
 * OOS on gold (gold-fix-systems.ts). If a DIFFERENT silver window also passes the 2015-19
 * holdout, it's an additive deployable leg. DST-aware London clock (shared logic).
 */
import { readFileSync } from 'node:fs';

interface C { timestamp: number; close: number }
const SIDE_BP = Number(process.env.SIDE_BP ?? 0.5); // silver spread wider than gold; 0.5bp/side futures-tight baseline

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

// London-local-minute boundaries around the 12:00 silver fix (720)
const BOUNDS = [600, 660, 690, 720, 750, 780, 810]; // 10:00..13:30 London
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
    for (const b of BOUNDS) if (lm <= b) rec[b] = c.close;
  }
  return byDay;
}

interface Win { label: string; s: number; e: number; sign: number }
const WINDOWS: Win[] = [
  { label: 'pre-fix 11-12 SHORT (deployed)', s: 660, e: 720, sign: -1 },
  { label: 'pre-fix 11:30-12 SHORT', s: 690, e: 720, sign: -1 },
  { label: 'pre-fix 10-12 SHORT', s: 600, e: 720, sign: -1 },
  { label: 'post-fix 12-12:30 LONG', s: 720, e: 750, sign: 1 },
  { label: 'post-fix 12-12:30 SHORT', s: 720, e: 750, sign: -1 },
  { label: 'post-fix 12-13 LONG', s: 720, e: 780, sign: 1 },
  { label: 'post-fix 12-13 SHORT', s: 720, e: 780, sign: -1 },
];

function windowDaily(byDay: Map<string, Record<number, number>>, w: Win): number[] {
  const out: number[] = [];
  for (const [, rec] of byDay) {
    const ps = rec[w.s], pe = rec[w.e];
    if (ps !== undefined && pe !== undefined && ps > 0) out.push(w.sign * Math.log(pe / ps) - 2 * SIDE_BP / 1e4);
  }
  return out;
}

const isB = boundaryCloses('data/XAGUSD_1m.json');
const oosB = boundaryCloses('data/XAGUSD_1m_holdout.json');
console.log(`Silver fix/time-window systems (12:00 London auction) — cost ${SIDE_BP}bp/side (${2 * SIDE_BP}bp RT) · IS 20-26 / OOS 15-19\n`);
console.log('  system                          | IS n | IS bp/d | IS Sharpe | OOS n | OOS bp/d | OOS Sharpe | survive?');
console.log('  --------------------------------|------|---------|-----------|-------|----------|------------|--------');
for (const w of WINDOWS) {
  const is = windowDaily(isB, w), oos = windowDaily(oosB, w);
  const surv = mean(oos) > 0 && sharpe(oos) > 0.5;
  console.log(`  ${w.label.padEnd(31)} | ${String(is.length).padStart(4)} | ${(mean(is) * 1e4).toFixed(2).padStart(7)} | ${sharpe(is).toFixed(2).padStart(9)} | ${String(oos.length).padStart(5)} | ${(mean(oos) * 1e4).toFixed(2).padStart(8)} | ${sharpe(oos).toFixed(2).padStart(10)} | ${surv ? 'YES ✅' : 'no'}`);
}
console.log('\nSURVIVE = OOS bp/d>0 AND OOS Sharpe>0.5. Additive edge = a silver window passing OOS that the gold/silver book does not already harvest.');
