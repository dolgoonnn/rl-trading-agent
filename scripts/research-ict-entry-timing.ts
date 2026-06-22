#!/usr/bin/env tsx
/**
 * Experiment 1 of the ICT-execution-layer program (ict-validation-research.md):
 * does an ICT-style liquidity-flush entry beat the fixed-clock entry on the
 * VALIDATED gold overnight edge? Same exposure thesis, same exit — only the
 * entry timing differs. Pre-registered, no parameter search.
 *
 *   Arm A (control): enter at close of first 1m bar at/after 18:05 ET.
 *   Arm B (ICT-timed): from the 18:00 ET reopen, watch for a SWEEP (new
 *     session low) followed by a REVERSION BAR (a later bar closing above the
 *     sweep bar's high) — per Osler 2005 the raw sweep print is continuation
 *     risk, so confirmation is required. Enter at the reversion bar's close
 *     (taker — no limit-fill fantasy per arXiv 2407.16527). If no trigger by
 *     19:35 ET, fall back to clock entry at 19:35 ET (caps opportunity cost).
 *   Exit (both arms): first close at/after 07:01 UTC next day.
 *
 * Metric: paired per-day diff r_B − r_A = log(entryA/entryB) (exit cancels,
 * friction identical both arms). Positive = ICT timing entered cheaper.
 * Stratified by trailing 20d realized-vol tercile — per Nagel (RFS 2012) the
 * flush premium should live in the HIGH-vol state; flat-across-states = noise.
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

interface DayWindow {
  nyDate: string;
  nyDow: number;
  bars: Candle[]; // 18:00–19:40 ET entry window, time-ordered
}

function main(): void {
  console.log('Loading gold 1m (2015–2026)...');
  const load = (names: string[]): Candle[] => {
    let out: Candle[] = [];
    for (const n of names) out = out.concat(JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', n), 'utf-8')) as Candle[]);
    return out.sort((a, b) => a.timestamp - b.timestamp);
  };
  const gold = load(['XAUUSD_1m_holdout.json', 'XAUUSD_1m.json']);

  // entry windows by NY date + exit marks + daily closes (for vol terciles)
  const windows = new Map<string, DayWindow>();
  const exitMark = new Map<string, number>();   // UTC date → first close ≥07:01
  const dailyClose = new Map<string, number>(); // UTC date → last close
  for (const c of gold) {
    const utcD = new Date(c.timestamp);
    const utcDay = utcD.toISOString().slice(0, 10);
    const utcMin = utcD.getUTCHours() * 60 + utcD.getUTCMinutes();
    if (utcMin >= 421 && utcMin <= 431 && !exitMark.has(utcDay)) exitMark.set(utcDay, c.close);
    dailyClose.set(utcDay, c.close);

    const local = c.timestamp + nyOffsetHours(c.timestamp) * 3_600_000;
    const nyD = new Date(local);
    const nyMin = nyD.getUTCHours() * 60 + nyD.getUTCMinutes();
    if (nyMin >= 18 * 60 && nyMin <= 19 * 60 + 40) {
      const nyDate = nyD.toISOString().slice(0, 10);
      let w = windows.get(nyDate);
      if (!w) { w = { nyDate, nyDow: nyD.getUTCDay(), bars: [] }; windows.set(nyDate, w); }
      w.bars.push(c);
    }
  }

  // trailing 20d realized vol per UTC day
  const days = [...dailyClose.keys()].sort();
  const rets = new Map<string, number>();
  for (let i = 1; i < days.length; i++) {
    rets.set(days[i]!, Math.log(dailyClose.get(days[i]!)! / dailyClose.get(days[i - 1]!)!));
  }
  const vol20 = new Map<string, number>();
  for (let i = 20; i < days.length; i++) {
    vol20.set(days[i]!, std(days.slice(i - 19, i + 1).map((d) => rets.get(d) ?? 0)));
  }
  const volValues = [...vol20.values()].sort((a, b) => a - b);
  const q1 = volValues[Math.floor(volValues.length / 3)]!;
  const q2 = volValues[Math.floor((2 * volValues.length) / 3)]!;

  // paired A/B per eligible day (Sun–Thu NY)
  interface Pair { nyDate: string; diff: number; triggered: boolean; trigMin: number; vol: 'low' | 'mid' | 'high' }
  const pairs: Pair[] = [];
  for (const w of [...windows.values()].sort((a, b) => a.nyDate.localeCompare(b.nyDate))) {
    if (w.nyDow > 4) continue; // Sun(0)–Thu(4) NY entries only
    const toNyMin = (c: Candle): number => {
      const d = new Date(c.timestamp + nyOffsetHours(c.timestamp) * 3_600_000);
      return d.getUTCHours() * 60 + d.getUTCMinutes();
    };
    const entryA = w.bars.find((c) => toNyMin(c) >= 18 * 60 + 5);
    if (!entryA) continue;
    const utcDay = new Date(entryA.timestamp).toISOString().slice(0, 10);
    const exitDay = new Date(Date.parse(`${utcDay}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    if (!exitMark.has(exitDay)) continue; // no next-day exit (holiday)

    // Arm B: sweep + reversion within 18:00–19:35 ET
    let sessionLow = Infinity;
    let sweepBarHigh: number | null = null;
    let entryB: number | null = null;
    let trigMin = -1;
    for (const c of w.bars) {
      const m = toNyMin(c);
      if (m > 19 * 60 + 35) break;
      if (sweepBarHigh !== null && entryB === null && c.close > sweepBarHigh) {
        if (m >= 18 * 60 + 5) { entryB = c.close; trigMin = m; }
      }
      if (c.low < sessionLow) {
        sessionLow = c.low;
        if (m >= 18 * 60 + 3) sweepBarHigh = c.high; // sweep only counts after a session low exists
      }
    }
    let triggered = true;
    if (entryB === null) {
      triggered = false;
      const fb = w.bars.find((c) => toNyMin(c) >= 19 * 60 + 35);
      entryB = fb ? fb.close : entryA.close;
      trigMin = 19 * 60 + 35;
    }

    const v = vol20.get(utcDay);
    pairs.push({
      nyDate: w.nyDate,
      diff: Math.log(entryA.close / entryB),
      triggered,
      trigMin,
      vol: v === undefined ? 'mid' : v <= q1 ? 'low' : v <= q2 ? 'mid' : 'high',
    });
  }

  const report = (name: string, xs: Pair[]): void => {
    const d = xs.map((p) => p.diff);
    console.log(
      `${name}: n=${d.length} meanΔ=${fmt(mean(d) * 1e4, 2)}bp t=${fmt(tstat(d))} ` +
      `winA<B=${fmt((d.filter((x) => x > 0).length / Math.max(1, d.length)) * 100, 0)}% ` +
      `total=${fmt(d.reduce((s, x) => s + x, 0) * 100, 2)}%`,
    );
  };

  console.log(`\n=== Overnight entry timing A/B (clock 18:05 ET vs sweep+reversion, same exit) ===`);
  console.log(`eligible days: ${pairs.length}, trigger rate: ${fmt((pairs.filter((p) => p.triggered).length / pairs.length) * 100, 0)}%, ` +
    `avg trigger ${fmt(mean(pairs.filter((p) => p.triggered).map((p) => p.trigMin)) / 60, 1)}h NY\n`);
  report('ALL          ', pairs);
  report('triggered    ', pairs.filter((p) => p.triggered));
  report('fallback     ', pairs.filter((p) => !p.triggered));
  console.log('--- by vol state (Nagel prediction: edge lives in HIGH only) ---');
  report('vol HIGH     ', pairs.filter((p) => p.vol === 'high'));
  report('vol MID      ', pairs.filter((p) => p.vol === 'mid'));
  report('vol LOW      ', pairs.filter((p) => p.vol === 'low'));
  // halves stability
  report('h1 2015-19   ', pairs.filter((p) => p.nyDate < '2020-01-01'));
  report('h2 2020-26   ', pairs.filter((p) => p.nyDate >= '2020-01-01'));

  const all = pairs.map((p) => p.diff);
  const mde = (2.8 * std(all)) / Math.sqrt(all.length) * 1e4; // ~80% power, 5% two-sided
  console.log(`\nminimum detectable effect ≈ ${fmt(mde, 2)}bp/day at this n`);

  fs.writeFileSync(
    path.resolve(__dirname, '..', 'experiments', 'runs', 'ict-entry-timing-results.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      n: pairs.length,
      triggerRatePct: (pairs.filter((p) => p.triggered).length / pairs.length) * 100,
      meanDiffBp: mean(all) * 1e4,
      t: tstat(all),
      byVol: Object.fromEntries((['high', 'mid', 'low'] as const).map((v) => {
        const d = pairs.filter((p) => p.vol === v).map((p) => p.diff);
        return [v, { n: d.length, meanBp: mean(d) * 1e4, t: tstat(d) }];
      })),
      mdeBp: mde,
    }, null, 2),
  );
  console.log('Saved → experiments/runs/ict-entry-timing-results.json');
}

main();
