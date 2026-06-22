#!/usr/bin/env tsx
/**
 * ICT kill-zone claims, measured on 11.4 years of 1m gold (NY-clock, DST-aware).
 *
 * Windows (ET): Asian 18:00–02:00 · London KZ 02:00–05:00 · NY KZ 07:00–10:00 ·
 * Silver Bullet 10:00–11:00 · London Close 10:00–12:00 · PM 12:00–17:00.
 *
 * Claims tested (each: n, mean bps, t, win rate, split 2015-19/2020-26):
 *  U)  Unconditional drift + vol share per window
 *  C1) "NY continues London": sign(LondonKZ) → NYKZ return (signed by London dir)
 *  C2) "London fades Asia":   sign(Asian)    → LondonKZ return (signed by Asia dir)
 *  C3) Judas sweep: London KZ wicks through the Asian high(low) but closes the KZ
 *      back inside → fade trade (short/long) from KZ end to 17:00 ET
 *  C4) Silver Bullet drift conditional on NY KZ direction
 *
 * Sweeps/patterns are dead on gold unconditionally (gold-1m-research.md) — this
 * tests whether SESSION-ANCHORED conditioning rescues any of it.
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
function tStat(xs: number[]): number { const s = std(xs); return s > 0 ? mean(xs) / (s / Math.sqrt(xs.length)) : 0; }
function line(xs: number[]): string {
  if (!xs.length) return 'n=0';
  const wr = (xs.filter((x) => x > 0).length / xs.length) * 100;
  return `n=${xs.length} mean=${(mean(xs) * 1e4).toFixed(2)}bps t=${tStat(xs).toFixed(2)} wr=${wr.toFixed(1)}%`;
}

interface DayWindows {
  date: string;
  ts: number;
  asianRet?: number; asianHigh?: number; asianLow?: number;
  ldnRet?: number; ldnHigh?: number; ldnLow?: number; ldnClose?: number;
  nyRet?: number;
  sbRet?: number;
  pmCloseRet?: number; // KZ-end (05:00 ET) → 17:00 ET
}

function buildDays(candles: Candle[]): DayWindows[] {
  // NY-clock day map: minute-of-day → window membership
  const byDay = new Map<string, Candle[]>();
  for (const c of candles) {
    const off = nyOffsetHours(c.timestamp);
    const local = c.timestamp + off * 3_600_000;
    byDay.set(new Date(local).toISOString().slice(0, 10), (byDay.get(new Date(local).toISOString().slice(0, 10)) ?? []));
  }
  // second pass: actually push (avoid re-alloc patterns)
  for (const [, v] of byDay) v.length = 0;
  for (const c of candles) {
    const off = nyOffsetHours(c.timestamp);
    const local = c.timestamp + off * 3_600_000;
    byDay.get(new Date(local).toISOString().slice(0, 10))!.push(c);
  }

  const out: DayWindows[] = [];
  for (const [date, bars] of byDay) {
    if (bars.length < 600) continue;
    const win = (fromMin: number, toMin: number): Candle[] => bars.filter((c) => {
      const off = nyOffsetHours(c.timestamp);
      const d = new Date(c.timestamp + off * 3_600_000);
      const lm = d.getUTCHours() * 60 + d.getUTCMinutes();
      return lm >= fromMin && lm < toMin;
    });

    const ret = (xs: Candle[]): number | undefined =>
      xs.length >= 20 ? Math.log(xs[xs.length - 1]!.close / xs[0]!.open) : undefined;

    // Asian for THIS NY-day = 00:00–02:00 (18:00 prev day crosses date line; use 20:00–02:00 of overnight bars
    // — simpler robust proxy: bars 00:00–02:00 ET plus we take high/low over 18:00-prev unavailable; use 00:00–02:00)
    const asian = win(0, 120);
    const ldn = win(120, 300);
    const ny = win(420, 600);
    const sb = win(600, 660);
    const pm = win(300, 1020); // 05:00 → 17:00 ET

    const d: DayWindows = { date, ts: bars[0]!.timestamp };
    d.asianRet = ret(asian);
    if (asian.length >= 20) {
      d.asianHigh = Math.max(...asian.map((c) => c.high));
      d.asianLow = Math.min(...asian.map((c) => c.low));
    }
    d.ldnRet = ret(ldn);
    if (ldn.length >= 20) {
      d.ldnHigh = Math.max(...ldn.map((c) => c.high));
      d.ldnLow = Math.min(...ldn.map((c) => c.low));
      d.ldnClose = ldn[ldn.length - 1]!.close;
    }
    d.nyRet = ret(ny);
    d.sbRet = ret(sb);
    d.pmCloseRet = ret(pm);
    out.push(d);
  }
  return out.sort((a, b) => a.ts - b.ts);
}

async function main(): Promise<void> {
  console.log('Loading gold 1m (2015–2026)...');
  let candles: Candle[] = [];
  for (const f of ['XAUUSD_1m_holdout.json', 'XAUUSD_1m.json']) {
    candles = candles.concat(JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', f), 'utf-8')) as Candle[]);
  }
  candles.sort((a, b) => a.timestamp - b.timestamp);
  const days = buildDays(candles);
  console.log(`  ${days.length} NY-days\n`);

  const splitTs = Date.UTC(2020, 0, 1);
  const halves: Array<{ label: string; f: (d: DayWindows) => boolean }> = [
    { label: '2015-19', f: (d) => d.ts < splitTs },
    { label: '2020-26', f: (d) => d.ts >= splitTs },
    { label: 'all    ', f: () => true },
  ];

  // U) Unconditional
  console.log('=== U. Unconditional window drift ===');
  const windows: Array<{ name: string; get: (d: DayWindows) => number | undefined }> = [
    { name: 'Asian 00-02ET', get: (d) => d.asianRet },
    { name: 'LondonKZ 02-05ET', get: (d) => d.ldnRet },
    { name: 'NYKZ 07-10ET', get: (d) => d.nyRet },
    { name: 'SilverBullet 10-11ET', get: (d) => d.sbRet },
  ];
  for (const w of windows) {
    const row = halves.map((h) => `${h.label}: ${line(days.filter(h.f).map(w.get).filter((x): x is number => x !== undefined))}`);
    console.log(`  ${w.name}\n    ${row.join(' | ')}`);
  }

  // C1) NY continues London
  console.log('\n=== C1. sign(LondonKZ) → NYKZ (signed by London direction) ===');
  for (const h of halves) {
    const xs = days.filter(h.f)
      .filter((d) => d.ldnRet !== undefined && d.nyRet !== undefined && d.ldnRet !== 0)
      .map((d) => Math.sign(d.ldnRet!) * d.nyRet!);
    console.log(`  ${h.label}: ${line(xs)}`);
  }

  // C2) London fades Asia
  console.log('\n=== C2. sign(Asian) → LondonKZ (signed by Asia direction; negative mean = fade) ===');
  for (const h of halves) {
    const xs = days.filter(h.f)
      .filter((d) => d.asianRet !== undefined && d.ldnRet !== undefined && d.asianRet !== 0)
      .map((d) => Math.sign(d.asianRet!) * d.ldnRet!);
    console.log(`  ${h.label}: ${line(xs)}`);
  }

  // C3) Judas sweep of the Asian extreme during London KZ → fade to 17:00 ET
  console.log('\n=== C3. Judas sweep (LondonKZ wicks Asian extreme, closes back inside) → fade 05:00→17:00 ET ===');
  for (const h of halves) {
    const xs: number[] = [];
    for (const d of days.filter(h.f)) {
      if (d.asianHigh === undefined || d.ldnHigh === undefined || d.ldnClose === undefined || d.pmCloseRet === undefined) continue;
      const sweptHigh = d.ldnHigh > d.asianHigh && d.ldnClose < d.asianHigh;
      const sweptLow = d.ldnLow! < d.asianLow! && d.ldnClose > d.asianLow!;
      if (sweptHigh === sweptLow) continue; // neither or both — skip
      // Fade: swept high → short rest of day; swept low → long
      xs.push(sweptHigh ? -d.pmCloseRet : d.pmCloseRet);
    }
    console.log(`  ${h.label}: ${line(xs)}`);
  }

  // C4) Silver Bullet conditional on NY KZ direction
  console.log('\n=== C4. sign(NYKZ) → SilverBullet (signed by NYKZ direction) ===');
  for (const h of halves) {
    const xs = days.filter(h.f)
      .filter((d) => d.nyRet !== undefined && d.sbRet !== undefined && d.nyRet !== 0)
      .map((d) => Math.sign(d.nyRet!) * d.sbRet!);
    console.log(`  ${h.label}: ${line(xs)}`);
  }
}

main().catch((err) => { console.error('Kill-zone research failed:', err); process.exit(1); });
