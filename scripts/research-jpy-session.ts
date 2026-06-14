#!/usr/bin/env tsx
/**
 * Breedon-Ranaldo session effect on USDJPY (pre-registered, 4 windows only).
 *
 * Mechanism (Breedon & Ranaldo 2013): a currency DEPRECIATES during its own
 * market's trading hours (domestic institutional outflows). Validated on EUR
 * (leg K of the session book: EUR-morning short, Sharpe 0.9 at real costs).
 *
 * Pre-registered windows — signs fixed by the mechanism, NOT fitted:
 *   W1  long  USDJPY 00:00→06:00 UTC   (full Tokyo session — JPY home hours)
 *   W2  long  USDJPY 00:00→03:00 UTC   (Tokyo morning)
 *   W3  short USDJPY 09:00→16:00 NY    (full NY session — USD home hours, DST-aware)
 *   W4  short USDJPY 09:00→12:00 NY    (NY morning — mirrors the EUR result shape)
 *
 * Suitability rule (same as the session book): sign stable across
 * 2015–19 / 2020–26 halves. Frictions: 0.2bp and 0.35bp per side (majors tier).
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

/** Window log-return per local day (gross — friction applied by caller). */
function windowDaily(
  candles: Candle[],
  clock: 'utc' | 'ny',
  fromMin: number,
  toMin: number,
  sign: 1 | -1,
): Map<string, number> {
  const byDay = new Map<string, { a?: number; b?: number }>();
  for (const c of candles) {
    const local = c.timestamp + (clock === 'ny' ? nyOffsetHours(c.timestamp) : 0) * 3_600_000;
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
    if (rec.a !== undefined && rec.b !== undefined && rec.a > 0) {
      out.set(day, sign * Math.log(rec.b / rec.a));
    }
  }
  return out;
}

function main(): void {
  console.log('Loading USDJPY 1m (2015–2026)...');
  const candles: Candle[] = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'data', 'USDJPY_1m.json'), 'utf-8'),
  );

  const windows: Array<{ name: string; clock: 'utc' | 'ny'; from: number; to: number; sign: 1 | -1 }> = [
    { name: 'W1 long Tokyo 00-06 UTC', clock: 'utc', from: 0, to: 360, sign: 1 },
    { name: 'W2 long Tokyo 00-03 UTC', clock: 'utc', from: 0, to: 180, sign: 1 },
    { name: 'W3 short NY 09-16 local', clock: 'ny', from: 540, to: 960, sign: -1 },
    { name: 'W4 short NY 09-12 local', clock: 'ny', from: 540, to: 720, sign: -1 },
  ];
  const frictions = [0.00002, 0.000035]; // 0.2bp / 0.35bp per side

  console.log('\nwindow | n | gross t | gross total% | @0.2bp: sharpe/total% | @0.35bp: sharpe/total% | h1% | h2% | SUITABLE?');
  const results: Record<string, unknown>[] = [];
  for (const w of windows) {
    const series = windowDaily(candles, w.clock, w.from, w.to, w.sign);
    const days = [...series.keys()].sort();
    const gross = days.map((d) => series.get(d)!);
    const h1 = days.filter((d) => d < '2020-01-01').reduce((s, d) => s + series.get(d)!, 0);
    const h2 = days.filter((d) => d >= '2020-01-01').reduce((s, d) => s + series.get(d)!, 0);
    const nets = frictions.map((f) => gross.map((g) => g - 2 * f));
    const suitable = h1 > 0 && h2 > 0;
    console.log(
      `${w.name} | ${gross.length} | t=${fmt(tstat(gross))} | ${fmt(mean(gross) * gross.length * 100, 1)}% | ` +
      `${fmt(sharpe(nets[0]!))}/${fmt(nets[0]!.reduce((s, x) => s + x, 0) * 100, 1)}% | ` +
      `${fmt(sharpe(nets[1]!))}/${fmt(nets[1]!.reduce((s, x) => s + x, 0) * 100, 1)}% | ` +
      `${fmt(h1 * 100, 1)} | ${fmt(h2 * 100, 1)} | ${suitable ? 'YES' : 'no'}`,
    );
    results.push({
      window: w.name, n: gross.length, grossT: Math.round(tstat(gross) * 100) / 100,
      at02bp: { sharpe: Math.round(sharpe(nets[0]!) * 100) / 100 },
      at035bp: { sharpe: Math.round(sharpe(nets[1]!) * 100) / 100 },
      halves: { h1Pct: Math.round(h1 * 1000) / 10, h2Pct: Math.round(h2 * 1000) / 10 },
      suitable,
    });
  }

  const outPath = path.resolve(__dirname, '..', 'experiments', 'runs', 'jpy-session-results.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nSaved → ${outPath}`);
}

main();
