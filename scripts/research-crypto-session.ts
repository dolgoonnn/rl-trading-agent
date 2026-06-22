#!/usr/bin/env tsx
/**
 * Crypto session-hold backtest — strategy-ifies the hour-of-day finding in
 * experiments/calendar-research.md (hour-22 UTC drift, t=5.4 pooled).
 *
 * Windows tested (1h bars; bar timestamped H spans H:00→H+1:00):
 *   21-23  — long 21:00→23:00 UTC (bars 21,22)
 *   22-23  — long 22:00→23:00 UTC (bar 22 only)
 *   22-07  — gold-symmetric overnight (bars 22..6)
 *
 * Friction ladder per side: 0, 1bp (maker), 5.5bp (taker).
 * Per-symbol + per-year + halves splits, vs buy-and-hold. 24/7 market: one
 * trade per calendar day, no weekend logic.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const FRICTIONS = [0, 0.0001, 0.00055];
const WINDOWS = [
  { name: '21-23', hours: [21, 22] },
  { name: '22-23', hours: [22] },
  { name: '22-07', hours: [22, 23, 0, 1, 2, 3, 4, 5, 6] },
];

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function sharpeDaily(xs: number[]): number {
  const s = std(xs);
  return s > 0 ? (mean(xs) / s) * Math.sqrt(365) : 0; // crypto: 365 sessions/yr
}
function maxDD(xs: number[]): number {
  let eq = 0; let peak = 0; let dd = 0;
  for (const r of xs) { eq += r; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; }
  return dd;
}
function fmt(x: number, dp = 2): number { const f = 10 ** dp; return Math.round(x * f) / f; }

interface DayTrade { day: string; ret: number }

/** Daily window return: sum of log returns of the window's hour-bars per calendar day. */
function windowDaily(candles: Candle[], hours: number[]): DayTrade[] {
  const hourSet = new Set(hours);
  const byDay = new Map<string, number>();
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!;
    const c = candles[i]!;
    if (c.timestamp - prev.timestamp > 2 * 3_600_000) continue;
    const d = new Date(c.timestamp);
    if (!hourSet.has(d.getUTCHours())) continue;
    // Assign the whole overnight window to the day it STARTS (bar 22's calendar day)
    const anchor = new Date(c.timestamp - 23 * 3_600_000 * 0); // calendar day of bar
    const key = anchor.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + Math.log(c.close / prev.close));
  }
  return [...byDay.entries()].map(([day, ret]) => ({ day, ret })).sort((a, b) => a.day.localeCompare(b.day));
}

function evaluate(trades: DayTrade[], frictionPerSide: number): {
  n: number; totalPct: number; sharpe: number; maxDDPct: number; wr: number;
  perYear: Record<string, number>; yearsPos: string; firstHalfPct: number; secondHalfPct: number;
} {
  const rets = trades.map((t) => t.ret - 2 * frictionPerSide);
  const perYear: Record<string, number> = {};
  for (let i = 0; i < trades.length; i++) {
    const y = trades[i]!.day.slice(0, 4);
    perYear[y] = (perYear[y] ?? 0) + rets[i]!;
  }
  const years = Object.keys(perYear).sort();
  const half = Math.floor(rets.length / 2);
  return {
    n: rets.length,
    totalPct: fmt(rets.reduce((s, x) => s + x, 0) * 100, 1),
    sharpe: fmt(sharpeDaily(rets)),
    maxDDPct: fmt(maxDD(rets) * 100, 1),
    wr: fmt((rets.filter((x) => x > 0).length / Math.max(1, rets.length)) * 100, 1),
    perYear: Object.fromEntries(years.map((y) => [y, fmt(perYear[y]! * 100, 1)])),
    yearsPos: `${years.filter((y) => perYear[y]! > 0).length}/${years.length}`,
    firstHalfPct: fmt(rets.slice(0, half).reduce((s, x) => s + x, 0) * 100, 1),
    secondHalfPct: fmt(rets.slice(half).reduce((s, x) => s + x, 0) * 100, 1),
  };
}

async function main(): Promise<void> {
  // --holdout switches to the pre-2023 files (zero overlap with selection data)
  const suffix = process.argv.includes('--holdout') ? '_1h_holdout.json' : '_1h.json';
  const out: Record<string, unknown> = {};
  for (const sym of SYMBOLS) {
    const p = path.resolve(__dirname, '..', 'data', `${sym}${suffix}`);
    if (!fs.existsSync(p)) continue;
    const candles: Candle[] = JSON.parse(fs.readFileSync(p, 'utf-8'));

    // Buy-and-hold benchmark (daily close-to-close)
    const dayClose = new Map<string, number>();
    for (const c of candles) dayClose.set(new Date(c.timestamp).toISOString().slice(0, 10), c.close);
    const days = [...dayClose.keys()].sort();
    const bhRets: number[] = [];
    for (let i = 1; i < days.length; i++) bhRets.push(Math.log(dayClose.get(days[i]!)! / dayClose.get(days[i - 1]!)!));
    console.log(`\n=== ${sym} ===  B&H: total=${fmt(bhRets.reduce((s, x) => s + x, 0) * 100, 1)}% sharpe=${fmt(sharpeDaily(bhRets))} maxDD=${fmt(maxDD(bhRets) * 100, 1)}%`);

    const symOut: Record<string, unknown> = {};
    for (const w of WINDOWS) {
      const trades = windowDaily(candles, w.hours);
      for (const f of FRICTIONS) {
        const r = evaluate(trades, f);
        symOut[`${w.name}@${f}`] = r;
        console.log(
          `  ${w.name} fric=${(f * 10000).toFixed(1)}bp | n=${r.n} wr=${r.wr}% total=${String(r.totalPct).padStart(7)}% ` +
          `sharpe=${String(r.sharpe).padStart(6)} maxDD=${r.maxDDPct}% yrs+=${r.yearsPos} halves=${r.firstHalfPct}/${r.secondHalfPct}`,
        );
      }
    }
    out[sym] = symOut;
  }

  const outName = process.argv.includes('--holdout') ? 'crypto-session-results-holdout.json' : 'crypto-session-results.json';
  const outPath = path.resolve(__dirname, '..', 'experiments', 'runs', outName);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nSaved → ${outPath}`);
}

main().catch((err) => {
  console.error('Crypto session backtest failed:', err);
  process.exit(1);
});
