#!/usr/bin/env tsx
/**
 * LETF close-flow strategy backtest — turns the research-letf-settlement-flow
 * footprint into a tradeable, NO-LOOKAHEAD rule.
 *
 * Rule (pre-registered from the event study before this script was written):
 *   At 15:00 ET each day compute sig = log(P15:00 / prev-day P16:00).
 *   If |sig| >= rolling Pth percentile of trailing 250 |sig| values
 *   (threshold known at decision time — no lookahead), enter sign(sig)
 *   at 15:00 ET, exit 16:00 ET. One trade per day max, flat overnight.
 *
 * Costs: maker+taker ~4bp RT and taker-only ~11bp RT (Bybit XAGUSDT/XAUUSDT
 * perp tiers). Report per-year, 2024+, and full-history stats + seeded
 * IID bootstrap CI on the 2024+ mean (few events — block structure minimal
 * for a 1-per-day event series).
 *
 * Usage: NODE_OPTIONS=--max-old-space-size=12288 npx tsx scripts/research-letf-close-strategy.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';

function nthSundayUTC(year: number, month: number, n: number): number {
  if (n > 0) {
    const dow = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return Date.UTC(year, month, 1 + ((7 - dow) % 7) + (n - 1) * 7);
  }
  const last = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay());
}
function nyOffsetHours(ts: number): number {
  const y = new Date(ts).getUTCFullYear();
  const start = nthSundayUTC(y, 2, 2) + 7 * 3_600_000;
  const end = nthSundayUTC(y, 10, 1) + 6 * 3_600_000;
  return ts >= start && ts < end ? -4 : -5;
}
function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function tstat(xs: number[]): number { const s = std(xs); return s > 0 ? mean(xs) / (s / Math.sqrt(xs.length)) : 0; }
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

interface DayMarks { m1500?: number; m1530?: number; m1600?: number }

function extractMarks(candles: Candle[]): Map<string, DayMarks> {
  const byDay = new Map<string, DayMarks>();
  const MARKS: [keyof DayMarks, number][] = [['m1500', 900], ['m1530', 930], ['m1600', 960]];
  for (const c of candles) {
    const local = c.timestamp + nyOffsetHours(c.timestamp) * 3_600_000;
    const d = new Date(local);
    const lm = d.getUTCHours() * 60 + d.getUTCMinutes();
    const day = d.toISOString().slice(0, 10);
    let rec = byDay.get(day);
    if (!rec) { rec = {}; byDay.set(day, rec); }
    for (const [k, m] of MARKS) if (lm <= m && lm > m - 30) rec[k] = c.close;
  }
  return byDay;
}

interface TradeDay { day: string; sig: number; ret: number } // ret = signed 15:00->16:00 log return, pre-cost

function buildSeries(marks: Map<string, DayMarks>): TradeDay[] {
  const days = [...marks.keys()].sort();
  const out: TradeDay[] = [];
  for (let i = 1; i < days.length; i++) {
    const prev = marks.get(days[i - 1]!)!;
    const cur = marks.get(days[i]!)!;
    if (!prev.m1600 || !cur.m1500 || !cur.m1600) continue;
    const sig = Math.log(cur.m1500 / prev.m1600);
    if (!isFinite(sig) || sig === 0) continue;
    out.push({ day: days[i]!, sig, ret: Math.sign(sig) * Math.log(cur.m1600 / cur.m1500) });
  }
  return out;
}

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
}

interface StratResult { day: string; net: number }

function runStrategy(series: TradeDay[], pctile: number, costRT: number, lookback = 250): StratResult[] {
  const trades: StratResult[] = [];
  const absHist: number[] = [];
  for (const d of series) {
    if (absHist.length >= lookback) {
      const thr = quantile(absHist.slice(-lookback), pctile);
      if (Math.abs(d.sig) >= thr) trades.push({ day: d.day, net: d.ret - costRT });
    }
    absHist.push(Math.abs(d.sig));
  }
  return trades;
}

function report(trades: StratResult[], label: string): void {
  if (!trades.length) { console.log(`${label}: 0 trades`); return; }
  const nets = trades.map((t) => t.net);
  const byYear = new Map<string, number[]>();
  for (const t of trades) {
    const y = t.day.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(t.net);
  }
  const ann = mean(nets) * (trades.length / ((new Date(trades.at(-1)!.day).getTime() - new Date(trades[0]!.day).getTime()) / 31_536_000_000 || 1));
  console.log(`${label}: ${trades.length} trades, mean ${(mean(nets) * 1e4).toFixed(1)}bp/trade (t=${tstat(nets).toFixed(1)}), hit ${((nets.filter((x) => x > 0).length / nets.length) * 100).toFixed(0)}%, ~${(ann * 100).toFixed(1)}%/yr contribution`);
  for (const [y, xs] of [...byYear.entries()].sort()) {
    console.log(`    ${y}: n=${xs.length}, mean=${(mean(xs) * 1e4).toFixed(1)}bp, t=${tstat(xs).toFixed(1)}, hit=${((xs.filter((x) => x > 0).length / xs.length) * 100).toFixed(0)}%, sum=${(xs.reduce((s, x) => s + x, 0) * 1e4).toFixed(0)}bp`);
  }
}

async function main(): Promise<void> {
  const load = (names: string[]): Candle[] => {
    let out: Candle[] = [];
    for (const nm of names) out = out.concat(JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', nm), 'utf-8')) as Candle[]);
    return out.sort((a, b) => a.timestamp - b.timestamp);
  };

  for (const metal of [
    { name: 'SILVER', files: ['XAGUSD_1m_holdout.json', 'XAGUSD_1m.json'] },
    { name: 'GOLD', files: ['XAUUSD_1m_holdout.json', 'XAUUSD_1m.json'] },
  ]) {
    console.log(`\n==================== ${metal.name} ====================`);
    const series = buildSeries(extractMarks(load(metal.files)));
    console.log(`${series.length} candidate days ${series[0]!.day} → ${series.at(-1)!.day}`);

    for (const pctile of [0.9, 0.95, 0.98]) {
      for (const costRT of [0.0004, 0.0011]) {
        console.log(`\n-- threshold p${pctile * 100}, cost ${(costRT * 1e4).toFixed(0)}bp RT --`);
        const trades = runStrategy(series, pctile, costRT);
        report(trades.filter((t) => t.day >= '2024-01-01'), '  2024+');
        report(trades.filter((t) => t.day < '2024-01-01'), '  pre-2024');
      }
    }

    // bootstrap CI on the 2024+ p95/4bp config
    const trades = runStrategy(series, 0.95, 0.0004).filter((t) => t.day >= '2024-01-01');
    if (trades.length >= 20) {
      const nets = trades.map((t) => t.net);
      const rand = lcg(7);
      const means: number[] = [];
      for (let it = 0; it < 5000; it++) {
        const sample: number[] = [];
        for (let i = 0; i < nets.length; i++) sample.push(nets[Math.floor(rand() * nets.length)]!);
        means.push(mean(sample));
      }
      means.sort((a, b) => a - b);
      console.log(`\n  Bootstrap (p95/4bp, 2024+): mean ${(mean(nets) * 1e4).toFixed(1)}bp, 90% CI [${(means[Math.floor(0.05 * means.length)]! * 1e4).toFixed(1)}, ${(means[Math.floor(0.95 * means.length)]! * 1e4).toFixed(1)}]bp, P(mean<=0) = ${(means.filter((m) => m <= 0).length / means.length * 100).toFixed(1)}%`);
    }
  }
}

main().catch((err) => { console.error('letf-close-strategy failed:', err); process.exit(1); });
