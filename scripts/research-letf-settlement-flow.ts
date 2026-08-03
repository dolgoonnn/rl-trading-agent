#!/usr/bin/env tsx
/**
 * LETF settlement-flow event study — Test 2 of the gold-scalp deep dig
 * (memory: gold-scalp-deep-dig-2026-08, candidate score 55).
 *
 * Mechanism (Todorov RoF 2024; BIS QR Mar-2026 Box C): leveraged metal ETFs
 * (AGQ/ZSL silver 2x/-2x, UGL/GLL gold) must rebalance daily by
 * AUM x (L^2-L) x r_day — a forced, price-INSENSITIVE flow executed against
 * the COMEX settlement (~13:25-13:30 ET), in the SAME direction as the day's
 * move. Prediction: on large |move-into-13:00| days, the 13:00->13:30 ET
 * settlement window shows signed CONTINUATION; multi-day reversal follows.
 *
 * Pass 1 (this script, $0): the flow FOOTPRINT test on existing spot 1m data
 * (XAUUSD/XAGUSD 2015-2026 — spot tracks futures at minute granularity).
 * Flow proxy = |prior-settle -> 13:00 ET return| deciles (AUM varies slowly,
 * so r_day dominates day-to-day flow variation). If the footprint exists,
 * pass 2 sharpens with real ProShares AUM series before any strategy code.
 *
 * Windows measured (verifier flagged the window as the main mis-spec risk):
 *   W1 13:00->13:25 ET (into silver settle)   W2 13:00->13:30 ET (gold settle)
 *   W3 13:30->15:00 ET (post-settle drift)    W4 15:30->16:00 ET (equity close)
 *   R1 next-day 13:30->13:30 reversal leg
 *
 * Decision rule (pre-registered in memory): edge lives only if top-decile
 * signed window return >= 2x Bybit round-trip cost (~11bp taker / ~4bp
 * maker+taker) with decile monotonicity, and holds in the 2024+ sub-sample.
 *
 * Usage: NODE_OPTIONS=--max-old-space-size=12288 npx tsx scripts/research-letf-settlement-flow.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';

// --- NY clock helpers (repo convention: duplicated per script, canonical
// form from analyze-combo-portfolio.ts) ---
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
function tstat(xs: number[]): number {
  const s = std(xs);
  return s > 0 ? (mean(xs) / (s / Math.sqrt(xs.length))) : 0;
}

/** Per-NY-day price marks: last close at/before each minute-of-day mark. */
const MARKS = { m1300: 780, m1325: 805, m1330: 810, m1500: 900, m1530: 930, m1600: 960 } as const;
type MarkKey = keyof typeof MARKS;

interface DayMarks { [k: string]: number | undefined }

function extractMarks(candles: Candle[]): Map<string, DayMarks> {
  const byDay = new Map<string, DayMarks>();
  for (const c of candles) {
    const local = c.timestamp + nyOffsetHours(c.timestamp) * 3_600_000;
    const d = new Date(local);
    const lm = d.getUTCHours() * 60 + d.getUTCMinutes();
    const day = d.toISOString().slice(0, 10);
    let rec = byDay.get(day);
    if (!rec) { rec = {}; byDay.set(day, rec); }
    for (const [k, m] of Object.entries(MARKS) as [MarkKey, number][]) {
      // last close at/before the mark, but not more than 30m stale
      if (lm <= m && lm > m - 30) rec[k] = c.close;
    }
  }
  return byDay;
}

interface EventRow {
  day: string;
  sig: number;        // prior-settle -> 13:00 ET log return (flow proxy direction+size)
  w1: number;         // signed 13:00->13:25 (sign(sig) applied)
  w2: number;         // signed 13:00->13:30
  w3: number;         // signed 13:30->15:00
  w4: number;         // signed 15:30->16:00
  r1: number | null;  // signed NEXT-day 13:30->13:30 (reversal leg: + means continuation)
}

