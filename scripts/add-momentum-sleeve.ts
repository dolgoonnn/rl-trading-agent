#!/usr/bin/env tsx
/**
 * Add xs-momentum as a portfolio sleeve (research loop, iteration 6 — COMBINE).
 *
 * Emits the validated 2wk long-short cross-sectional momentum book (see
 * scripts/xs-momentum-pulse.ts: net Sharpe 1.49, 52/55 rolling windows, ρ=0.07
 * to BTC) as DAILY LOG RETURNS so it slots into the tested portfolio combiner
 * (scripts/combine-strategies.ts) alongside crypto/sessionBook/f2f.
 *
 * Methodology IDENTICAL to the validated pulse — computed on the 1h grid
 * (LOOKBACK=336h=2wk, HOLD=168h=1wk, long top / short bottom tercile, cost on
 * rebalance) — then 1h book returns are bucketed into UTC-day log returns. Raw
 * returns are emitted (no vol-scaling); the combiner vol-normalizes each sleeve.
 *
 * Output: experiments/runs/strategy-daily-returns-plus-momentum.json
 * (canonical file untouched; combiner reads this via RETURNS_FILE env).
 *
 * NOTE: the 20-coin universe is survivorship-biased ⇒ this sleeve's LEVEL is an
 * upper bound. The combiner vol-targets to 10% so level-inflation is largely
 * removed; the robust contribution is the low correlation (diversification).
 */
import * as fs from 'fs';
import * as path from 'path';

interface Candle { timestamp: number; close: number }
// MATICUSDT dropped (data ends 2024-09-10, MATIC→POL rebrand) — it truncated the
// common timeline to Sep-2024; without it the panel reaches Feb-2026 (full window).
const COINS = [
  'AAVEUSDT', 'ADAUSDT', 'APTUSDT', 'ARBUSDT', 'ATOMUSDT', 'AVAXUSDT', 'BNBUSDT',
  'BTCUSDT', 'DOGEUSDT', 'DOTUSDT', 'ETHUSDT', 'FILUSDT', 'ICPUSDT', 'LINKUSDT',
  'LTCUSDT', 'NEARUSDT', 'SOLUSDT', 'UNIUSDT', 'XRPUSDT',
];
const LOOKBACK = 336;  // 2 weeks (hours)
const HOLD = 168;      // 1 week (hours)
const FRICTION = 0.0005;

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function utcDate(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }

const closeByCoin = new Map<string, Map<number, number>>();
for (const c of COINS) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.resolve('data', `${c}_1h.json`), 'utf8')) as Candle[];
    const m = new Map<number, number>();
    for (const k of raw) if (k.close > 0) m.set(k.timestamp, k.close);
    closeByCoin.set(c, m);
  } catch { /* skip */ }
}
const live = COINS.filter((c) => closeByCoin.has(c));
const btcTs = [...closeByCoin.get('BTCUSDT')!.keys()].sort((a, b) => a - b);
const timeline = btcTs.filter((t) => live.every((c) => closeByCoin.get(c)!.has(t)));
const px = new Map<string, number[]>();
for (const c of live) px.set(c, timeline.map((t) => closeByCoin.get(c)!.get(t)!));

function ret(c: string, i0: number, i1: number): number | null {
  const p = px.get(c)!; const a = p[i0], b = p[i1];
  return a === undefined || b === undefined || a <= 0 ? null : b / a - 1;
}

// build the long-short book, accumulate 1h book returns into UTC-day log returns
const dailyLog = new Map<string, number>();
let prevSet = new Set<string>();
for (let i = LOOKBACK; i + HOLD < timeline.length; i += HOLD) {
  const scored: { c: string; r: number }[] = [];
  for (const c of live) { const r = ret(c, i - LOOKBACK, i); if (r !== null) scored.push({ c, r }); }
  if (scored.length < 6) continue;
  scored.sort((a, b) => a.r - b.r);
  const t = Math.floor(scored.length / 3);
  const losers = scored.slice(0, t).map((x) => x.c);          // short
  const winners = scored.slice(scored.length - t).map((x) => x.c); // long
  // turnover cost at rebalance (fraction of book changed × friction), charged on first held bar
  const curSet = new Set<string>();
  winners.forEach((c) => curSet.add('L' + c)); losers.forEach((c) => curSet.add('S' + c));
  let changed = 0;
  for (const c of curSet) if (!prevSet.has(c)) changed++;
  for (const c of prevSet) if (!curSet.has(c)) changed++;
  const bookSize = 2 * t;
  const rebalCost = bookSize === 0 ? 0 : (changed / bookSize) * FRICTION;
  prevSet = curSet;
  // hold for HOLD bars; book 1h return = mean(long) − mean(short)
  for (let b = i + 1; b <= i + HOLD && b < timeline.length; b++) {
    const longF: number[] = [], shortF: number[] = [];
    for (const c of winners) { const r = ret(c, b - 1, b); if (r !== null) longF.push(r); }
    for (const c of losers) { const r = ret(c, b - 1, b); if (r !== null) shortF.push(r); }
    if (longF.length === 0 || shortF.length === 0) continue;
    let bookRet = mean(longF) - mean(shortF);
    if (b === i + 1) bookRet -= rebalCost; // one-time rebalance cost
    const d = utcDate(timeline[b]!);
    dailyLog.set(d, (dailyLog.get(d) ?? 0) + Math.log(1 + bookRet));
  }
}

const series: Record<string, number> = {};
for (const [d, v] of [...dailyLog.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) series[d] = v;
const dates = Object.keys(series);
const sumLog = Object.values(series).reduce((s, x) => s + x, 0);
const sd = Math.sqrt(mean(Object.values(series).map((x) => (x - mean(Object.values(series))) ** 2)));
console.log(`xsMomentum sleeve: ${dates.length} days, ${dates[0]} .. ${dates.at(-1)}, totalLog ${(sumLog * 100).toFixed(1)}%, daily Sharpe(ann) ${(mean(Object.values(series)) / sd * Math.sqrt(365)).toFixed(2)}`);

const canonPath = path.resolve('experiments', 'runs', 'strategy-daily-returns.json');
const canon = JSON.parse(fs.readFileSync(canonPath, 'utf8')) as { series: Record<string, Record<string, number>>;[k: string]: unknown };
canon.series.xsMomentum = series;
// Survivorship-haircut variant: halve the daily mean (keeps vol/shape, ~halves
// Sharpe) to stress-test whether the book still improves under a conservative
// estimate of momentum's true (survivorship-free) edge.
const vals = Object.values(series);
const mu = mean(vals);
const seriesHC: Record<string, number> = {};
for (const [d, v] of Object.entries(series)) seriesHC[d] = v - 0.5 * mu;
canon.series.xsMomentumHC = seriesHC;
const sdHC = Math.sqrt(mean(Object.values(seriesHC).map((x) => (x - mean(Object.values(seriesHC))) ** 2)));
console.log(`xsMomentumHC (survivorship haircut): daily Sharpe(ann) ${(mean(Object.values(seriesHC)) / sdHC * Math.sqrt(365)).toFixed(2)}`);
const outPath = path.resolve('experiments', 'runs', 'strategy-daily-returns-plus-momentum.json');
fs.writeFileSync(outPath, JSON.stringify(canon, null, 2));
console.log(`wrote ${outPath} (canonical untouched; combiner reads via RETURNS_FILE)`);
