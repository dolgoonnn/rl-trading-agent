#!/usr/bin/env tsx
/**
 * Gold VWAP reversion (gold loop). Classic intraday: fade deviations from the
 * session (UTC-day) VWAP, bet on reversion to VWAP. Hold intraday, exit at VWAP
 * touch or EOD. Tests several deviation thresholds, IS 2020-26 + OOS 2015-19.
 * Judge on OOS net of cost. (Gold intraday autocorr≈0, so prior is weak.)
 */
import { readFileSync } from 'node:fs';

interface C { timestamp: number; open: number; high: number; low: number; close: number; volume: number }
const SPREAD_BP = Number(process.env.SPREAD_BP ?? 4);

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); }
function sharpe(xs: number[]): number { const s = std(xs); return s === 0 ? 0 : (mean(xs) / s) * Math.sqrt(252); }

function loadDays(file: string): C[][] {
  const m1 = JSON.parse(readFileSync(file, 'utf8')) as C[];
  const byDay = new Map<string, C[]>();
  for (const c of m1) { const d = new Date(c.timestamp).toISOString().slice(0, 10); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d)!.push(c); }
  return [...byDay.values()];
}

/** one trade/day: first time |price/VWAP-1| exceeds threshBp, fade to VWAP touch or EOD */
function run(days: C[][], threshBp: number): { n: number; netBp: number; netSharpe: number } {
  const net: number[] = [];
  for (const bars of days) {
    if (bars.length < 60) continue;
    let cumPV = 0, cumV = 0;
    let pos = 0, entry = 0;
    let dayRet: number | null = null;
    for (const b of bars) {
      const v = b.volume > 0 ? b.volume : 1;
      cumPV += b.close * v; cumV += v;
      const vwap = cumPV / cumV;
      if (pos === 0) {
        const dev = b.close / vwap - 1;
        if (dev > threshBp / 1e4) { pos = -1; entry = b.close; }       // above VWAP → short (fade)
        else if (dev < -threshBp / 1e4) { pos = 1; entry = b.close; }  // below VWAP → long
      } else {
        const touched = pos === 1 ? b.close >= vwap : b.close <= vwap;
        if (touched) { dayRet = pos * (b.close / entry - 1); break; }
      }
    }
    if (pos !== 0 && dayRet === null) dayRet = pos * (bars[bars.length - 1]!.close / entry - 1); // EOD exit
    if (dayRet !== null) net.push(dayRet - SPREAD_BP / 1e4);
  }
  return { n: net.length, netBp: mean(net) * 1e4, netSharpe: sharpe(net) };
}

const isDays = loadDays('data/XAUUSD_1m.json');
const oosDays = loadDays('data/XAUUSD_1m_holdout.json');
console.log(`Gold VWAP reversion — fade day-VWAP deviation, cost ${SPREAD_BP}bp RT · IS ${isDays.length}d / OOS ${oosDays.length}d\n`);
console.log('  threshBp | IS n | IS netBp | IS Sharpe | OOS n | OOS netBp | OOS Sharpe | survive?');
console.log('  ---------|------|----------|-----------|-------|-----------|------------|--------');
for (const th of [10, 20, 40, 80]) {
  const is = run(isDays, th), oos = run(oosDays, th);
  const surv = oos.netBp > 0 && oos.netSharpe > 0.5;
  console.log(`  ${String(th).padStart(8)} | ${String(is.n).padStart(4)} | ${is.netBp.toFixed(2).padStart(8)} | ${is.netSharpe.toFixed(2).padStart(9)} | ${String(oos.n).padStart(5)} | ${oos.netBp.toFixed(2).padStart(9)} | ${oos.netSharpe.toFixed(2).padStart(10)} | ${surv ? 'YES ✅' : 'no'}`);
}
console.log('\nSURVIVE = OOS netBp>0 AND OOS Sharpe>0.5.');
