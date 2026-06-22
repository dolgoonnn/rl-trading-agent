#!/usr/bin/env tsx
/**
 * Multi-leg intraday book — "trade the pair with many strategies, not one".
 *
 * Candidate legs (all futures-tier friction, 2015–2026, 1m data):
 *   A  gold overnight 22:01→07:01 + wknd       (validated)
 *   B  silver overnight (same)                  (validated)
 *   C  gold fix-short 14:00→15:00 London        (validated)
 *   D  gold AM-fix bounce long 10:30→11:30 Ldn  (t=3.12 in research, unbanked)
 *   E  gold NY-open-hour short 13:00→14:00 UTC  (worst hour cell, unbanked)
 *   F  gold NFP 30m momentum 09:00→12:00 ET     (t=1.33, 12 events/yr, unbanked)
 *
 * Suitability rule (pre-registered): a leg enters the book ONLY if its sign is
 * stable across 2015–19 / 2020–26 halves. Then: full-book stats, each leg's
 * marginal Sharpe contribution (book with vs without), correlation matrix.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';
import { extractTrades } from './backtest-gold-session';

const FRICTION_AU = 0.00003;
const FRICTION_AG = 0.0001;

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
function nyOffsetHours(ts: number): number {
  const y = new Date(ts).getUTCFullYear();
  const start = nthSundayUTC(y, 2, 2) + 7 * 3_600_000;
  const end = nthSundayUTC(y, 10, 1) + 6 * 3_600_000;
  return ts >= start && ts < end ? -4 : -5;
}
function firstFriday(year: number, month: number): string {
  const dow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return new Date(Date.UTC(year, month, 1 + ((5 - dow + 7) % 7))).toISOString().slice(0, 10);
}

/** Window return per local day on a given clock; sign +1 long / −1 short. */
function clockWindowDaily(
  candles: Candle[],
  clock: 'london' | 'ny' | 'utc',
  fromMin: number,
  toMin: number,
  sign: 1 | -1,
  friction: number,
  onlyDates?: Set<string>,
): Map<string, number> {
  const off = (ts: number): number =>
    clock === 'london' ? londonOffsetHours(ts) : clock === 'ny' ? nyOffsetHours(ts) : 0;
  const byDay = new Map<string, { a?: number; b?: number }>();
  for (const c of candles) {
    const local = c.timestamp + off(c.timestamp) * 3_600_000;
    const d = new Date(local);
    const lm = d.getUTCHours() * 60 + d.getUTCMinutes();
    const day = d.toISOString().slice(0, 10);
    let rec = byDay.get(day);
    if (!rec) { rec = {}; byDay.set(day, rec); }
    if (lm <= fromMin) rec.a = c.close;
    if (lm <= toMin) rec.b = c.close;
  }
  const out = new Map<string, number>();
  for (const [day, rec] of byDay) {
    if (onlyDates && !onlyDates.has(day)) continue;
    if (rec.a !== undefined && rec.b !== undefined && rec.a > 0) {
      out.set(day, sign * Math.log(rec.b / rec.a) - 2 * friction);
    }
  }
  return out;
}

/** Per-leg notional weight in the book (overnight/equity legs are capital-heavy). */
export function legWeight(name: string): number {
  return name.startsWith('A') || name.startsWith('B') || name.startsWith('J') ? 0.5 : 1.0;
}