function buildEvents(marks: Map<string, DayMarks>): EventRow[] {
  const days = [...marks.keys()].sort();
  const rows: EventRow[] = [];
  for (let i = 1; i < days.length; i++) {
    const prev = marks.get(days[i - 1]!)!;
    const cur = marks.get(days[i]!)!;
    const next = i + 1 < days.length ? marks.get(days[i + 1]!)! : undefined;
    if (!prev.m1330 || !cur.m1300 || !cur.m1325 || !cur.m1330 || !cur.m1500) continue;
    const sig = Math.log(cur.m1300 / prev.m1330);
    if (!isFinite(sig) || sig === 0) continue;
    const s = Math.sign(sig);
    rows.push({
      day: days[i]!,
      sig,
      w1: s * Math.log(cur.m1325 / cur.m1300),
      w2: s * Math.log(cur.m1330 / cur.m1300),
      w3: s * Math.log(cur.m1500 / cur.m1330),
      w4: cur.m1530 && cur.m1600 ? s * Math.log(cur.m1600 / cur.m1530) : 0,
      r1: next?.m1330 ? s * Math.log(next.m1330 / cur.m1330) : null,
    });
  }
  return rows;
}

/**
 * Close-anchored spec (corrected per BIS QR Mar-2026 / issuer mechanics:
 * LETF NAV strikes at 16:00 ET; hedge rebalancing executes in the FINAL
 * 30-60 minutes, not at the COMEX settle). Signal = prev 16:00 -> today
 * 15:00 (the flow is ~known by then); windows: V1 15:00->15:30 (early
 * rebalance/front-run), V2 15:30->16:00 (the rebalance print),
 * R1 next-day 16:00->16:00 (documented multi-day reversal).
 */
interface CloseEventRow { day: string; sig: number; v1: number; v2: number; v12: number; r1: number | null }

