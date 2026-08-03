#!/usr/bin/env tsx
/**
 * LETF close-flow PASS 2 — real AUM flow ranking (replaces the |move| proxy).
 *
 * Data: ProShares official daily NAV/SO/AUM CSVs (data/proshares/{AGQ,ZSL,
 * UGL,GLL}.csv, back to 2008-12, free via accounts.profunds.com).
 *
 * Mechanism-true signal at 15:00 ET decision time:
 *   flow$(t) = [2 x AUM_2x(t-1) + 6 x AUM_-2x(t-1)] x sig(t)
 * where sig = log(P15:00 / prev P16:00) and (L^2-L) = 2 for L=2, 6 for L=-2
 * (inverse funds rebalance 3x harder per AUM dollar). AUM is LAGGED one day —
 * yesterday's print is the latest known at today's decision time.
 *
 * Tests:
 *   A. Decile table on |flow$| — same shape as the |sig| study, so the two
 *      rankings are directly comparable.
 *   B. Dollar-threshold rule grid (|flow| >= $25/50/100/200M), per-year.
 *   C. Head-to-head on 2024+: deployed p95-|sig| rule vs flow-threshold rule.
 *
 * Usage: NODE_OPTIONS=--max-old-space-size=12288 npx tsx scripts/research-letf-aum-flow.ts
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
function tstat(xs: number[]): number { const s = std(xs); return s > 0 ? mean(xs) / (s / Math.sqrt(xs.length)) : 0; }
function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
}

/** date(ISO) -> AUM, from a ProShares historical_nav.csv */
function loadAUM(fund: string): Map<string, number> {
  const raw = fs.readFileSync(path.resolve(__dirname, '..', 'data', 'proshares', `${fund}.csv`), 'utf-8');
  const out = new Map<string, number>();
  for (const line of raw.split('\n').slice(1)) {
    const cols = line.split(',');
    if (cols.length < 9) continue;
    const [mo, dy, yr] = cols[0]!.split('/');
    if (!mo || !dy || !yr) continue;
    const aum = parseFloat(cols[8]!);
    if (isFinite(aum) && aum > 0) out.set(`${yr}-${mo.padStart(2, '0')}-${dy.padStart(2, '0')}`, aum);
  }
  return out;
}

/** Latest AUM print strictly BEFORE the given day (no lookahead). */
function lagged(aum: Map<string, number>, sortedDates: string[], day: string): number | null {
  // binary search would be nicer; linear from a moving pointer is fine at this scale
  let best: number | null = null;
  for (const d of sortedDates) {
    if (d >= day) break;
    best = aum.get(d)!;
  }
  return best;
}

interface DayMarks { m1500?: number; m1530?: number; m1600?: number }

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
    if (lm <= 930 && lm > 900) rec.m1530 = c.close;
    if (lm <= 960 && lm > 930) rec.m1600 = c.close;
  }
  return byDay;
}

interface FlowEvent { day: string; sig: number; flowUsd: number; v12: number }

function buildEvents(candles: Candle[], longAUM: Map<string, number>, shortAUM: Map<string, number>): FlowEvent[] {
  const marks = extractMarks(candles);
  const days = [...marks.keys()].sort();
  const longDates = [...longAUM.keys()].sort();
  const shortDates = [...shortAUM.keys()].sort();
  const rows: FlowEvent[] = [];
  let prev1600: number | undefined;
  for (const day of days) {
    const rec = marks.get(day)!;
    if (prev1600 && rec.m1500 && rec.m1600) {
      const sig = Math.log(rec.m1500 / prev1600);
      const aL = lagged(longAUM, longDates, day);
      const aS = lagged(shortAUM, shortDates, day);
      if (isFinite(sig) && sig !== 0 && aL !== null && aS !== null) {
        rows.push({
          day,
          sig,
          flowUsd: (2 * aL + 6 * aS) * sig,
          v12: Math.sign(sig) * Math.log(rec.m1600 / rec.m1500),
        });
      }
    }
    if (rec.m1600) prev1600 = rec.m1600;
  }
  return rows;
}

