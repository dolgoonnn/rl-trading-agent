#!/usr/bin/env tsx
/**
 * LETF close-flow vs deployed book — orthogonality check.
 *
 * Question (gating whether the close-flow sleeve may ever count toward book
 * allocation): is the close-flow strategy's daily P&L correlated with the
 * deployed sleeves (session book, F2F gold, crypto), or genuinely additive?
 *
 * Method:
 *  1. Rebuild the DEPLOYED close-flow rule exactly (run-letf-bot.ts): silver
 *     1.0x + gold 0.5x, |sig| >= rolling p95 of trailing 250 days, enter
 *     15:00 ET, exit 16:00 ET, 4bp RT — daily LOG return series keyed by day.
 *  2. Load deployed sleeve daily series from
 *     experiments/runs/strategy-daily-returns.json (log returns).
 *  3. Union-calendar correlations (zeros on inactive days) on the 2024+
 *     overlap; plus trade-day clustering: do the sleeves move MORE on
 *     close-flow trade days (shared factor exposure)?
 *  4. Marginal test: equal-weight deployed book with vs without a
 *     vol-matched close-flow allocation, Sharpe on 2024+.
 *
 * Usage: NODE_OPTIONS=--max-old-space-size=12288 npx tsx scripts/research-letf-orthogonality.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';

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
function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function sharpe(xs: number[]): number { const s = std(xs); return s > 0 ? (mean(xs) / s) * Math.sqrt(252) : 0; }
function corr(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; db += (b[i]! - mb) ** 2; }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : 0;
}
function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
}

interface DayMarks { m1500?: number; m1600?: number }

function extractMarks(candles: Candle[]): Map<string, DayMarks> {
  const byDay = new Map<string, DayMarks>();
  for (const c of candles) {
    const local = c.timestamp + nyOffsetHours(c.timestamp) * 3_600_000;
    const d = new Date(local);
    const lm = d.getUTCHours() * 60 + d.getUTCMinutes();
    const day = d.toISOString().slice(0, 10);
    let rec = byDay.get(day);
    if (!rec) { rec = {}; byDay.set(day, rec); }
    if (lm <= 900 && lm > 870) rec.m1500 = c.close;
    if (lm <= 960 && lm > 930) rec.m1600 = c.close;
  }
  return byDay;
}

/** Deployed rule: daily log return map (only trade days present). */
function closeFlowDaily(candles: Candle[], weight: number, costRT = 0.0004, pctile = 0.95, lookback = 250): Map<string, number> {
  const marks = extractMarks(candles);
  const days = [...marks.keys()].sort();
  const out = new Map<string, number>();
  const absHist: number[] = [];
  let prev1600: number | undefined;
  for (const day of days) {
    const rec = marks.get(day)!;
    if (prev1600 && rec.m1500 && rec.m1600) {
      const sig = Math.log(rec.m1500 / prev1600);
      if (isFinite(sig) && sig !== 0) {
        if (absHist.length >= lookback) {
          const thr = quantile(absHist.slice(-lookback), pctile);
          if (Math.abs(sig) >= thr) {
            const ret = (Math.sign(sig) * Math.log(rec.m1600 / rec.m1500) - costRT) * weight;
            out.set(day, (out.get(day) ?? 0) + ret);
          }
        }
        absHist.push(Math.abs(sig));
      }
    }
    if (rec.m1600) prev1600 = rec.m1600;
  }
  return out;
}

async function main(): Promise<void> {
  const load = (names: string[]): Candle[] => {
    let out: Candle[] = [];
    for (const nm of names) out = out.concat(JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', nm), 'utf-8')) as Candle[]);
    return out.sort((a, b) => a.timestamp - b.timestamp);
  };

  console.log('Building close-flow daily series (deployed rule: silver 1.0x + gold 0.5x, p95/250d, 4bp RT)...');
  const silver = closeFlowDaily(load(['XAGUSD_1m_holdout.json', 'XAGUSD_1m.json']), 1.0);
  const gold = closeFlowDaily(load(['XAUUSD_1m_holdout.json', 'XAUUSD_1m.json']), 0.5);
  const closeFlow = new Map<string, number>(silver);
  for (const [d, r] of gold) closeFlow.set(d, (closeFlow.get(d) ?? 0) + r);
  console.log(`close-flow: ${closeFlow.size} trade days, ${[...closeFlow.keys()].sort()[0]} → ${[...closeFlow.keys()].sort().at(-1)}`);

  const sdr = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'experiments', 'runs', 'strategy-daily-returns.json'), 'utf-8')) as
    { series: Record<string, Record<string, number>> };
  const sleeves: Record<string, Record<string, number>> = {
    crypto: sdr.series.crypto ?? {},
    sessionBook: sdr.series.sessionBookRetail ?? sdr.series.sessionBook ?? {},
    f2f: sdr.series.f2f ?? {},
  };

  for (const window of [
    { label: '2024+ (close-flow edge regime)', from: '2024-01-01' },
    { label: 'FULL overlap', from: '2015-01-01' },
  ]) {
    // union calendar = all days any sleeve or close-flow was active, in range
    const all = new Set<string>();
    for (const s of Object.values(sleeves)) for (const d of Object.keys(s)) if (d >= window.from) all.add(d);
    for (const d of closeFlow.keys()) if (d >= window.from) all.add(d);
    const days = [...all].sort().filter((d) => d <= '2026-06-10'); // series end alignment
    const cf = days.map((d) => closeFlow.get(d) ?? 0);

    console.log(`\n===== ${window.label}: ${days.length} union days =====`);
    console.log('Correlations (union calendar, zeros on inactive days):');
    for (const [name, s] of Object.entries(sleeves)) {
      const v = days.map((d) => s[d] ?? 0);
      const tradeDays = days.filter((d) => closeFlow.has(d));
      const sleeveOnTrade = tradeDays.map((d) => s[d] ?? 0);
      const sleeveOffTrade = days.filter((d) => !closeFlow.has(d)).map((d) => s[d] ?? 0);
      console.log(
        `  ${name.padEnd(12)} rho=${corr(cf, v).toFixed(3)}  |  sleeve |ret| on trade days ${(mean(sleeveOnTrade.map(Math.abs)) * 1e4).toFixed(1)}bp vs other days ${(mean(sleeveOffTrade.map(Math.abs)) * 1e4).toFixed(1)}bp`,
      );
    }

    // marginal book test: EW book of the three sleeves vs + vol-matched close-flow
    const bookDaily = days.map((d) => {
      const vals = Object.values(sleeves).map((s) => s[d] ?? 0);
      return mean(vals);
    });
    const volBook = std(bookDaily);
    const volCf = std(cf);
    const scale = volCf > 0 ? volBook / volCf : 0;
    const cfScaled = cf.map((x) => x * scale);
    for (const w of [0.1, 0.2, 0.3]) {
      const combined = bookDaily.map((b, i) => (1 - w) * b + w * cfScaled[i]!);
      console.log(
        `  book Sharpe ${sharpe(bookDaily).toFixed(2)} -> +closeFlow(volmatched) w=${w}: ${sharpe(combined).toFixed(2)}`,
      );
    }
    console.log(`  close-flow standalone (union days incl zeros): Sharpe ${sharpe(cf).toFixed(2)}, ${days.filter((d) => closeFlow.has(d)).length} trade days`);
  }
}

main().catch((err) => { console.error('letf-orthogonality failed:', err); process.exit(1); });