function buildCloseEvents(marks: Map<string, DayMarks>): CloseEventRow[] {
  const days = [...marks.keys()].sort();
  const rows: CloseEventRow[] = [];
  for (let i = 1; i < days.length; i++) {
    const prev = marks.get(days[i - 1]!)!;
    const cur = marks.get(days[i]!)!;
    const next = i + 1 < days.length ? marks.get(days[i + 1]!)! : undefined;
    if (!prev.m1600 || !cur.m1500 || !cur.m1530 || !cur.m1600) continue;
    // LETF flow exists only on US trading days — drop weekend "events" on
    // 24/7 instruments (no-op for metals/index data with no weekend bars).
    const dow = new Date(`${days[i]!}T12:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const sig = Math.log(cur.m1500 / prev.m1600);
    if (!isFinite(sig) || sig === 0) continue;
    const s = Math.sign(sig);
    rows.push({
      day: days[i]!,
      sig,
      v1: s * Math.log(cur.m1530 / cur.m1500),
      v2: s * Math.log(cur.m1600 / cur.m1530),
      v12: s * Math.log(cur.m1600 / cur.m1500),
      r1: next?.m1600 ? s * Math.log(next.m1600 / cur.m1600) : null,
    });
  }
  return rows;
}

function closeDecileReport(rows: CloseEventRow[], label: string): void {
  if (rows.length < 100) { console.log(`${label}: only ${rows.length} events — skipped`); return; }
  const sorted = [...rows].sort((a, b) => Math.abs(a.sig) - Math.abs(b.sig));
  const n = sorted.length;
  console.log(`\n--- CLOSE-ANCHORED ${label} (${n} events) ---`);
  console.log('decile |  |sig| bp | V1 15:00-30 bp (t) | V2 15:30-16 bp (t) | V1+V2 bp (t)       | R1 nextday bp (t)');
  for (let d = 0; d < 10; d++) {
    const lo = Math.floor((d * n) / 10);
    const hi = Math.floor(((d + 1) * n) / 10);
    const bucket = sorted.slice(lo, hi);
    const f = (xs: number[]): string => `${(mean(xs) * 1e4).toFixed(2).padStart(7)} (${tstat(xs).toFixed(1).padStart(4)})`;
    const r1s = bucket.map((r) => r.r1).filter((x): x is number => x !== null);
    console.log(
      `  ${d === 9 ? 'TOP' : ` ${d + 1} `}  | ${(mean(bucket.map((r) => Math.abs(r.sig))) * 1e4).toFixed(0).padStart(8)} | ${f(bucket.map((r) => r.v1))}     | ${f(bucket.map((r) => r.v2))}     | ${f(bucket.map((r) => r.v12))}     | ${f(r1s)}`,
    );
  }
  const top = sorted.slice(Math.floor(0.9 * n));
  const v12bp = mean(top.map((r) => r.v12)) * 1e4;
  console.log(`  TOP-decile V1+V2 = ${v12bp.toFixed(2)}bp vs cost bar 2x maker ~4bp / 2x taker ~11bp -> ${v12bp >= 4 ? (v12bp >= 11 ? 'CLEARS TAKER' : 'clears maker only') : 'FAILS'}`);
}

function decileReport(rows: EventRow[], label: string): void {
  if (rows.length < 100) { console.log(`${label}: only ${rows.length} events — skipped`); return; }
  const sorted = [...rows].sort((a, b) => Math.abs(a.sig) - Math.abs(b.sig));
  const n = sorted.length;
  console.log(`\n--- ${label} (${n} events) ---`);
  console.log('decile |  |sig| bp | W1 13:00-25 bp (t) | W2 13:00-30 bp (t) | W3 13:30-15 bp (t) | R1 nextday bp (t)');
  for (let d = 0; d < 10; d++) {
    const lo = Math.floor((d * n) / 10);
    const hi = Math.floor(((d + 1) * n) / 10);
    const bucket = sorted.slice(lo, hi);
    const f = (xs: number[]): string => `${(mean(xs) * 1e4).toFixed(2).padStart(7)} (${tstat(xs).toFixed(1).padStart(4)})`;
    const r1s = bucket.map((r) => r.r1).filter((x): x is number => x !== null);
    console.log(
      `  ${d === 9 ? 'TOP' : ` ${d + 1} `}  | ${(mean(bucket.map((r) => Math.abs(r.sig))) * 1e4).toFixed(0).padStart(8)} | ${f(bucket.map((r) => r.w1))}     | ${f(bucket.map((r) => r.w2))}     | ${f(bucket.map((r) => r.w3))}     | ${f(r1s)}`,
    );
  }
  // cost bar check on top decile
  const top = sorted.slice(Math.floor(0.9 * n));
  const w2bp = mean(top.map((r) => r.w2)) * 1e4;
  console.log(`  TOP-decile W2 = ${w2bp.toFixed(2)}bp vs cost bar 2x maker ~4bp / 2x taker ~11bp -> ${w2bp >= 4 ? (w2bp >= 11 ? 'CLEARS TAKER' : 'clears maker only') : 'FAILS'}`);
}

async function main(): Promise<void> {
  const load = (names: string[]): Candle[] => {
    let out: Candle[] = [];
    for (const nm of names) out = out.concat(JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', nm), 'utf-8')) as Candle[]);
    return out.sort((a, b) => a.timestamp - b.timestamp);
  };

  const universe = [
    { name: 'SILVER (XAGUSD — AGQ/ZSL flow, largest LETF share)', files: ['XAGUSD_1m_holdout.json', 'XAGUSD_1m.json'] },
    { name: 'GOLD (XAUUSD — UGL/GLL flow)', files: ['XAUUSD_1m_holdout.json', 'XAUUSD_1m.json'] },
    // US500: TQQQ/SQQQ/SPXL/SPXU etc — the largest LETF complex in the world.
    // Same 16:00 ET NAV-strike mechanism; heavily studied/arbed, so expect a
    // smaller per-event edge but far more qualifying events.
    { name: 'US500 (SPXL/SPXU/UPRO complex)', files: ['US500_1m.json'] },
    // BTC: BITX/BTCL 2x complexes (NAV strike 16:00 ET, hedged via CME/spot).
    // Bybit perp is the user's native venue — real 1bp maker costs.
    { name: 'BTC (BITX 2x complex, Bybit perp venue)', files: ['BTCUSDT_1m.json'] },
  ].filter((m) => m.files.every((f) => fs.existsSync(path.resolve(__dirname, '..', 'data', f))));

  for (const metal of universe) {
    console.log(`\n==================== ${metal.name} ====================`);
    const candles = load(metal.files);
    const marks = extractMarks(candles);
    const events = buildEvents(marks);
    console.log(`${events.length} events, ${marks.size} marked days`);

    decileReport(events, 'FULL 2015-2026');
    decileReport(events.filter((r) => r.day >= '2020-01-01'), '2020+');
    decileReport(events.filter((r) => r.day >= '2024-01-01'), '2024+ (post-AUM-boom — the regime that matters)');
    decileReport(events.filter((r) => r.day < '2020-01-01'), '2015-2019 holdout');

    const closeEvents = buildCloseEvents(marks);
    closeDecileReport(closeEvents, 'FULL 2015-2026');
    closeDecileReport(closeEvents.filter((r) => r.day >= '2020-01-01'), '2020+');
    closeDecileReport(closeEvents.filter((r) => r.day >= '2024-01-01'), '2024+ (post-AUM-boom)');
    closeDecileReport(closeEvents.filter((r) => r.day >= '2025-01-01'), '2025+ (AUM-doubled regime)');
    closeDecileReport(closeEvents.filter((r) => r.day < '2020-01-01'), '2015-2019 holdout');

    // Robustness: is the 2024+ top-decile effect a Jan/Feb-2026-crash artifact,
    // and how concentrated is it in a handful of events?
    closeDecileReport(
      closeEvents.filter((r) => r.day >= '2024-01-01' && !(r.day >= '2026-01-01' && r.day < '2026-03-01')),
      '2024+ EXCLUDING Jan-Feb 2026 (BIS crash episode)',
    );
    const recent = closeEvents.filter((r) => r.day >= '2024-01-01');
    const sortedR = [...recent].sort((a, b) => Math.abs(a.sig) - Math.abs(b.sig));
    const topR = sortedR.slice(Math.floor(0.9 * sortedR.length));
    const byYear = new Map<string, number[]>();
    for (const r of topR) {
      const y = r.day.slice(0, 4);
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y)!.push(r.v12);
    }
    console.log('\nTop-decile (2024+) V1+V2 by year:');
    for (const [y, xs] of [...byYear.entries()].sort()) {
      console.log(`  ${y}: n=${xs.length}, mean=${(mean(xs) * 1e4).toFixed(1)}bp, t=${tstat(xs).toFixed(1)}, hit=${((xs.filter((x) => x > 0).length / xs.length) * 100).toFixed(0)}%`);
    }
    const contrib = [...topR].sort((a, b) => b.v12 - a.v12);
    const total = contrib.reduce((s, r) => s + r.v12, 0);
    const top5 = contrib.slice(0, 5).reduce((s, r) => s + r.v12, 0);
    console.log(`Concentration: top-5 events = ${((top5 / total) * 100).toFixed(0)}% of total top-decile P&L (${contrib.length} events, sum ${(total * 1e4).toFixed(0)}bp)`);
    console.log(`Top-decile events with V1+V2 > 0: ${((topR.filter((r) => r.v12 > 0).length / topR.length) * 100).toFixed(0)}%`);
    console.log('Top 5 event days:', contrib.slice(0, 5).map((r) => `${r.day} (${(r.v12 * 1e4).toFixed(0)}bp)`).join(', '));
    console.log('Bottom 3 event days:', contrib.slice(-3).map((r) => `${r.day} (${(r.v12 * 1e4).toFixed(0)}bp)`).join(', '));
  }

  console.log('\nInterpretation guide: W1/W2 positive & monotone-increasing in decile = settlement');
  console.log('continuation footprint (the edge). R1 negative on top decile = the documented');
  console.log('multi-day reversal. W4 large instead of W1/W2 = flow prints at equity close, not settle.');
}

main().catch((err) => { console.error('letf-settlement-flow failed:', err); process.exit(1); });
