#!/usr/bin/env tsx
/**
 * Gold PM-fix MONTH-END concentration (systems-loop "improve" step).
 *
 * The fix-short edge is CONFIRMED (pre-PM-fix down-drift, OOS-robust, institutional cost).
 * Mechanism = informed flow + benchmark rebalancing through the 15:00 London auction.
 * Benchmark/index rebalancing flow is LARGEST at month-end (last business days) — so the
 * fix down-drift should CONCENTRATE there. If so, a month-end-only fix-short trades ~5×
 * fewer days for a bigger move per trade ⇒ may survive at HIGHER (retail) cost.
 *
 * Test: 14:00→15:00 London short, split by business-days-to-month-end. IS 2020-26 / OOS 2015-19.
 * Reuses the DST-aware London clock from gold-fix-systems.ts.
 */
import { readFileSync } from 'node:fs';

interface C { timestamp: number; close: number }
const SIDE_BP = Number(process.env.SIDE_BP ?? 0.3);

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
function tstat(xs: number[]): number { const s = std(xs); return s === 0 ? 0 : (mean(xs) / s) * Math.sqrt(xs.length); }

// last close ≤ 14:00 and ≤ 15:00 London, per UTC calendar day
function fixDays(file: string): { day: string; r: number }[] {
  const m1 = JSON.parse(readFileSync(file, 'utf8')) as C[];
  const byDay = new Map<string, { at14?: number; at15?: number }>();
  for (const c of m1) {
    if (c.close <= 0) continue;
    const local = c.timestamp + londonOffsetHours(c.timestamp) * 3_600_000;
    const d = new Date(local);
    const lm = d.getUTCHours() * 60 + d.getUTCMinutes();
    const day = d.toISOString().slice(0, 10);
    let rec = byDay.get(day); if (!rec) { rec = {}; byDay.set(day, rec); }
    if (lm <= 840) rec.at14 = c.close;
    if (lm <= 900) rec.at15 = c.close;
  }
  const out: { day: string; r: number }[] = [];
  for (const [day, rec] of byDay) if (rec.at14 && rec.at15 && rec.at14 > 0) out.push({ day, r: -Math.log(rec.at15 / rec.at14) - 2 * SIDE_BP / 1e4 });
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

// business-days-from-month-end: 0 = last trading day in our series for that month, 1 = prev, ...
function tagMonthEnd(days: { day: string; r: number }[]): { r: number; bdToEnd: number }[] {
  const byMonth = new Map<string, { day: string; r: number }[]>();
  for (const d of days) { const ym = d.day.slice(0, 7); let a = byMonth.get(ym); if (!a) { a = []; byMonth.set(ym, a); } a.push(d); }
  const out: { r: number; bdToEnd: number }[] = [];
  for (const [, arr] of byMonth) { arr.sort((a, b) => a.day.localeCompare(b.day)); const n = arr.length; for (let i = 0; i < n; i++) out.push({ r: arr[i]!.r, bdToEnd: n - 1 - i }); }
  return out;
}

function report(label: string, file: string) {
  const tagged = tagMonthEnd(fixDays(file));
  const all = tagged.map((t) => t.r);
  // month-end window = last K business days (K=3, covers the bulk of rebalancing flow)
  for (const K of [3, 5]) {
    const me = tagged.filter((t) => t.bdToEnd < K).map((t) => t.r);
    const rest = tagged.filter((t) => t.bdToEnd >= K).map((t) => t.r);
    console.log(`  ${label.padEnd(9)} K=${K} | ME n=${String(me.length).padStart(4)} ${(mean(me) * 1e4).toFixed(2).padStart(6)}bp Sh ${sharpe(me).toFixed(2).padStart(5)} t ${tstat(me).toFixed(2).padStart(5)} | rest n=${String(rest.length).padStart(4)} ${(mean(rest) * 1e4).toFixed(2).padStart(6)}bp Sh ${sharpe(rest).toFixed(2).padStart(5)}`);
  }
  console.log(`  ${label.padEnd(9)} ALL  | n=${all.length} ${(mean(all) * 1e4).toFixed(2)}bp Sharpe ${sharpe(all).toFixed(2)}`);
}

console.log(`Gold PM-fix month-end concentration — 14→15 London SHORT, cost ${SIDE_BP}bp/side (${2 * SIDE_BP}bp RT)`);
console.log('Hypothesis: down-drift concentrates in last K business days (benchmark rebalancing flow).\n');
console.log('  set       win  | month-end window                          | rest-of-month');
console.log('  ----------|----|------------------------------------------|-------------------');
report('IS 20-26', 'data/XAUUSD_1m.json');
report('OOS 15-19', 'data/XAUUSD_1m_holdout.json');
console.log('\nIf ME bp >> rest bp AND ME survives at higher SIDE_BP → cost-robust deployable subset.');
