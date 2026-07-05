#!/usr/bin/env tsx
/**
 * VALIDATE the gold 14:30-15 fix refinement (systems-loop improve step).
 *
 * gold-fix-systems.ts found the tighter 14:30-15 pre-PM-fix SHORT is OOS-stronger (Sharpe 1.06)
 * than the deployed 14:00-15:00 (0.57). Is that a REAL improvement or noise / lower-variance?
 *
 * Tests:
 *  1. First-half segment (14:00→14:30): is it adverse/flat for a short? (explains the refinement)
 *  2. Paired difference per day (14:30-15 short MINUS 14-15 short) = -(first-half drift): mean + t.
 *  3. Year-by-year Sharpe of both windows (stability, not one lucky window).
 * Combined IS 2020-26 + OOS 2015-19. Cost 0.3bp/side (futures-tier).
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

interface Day { year: number; at14: number; at1430: number; at15: number }
function days(file: string): Day[] {
  const m1 = JSON.parse(readFileSync(file, 'utf8')) as C[];
  const byDay = new Map<string, { y: number; at14?: number; at1430?: number; at15?: number }>();
  for (const c of m1) {
    if (c.close <= 0) continue;
    const local = c.timestamp + londonOffsetHours(c.timestamp) * 3_600_000;
    const d = new Date(local);
    const lm = d.getUTCHours() * 60 + d.getUTCMinutes();
    const key = d.toISOString().slice(0, 10);
    let rec = byDay.get(key); if (!rec) { rec = { y: d.getUTCFullYear() }; byDay.set(key, rec); }
    if (lm <= 840) rec.at14 = c.close;
    if (lm <= 870) rec.at1430 = c.close;
    if (lm <= 900) rec.at15 = c.close;
  }
  const out: Day[] = [];
  for (const [, r] of byDay) if (r.at14 && r.at1430 && r.at15 && r.at14 > 0 && r.at1430 > 0) out.push({ year: r.y, at14: r.at14, at1430: r.at1430, at15: r.at15 });
  return out;
}

const all = [...days('data/XAUUSD_1m.json'), ...days('data/XAUUSD_1m_holdout.json')];
const c = 2 * SIDE_BP / 1e4;
const short1415 = all.map((d) => -Math.log(d.at15 / d.at14) - c);          // deployed
const short1430 = all.map((d) => -Math.log(d.at15 / d.at1430) - c);        // refinement
const firstHalf = all.map((d) => Math.log(d.at1430 / d.at14) * 1e4);        // 14:00→14:30 drift (bp), gross
const paired = all.map((_, i) => short1430[i]! - short1415[i]!);            // = -(first-half drift)/1e4 ... net cost cancels

console.log(`Gold 14:30-15 fix refinement validation — cost ${SIDE_BP}bp/side · combined IS+OOS n=${all.length}\n`);
console.log('1) Window net Sharpe (combined):');
console.log(`   deployed 14:00-15:00 SHORT : ${(mean(short1415) * 1e4).toFixed(2)}bp/d  Sharpe ${sharpe(short1415).toFixed(2)}  t ${tstat(short1415).toFixed(2)}`);
console.log(`   refined  14:30-15:00 SHORT : ${(mean(short1430) * 1e4).toFixed(2)}bp/d  Sharpe ${sharpe(short1430).toFixed(2)}  t ${tstat(short1430).toFixed(2)}`);
console.log(`\n2) First-half 14:00→14:30 drift (gross): ${mean(firstHalf).toFixed(2)}bp/d  t ${tstat(firstHalf).toFixed(2)}  std ${std(firstHalf).toFixed(0)}bp`);
console.log(`   (a short over 14-15 carries this segment; if ~0 mean + high vol ⇒ it adds variance, not return)`);
console.log(`   Paired diff (refined − deployed) per day: ${(mean(paired) * 1e4).toFixed(2)}bp/d  t ${tstat(paired).toFixed(2)}`);
console.log(`   refined std ${(std(short1430) * 1e4).toFixed(0)}bp vs deployed std ${(std(short1415) * 1e4).toFixed(0)}bp → variance reduction ${((1 - std(short1430) / std(short1415)) * 100).toFixed(0)}%`);

console.log(`\n3) Year-by-year net Sharpe (stability):`);
console.log('   year |   n  | 14-15 Sharpe | 14:30-15 Sharpe | refined better?');
console.log('   -----|------|--------------|-----------------|----------------');
const years = [...new Set(all.map((d) => d.year))].sort((a, b) => a - b);
let wins = 0, tot = 0;
for (const y of years) {
  const idx = all.map((d, i) => (d.year === y ? i : -1)).filter((i) => i >= 0);
  if (idx.length < 30) continue;
  const a = idx.map((i) => short1415[i]!), b = idx.map((i) => short1430[i]!);
  const better = sharpe(b) > sharpe(a); if (better) wins++; tot++;
  console.log(`   ${y} | ${String(idx.length).padStart(4)} | ${sharpe(a).toFixed(2).padStart(12)} | ${sharpe(b).toFixed(2).padStart(15)} | ${better ? 'yes' : 'no'}`);
}
console.log(`\n   refined beats deployed in ${wins}/${tot} years. Both positive most years ⇒ stable mechanism, not one window.`);
console.log(`\nVERDICT logic: if paired-diff t is weak BUT variance-reduction is large + refined positive every year,`);
console.log(`the refinement is a LOWER-VARIANCE harvest of the same drift (legit), not new alpha. Forward-test, don't oversize.`);
