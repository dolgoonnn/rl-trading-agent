#!/usr/bin/env tsx
/**
 * Gold intraday BATTERY (gold loop — breadth pass). Tests many distinct daily-
 * directional intraday hypotheses in one honest IS/OOS sweep. 1 trade/day,
 * hold-to-exit, realistic cost. Judge on OOS (2015-19 holdout), not IS.
 *
 * Sessions (UTC): Asian 00-07, London 07-12, NY 13-20. Day window 07-20.
 * Signals (each: a daily directional bet, exit at session close):
 *   S1 asianBO_cont   long break-dir of Asian range          (continuation)
 *   S2 asianBO_fade   fade the Asian-range break
 *   S3 overnight_mom  Asian-session return sign → day position (continuation)
 *   S4 overnight_rev  fade Asian-session return
 *   S5 priorday_mom   yesterday close-close sign → today
 *   S6 priorday_rev   fade yesterday
 *   S7 london_to_ny   London-session return sign → NY position
 *   S8 timeofday      always-long fixed strong-hours window (22-01 UTC)
 * Reports IS & OOS net Sharpe + netBp. SURVIVE = OOS netBp>0 AND OOS Sharpe>0.5.
 */
import { readFileSync } from 'node:fs';

interface C { timestamp: number; open: number; high: number; low: number; close: number }
const SPREAD_BP = Number(process.env.SPREAD_BP ?? 4);

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); }
function sharpe(xs: number[]): number { const s = std(xs); return s === 0 ? 0 : (mean(xs) / s) * Math.sqrt(252); }

interface Day { day: string; bars: C[] }
function loadDays(file: string): Day[] {
  const m1 = JSON.parse(readFileSync(file, 'utf8')) as C[];
  const byDay = new Map<string, C[]>();
  for (const c of m1) { const d = new Date(c.timestamp).toISOString().slice(0, 10); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d)!.push(c); }
  return [...byDay.entries()].map(([day, bars]) => ({ day, bars })).sort((a, b) => (a.day < b.day ? -1 : 1));
}
function hourBars(bars: C[], h0: number, h1: number): C[] { return bars.filter((b) => { const h = new Date(b.timestamp).getUTCHours(); return h >= h0 && h < h1; }); }
function sessRet(bars: C[]): number | null { if (bars.length < 5) return null; return bars[bars.length - 1]!.close / bars[0]!.open - 1; }

// each signal returns daily {dir, entry, exit} or null (no trade)
type Sig = (today: Day, prev: Day | null) => { dir: number; entry: number; exit: number } | null;
const SIGNALS: Record<string, Sig> = {
  S1_asianBO_cont: (t) => asianBreak(t, +1),
  S2_asianBO_fade: (t) => asianBreak(t, -1),
  S3_overnight_mom: (t) => sessionDir(t, +1),
  S4_overnight_rev: (t) => sessionDir(t, -1),
  S5_priorday_mom: (t, p) => priorDay(t, p, +1),
  S6_priorday_rev: (t, p) => priorDay(t, p, -1),
  S7_london_to_ny: (t) => londonToNy(t),
  S8_timeofday: (t) => timeOfDay(t),
};

function asianBreak(t: Day, sign: number): { dir: number; entry: number; exit: number } | null {
  const asian = hourBars(t.bars, 0, 7), win = hourBars(t.bars, 7, 20);
  if (asian.length < 30 || win.length < 30) return null;
  const hi = Math.max(...asian.map((b) => b.high)), lo = Math.min(...asian.map((b) => b.low));
  for (const b of win) { if (b.high >= hi) return { dir: sign * 1, entry: hi, exit: win[win.length - 1]!.close }; if (b.low <= lo) return { dir: sign * -1, entry: lo, exit: win[win.length - 1]!.close }; }
  return null;
}
function sessionDir(t: Day, sign: number): { dir: number; entry: number; exit: number } | null {
  const asian = hourBars(t.bars, 0, 7), win = hourBars(t.bars, 7, 20);
  const r = sessRet(asian); if (r === null || win.length < 30) return null;
  return { dir: sign * Math.sign(r), entry: win[0]!.open, exit: win[win.length - 1]!.close };
}
function priorDay(t: Day, p: Day | null, sign: number): { dir: number; entry: number; exit: number } | null {
  if (!p) return null; const pr = sessRet(p.bars), win = hourBars(t.bars, 7, 20);
  if (pr === null || win.length < 30) return null;
  return { dir: sign * Math.sign(pr), entry: win[0]!.open, exit: win[win.length - 1]!.close };
}
function londonToNy(t: Day): { dir: number; entry: number; exit: number } | null {
  const lon = hourBars(t.bars, 7, 12), ny = hourBars(t.bars, 13, 20);
  const r = sessRet(lon); if (r === null || ny.length < 20) return null;
  return { dir: Math.sign(r), entry: ny[0]!.open, exit: ny[ny.length - 1]!.close };
}
function timeOfDay(t: Day): { dir: number; entry: number; exit: number } | null {
  const w = t.bars.filter((b) => { const h = new Date(b.timestamp).getUTCHours(); return h >= 22 || h < 1; });
  if (w.length < 20) return null; return { dir: 1, entry: w[0]!.open, exit: w[w.length - 1]!.close };
}

function runSignal(days: Day[], sig: Sig): { n: number; netBp: number; netSharpe: number } {
  const net: number[] = [];
  for (let i = 0; i < days.length; i++) {
    const r = sig(days[i]!, i > 0 ? days[i - 1]! : null);
    if (!r || r.dir === 0 || r.entry <= 0) continue;
    const g = r.dir * (r.exit / r.entry - 1);
    net.push(g - SPREAD_BP / 1e4);
  }
  return { n: net.length, netBp: mean(net) * 1e4, netSharpe: sharpe(net) };
}

const isDays = loadDays('data/XAUUSD_1m.json');
const oosDays = loadDays('data/XAUUSD_1m_holdout.json');
console.log(`Gold intraday battery — cost ${SPREAD_BP}bp RT · IS ${isDays.length}d (20-26) / OOS ${oosDays.length}d (15-19)\n`);
console.log('  signal            | IS n | IS netBp | IS Sharpe | OOS n | OOS netBp | OOS Sharpe | survive?');
console.log('  ------------------|------|----------|-----------|-------|-----------|------------|--------');
for (const [name, sig] of Object.entries(SIGNALS)) {
  const is = runSignal(isDays, sig), oos = runSignal(oosDays, sig);
  const surv = oos.netBp > 0 && oos.netSharpe > 0.5;
  console.log(`  ${name.padEnd(17)} | ${String(is.n).padStart(4)} | ${is.netBp.toFixed(2).padStart(8)} | ${is.netSharpe.toFixed(2).padStart(9)} | ${String(oos.n).padStart(5)} | ${oos.netBp.toFixed(2).padStart(9)} | ${oos.netSharpe.toFixed(2).padStart(10)} | ${surv ? 'YES ✅' : 'no'}`);
}
console.log('\nSURVIVE = OOS netBp>0 AND OOS Sharpe>0.5 (judged on unseen 2015-19). Survivors get deep analysis.');
