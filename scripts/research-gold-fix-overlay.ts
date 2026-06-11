#!/usr/bin/env tsx
/**
 * Gold portfolio: overnight session-hold (long) + pre-PM-fix hour (short).
 *
 * Leg A: long 22:00→07:00 UTC + Friday weekend leg (wknd-gap variant,
 *        experiments/gold-session-hold.md)
 * Leg B: short 14:00→15:00 London daily (the replicated fix down-drift,
 *        −1.59 bps/d, t=−2.62 — experiments/gold-1m-research.md round 2)
 *
 * Both at futures-tier friction (0.3 bp/side default; B is only viable there).
 * Reports each leg + combined daily series, 2015–2026, per-year, correlation.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';
import { extractTrades } from './backtest-gold-session';

const FRICTION = 0.00003; // 0.3 bp/side, GC futures tier

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
function corr(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; db += (b[i]! - mb) ** 2; }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : 0;
}
function fmt(x: number, dp = 2): number { const f = 10 ** dp; return Math.round(x * f) / f; }

function nthSundayUTC(year: number, month: number, n: number): number {
  if (n > 0) {
    const dow = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return Date.UTC(year, month, 1 + ((7 - dow) % 7) + (n - 1) * 7);
  }
  const last = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay());
}
function londonOffsetHours(ts: number): number {
  const y = new Date(ts).getUTCFullYear();
  return ts >= nthSundayUTC(y, 2, -1) + 3_600_000 && ts < nthSundayUTC(y, 9, -1) + 3_600_000 ? 1 : 0;
}

/** Daily SHORT return of the 14:00→15:00 London window (positive = profitable short). */
function fixShortDaily(candles: Candle[]): Map<string, number> {
  const byDay = new Map<string, { at14?: number; at15?: number }>();
  for (const c of candles) {
    const off = londonOffsetHours(c.timestamp);
    const local = c.timestamp + off * 3_600_000;
    const d = new Date(local);
    const lm = d.getUTCHours() * 60 + d.getUTCMinutes();
    const day = d.toISOString().slice(0, 10);
    let rec = byDay.get(day);
    if (!rec) { rec = {}; byDay.set(day, rec); }
    if (lm <= 840) rec.at14 = c.close;
    if (lm <= 900) rec.at15 = c.close;
  }
  const out = new Map<string, number>();
  for (const [day, rec] of byDay) {
    if (rec.at14 !== undefined && rec.at15 !== undefined && rec.at14 > 0) {
      out.set(day, -Math.log(rec.at15 / rec.at14) - 2 * FRICTION);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const sessionDaily = new Map<string, number>();
  const fixDaily = new Map<string, number>();

  for (const file of ['XAUUSD_1m_holdout.json', 'XAUUSD_1m.json']) {
    const candles: Candle[] = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', file), 'utf-8'));
    for (const t of extractTrades(candles, true)) {
      const key = new Date(t.exitTs).toISOString().slice(0, 10);
      sessionDaily.set(key, (sessionDaily.get(key) ?? 0) + t.rawLogRet - 2 * FRICTION);
    }
    for (const [day, r] of fixShortDaily(candles)) fixDaily.set(day, r);
  }

  const allDates = [...new Set([...sessionDaily.keys(), ...fixDaily.keys()])].sort();
  const a: number[] = [], b: number[] = [], combo: number[] = [];
  const perYear = new Map<string, { a: number; b: number; c: number }>();
  for (const d of allDates) {
    const ra = sessionDaily.get(d) ?? 0;
    const rb = fixDaily.get(d) ?? 0;
    a.push(ra); b.push(rb); combo.push(ra + rb);
    const y = d.slice(0, 4);
    const rec = perYear.get(y) ?? { a: 0, b: 0, c: 0 };
    rec.a += ra; rec.b += rb; rec.c += ra + rb;
    perYear.set(y, rec);
  }

  const report = (label: string, xs: number[]): void => {
    console.log(`  ${label.padEnd(16)} total=${fmt(xs.reduce((s, x) => s + x, 0) * 100, 1)}% sharpe=${fmt(sharpe(xs))} maxDD=${fmt(maxDD(xs) * 100, 1)}%`);
  };

  console.log(`=== Gold overnight + fix-short overlay (0.3bp/side, ${allDates[0]} → ${allDates[allDates.length - 1]}) ===`);
  report('A: overnight', a);
  report('B: fix-short', b);
  report('A+B combo', combo);
  console.log(`  correlation(A,B) = ${fmt(corr(a, b), 3)}`);
  console.log('\n  Per-year (A / B / combo):');
  for (const [y, r] of [...perYear.entries()].sort()) {
    console.log(`    ${y}: ${fmt(r.a * 100, 1)}% / ${fmt(r.b * 100, 1)}% / ${fmt(r.c * 100, 1)}%`);
  }

  fs.writeFileSync(
    path.resolve(__dirname, '..', 'experiments', 'runs', 'gold-fix-overlay.json'),
    JSON.stringify({
      legA: { totalPct: fmt(a.reduce((s, x) => s + x, 0) * 100, 2), sharpe: fmt(sharpe(a)), maxDDPct: fmt(maxDD(a) * 100, 2) },
      legB: { totalPct: fmt(b.reduce((s, x) => s + x, 0) * 100, 2), sharpe: fmt(sharpe(b)), maxDDPct: fmt(maxDD(b) * 100, 2) },
      combo: { totalPct: fmt(combo.reduce((s, x) => s + x, 0) * 100, 2), sharpe: fmt(sharpe(combo)), maxDDPct: fmt(maxDD(combo) * 100, 2) },
      correlation: fmt(corr(a, b), 4),
      perYear: Object.fromEntries([...perYear.entries()].map(([y, r]) => [y, { a: fmt(r.a * 100, 1), b: fmt(r.b * 100, 1), combo: fmt(r.c * 100, 1) }])),
    }, null, 2),
  );
  console.log('\nSaved → experiments/runs/gold-fix-overlay.json');
}

main().catch((err) => { console.error('Overlay analysis failed:', err); process.exit(1); });
