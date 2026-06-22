#!/usr/bin/env tsx
/**
 * FOMC event suite — two pre-registered tests (practitioner-mechanisms.md #2).
 *
 * T1  Pre-FOMC drift (Lucca-Moench 2015; alive 2020-24 per QuantSeeker):
 *     long US500 from 14:00 ET the day BEFORE a scheduled announcement to
 *     13:55 ET on announcement day (exit before the statement). Plus the
 *     pre-registered uncertainty gate (Quantpedia): trade only when trailing
 *     5d realized vol > trailing 252d median of that measure (no lookahead).
 *
 * T2  Post-FOMC gold drift (IRFA 2024 — adjustment continues >5min):
 *     signal = sign of gold move 14:00→14:05 ET; enter 14:05, exit 15:00 ET.
 *     Sister of the validated NFP-momentum leg.
 *
 * Scheduled meetings only (emergency cuts excluded — not tradeable ex ante).
 * Frictions: US500 0.5bp/side (MES), gold 0.45bp/side (MGC RTH).
 * Suitability: sign stable across 2015-19 / 2020-26 halves.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';

interface FomcEvent { date: string; action: 'hike' | 'cut' | 'hold'; scheduled: boolean }

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function tstat(xs: number[]): number { const s = std(xs); return s > 0 ? mean(xs) / (s / Math.sqrt(xs.length)) : 0; }
function fmt(x: number, dp = 2): string { return x.toFixed(dp); }

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

/** day(NY) → minute-of-day(NY) → close. Single pass. */
function nyMinuteMarks(candles: Candle[]): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  for (const c of candles) {
    const local = c.timestamp + nyOffsetHours(c.timestamp) * 3_600_000;
    const d = new Date(local);
    const day = d.toISOString().slice(0, 10);
    let m = out.get(day);
    if (!m) { m = new Map(); out.set(day, m); }
    m.set(d.getUTCHours() * 60 + d.getUTCMinutes(), c.close);
  }
  return out;
}

/** price at or just before the given NY minute (≤10 min stale). */
function markAt(marks: Map<string, Map<number, number>>, day: string, minute: number): number | null {
  const m = marks.get(day);
  if (!m) return null;
  for (let k = minute; k >= minute - 10; k--) {
    const p = m.get(k);
    if (p !== undefined) return p;
  }
  return null;
}

