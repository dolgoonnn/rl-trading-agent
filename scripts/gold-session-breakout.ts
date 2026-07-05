#!/usr/bin/env tsx
/**
 * Gold Asian-range session breakout — DEEP ANALYSIS (gold intraday loop).
 *
 * The one candidate the structure diagnostic surfaced (post-break continuation
 * +4.79bp/break gross). Clean, low-param, low-turnover (≤1 trade/day):
 *   - Asian range = high/low of [asianStart, asianEnd) UTC.
 *   - Enter on FIRST 1m break beyond range±buffer during [tradeStart, exitHour) UTC,
 *     in the break direction (continuation). Entry at the break level + slippage.
 *   - Exit: hard stop / target in R multiples, else flat at exitHour (session close).
 *   - Cost = spread (round-trip) charged once.
 *
 * Reports per-period (per-trade) edge, annualized Sharpe, WR, maxDD, GROSS & NET.
 * Runs IS (2020–2026) and the untouched OOS holdout (2015–2019) for the SAME params
 * — a genuine out-of-sample test (no fitting on the holdout).
 *
 * "Don't make false hope": verdict is NET-of-cost on the HOLDOUT. If it doesn't
 * clear realistic cost OOS, it is reported dead.
 */
import { readFileSync } from 'node:fs';

interface C { timestamp: number; open: number; high: number; low: number; close: number }

// ── params (defaults; override via env for the improve step) ──
const ASIAN_START = Number(process.env.ASIAN_START ?? 0);   // UTC hour inclusive
const ASIAN_END = Number(process.env.ASIAN_END ?? 7);       // exclusive
const TRADE_START = ASIAN_END;                              // breakout window start
const EXIT_HOUR = Number(process.env.EXIT_HOUR ?? 20);      // flat-by hour (UTC)
const BUFFER_BP = Number(process.env.BUFFER_BP ?? 0);       // break buffer beyond range (bp)
const STOP_R = Number(process.env.STOP_R ?? 0);             // stop = STOP_R × asian range (0 = none)
const TARGET_R = Number(process.env.TARGET_R ?? 0);         // target = TARGET_R × asian range (0 = none, hold to close)
const SPREAD_BP = Number(process.env.SPREAD_BP ?? 4);       // round-trip cost in bp (gold ~3-4bp)

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); }
function maxDD(rets: number[]): number { let eq = 1, pk = 1, dd = 0; for (const r of rets) { eq *= (1 + r); if (eq > pk) pk = eq; dd = Math.max(dd, (pk - eq) / pk); } return dd; }

interface Res { n: number; grossBp: number; netBp: number; grossSharpe: number; netSharpe: number; wr: number; maxddNet: number; netTotalPct: number }
function backtest(file: string): Res {
  const m1 = JSON.parse(readFileSync(file, 'utf8')) as C[];
  // group by UTC day
  const byDay = new Map<string, C[]>();
  for (const c of m1) {
    const day = new Date(c.timestamp).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(c);
  }
  const gross: number[] = [], net: number[] = [];
  for (const [, bars] of byDay) {
    const asian = bars.filter((b) => { const h = new Date(b.timestamp).getUTCHours(); return h >= ASIAN_START && h < ASIAN_END; });
    const win = bars.filter((b) => { const h = new Date(b.timestamp).getUTCHours(); return h >= TRADE_START && h < EXIT_HOUR; });
    if (asian.length < 30 || win.length < 30) continue;
    const hi = Math.max(...asian.map((b) => b.high)), lo = Math.min(...asian.map((b) => b.low));
    const range = hi - lo;
    if (range <= 0) continue;
    const upLvl = hi * (1 + BUFFER_BP / 1e4), dnLvl = lo * (1 - BUFFER_BP / 1e4);
    // first break
    let dir = 0, entry = 0, entryIdx = -1;
    for (let i = 0; i < win.length; i++) {
      if (win[i]!.high >= upLvl) { dir = 1; entry = upLvl; entryIdx = i; break; }
      if (win[i]!.low <= dnLvl) { dir = -1; entry = dnLvl; entryIdx = i; break; }
    }
    if (dir === 0) continue;
    const stopPx = STOP_R > 0 ? entry - dir * STOP_R * range : NaN;
    const tgtPx = TARGET_R > 0 ? entry + dir * TARGET_R * range : NaN;
    let exit = win[win.length - 1]!.close; // default: flat at session close
    for (let i = entryIdx; i < win.length; i++) {
      if (STOP_R > 0 && (dir > 0 ? win[i]!.low <= stopPx : win[i]!.high >= stopPx)) { exit = stopPx; break; }
      if (TARGET_R > 0 && (dir > 0 ? win[i]!.high >= tgtPx : win[i]!.low <= tgtPx)) { exit = tgtPx; break; }
    }
    const g = dir * (exit / entry - 1);
    gross.push(g); net.push(g - SPREAD_BP / 1e4);
  }
  const ann = Math.sqrt(252); // ~1 trade/day
  return {
    n: net.length,
    grossBp: mean(gross) * 1e4, netBp: mean(net) * 1e4,
    grossSharpe: std(gross) ? (mean(gross) / std(gross)) * ann : 0,
    netSharpe: std(net) ? (mean(net) / std(net)) * ann : 0,
    wr: 100 * net.filter((r) => r > 0).length / net.length,
    maxddNet: maxDD(net) * 100,
    netTotalPct: (net.reduce((e, r) => e * (1 + r), 1) - 1) * 100,
  };
}

console.log('Gold Asian-range session breakout — deep analysis');
console.log(`params: asian ${ASIAN_START}-${ASIAN_END}h, trade→${EXIT_HOUR}h, buffer ${BUFFER_BP}bp, stop ${STOP_R}R, target ${TARGET_R}R, cost ${SPREAD_BP}bp RT\n`);
console.log('  set       |   n  | grossBp | netBp | grossSharpe | netSharpe | WR%  | maxDD% | netTotal%');
console.log('  ----------|------|---------|-------|-------------|-----------|------|--------|----------');
for (const [label, file] of [['IS 20-26', 'data/XAUUSD_1m.json'], ['OOS 15-19', 'data/XAUUSD_1m_holdout.json']] as [string, string][]) {
  const r = backtest(file);
  console.log(`  ${label.padEnd(9)} | ${String(r.n).padStart(4)} | ${r.grossBp.toFixed(2).padStart(7)} | ${r.netBp.toFixed(2).padStart(5)} | ${r.grossSharpe.toFixed(2).padStart(11)} | ${r.netSharpe.toFixed(2).padStart(9)} | ${r.wr.toFixed(0).padStart(4)} | ${r.maxddNet.toFixed(1).padStart(6)} | ${r.netTotalPct.toFixed(1).padStart(8)}`);
}
console.log('\nVERDICT basis: NET Sharpe + netBp on OOS 15-19 (unseen). netBp>0 AND OOS netSharpe>0.5 ⇒ worth more work; else dead.');
