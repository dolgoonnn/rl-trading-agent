#!/usr/bin/env tsx
/**
 * Calendar anomaly research:
 *  A. Gold turn-of-month (TDOM) on 21 years of daily data (GC_F_1d.json)
 *  B. Crypto hour-of-day / day-of-week on BTC/ETH/SOL 1h (~3yr each)
 *
 * Literature anchors: ToM documented for equities/metals (mixed for gold);
 * BTC best hours ~21:00–23:00 UTC, worst ~03:00–04:00 (Quantpedia; Baur et al. 2019).
 * Split-period stability reported for every cell.
 *
 * Output: console + experiments/runs/calendar-research.json
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function tStat(xs: number[]): number {
  const s = std(xs);
  return s > 0 ? mean(xs) / (s / Math.sqrt(xs.length)) : 0;
}
function statLine(xs: number[]): { n: number; meanBps: number; t: number; totalPct: number } {
  return {
    n: xs.length,
    meanBps: Math.round(mean(xs) * 1e6) / 100,
    t: Math.round(tStat(xs) * 100) / 100,
    totalPct: Math.round(xs.reduce((s, x) => s + x, 0) * 10000) / 100,
  };
}

// ---------------------------------------------------------------------------
// A. Gold turn-of-month
// ---------------------------------------------------------------------------

function goldTurnOfMonth(): Record<string, unknown> {
  const daily: Candle[] = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'data', 'GC_F_1d.json'), 'utf-8'),
  );

  // Trading-day-of-month indices: +1.. from start, -1.. from end
  interface DayRet { ts: number; ret: number; tdomFromStart: number; tdomFromEnd: number }
  const rets: DayRet[] = [];

  // Group indices by month
  const byMonth = new Map<string, number[]>();
  for (let i = 1; i < daily.length; i++) {
    const key = new Date(daily[i]!.timestamp).toISOString().slice(0, 7);
    let arr = byMonth.get(key);
    if (!arr) { arr = []; byMonth.set(key, arr); }
    arr.push(i);
  }
  for (const [, idxs] of byMonth) {
    for (let k = 0; k < idxs.length; k++) {
      const i = idxs[k]!;
      const prev = daily[i - 1]!;
      if (prev.close <= 0) continue;
      rets.push({
        ts: daily[i]!.timestamp,
        ret: Math.log(daily[i]!.close / prev.close),
        tdomFromStart: k + 1,
        tdomFromEnd: -(idxs.length - k),
      });
    }
  }

  const splitTs = Date.UTC(2016, 0, 1);
  const halves: Array<{ label: string; f: (r: DayRet) => boolean }> = [
    { label: '2005-15', f: (r) => r.ts < splitTs },
    { label: '2016-26', f: (r) => r.ts >= splitTs },
    { label: 'all', f: () => true },
  ];

  const cells: Record<string, Record<string, ReturnType<typeof statLine>>> = {};
  const defs: Array<{ name: string; f: (r: DayRet) => boolean }> = [
    { name: 'ToM window (-1..+3)', f: (r) => r.tdomFromEnd === -1 || (r.tdomFromStart >= 1 && r.tdomFromStart <= 3) },
    { name: 'last day (-1)', f: (r) => r.tdomFromEnd === -1 },
    { name: 'first day (+1)', f: (r) => r.tdomFromStart === 1 },
    { name: 'days +1..+3', f: (r) => r.tdomFromStart >= 1 && r.tdomFromStart <= 3 },
    { name: 'last 4 days (-4..-1)', f: (r) => r.tdomFromEnd >= -4 },
    { name: 'mid-month (+8..-8)', f: (r) => r.tdomFromStart > 7 && r.tdomFromEnd < -7 },
    { name: 'all days', f: () => true },
  ];

  console.log('=== A. Gold turn-of-month (GC_F daily, 2005–2026) ===');
  for (const d of defs) {
    cells[d.name] = {};
    const row: string[] = [];
    for (const h of halves) {
      const xs = rets.filter((r) => h.f(r) && d.f(r)).map((r) => r.ret);
      const s = statLine(xs);
      cells[d.name]![h.label] = s;
      row.push(`${h.label}: ${s.meanBps}bps/d t=${s.t} n=${s.n}`);
    }
    console.log(`  ${d.name}\n    ${row.join(' | ')}`);
  }
  return cells;
}

// ---------------------------------------------------------------------------
// B. Crypto hour-of-day / day-of-week (1h files)
// ---------------------------------------------------------------------------

function cryptoHourly(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  console.log('\n=== B. Crypto hour-of-day (UTC) / day-of-week — 1h data ===');

  const pooledByHour: number[][] = Array.from({ length: 24 }, () => []);
  const pooledByDow: number[][] = Array.from({ length: 7 }, () => []);

  for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
    const p = path.resolve(__dirname, '..', 'data', `${sym}_1h.json`);
    if (!fs.existsSync(p)) { console.log(`  ${sym}: no 1h data, skipped`); continue; }
    const candles: Candle[] = JSON.parse(fs.readFileSync(p, 'utf-8'));

    const byHour: number[][] = Array.from({ length: 24 }, () => []);
    const byDow: number[][] = Array.from({ length: 7 }, () => []);
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1]!;
      const c = candles[i]!;
      if (c.timestamp - prev.timestamp > 2 * 3_600_000) continue;
      const r = Math.log(c.close / prev.close);
      const d = new Date(c.timestamp);
      byHour[d.getUTCHours()]!.push(r);
      byDow[d.getUTCDay()]!.push(r);
      pooledByHour[d.getUTCHours()]!.push(r);
      pooledByDow[d.getUTCDay()]!.push(r);
    }

    const range = `${new Date(candles[0]!.timestamp).toISOString().slice(0, 10)}→${new Date(candles[candles.length - 1]!.timestamp).toISOString().slice(0, 10)}`;
    const hourStats = byHour.map((xs, h) => ({ hour: h, ...statLine(xs) }));
    const top = [...hourStats].sort((a, b) => b.t - a.t).slice(0, 3);
    const bottom = [...hourStats].sort((a, b) => a.t - b.t).slice(0, 3);
    console.log(`  ${sym} (${range}, ${candles.length.toLocaleString()} bars)`);
    console.log(`    best hours:  ${top.map((h) => `${h.hour}h ${h.meanBps}bps t=${h.t}`).join(' | ')}`);
    console.log(`    worst hours: ${bottom.map((h) => `${h.hour}h ${h.meanBps}bps t=${h.t}`).join(' | ')}`);
    out[sym] = { range, hourStats, dow: byDow.map((xs, d) => ({ dow: d, ...statLine(xs) })) };
  }

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  console.log('  POOLED (3 symbols):');
  const pooledHours = pooledByHour.map((xs, h) => ({ hour: h, ...statLine(xs) }));
  for (const h of pooledHours.filter((x) => Math.abs(x.t) >= 2)) {
    console.log(`    hour ${String(h.hour).padStart(2)}: ${h.meanBps}bps t=${h.t} total=${h.totalPct}%`);
  }
  const pooledDow = pooledByDow.map((xs, d) => ({ day: dayNames[d], ...statLine(xs) }));
  console.log(`    DoW: ${pooledDow.map((d) => `${d.day} ${d.meanBps}bps(t=${d.t})`).join(' | ')}`);
  out['pooled'] = { hours: pooledHours, dow: pooledDow };
  return out;
}

async function main(): Promise<void> {
  const tom = goldTurnOfMonth();
  const crypto = cryptoHourly();
  const outPath = path.resolve(__dirname, '..', 'experiments', 'runs', 'calendar-research.json');
  fs.writeFileSync(outPath, JSON.stringify({ goldTurnOfMonth: tom, crypto }, null, 2));
  console.log(`\nSaved → ${outPath}`);
}

main().catch((err) => {
  console.error('Calendar research failed:', err);
  process.exit(1);
});