function decileReport(rows: FlowEvent[], key: (r: FlowEvent) => number, label: string): void {
  if (rows.length < 100) { console.log(`${label}: only ${rows.length} events — skipped`); return; }
  const sorted = [...rows].sort((a, b) => Math.abs(key(a)) - Math.abs(key(b)));
  const n = sorted.length;
  console.log(`\n--- ${label} (${n} events) ---`);
  console.log('decile | median |flow$|M | V1+V2 bp (t)    | hit%');
  for (let d = 0; d < 10; d++) {
    const bucket = sorted.slice(Math.floor((d * n) / 10), Math.floor(((d + 1) * n) / 10));
    const flows = bucket.map((r) => Math.abs(r.flowUsd) / 1e6).sort((a, b) => a - b);
    const v = bucket.map((r) => r.v12);
    console.log(
      `  ${d === 9 ? 'TOP' : ` ${d + 1} `}  | ${flows[Math.floor(flows.length / 2)]!.toFixed(0).padStart(15)} | ${(mean(v) * 1e4).toFixed(2).padStart(7)} (${tstat(v).toFixed(1).padStart(4)}) | ${((v.filter((x) => x > 0).length / v.length) * 100).toFixed(0)}%`,
    );
  }
}

function thresholdGrid(rows: FlowEvent[], label: string, costRT = 0.0004): void {
  console.log(`\n--- ${label}: |flow| dollar-threshold rule (cost ${(costRT * 1e4).toFixed(0)}bp RT) ---`);
  for (const thrM of [25, 50, 100, 200]) {
    const trades = rows.filter((r) => Math.abs(r.flowUsd) >= thrM * 1e6);
    if (!trades.length) { console.log(`  >=$${thrM}M: 0 trades`); continue; }
    const nets = trades.map((r) => r.v12 - costRT);
    const byYear = new Map<string, number[]>();
    for (const t of trades) {
      const y = t.day.slice(0, 4);
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y)!.push(t.v12 - costRT);
    }
    const yearStr = [...byYear.entries()].sort().map(([y, xs]) => `${y}:${(mean(xs) * 1e4).toFixed(0)}bp/${xs.length}`).join(' ');
    console.log(
      `  >=$${String(thrM).padStart(3)}M: n=${String(trades.length).padStart(4)}, mean ${(mean(nets) * 1e4).toFixed(1)}bp (t=${tstat(nets).toFixed(1)}), hit ${((nets.filter((x) => x > 0).length / nets.length) * 100).toFixed(0)}%  | ${yearStr}`,
    );
  }
}

async function main(): Promise<void> {
  const load = (names: string[]): Candle[] => {
    let out: Candle[] = [];
    for (const nm of names) out = out.concat(JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', nm), 'utf-8')) as Candle[]);
    return out.sort((a, b) => a.timestamp - b.timestamp);
  };

  const metals = [
    { name: 'SILVER', files: ['XAGUSD_1m_holdout.json', 'XAGUSD_1m.json'], long: 'AGQ', short: 'ZSL' },
    { name: 'GOLD', files: ['XAUUSD_1m_holdout.json', 'XAUUSD_1m.json'], long: 'UGL', short: 'GLL' },
  ];

  for (const m of metals) {
    console.log(`\n==================== ${m.name} (${m.long}/${m.short}, lagged AUM x (L^2-L) x sig) ====================`);
    const events = buildEvents(load(m.files), loadAUM(m.long), loadAUM(m.short));
    console.log(`${events.length} events ${events[0]?.day} → ${events.at(-1)?.day}`);

    // A. flow-ranked vs sig-ranked deciles, same event set
    decileReport(events.filter((r) => r.day >= '2024-01-01'), (r) => r.flowUsd, '2024+ ranked by |FLOW$|');
    decileReport(events.filter((r) => r.day >= '2024-01-01'), (r) => r.sig, '2024+ ranked by |SIG| (baseline)');
    decileReport(events, (r) => r.flowUsd, 'FULL ranked by |FLOW$|');

    // B. dollar-threshold grid
    thresholdGrid(events.filter((r) => r.day >= '2024-01-01'), '2024+');
    thresholdGrid(events.filter((r) => r.day >= '2020-01-01' && r.day < '2024-01-01'), '2020-2023 (pre-boom check)');

    // C. head-to-head: deployed p95-|sig| rule (rolling 250d) vs $100M flow rule, 2024+
    const absHist: number[] = [];
    const p95Trades: number[] = [];
    for (const r of events) {
      if (absHist.length >= 250) {
        const thr = quantile(absHist.slice(-250), 0.95);
        if (Math.abs(r.sig) >= thr && r.day >= '2024-01-01') p95Trades.push(r.v12 - 0.0004);
      }
      absHist.push(Math.abs(r.sig));
    }
    console.log(`\n  HEAD-TO-HEAD 2024+: p95-|sig| rule n=${p95Trades.length}, mean ${(mean(p95Trades) * 1e4).toFixed(1)}bp (t=${tstat(p95Trades).toFixed(1)})`);
  }
}

main().catch((err) => { console.error('letf-aum-flow failed:', err); process.exit(1); });
