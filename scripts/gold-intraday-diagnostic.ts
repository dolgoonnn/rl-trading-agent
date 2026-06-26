#!/usr/bin/env tsx
/**
 * Gold intraday STRUCTURE diagnostic (gold scalp/intraday loop — research step).
 *
 * Before building any strategy: WHERE (if anywhere) does gold have exploitable
 * intraday structure? Measures, on XAUUSD 1m → hourly, over 2020–2026:
 *   1. Hour-of-day (UTC): mean return, Sharpe, realized vol, %positive.
 *   2. Lag-1 hourly autocorrelation (trend vs mean-revert), overall + by hour.
 *   3. Asian-range (00–06 UTC) → London/NY break-and-CONTINUE vs break-and-FADE.
 * No trading, no cost — pure structure. Tells us what edge to target (if any).
 */
import { readFileSync } from 'node:fs';

interface C { timestamp: number; open: number; high: number; low: number; close: number }
const FILE = process.env.GOLD_FILE ?? 'data/XAUUSD_1m.json';
const m1 = JSON.parse(readFileSync(FILE, 'utf8')) as C[];

// aggregate 1m → hourly
interface HB { ts: number; hour: number; day: string; open: number; high: number; low: number; close: number }
const hourly: HB[] = [];
let cur: HB | null = null;
for (const c of m1) {
  const hBucket = Math.floor(c.timestamp / 3_600_000) * 3_600_000;
  if (!cur || cur.ts !== hBucket) {
    if (cur) hourly.push(cur);
    const d: Date = new Date(hBucket);
    cur = { ts: hBucket, hour: d.getUTCHours(), day: d.toISOString().slice(0, 10), open: c.open, high: c.high, low: c.low, close: c.close };
  } else {
    cur.high = Math.max(cur.high, c.high); cur.low = Math.min(cur.low, c.low); cur.close = c.close;
  }
}
if (cur) hourly.push(cur);

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); }

// hourly close-to-close returns
const rets: { hour: number; r: number }[] = [];
for (let i = 1; i < hourly.length; i++) {
  if (hourly[i]!.ts - hourly[i - 1]!.ts !== 3_600_000) continue; // contiguous only
  rets.push({ hour: hourly[i]!.hour, r: hourly[i]!.close / hourly[i - 1]!.close - 1 });
}

console.log(`Gold intraday structure — ${FILE}`);
console.log(`${m1.length} 1m → ${hourly.length} hourly bars, ${rets.length} contiguous hourly returns\n`);

// 1. by hour-of-day
console.log('── 1. Hour-of-day (UTC) ─────────────────────────────────');
console.log('  h | n     | mean(bp) | vol(bp) | Sharpe(ann) | %pos');
console.log('  --|-------|----------|---------|-------------|-----');
for (let h = 0; h < 24; h++) {
  const hr = rets.filter((x) => x.hour === h).map((x) => x.r);
  if (hr.length < 30) continue;
  const mn = mean(hr), sd = std(hr);
  const shAnn = sd === 0 ? 0 : (mn / sd) * Math.sqrt(24 * 252);
  console.log(`  ${String(h).padStart(2)}| ${String(hr.length).padStart(5)} | ${(mn * 1e4).toFixed(2).padStart(8)} | ${(sd * 1e4).toFixed(1).padStart(7)} | ${shAnn.toFixed(2).padStart(11)} | ${(100 * hr.filter((r) => r > 0).length / hr.length).toFixed(0).padStart(3)}`);
}

