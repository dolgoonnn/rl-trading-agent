/**
 * Low-volatility / betting-against-beta (BAB) — PULSE CHECK (research loop, iter 8)
 *
 * NEW factor family (not momentum, not mean-reversion): the low-vol anomaly
 * (Frazzini-Pedersen) — low-risk assets earn higher risk-adjusted returns than
 * high-risk ones. In crypto this is ~"long established low-vol coins / short
 * speculative high-vol alts." Low turnover (vol ranks are persistent) ⇒ dodges
 * the cost wall.
 *
 * Method: every week, rank coins by trailing realized vol; long bottom tercile
 * (low vol) / short top tercile (high vol), dollar-neutral, equal weight. WF-first
 * (iter-3 lesson): split-half + rolling windows. Decisive extra checks:
 *  - corr→BTC (is it market-neutral or just a beta tilt?)
 *  - is it a NEW premium or redundant with momentum? (report; redundancy judged
 *    against the xs-momentum winner separately if it survives)
 *
 * Survives only if net Sharpe>1, both split-halves>0, robust across windows.
 */
import { readFileSync } from 'node:fs';

interface Candle { timestamp: number; close: number }
const COINS = [
  'AAVEUSDT', 'ADAUSDT', 'APTUSDT', 'ARBUSDT', 'ATOMUSDT', 'AVAXUSDT', 'BNBUSDT',
  'BTCUSDT', 'DOGEUSDT', 'DOTUSDT', 'ETHUSDT', 'FILUSDT', 'ICPUSDT', 'LINKUSDT',
  'LTCUSDT', 'NEARUSDT', 'SOLUSDT', 'UNIUSDT', 'XRPUSDT',
];
const FRICTION = Number(process.env.FRICTION ?? 0.0005);
const HOLD = 168;        // weekly
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

interface Run { net: number[]; gross: number[]; netExp: number[] }
function run(volWin: number): Run {
  const net: number[] = [], gross: number[] = [], netExp: number[] = [];
  let prevSet = new Set<string>();
  for (let i = volWin; i + HOLD < timeline.length; i += HOLD) {
    const scored: { c: string; v: number }[] = [];
    for (const c of live) { const v = realizedVol(c, i, volWin); if (v > 0) scored.push({ c, v }); }
    if (scored.length < 6) continue;
    scored.sort((a, b) => a.v - b.v);
    const t = Math.floor(scored.length / 3);
    const lowVol = scored.slice(0, t).map((x) => x.c);              // long (low vol)
    const highVol = scored.slice(scored.length - t).map((x) => x.c); // short (high vol)
    const curSet = new Set<string>();
    lowVol.forEach((c) => curSet.add('L' + c)); highVol.forEach((c) => curSet.add('S' + c));
    let changed = 0; const names = new Set([...curSet, ...prevSet]);
    for (const c of names) if (curSet.has(c) !== prevSet.has(c)) changed++;
    const cost = (changed / (2 * t)) * FRICTION;
    prevSet = curSet;
    const longF: number[] = [], shortF: number[] = [];
    for (const c of lowVol) { const r = ret(c, i, i + HOLD); if (r !== null) longF.push(r); }
    for (const c of highVol) { const r = ret(c, i, i + HOLD); if (r !== null) shortF.push(r); }
    if (longF.length === 0 || shortF.length === 0) continue;
    const pr = mean(longF) - mean(shortF); // dollar-neutral: long low-vol, short high-vol
    gross.push(pr); net.push(pr - cost); netExp.push(0); // dollar-neutral by construction
  }
  return { net, gross, netExp };
}

function half<T>(xs: T[]): [T[], T[]] { const h = Math.floor(xs.length / 2); return [xs.slice(0, h), xs.slice(h)]; }
function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length); const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { cov += (a[i]! - ma) * (b[i]! - mb); va += (a[i]! - ma) ** 2; vb += (b[i]! - mb) ** 2; }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

console.log(`BAB / low-vol anomaly pulse — ${live.length} coins, ${timeline.length} 1h bars, weekly rebalance, long low-vol / short high-vol tercile, cost ${FRICTION * 10000}bps\n`);
console.log('  volWin(d) |  n  | grossSharpe | netSharpe | netAnn% | maxDD% | splitH (1st/2nd) | corr→BTC');
console.log('  ----------|-----|-------------|-----------|---------|--------|------------------|--------');
for (const days of [7, 14, 30, 60]) {
  const vw = days * 24;
  const r = run(vw);
  if (r.net.length < 10) { console.log(`  ${String(days).padStart(9)} | insufficient`); continue; }
  const [h1, h2] = half(r.net);
  const btcWk: number[] = [];
  for (let i = vw, k = 0; i + HOLD < timeline.length && k < r.net.length; i += HOLD, k++) btcWk.push(ret('BTCUSDT', i, i + HOLD) ?? 0);
  console.log(
    `  ${String(days).padStart(9)} | ${String(r.net.length).padStart(3)} | ${sharpe(r.gross).toFixed(2).padStart(11)} | ${sharpe(r.net).toFixed(2).padStart(9)} | ${(mean(r.net) * PERIODS_YR * 100).toFixed(1).padStart(6)}% | ${(maxDD(r.net) * 100).toFixed(1).padStart(5)}% | ${sharpe(h1).toFixed(2)} / ${sharpe(h2).toFixed(2)} | ${corr(r.net, btcWk).toFixed(2)}`,
  );
}
console.log('\nRead: netSharpe>1 + both split-halves>0 ⇒ real low-vol premium. Sign of long-low/short-high: positive = classic BAB; negative = high-vol outperforms (crypto "lottery" tilt).');