function prevTradingDay(marks: Map<string, Map<number, number>>, day: string): string | null {
  const d = new Date(`${day}T00:00:00Z`);
  for (let i = 1; i <= 5; i++) {
    const cand = new Date(d.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    if (marks.has(cand) && markAt(marks, cand, 14 * 60) !== null) return cand;
  }
  return null;
}

function report(name: string, rows: Array<{ date: string; r: number }>, friction: number): void {
  const net = rows.map((x) => x.r - 2 * friction);
  const xs = net;
  const h1 = rows.filter((x) => x.date < '2020-01-01').map((x) => x.r - 2 * friction);
  const h2 = rows.filter((x) => x.date >= '2020-01-01').map((x) => x.r - 2 * friction);
  const wr = xs.filter((x) => x > 0).length / Math.max(1, xs.length);
  const sum = (a: number[]): number => a.reduce((s, x) => s + x, 0);
  console.log(
    `${name}: n=${xs.length} mean=${fmt(mean(xs) * 1e4, 1)}bp t=${fmt(tstat(xs))} WR=${fmt(wr * 100, 0)}% ` +
    `total=${fmt(sum(xs) * 100, 2)}% | h1=${fmt(sum(h1) * 100, 2)}% h2=${fmt(sum(h2) * 100, 2)}% ` +
    `SUITABLE=${sum(h1) > 0 && sum(h2) > 0 ? 'YES' : 'no'}`,
  );
}

function main(): void {
  const events = (JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', 'fomc-calendar.json'), 'utf-8')) as FomcEvent[])
    .filter((e) => e.scheduled);
  console.log(`${events.length} scheduled FOMC announcements 2015–2026`);

  console.log('Loading US500 + XAUUSD 1m...');
  const us500: Candle[] = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', 'US500_1m.json'), 'utf-8'));
  const gold: Candle[] = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', 'XAUUSD_1m.json'), 'utf-8'));
  const usMarks = nyMinuteMarks(us500);
  const auMarks = nyMinuteMarks(gold);

  // ---- T1: pre-FOMC drift on US500 ----
  const t1: Array<{ date: string; r: number }> = [];
  for (const e of events) {
    const prev = prevTradingDay(usMarks, e.date);
    if (!prev) continue;
    const entry = markAt(usMarks, prev, 14 * 60);
    const exit = markAt(usMarks, e.date, 13 * 60 + 55);
    if (entry && exit && entry > 0) t1.push({ date: e.date, r: Math.log(exit / entry) });
  }
  console.log('\n=== T1 pre-FOMC drift, US500 (long T−1 14:00 ET → T 13:55 ET, 0.5bp/side) ===');
  report('all events       ', t1, 0.00005);

  // Uncertainty gate: trailing 5d realized vol of US500 daily closes vs trailing 252d median
  const dayList = [...usMarks.keys()].sort().filter((d) => markAt(usMarks, d, 16 * 60) !== null);
  const closeOf = new Map(dayList.map((d) => [d, markAt(usMarks, d, 16 * 60)!]));
  const dailyRet = new Map<string, number>();
  for (let i = 1; i < dayList.length; i++) {
    dailyRet.set(dayList[i]!, Math.log(closeOf.get(dayList[i]!)! / closeOf.get(dayList[i - 1]!)!));
  }
  const vol5 = new Map<string, number>();
  for (let i = 5; i < dayList.length; i++) {
    const w = dayList.slice(i - 4, i + 1).map((d) => dailyRet.get(d) ?? 0);
    vol5.set(dayList[i]!, std(w));
  }
  const gated: Array<{ date: string; r: number }> = [];
  for (const row of t1) {
    const prev = prevTradingDay(usMarks, row.date)!;
    const idx = dayList.indexOf(prev);
    if (idx < 260) continue;
    const v = vol5.get(prev);
    const hist = dayList.slice(idx - 252, idx).map((d) => vol5.get(d)).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
    if (v !== undefined && hist.length > 100 && v > hist[Math.floor(hist.length / 2)]!) gated.push(row);
  }
  report('vol-gated (>med) ', gated, 0.00005);

  // ---- T2: post-FOMC gold drift ----
  const t2: Array<{ date: string; r: number; action: string }> = [];
  for (const e of events) {
    const p1400 = markAt(auMarks, e.date, 14 * 60);
    const p1405 = markAt(auMarks, e.date, 14 * 60 + 5);
    const p1500 = markAt(auMarks, e.date, 15 * 60);
    if (!p1400 || !p1405 || !p1500) continue;
    const sig = Math.log(p1405 / p1400);
    if (sig === 0) continue;
    t2.push({ date: e.date, r: Math.sign(sig) * Math.log(p1500 / p1405), action: e.action });
  }
  console.log('\n=== T2 post-FOMC gold drift (sign of 14:00→14:05 ET, hold 14:05→15:00, 0.45bp/side) ===');
  report('all events       ', t2, 0.000045);
  for (const a of ['cut', 'hike', 'hold'] as const) {
    const sub = t2.filter((x) => x.action === a);
    if (sub.length >= 5) report(`  ${a.padEnd(15)}`, sub, 0.000045);
  }

  fs.writeFileSync(
    path.resolve(__dirname, '..', 'experiments', 'runs', 'fomc-results.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      t1: { n: t1.length, meanBp: mean(t1.map((x) => x.r)) * 1e4, t: tstat(t1.map((x) => x.r)) },
      t1Gated: { n: gated.length, meanBp: mean(gated.map((x) => x.r)) * 1e4, t: tstat(gated.map((x) => x.r)) },
      t2: { n: t2.length, meanBp: mean(t2.map((x) => x.r)) * 1e4, t: tstat(t2.map((x) => x.r)) },
    }, null, 2),
  );
  console.log('\nSaved → experiments/runs/fomc-results.json');
}

main();