/** Build all candidate leg daily-return series (date → log return, friction included). */
export async function buildLegs(): Promise<Map<string, Map<string, number>>> {
  const load = (names: string[]): Candle[] => {
    let out: Candle[] = [];
    for (const n of names) out = out.concat(JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', n), 'utf-8')) as Candle[]);
    return out.sort((a, b) => a.timestamp - b.timestamp);
  };
  const gold = load(['XAUUSD_1m_holdout.json', 'XAUUSD_1m.json']);
  const silver = load(['XAGUSD_1m_holdout.json', 'XAGUSD_1m.json']);
  const us500 = fs.existsSync(path.resolve(__dirname, '..', 'data', 'US500_1m.json'))
    ? load(['US500_1m.json']) : null;
  const eurusd = fs.existsSync(path.resolve(__dirname, '..', 'data', 'EURUSD_1m.json'))
    ? load(['EURUSD_1m.json']) : null;

  // NFP momentum dates+direction need per-day handling: signal = sign(08:30→09:00 ET), hold 09:00→12:00 ET, NFP Fridays only
  const nfpDates = new Set<string>();
  for (let y = 2015; y <= 2026; y++) for (let m = 0; m < 12; m++) nfpDates.add(firstFriday(y, m));

  const legs = new Map<string, Map<string, number>>();
  // A/B: overnight — 18:05 ET DST-aware anchor (CME reopen +5m). The old fixed
  // 22:01 UTC anchor sat on the maintenance break in winter (execution-audit
  // gating item; remeasure-anchor.ts: gold Sharpe 1.09→0.85, silver 0.81→0.59).
  const overnight = (candles: Candle[], friction: number): Map<string, number> => {
    const out = new Map<string, number>();
    for (const t of extractTrades(candles, true, 18, 7, 5, 'ny')) {
      const key = new Date(t.exitTs).toISOString().slice(0, 10);
      out.set(key, (out.get(key) ?? 0) + t.rawLogRet - 2 * friction);
    }
    return out;
  };
  legs.set('A:Au-overnight', overnight(gold, FRICTION_AU));
  legs.set('B:Ag-overnight', overnight(silver, FRICTION_AG));
  legs.set('C:Au-fix-short', clockWindowDaily(gold, 'london', 840, 900, -1, FRICTION_AU));
  legs.set('D:Au-AMfix-long', clockWindowDaily(gold, 'london', 630, 690, 1, FRICTION_AU));
  // E (NY-open short) removed: marginal-negative, DST-redundant with C (iteration 8)
  // G/H (gold's fix windows on silver) removed: failed suitability — the fix effect
  // is fix-specific, which is why silver's OWN fix (leg I) works
  legs.set('I:Ag-ownfix-short', clockWindowDaily(silver, 'london', 660, 720, -1, FRICTION_AG));
  // Silver's own fix is 12:00 London — pre-fix short 11:00→12:00

  // F: NFP momentum — signal sign(08:30→09:00 ET) applied to 09:00→12:00 ET
  const sig = clockWindowDaily(gold, 'ny', 510, 540, 1, 0, nfpDates);
  const out0912 = clockWindowDaily(gold, 'ny', 540, 720, 1, 0, nfpDates);
  const fLeg = new Map<string, number>();
  for (const [day, s] of sig) {
    const o = out0912.get(day);
    if (o !== undefined && s !== 0) fLeg.set(day, Math.sign(s) * o - 2 * FRICTION_AU);
  }
  legs.set('F:Au-NFP-mom', fLeg);

  // J: US500 overnight (close 16:00 ET → next open 09:31 ET), the equity premium leg
  if (us500) {
    const marks = new Map<string, { open?: number; close?: number }>();
    for (const c of us500) {
      const d = new Date(c.timestamp + nyOffsetHours(c.timestamp) * 3_600_000);
      const lm = d.getUTCHours() * 60 + d.getUTCMinutes();
      const day = d.toISOString().slice(0, 10);
      let rec = marks.get(day);
      if (!rec) { rec = {}; marks.set(day, rec); }
      if (lm >= 565 && lm <= 575) rec.open = c.close;
      if (lm >= 955 && lm <= 965) rec.close = c.close;
    }
    const seq = [...marks.entries()].filter(([, r]) => r.open && r.close).sort((a, b) => a[0].localeCompare(b[0]));
    const jLeg = new Map<string, number>();
    for (let i = 0; i + 1 < seq.length; i++) {
      jLeg.set(seq[i + 1]![0], Math.log(seq[i + 1]![1].open! / seq[i]![1].close!) - 2 * 0.00005);
    }
    legs.set('J:US500-overnight', jLeg);
  }

  // K/L: Breedon-Ranaldo FX session legs (EUR depreciates in its home hours).
  // Friction 0.15bp/side (EURUSD spot majors tier).
  if (eurusd) {
    legs.set('K:EUR-morning-short', clockWindowDaily(eurusd, 'utc', 540, 720, -1, 0.000015));
    legs.set('L:EUR-h22-long', clockWindowDaily(eurusd, 'utc', 1320, 1380, 1, 0.000015));
  }

  return legs;
}

async function main(): Promise<void> {
  console.log('Loading metals 1m (2015–2026)...');
  const legs = await buildLegs();

  // Suitability: per-leg stats + halves stability
  const splitDate = '2020-01-01';
  console.log('\n=== Leg suitability (pre-registered rule: same sign both halves) ===');
  console.log('leg | n | total% | sharpe | h1% | h2% | SUITABLE?');
  const suitable: string[] = [];
  for (const [name, series] of legs) {
    const days = [...series.keys()].sort();
    const xs = days.map((d) => series.get(d)!);
    const h1 = days.filter((d) => d < splitDate).reduce((s, d) => s + series.get(d)!, 0);
    const h2 = days.filter((d) => d >= splitDate).reduce((s, d) => s + series.get(d)!, 0);
    const ok = h1 > 0 && h2 > 0;
    if (ok) suitable.push(name);
    console.log(`${name} | ${xs.length} | ${fmt(xs.reduce((s, x) => s + x, 0) * 100, 1)} | ${fmt(sharpe(xs))} | ${fmt(h1 * 100, 1)} | ${fmt(h2 * 100, 1)} | ${ok ? 'YES' : 'no'}`);
  }

  // Book: union dates, weights — overnight legs 0.5 each (capital-heavy), intraday legs 1.0 (1h windows)
  const weight = legWeight;
  const allDates = [...new Set([...legs.values()].flatMap((s) => [...s.keys()]))].sort();
  const series: Record<string, number[]> = {};
  for (const name of legs.keys()) {
    series[name] = allDates.map((d) => legs.get(name)!.get(d) ?? 0);
  }
  const book = (names: string[]): number[] =>
    allDates.map((_, i) => names.reduce((s, n) => s + weight(n) * series[n]![i]!, 0));

  const full = book(suitable);
  console.log(`\n=== BOOK (suitable legs only: ${suitable.join(', ')}) ===`);
  console.log(`  total=${fmt(full.reduce((s, x) => s + x, 0) * 100, 1)}% sharpe=${fmt(sharpe(full))} maxDD=${fmt(maxDD(full) * 100, 1)}%`);

  // Honest DSR: ~40 trials across the whole session's strategy search
  // (legs tried, windows probed, variants tested), fat tails accounted.
  {
    const m = mean(full); const sd = std(full);
    const skew = sd > 0 ? mean(full.map((x) => ((x - m) / sd) ** 3)) : 0;
    const kurt = sd > 0 ? mean(full.map((x) => ((x - m) / sd) ** 4)) : 3;
    const sr0 = sd > 0 ? m / sd : 0;
    const srVar = (1 + 0.5 * sr0 * sr0 - skew * sr0 + ((kurt - 3) / 4) * sr0 * sr0) / full.length;
    const trials = 40;
    const z1 = 1.6449, z2 = 2.1009; // invNorm(1-1/40), invNorm(1-1/(40e)) approx
    const haircut = Math.sqrt(srVar) * ((1 - 0.5772) * z1 + 0.5772 * z2) * Math.sqrt(252);
    console.log(`  DSR(${trials} trials): ${fmt(sharpe(full) - haircut)} (haircut ${fmt(haircut)}, skew ${fmt(skew)}, kurt ${fmt(kurt, 1)})`);
  }

  console.log('\n  Marginal contribution (book Sharpe without each leg):');
  for (const name of suitable) {
    const without = book(suitable.filter((n) => n !== name));
    console.log(`    −${name}: sharpe ${fmt(sharpe(without))} (Δ=${fmt(sharpe(full) - sharpe(without))})`);
  }

  console.log('\n  Correlations:');
  for (let i = 0; i < suitable.length; i++) {
    for (let j = i + 1; j < suitable.length; j++) {
      console.log(`    ${suitable[i]} × ${suitable[j]}: ${fmt(corr(series[suitable[i]!]!, series[suitable[j]!]!), 3)}`);
    }
  }

  const perYear = new Map<string, number>();
  for (let i = 0; i < allDates.length; i++) {
    const y = allDates[i]!.slice(0, 4);
    perYear.set(y, (perYear.get(y) ?? 0) + full[i]!);
  }
  console.log('\n  Per-year (book):');
  for (const [y, v] of [...perYear.entries()].sort()) console.log(`    ${y}: ${fmt(v * 100, 1)}%`);

  // Inverse-vol weighted book (descriptive: weights from full-sample leg vols)
  const ivWeights = new Map<string, number>();
  let ivSum = 0;
  for (const n of suitable) { const v = std(series[n]!); if (v > 0) { ivWeights.set(n, 1 / v); ivSum += 1 / v; } }
  const ivBook = allDates.map((_, i) => suitable.reduce((s, n) => s + (ivWeights.get(n)! / ivSum) * suitable.length * 0.6 * series[n]![i]!, 0));
  console.log(`\n  Inverse-vol book (scaled): total=${fmt(ivBook.reduce((s, x) => s + x, 0) * 100, 1)}% sharpe=${fmt(sharpe(ivBook))} maxDD=${fmt(maxDD(ivBook) * 100, 1)}%`);

  fs.writeFileSync(
    path.resolve(__dirname, '..', 'experiments', 'runs', 'combo-book.json'),
    JSON.stringify({ suitable, bookTotalPct: fmt(full.reduce((s, x) => s + x, 0) * 100, 1), bookSharpe: fmt(sharpe(full)), bookMaxDDPct: fmt(maxDD(full) * 100, 1) }, null, 2),
  );
}

if (require.main === module) {
  main().catch((err) => { console.error('Combo analysis failed:', err); process.exit(1); });
}
