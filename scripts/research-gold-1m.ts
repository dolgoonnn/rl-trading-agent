#!/usr/bin/env tsx
/**
 * Exploratory research on 1m XAUUSD — where does gold's drift/volatility live?
 *
 * Per experiments/KNOWLEDGE.md §7: before any new strategy, establish whether
 * GROSS conditional structure exists. This script measures:
 *
 *  1. Hour-of-day return decomposition (UTC) — mean drift, vol, share of total
 *     return per hour, with per-year stability. Tests the documented
 *     "gold drift concentrates outside US hours / around London fix" anomaly.
 *  2. Day-of-week drift.
 *  3. Asian range (00–07 UTC) breakout follow-through: continuation vs
 *     reversal stats from first breakout to NY close.
 *  4. Sweep forward returns: after a swing-low/high sweep (same detector as
 *     sweep_choch), forward return at +15/30/60/240 min, split by direction,
 *     session, and daily EMA trend bias.
 *
 * Output: console report + experiments/runs/gold-1m-research.json
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';
import { detectSwingLows, detectSwingHighs } from '../src/lib/ict/market-structure';

const DATA_PATH = path.resolve(__dirname, '..', 'data', 'XAUUSD_1m.json');
const OUT_PATH = path.resolve(__dirname, '..', 'experiments', 'runs', 'gold-1m-research.json');

const MIN_MS = 60_000;

interface HourStat {
  hour: number;
  bars: number;
  meanRetBps: number;     // mean 1m log return ×1e4, within this hour
  totalRetPct: number;    // cumulative log return contribution of this hour, %
  volBps: number;         // std of 1m returns, bps
  perYearTotalPct: Record<string, number>;
}

function logRet(a: number, b: number): number {
  return Math.log(b / a);
}

function pct(x: number): number {
  return Math.round(x * 10000) / 100; // fraction → % with 2dp
}

function bps(x: number): number {
  return Math.round(x * 1e6) / 100; // fraction → bps with 2dp
}

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
  return s > 0 ? (mean(xs) / (s / Math.sqrt(xs.length))) : 0;
}

// ---------------------------------------------------------------------------
// 1+2. Hour-of-day / day-of-week decomposition
// ---------------------------------------------------------------------------

function hourOfDayStats(candles: Candle[]): { hours: HourStat[]; dow: Array<{ day: string; totalRetPct: number; bars: number }> } {
  const byHour: number[][] = Array.from({ length: 24 }, () => []);
  const byHourYear = new Map<string, number>();
  const byDow: number[][] = Array.from({ length: 7 }, () => []);

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    // Only intra-continuous returns: skip across gaps > 5 min (weekends, halts)
    if (c.timestamp - prev.timestamp > 5 * MIN_MS) continue;
    const r = logRet(prev.close, c.close);
    const d = new Date(c.timestamp);
    const h = d.getUTCHours();
    byHour[h]!.push(r);
    byDow[d.getUTCDay()]!.push(r);
    const key = `${h}|${d.getUTCFullYear()}`;
    byHourYear.set(key, (byHourYear.get(key) ?? 0) + r);
  }

  const years = [...new Set(candles.map((c) => new Date(c.timestamp).getUTCFullYear()))].sort();

  const hours: HourStat[] = byHour.map((rets, hour) => {
    const perYear: Record<string, number> = {};
    for (const y of years) {
      perYear[String(y)] = pct(byHourYear.get(`${hour}|${y}`) ?? 0);
    }
    return {
      hour,
      bars: rets.length,
      meanRetBps: bps(mean(rets)),
      totalRetPct: pct(rets.reduce((s, r) => s + r, 0)),
      volBps: bps(std(rets)),
      perYearTotalPct: perYear,
    };
  });

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dow = byDow.map((rets, d) => ({
    day: dayNames[d]!,
    totalRetPct: pct(rets.reduce((s, r) => s + r, 0)),
    bars: rets.length,
  }));

  return { hours, dow };
}

// ---------------------------------------------------------------------------
// 3. Asian range breakout follow-through
// ---------------------------------------------------------------------------

interface AsianDayResult {
  brokeDirection: 'up' | 'down' | 'none';
  retBreakToNyCloseBps: number; // signed in breakout direction
  rangePct: number;
}

function asianRangeStats(candles: Candle[]): {
  days: number;
  brokeUp: number;
  brokeDown: number;
  noBreak: number;
  continuationWinRateUp: number;
  continuationWinRateDown: number;
  meanFollowUpBps: number;
  meanFollowDownBps: number;
  tUp: number;
  tDown: number;
  byRangeTercile: Array<{ tercile: string; n: number; meanFollowBps: number; winRate: number }>;
} {
  // Group bars by UTC day
  const byDay = new Map<string, Candle[]>();
  for (const c of candles) {
    const key = new Date(c.timestamp).toISOString().slice(0, 10);
    let arr = byDay.get(key);
    if (!arr) { arr = []; byDay.set(key, arr); }
    arr.push(c);
  }

  const results: AsianDayResult[] = [];

  for (const [, bars] of byDay) {
    const asian = bars.filter((c) => { const h = new Date(c.timestamp).getUTCHours(); return h >= 0 && h < 7; });
    const rest = bars.filter((c) => { const h = new Date(c.timestamp).getUTCHours(); return h >= 7 && h < 21; });
    if (asian.length < 200 || rest.length < 400) continue; // skip partial days

    const hi = Math.max(...asian.map((c) => c.high));
    const lo = Math.min(...asian.map((c) => c.low));
    const mid = (hi + lo) / 2;
    const rangePct = (hi - lo) / mid;

    let brokeDirection: 'up' | 'down' | 'none' = 'none';
    let breakClose = 0;
    for (const c of rest) {
      if (c.close > hi) { brokeDirection = 'up'; breakClose = c.close; break; }
      if (c.close < lo) { brokeDirection = 'down'; breakClose = c.close; break; }
    }

    if (brokeDirection === 'none') {
      results.push({ brokeDirection, retBreakToNyCloseBps: 0, rangePct });
      continue;
    }

    const nyClose = rest[rest.length - 1]!.close;
    const raw = logRet(breakClose, nyClose);
    const signed = brokeDirection === 'up' ? raw : -raw;
    results.push({ brokeDirection, retBreakToNyCloseBps: signed * 1e4, rangePct });
  }

  const ups = results.filter((r) => r.brokeDirection === 'up');
  const downs = results.filter((r) => r.brokeDirection === 'down');
  const broke = results.filter((r) => r.brokeDirection !== 'none');

  // Range terciles (does a tight Asian range predict better follow-through?)
  const sorted = [...broke].sort((a, b) => a.rangePct - b.rangePct);
  const terciles: Array<{ tercile: string; n: number; meanFollowBps: number; winRate: number }> = [];
  const labels = ['tight', 'mid', 'wide'];
  for (let t = 0; t < 3; t++) {
    const slice = sorted.slice(Math.floor((t * sorted.length) / 3), Math.floor(((t + 1) * sorted.length) / 3));
    terciles.push({
      tercile: labels[t]!,
      n: slice.length,
      meanFollowBps: Math.round(mean(slice.map((r) => r.retBreakToNyCloseBps)) * 100) / 100,
      winRate: Math.round((slice.filter((r) => r.retBreakToNyCloseBps > 0).length / Math.max(1, slice.length)) * 1000) / 10,
    });
  }

  return {
    days: results.length,
    brokeUp: ups.length,
    brokeDown: downs.length,
    noBreak: results.length - broke.length,
    continuationWinRateUp: Math.round((ups.filter((r) => r.retBreakToNyCloseBps > 0).length / Math.max(1, ups.length)) * 1000) / 10,
    continuationWinRateDown: Math.round((downs.filter((r) => r.retBreakToNyCloseBps > 0).length / Math.max(1, downs.length)) * 1000) / 10,
    meanFollowUpBps: Math.round(mean(ups.map((r) => r.retBreakToNyCloseBps)) * 100) / 100,
    meanFollowDownBps: Math.round(mean(downs.map((r) => r.retBreakToNyCloseBps)) * 100) / 100,
    tUp: Math.round(tStat(ups.map((r) => r.retBreakToNyCloseBps)) * 100) / 100,
    tDown: Math.round(tStat(downs.map((r) => r.retBreakToNyCloseBps)) * 100) / 100,
    byRangeTercile: terciles,
  };
}

// ---------------------------------------------------------------------------
// 4. Sweep forward returns (conditional information content)
// ---------------------------------------------------------------------------

interface SweepEvent {
  index: number;
  direction: 'long' | 'short'; // long = swept a swing LOW and closed back above
  hour: number;
  dailyBias: 'up' | 'down';
  fwd: Record<string, number>; // signed bps in trade direction at each horizon
}

function dailyEmaBias(candles: Candle[], lambda = 0.95): Map<string, 'up' | 'down'> {
  // Daily closes → EMA; bias for day D uses data through D-1 (no look-ahead)
  const dayClose = new Map<string, number>();
  for (const c of candles) {
    dayClose.set(new Date(c.timestamp).toISOString().slice(0, 10), c.close);
  }
  const days = [...dayClose.keys()].sort();
  const bias = new Map<string, 'up' | 'down'>();
  let ema: number | null = null;
  let prevEma: number | null = null;
  for (let i = 0; i < days.length; i++) {
    const day = days[i]!;
    if (ema !== null) bias.set(day, (prevEma !== null && ema >= prevEma) ? 'up' : 'down');
    const close = dayClose.get(day)!;
    prevEma = ema;
    ema = ema === null ? close : lambda * ema + (1 - lambda) * close;
  }
  return bias;
}

function sweepForwardStats(candles: Candle[]): {
  events: number;
  byGroup: Array<{
    group: string;
    n: number;
    horizons: Record<string, { meanBps: number; winRate: number; t: number }>;
  }>;
} {
  const HORIZONS = [15, 30, 60, 240];
  const SWING_LOOKBACK = 3;
  const WINDOW = 200;
  const STRIDE_SKIP_AFTER_EVENT = 10; // avoid double counting overlapping sweeps

  const biasByDay = dailyEmaBias(candles);
  const events: SweepEvent[] = [];

  let lastEventIndex = -999;

  for (let i = WINDOW; i < candles.length - 250; i++) {
    if (i - lastEventIndex < STRIDE_SKIP_AFTER_EVENT) continue;
    const current = candles[i]!;
    // Continuous data only (no weekend-crossing forward windows)
    if (candles[i + 240]!.timestamp - current.timestamp > 300 * MIN_MS) continue;

    const slice = candles.slice(i - WINDOW, i + 1);
    const cfg = { lookback: SWING_LOOKBACK, minStrength: 1 };
    const lows = detectSwingLows(slice, cfg);
    const highs = detectSwingHighs(slice, cfg);
    const localCurrent = slice.length - 1;

    let direction: 'long' | 'short' | null = null;

    for (let k = lows.length - 1; k >= 0; k--) {
      const sw = lows[k]!;
      if (sw.index >= localCurrent) continue;
      if (current.low < sw.price && current.close > sw.price) {
        let untouched = true;
        for (let j = sw.index + 1; j < localCurrent; j++) {
          if (slice[j]!.low < sw.price) { untouched = false; break; }
        }
        if (untouched) direction = 'long';
      }
      break;
    }
    if (!direction) {
      for (let k = highs.length - 1; k >= 0; k--) {
        const sw = highs[k]!;
        if (sw.index >= localCurrent) continue;
        if (current.high > sw.price && current.close < sw.price) {
          let untouched = true;
          for (let j = sw.index + 1; j < localCurrent; j++) {
            if (slice[j]!.high > sw.price) { untouched = false; break; }
          }
          if (untouched) direction = 'short';
        }
        break;
      }
    }
    if (!direction) continue;

    const day = new Date(current.timestamp).toISOString().slice(0, 10);
    const bias = biasByDay.get(day);
    if (!bias) continue;

    const fwd: Record<string, number> = {};
    for (const h of HORIZONS) {
      const exit = candles[i + h]!;
      const raw = logRet(current.close, exit.close);
      fwd[String(h)] = (direction === 'long' ? raw : -raw) * 1e4;
    }

    events.push({ index: i, direction, hour: new Date(current.timestamp).getUTCHours(), dailyBias: bias, fwd });
    lastEventIndex = i;
  }

  // Group: direction × session × bias alignment
  const groups = new Map<string, SweepEvent[]>();
  const sessionOf = (h: number): string => (h >= 7 && h < 21 ? 'LDN/NY' : 'Asia');
  for (const e of events) {
    const aligned = (e.direction === 'long') === (e.dailyBias === 'up') ? 'with-trend' : 'counter-trend';
    for (const g of [
      `all|${e.direction}`,
      `${sessionOf(e.hour)}|${e.direction}`,
      `${aligned}|${e.direction}`,
      `${aligned}|both`,
    ]) {
      let arr = groups.get(g);
      if (!arr) { arr = []; groups.set(g, arr); }
      arr.push(e);
    }
  }

  const byGroup = [...groups.entries()].map(([group, evs]) => {
    const horizons: Record<string, { meanBps: number; winRate: number; t: number }> = {};
    for (const h of ['15', '30', '60', '240']) {
      const xs = evs.map((e) => e.fwd[h]!);
      horizons[h] = {
        meanBps: Math.round(mean(xs) * 100) / 100,
        winRate: Math.round((xs.filter((x) => x > 0).length / xs.length) * 1000) / 10,
        t: Math.round(tStat(xs) * 100) / 100,
      };
    }
    return { group, n: evs.length, horizons };
  }).sort((a, b) => a.group.localeCompare(b.group));

  return { events: events.length, byGroup };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dataArgIdx = process.argv.indexOf('--data');
  const dataPath = dataArgIdx !== -1 && process.argv[dataArgIdx + 1]
    ? path.resolve(process.cwd(), process.argv[dataArgIdx + 1]!)
    : DATA_PATH;
  console.log(`Loading ${path.basename(dataPath)}...`);
  const candles: Candle[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  console.log(`  ${candles.length.toLocaleString()} candles, ${new Date(candles[0]!.timestamp).toISOString().slice(0, 10)} → ${new Date(candles[candles.length - 1]!.timestamp).toISOString().slice(0, 10)}\n`);

  console.log('1) Hour-of-day decomposition...');
  const { hours, dow } = hourOfDayStats(candles);
  const totalRet = hours.reduce((s, h) => s + h.totalRetPct, 0);
  console.log(`   Total close-to-close log return captured: ${totalRet.toFixed(1)}%`);
  console.log('   hour | bars     | mean(bps) | vol(bps) | total% | per-year stability');
  for (const h of hours) {
    const years = Object.entries(h.perYearTotalPct);
    const posYears = years.filter(([, v]) => v > 0).length;
    console.log(
      `   ${String(h.hour).padStart(4)} | ${String(h.bars).padStart(8)} | ${String(h.meanRetBps).padStart(9)} | ${String(h.volBps).padStart(8)} | ${String(h.totalRetPct).padStart(6)} | ${posYears}/${years.length} yrs positive`,
    );
  }

  console.log('\n2) Day-of-week totals:');
  for (const d of dow) console.log(`   ${d.day}: ${d.totalRetPct}% (${d.bars.toLocaleString()} bars)`);

  console.log('\n3) Asian range (00-07 UTC) breakout follow-through to NY close...');
  const asian = asianRangeStats(candles);
  console.log(JSON.stringify(asian, null, 2));

  console.log('\n4) Sweep forward returns (sweep_choch detector, conditioned)...');
  const sweeps = sweepForwardStats(candles);
  console.log(`   events: ${sweeps.events.toLocaleString()}`);
  console.log('   group | n | h15 | h30 | h60 | h240 (meanBps / WR% / t)');
  for (const g of sweeps.byGroup) {
    const f = (h: string) => `${g.horizons[h]!.meanBps}/${g.horizons[h]!.winRate}/${g.horizons[h]!.t}`;
    console.log(`   ${g.group} | n=${g.n} | ${f('15')} | ${f('30')} | ${f('60')} | ${f('240')}`);
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({ hours, dow, asian, sweeps }, null, 2));
  console.log(`\nSaved → ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('Research failed:', err);
  process.exit(1);
});
