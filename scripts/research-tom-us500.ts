#!/usr/bin/env tsx
/**
 * Turn-of-month effect on US500 (Etula et al. RFS 2020 "Dash for Cash").
 *
 * Mechanism: month-end institutional liquidity demand depresses prices into
 * T−3 (selling), pension/payroll inflows lift T+1..T+3 (buying). Flow-anchored.
 *
 * Pre-registered CANONICAL window: long from close of the 4th-to-last trading
 * day of the month (T−3) to the close of the 3rd trading day of the next month
 * (T+3). The entry/exit grid around it is reported transparently for stability
 * context, NOT for selection — the canonical window is the verdict window.
 *
 * Honesty control: US500 drifts upward unconditionally. We report the
 * in-window daily mean vs the out-of-window daily mean and the t-stat of the
 * DIFFERENCE — the effect must beat its pro-rata share of drift.
 *
 * Friction: MES 0.5bp/side (execution-audit tier). Suitability: sign stable
 * across 2015–19 / 2020–26 halves.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function sharpe(xs: number[]): number { const s = std(xs); return s > 0 ? (mean(xs) / s) * Math.sqrt(252) : 0; }
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

/** NY-16:00 cash-close mark per trading day. */
function dailyCloses(candles: Candle[]): Array<{ day: string; close: number }> {
  const byDay = new Map<string, number>();
  for (const c of candles) {
    const local = c.timestamp + nyOffsetHours(c.timestamp) * 3_600_000;
    const d = new Date(local);
    const lm = d.getUTCHours() * 60 + d.getUTCMinutes();
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    // last print in the 15:50–16:05 NY window wins
    if (lm >= 950 && lm <= 965) byDay.set(d.toISOString().slice(0, 10), c.close);
  }
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, close]) => ({ day, close }));
}

function main(): void {
  console.log('Loading US500 1m...');
  const candles: Candle[] = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'data', 'US500_1m.json'), 'utf-8'),
  );
  const closes = dailyCloses(candles);
  console.log(`${closes.length} trading days, ${closes[0]!.day} → ${closes[closes.length - 1]!.day}`);

  // daily log returns + position-in-month labels (T−k from month end, T+k from start)
  const rets: Array<{ day: string; r: number; fromEnd: number; fromStart: number }> = [];
  const monthOf = (d: string): string => d.slice(0, 7);
  // index within month
  const monthDays = new Map<string, string[]>();
  for (const c of closes) {
    const m = monthOf(c.day);
    if (!monthDays.has(m)) monthDays.set(m, []);
    monthDays.get(m)!.push(c.day);
  }
  for (let i = 1; i < closes.length; i++) {
    const cur = closes[i]!;
    const m = monthDays.get(monthOf(cur.day))!;
    const idx = m.indexOf(cur.day);
    rets.push({
      day: cur.day,
      r: Math.log(cur.close / closes[i - 1]!.close),
      fromStart: idx + 1,             // T+1 = first trading day of month
      fromEnd: m.length - idx,        // T−1 = last trading day (we label it 1)
    });
  }

  // In-window: T−3..T−1 from end (i.e. fromEnd ≤ 3 — the days AFTER the T−4 close
  // entry) plus T+1..T+3 of the next month (fromStart ≤ 3).
  const inWindow = (x: { fromEnd: number; fromStart: number }): boolean => x.fromEnd <= 3 || x.fromStart <= 3;
  const inXs = rets.filter(inWindow).map((x) => x.r);
  const outXs = rets.filter((x) => !inWindow(x)).map((x) => x.r);

  const diff = mean(inXs) - mean(outXs);
  const se = Math.sqrt(std(inXs) ** 2 / inXs.length + std(outXs) ** 2 / outXs.length);
  console.log('\n=== Canonical ToM window (hold T−4 close → T+3 close ≈ 6 days/month) ===');
  console.log(`in-window:  n=${inXs.length} mean/day=${fmt(mean(inXs) * 1e4, 2)}bp ann=${fmt(mean(inXs) * 252 * 100, 1)}% sharpe=${fmt(sharpe(inXs))}`);
  console.log(`out-window: n=${outXs.length} mean/day=${fmt(mean(outXs) * 1e4, 2)}bp ann=${fmt(mean(outXs) * 252 * 100, 1)}% sharpe=${fmt(sharpe(outXs))}`);
  console.log(`difference: ${fmt(diff * 1e4, 2)}bp/day, t=${fmt(diff / se)}`);

  // strategy P&L: in-market only during window, friction 0.5bp/side once per month
  const FRICTION = 0.00005;
  const monthsCount = monthDays.size;
  const stratTotal = inXs.reduce((s, x) => s + x, 0) - monthsCount * 2 * FRICTION;
  const stratDaily = rets.map((x) => (inWindow(x) ? x.r : 0));
  // halves
  const h1 = rets.filter((x) => inWindow(x) && x.day < '2020-01-01').reduce((s, x) => s + x.r, 0);
  const h2 = rets.filter((x) => inWindow(x) && x.day >= '2020-01-01').reduce((s, x) => s + x.r, 0);
  const h1out = rets.filter((x) => !inWindow(x) && x.day < '2020-01-01');
  const h2out = rets.filter((x) => !inWindow(x) && x.day >= '2020-01-01');
  console.log(`\nstrategy (window-only, ${fmt((inXs.length / rets.length) * 100, 0)}% of days, friction 0.5bp/side):`);
  console.log(`  total=${fmt(stratTotal * 100, 1)}% sharpe(calendar)=${fmt(sharpe(stratDaily))}`);
  console.log(`  halves: h1=${fmt(h1 * 100, 1)}% (out-drift ${fmt(mean(h1out.map((x) => x.r)) * 1e4, 2)}bp/d) | h2=${fmt(h2 * 100, 1)}% (out-drift ${fmt(mean(h2out.map((x) => x.r)) * 1e4, 2)}bp/d) | SUITABLE=${h1 > 0 && h2 > 0 ? 'YES' : 'no'}`);

  // transparent grid (context only): per-position-in-month mean returns
  console.log('\nper-day-position mean returns (bp/day) — context, NOT selection:');
  for (let k = 5; k >= 1; k--) {
    const xs = rets.filter((x) => x.fromEnd === k).map((x) => x.r);
    console.log(`  T−${k}: ${fmt(mean(xs) * 1e4, 2)} (n=${xs.length})`);
  }
  for (let k = 1; k <= 4; k++) {
    const xs = rets.filter((x) => x.fromStart === k).map((x) => x.r);
    console.log(`  T+${k}: ${fmt(mean(xs) * 1e4, 2)} (n=${xs.length})`);
  }

  fs.writeFileSync(
    path.resolve(__dirname, '..', 'experiments', 'runs', 'tom-us500-results.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      inWindow: { n: inXs.length, meanBpDay: mean(inXs) * 1e4, sharpe: sharpe(inXs) },
      outWindow: { n: outXs.length, meanBpDay: mean(outXs) * 1e4, sharpe: sharpe(outXs) },
      diffT: diff / se,
      strategyTotalPct: stratTotal * 100,
      halves: { h1Pct: h1 * 100, h2Pct: h2 * 100 },
    }, null, 2),
  );
  console.log('\nSaved → experiments/runs/tom-us500-results.json');
}

main();