// 2. lag-1 autocorrelation (trend vs revert)
const allR = rets.map((x) => x.r);
function autocorr1(xs: number[]): number {
  const m = mean(xs); let num = 0, den = 0;
  for (let i = 1; i < xs.length; i++) num += (xs[i]! - m) * (xs[i - 1]! - m);
  for (const x of xs) den += (x - m) ** 2;
  return den === 0 ? 0 : num / den;
}
console.log(`\n── 2. Lag-1 hourly autocorrelation ──────────────────────`);
console.log(`  overall: ${autocorr1(allR).toFixed(4)}  (>0 trend/continuation, <0 mean-revert)`);
// by hour (does the move at hour h predict hour h+1?)
console.log('  strongest by-hour |ac1|:');
const byHourAc: { h: number; ac: number }[] = [];
for (let h = 0; h < 24; h++) {
  const seq: number[] = [];
  for (let i = 1; i < rets.length; i++) if (rets[i]!.hour === h) seq.push(rets[i]!.r * 0 + 0); // placeholder
  // proper: pairs (r[i-1], r[i]) where r[i].hour==h
  const pairs: [number, number][] = [];
  for (let i = 1; i < rets.length; i++) if (rets[i]!.hour === h) pairs.push([rets[i - 1]!.r, rets[i]!.r]);
  if (pairs.length < 50) continue;
  const a = pairs.map((p) => p[0]), b = pairs.map((p) => p[1]);
  const ma = mean(a), mb = mean(b);
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < pairs.length; i++) { cov += (a[i]! - ma) * (b[i]! - mb); va += (a[i]! - ma) ** 2; vb += (b[i]! - mb) ** 2; }
  byHourAc.push({ h, ac: va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0 });
}
byHourAc.sort((x, y) => Math.abs(y.ac) - Math.abs(x.ac));
for (const x of byHourAc.slice(0, 5)) console.log(`    hour ${String(x.h).padStart(2)} → next: ac=${x.ac.toFixed(3)} ${x.ac > 0 ? '(continues)' : '(reverts)'}`);

// 3. Asian-range (00–06 UTC) breakout: continue vs fade
console.log(`\n── 3. Asian-range (00–06 UTC) breakout behavior ─────────`);
const byDay = new Map<string, HB[]>();
for (const h of hourly) { if (!byDay.has(h.day)) byDay.set(h.day, []); byDay.get(h.day)!.push(h); }
let nUp = 0, contUp = 0, nDn = 0, contDn = 0;
const breakFwd: number[] = []; // return from first break to end of NY day, signed by break direction
for (const [, bars] of byDay) {
  const asian = bars.filter((b) => b.hour >= 0 && b.hour <= 6);
  const rest = bars.filter((b) => b.hour >= 7 && b.hour <= 20);
  if (asian.length < 5 || rest.length < 5) continue;
  const hi = Math.max(...asian.map((b) => b.high)), lo = Math.min(...asian.map((b) => b.low));
  let broke = 0, breakIdx = -1;
  for (let i = 0; i < rest.length; i++) { if (rest[i]!.high > hi) { broke = 1; breakIdx = i; break; } if (rest[i]!.low < lo) { broke = -1; breakIdx = i; break; } }
  if (broke === 0 || breakIdx < 0) continue;
  const breakPx = broke > 0 ? hi : lo;
  const endPx = rest[rest.length - 1]!.close;
  const fwd = broke * (endPx / breakPx - 1); // positive = continued in break direction
  breakFwd.push(fwd);
  if (broke > 0) { nUp++; if (endPx > hi) contUp++; } else { nDn++; if (endPx < lo) contDn++; }
}
console.log(`  days w/ break: ${breakFwd.length}`);
console.log(`  UP breaks: ${nUp}, continued to close: ${nUp ? (100 * contUp / nUp).toFixed(0) : 0}%`);
console.log(`  DN breaks: ${nDn}, continued to close: ${nDn ? (100 * contDn / nDn).toFixed(0) : 0}%`);
console.log(`  mean post-break return (signed by break dir): ${(mean(breakFwd) * 1e4).toFixed(2)}bp, Sharpe ${(mean(breakFwd) / std(breakFwd)).toFixed(3)} per-day`);
console.log(`  ⇒ >0 ⇒ breakouts CONTINUE (trade breakout); <0 ⇒ breakouts FADE (trade reversion)`);
