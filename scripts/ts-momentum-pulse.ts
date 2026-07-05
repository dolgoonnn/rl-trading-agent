/**
 * Time-series (absolute) momentum / trend — PULSE CHECK (research loop, iter 7)
 *
 * Distinct from iter-5 cross-sectional momentum: each coin is long/short on its
 * OWN trailing trend (Moskowitz-Ooi-Pedersen 2012 TSMOM), inverse-vol sized,
 * equal-risk across the panel. Low turnover (weekly) so it dodges the cost wall.
 *
 * The decisive questions (beyond "does it work"):
 *  - Is it just LONG BETA? In crypto bulls TSMOM is long most of the time →
 *    high BTC correlation → REDUNDANT with the directional Run-20 book.
 *  - Does the SHORT leg (bear regimes) add uncorrelated return, or just whipsaw?
 * So we report net-exposure (how directional) + corr to BTC + vs buy-hold market,
 * not only Sharpe. WF-first: split-half + rolling windows (iter-3 lesson).
 *
 * Survives & ADDS only if net Sharpe>1, robust across windows, AND corr-to-BTC
 * is low enough that it's not duplicating the directional book.
 */
import { readFileSync } from 'node:fs';

interface Candle { timestamp: number; close: number }
// 19 coins (MATICUSDT dropped — data ends Sep-2024, see xs-momentum-pulse.ts)
const COINS = [
  'AAVEUSDT', 'ADAUSDT', 'APTUSDT', 'ARBUSDT', 'ATOMUSDT', 'AVAXUSDT', 'BNBUSDT',
  'BTCUSDT', 'DOGEUSDT', 'DOTUSDT', 'ETHUSDT', 'FILUSDT', 'ICPUSDT', 'LINKUSDT',
  'LTCUSDT', 'NEARUSDT', 'SOLUSDT', 'UNIUSDT', 'XRPUSDT',
];
const FRICTION = Number(process.env.FRICTION ?? 0.0005);
const HOLD = 168;        // weekly rebalance
const VOL_WIN = 720;     // 30d trailing vol for inverse-vol sizing
const PERIODS_YR = (24 * 365) / HOLD;

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); }
function sharpe(xs: number[]): number { const s = std(xs); return s === 0 ? 0 : (mean(xs) / s) * Math.sqrt(PERIODS_YR); }
function maxDD(rets: number[]): number { let eq = 1, pk = 1, dd = 0; for (const r of rets) { eq *= (1 + r); if (eq > pk) pk = eq; dd = Math.max(dd, (pk - eq) / pk); } return dd; }

const closeByCoin = new Map<string, Map<number, number>>();
for (const c of COINS) {
  try {
    const raw = JSON.parse(readFileSync(`data/${c}_1h.json`, 'utf8')) as Candle[];
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
function realizedVol(c: string, i: number, win: number): number {
  const rs: number[] = [];
  for (let k = i - win + 1; k <= i; k++) { const r = ret(c, k - 1, k); if (r !== null) rs.push(r); }
  return rs.length > 10 ? std(rs) : 0;
}

interface Run { net: number[]; gross: number[]; netExp: number[]; mkt: number[] }
function run(lookback: number): Run {
  const net: number[] = [], gross: number[] = [], netExp: number[] = [], mkt: number[] = [];
  let prevW = new Map<string, number>();
  const start = Math.max(lookback, VOL_WIN);
  for (let i = start; i + HOLD < timeline.length; i += HOLD) {
    // inverse-vol-weighted sign(trailing return) positions
    const w = new Map<string, number>();
    let gsum = 0;
    for (const c of live) {
      const r = ret(c, i - lookback, i);
      const v = realizedVol(c, i, VOL_WIN);
      if (r === null || v === 0) continue;
      const raw = Math.sign(r) / v;
      w.set(c, raw); gsum += Math.abs(raw);
    }
    if (gsum === 0) continue;
    for (const [c, x] of w) w.set(c, x / gsum); // normalize gross exposure to 1
    // turnover cost
    let turn = 0;
    const names = new Set([...w.keys(), ...prevW.keys()]);
    for (const c of names) turn += Math.abs((w.get(c) ?? 0) - (prevW.get(c) ?? 0));
    const cost = turn * FRICTION;
    prevW = w;
    // hold HOLD bars, accumulate portfolio period return
    let port = 0, mktR = 0, nMkt = 0;
    for (let b = i + 1; b <= i + HOLD && b < timeline.length; b++) {
      for (const [c, wc] of w) { const r = ret(c, b - 1, b); if (r !== null) port += wc * r; }
    }
    // market = equal-weight buy-hold over the hold window
    for (const c of live) { const r = ret(c, i, i + HOLD); if (r !== null) { mktR += r; nMkt++; } }
    let ne = 0; for (const wc of w.values()) ne += wc; // net exposure (sum of signed weights)
    gross.push(port); net.push(port - cost); netExp.push(ne); mkt.push(nMkt ? mktR / nMkt : 0);
  }
  return { net, gross, netExp, mkt };
}

function half<T>(xs: T[]): [T[], T[]] { const h = Math.floor(xs.length / 2); return [xs.slice(0, h), xs.slice(h)]; }
function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length); const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { cov += (a[i]! - ma) * (b[i]! - mb); va += (a[i]! - ma) ** 2; vb += (b[i]! - mb) ** 2; }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

console.log(`Time-series momentum pulse — ${live.length} coins, ${timeline.length} 1h bars, weekly rebalance, inverse-vol sized, cost ${FRICTION * 10000}bps/turnover\n`);
console.log('  lkbk(wk) |  n  | grossSharpe | netSharpe | netAnn% | maxDD% | avgNetExp | splitH (1st/2nd) | corr→BTC');
console.log('  ---------|-----|-------------|-----------|---------|--------|-----------|------------------|--------');
// BTC weekly returns for corr
for (const wk of [1, 2, 4, 8, 12]) {
  const r = run(wk * HOLD);
  if (r.net.length < 10) { console.log(`  ${String(wk).padStart(8)} | insufficient`); continue; }
  const [h1, h2] = half(r.net);
  const btcWk: number[] = [];
  const start = Math.max(wk * HOLD, VOL_WIN);
  for (let i = start, k = 0; i + HOLD < timeline.length && k < r.net.length; i += HOLD, k++) { const rr = ret('BTCUSDT', i, i + HOLD); btcWk.push(rr ?? 0); }
  console.log(
    `  ${String(wk).padStart(8)} | ${String(r.net.length).padStart(3)} | ${sharpe(r.gross).toFixed(2).padStart(11)} | ${sharpe(r.net).toFixed(2).padStart(9)} | ${(mean(r.net) * PERIODS_YR * 100).toFixed(1).padStart(6)}% | ${(maxDD(r.net) * 100).toFixed(1).padStart(5)}% | ${mean(r.netExp).toFixed(2).padStart(9)} | ${sharpe(h1).toFixed(2)} / ${sharpe(h2).toFixed(2)} | ${corr(r.net, btcWk).toFixed(2)}`,
  );
}
// market benchmark
const mk = run(2 * HOLD).mkt;
console.log(`\nequal-weight buy-hold market: ann ${(mean(mk) * PERIODS_YR * 100).toFixed(1)}%, Sharpe ${sharpe(mk).toFixed(2)}`);
console.log('Read: netSharpe>1 + both split-halves>0 + corr→BTC LOW ⇒ real & adds to the directional book. High corr→BTC ⇒ just long beta (redundant).');
