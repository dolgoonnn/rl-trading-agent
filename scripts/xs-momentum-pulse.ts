/**
 * Cross-sectional momentum — PULSE CHECK (research loop, iteration 5)
 *
 * The strongest remaining candidate because it structurally dodges the kill
 * switches that took iters 1/3/4:
 *  - WEEKLY rebalance ⇒ low turnover ⇒ no cost wall (killed reversal + lead-lag).
 *  - Fixed ranking rule (long trailing winners), no fitted params ⇒ not
 *    estimation-window-fragile like stat-arb pairs.
 * Lit prior: Dobrynskaya et al — large, significant crypto momentum not spanned
 * by standard factors.
 *
 * Method: every HOLD bars, rank coins by trailing LOOKBACK return; long top
 * tercile / short bottom tercile (and a long-only top-tercile variant). Hold,
 * rebalance. Cost charged on ACTUAL name turnover each rebalance. Honest checks:
 *  - long-SHORT: is there a momentum factor at all (net Sharpe, split-half)?
 *  - long-ONLY: must BEAT equal-weight buy-hold (else it's just long beta).
 *  - corr to BTC spot (combine-candidate check).
 */
import { readFileSync } from 'node:fs';

interface Candle { timestamp: number; close: number }
// MATICUSDT dropped: its 1h data ends 2024-09-10 (MATIC→POL rebrand) and was the
// SINGLE coin truncating the all-coins common timeline to Sep-2024. Dropping it
// (a rebrand/data-availability artifact, not a zero) extends the panel to Feb-2026
// so momentum is tested on the FULL ~3yr window incl. the recent regime.
const COINS = [
  'AAVEUSDT', 'ADAUSDT', 'APTUSDT', 'ARBUSDT', 'ATOMUSDT', 'AVAXUSDT', 'BNBUSDT',
  'BTCUSDT', 'DOGEUSDT', 'DOTUSDT', 'ETHUSDT', 'FILUSDT', 'ICPUSDT', 'LINKUSDT',
  'LTCUSDT', 'NEARUSDT', 'SOLUSDT', 'UNIUSDT', 'XRPUSDT',
];
const FRICTION = Number(process.env.FRICTION ?? 0.0005); // 5 bps per name-side traded
const HOLD = 168;        // 1 week (hours)
const PERIODS_YR = (24 * 365) / HOLD; // ~52

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); }
function sharpe(xs: number[]): number { const s = std(xs); return s === 0 ? 0 : (mean(xs) / s) * Math.sqrt(PERIODS_YR); }
function maxDD(rets: number[]): number { let eq = 1, peak = 1, dd = 0; for (const r of rets) { eq *= (1 + r); if (eq > peak) peak = eq; dd = Math.max(dd, (peak - eq) / peak); } return dd; }

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

interface Run { gross: number[]; net: number[]; mkt: number[] }
/** mode: 'ls' long-short tercile, 'lo' long-only top tercile (mkt = equal-weight all) */
function run(lookback: number, mode: 'ls' | 'lo'): Run {
  const gross: number[] = [], net: number[] = [], mkt: number[] = [];
  let prevSet = new Set<string>();
  for (let i = lookback; i + HOLD < timeline.length; i += HOLD) {
    const scored: { c: string; r: number }[] = [];
    for (const c of live) { const r = ret(c, i - lookback, i); if (r !== null) scored.push({ c, r }); }
    if (scored.length < 6) continue;
    scored.sort((a, b) => a.r - b.r);
    const t = Math.floor(scored.length / 3);
    const losers = scored.slice(0, t).map((x) => x.c);
    const winners = scored.slice(scored.length - t).map((x) => x.c);
    const fwd = (c: string): number | null => ret(c, i, i + HOLD);
    const longF = winners.map(fwd).filter((x): x is number => x !== null);
    const allF = scored.map((x) => fwd(x.c)).filter((x): x is number => x !== null);
    if (longF.length === 0 || allF.length === 0) continue;
    let periodRet: number;
    const curSet = new Set<string>();
    if (mode === 'ls') {
      const shortF = losers.map(fwd).filter((x): x is number => x !== null);
      if (shortF.length === 0) continue;
      periodRet = mean(longF) - mean(shortF);
      winners.forEach((c) => curSet.add('L' + c)); losers.forEach((c) => curSet.add('S' + c));
    } else {
      periodRet = mean(longF);
      winners.forEach((c) => curSet.add('L' + c));
    }
    // turnover cost: names entering+leaving the book, each traded once
    let changed = 0;
    for (const c of curSet) if (!prevSet.has(c)) changed++;
    for (const c of prevSet) if (!curSet.has(c)) changed++;
    const bookSize = mode === 'ls' ? 2 * t : t;
    const cost = bookSize === 0 ? 0 : (changed / bookSize) * FRICTION; // fraction of book turned × friction
    prevSet = curSet;
    gross.push(periodRet); net.push(periodRet - cost); mkt.push(mean(allF));
  }
  return { gross, net, mkt };
}

function half<T>(xs: T[]): [T[], T[]] { const h = Math.floor(xs.length / 2); return [xs.slice(0, h), xs.slice(h)]; }

console.log(`Cross-sectional momentum pulse — ${live.length} coins, ${timeline.length} 1h bars, weekly (HOLD=${HOLD}) rebalance, cost ${FRICTION * 10000}bps/name\n`);
console.log('  mode | lkbk(wk) |  n  | grossSharpe | netSharpe | netAnn% | maxDD% | splitH Sharpe (1st/2nd)');
console.log('  -----|----------|-----|-------------|-----------|---------|--------|----------------------');
for (const mode of ['ls', 'lo'] as const) {
  for (const wk of [1, 2, 4, 8]) {
    const r = run(wk * HOLD, mode);
    if (r.net.length < 10) { console.log(`  ${mode}  | ${String(wk).padStart(8)} | insufficient`); continue; }
    const [h1, h2] = half(r.net);
    console.log(
      `  ${mode}  | ${String(wk).padStart(8)} | ${String(r.net.length).padStart(3)} | ${sharpe(r.gross).toFixed(2).padStart(11)} | ${sharpe(r.net).toFixed(2).padStart(9)} | ${(mean(r.net) * PERIODS_YR * 100).toFixed(1).padStart(6)}% | ${(maxDD(r.net) * 100).toFixed(1).padStart(5)}% | ${sharpe(h1).toFixed(2)} / ${sharpe(h2).toFixed(2)}`,
    );
  }
}

// long-only vs market benchmark (does momentum SELECTION beat just holding the basket?)
console.log('\nlong-only top-tercile vs equal-weight market (buy-hold all):');
console.log('  lkbk(wk) | momo netAnn% | momo Sharpe | market Ann% | market Sharpe | momo−mkt Sharpe');
console.log('  ---------|--------------|-------------|-------------|---------------|----------------');
for (const wk of [2, 4, 8]) {
  const r = run(wk * HOLD, 'lo');
  if (r.net.length < 10) continue;
  const excess = r.net.map((v, i) => v - r.mkt[i]!);
  console.log(
    `  ${String(wk).padStart(8)} | ${(mean(r.net) * PERIODS_YR * 100).toFixed(1).padStart(11)}% | ${sharpe(r.net).toFixed(2).padStart(11)} | ${(mean(r.mkt) * PERIODS_YR * 100).toFixed(1).padStart(10)}% | ${sharpe(r.mkt).toFixed(2).padStart(13)} | ${sharpe(excess).toFixed(2).padStart(15)}`,
  );
}
// --- deep-dive on the winning config (2wk long-short): rolling robustness + BTC corr (combine check) ---
const best = run(2 * HOLD, 'ls');
const W = 20; // rolling 20-week window
const rollS: number[] = [];
for (let i = 0; i + W <= best.net.length; i++) rollS.push(sharpe(best.net.slice(i, i + W)));
const rollPos = rollS.filter((s) => s > 0).length;
console.log(`\n2wk long-short — rolling ${W}-week Sharpe: ${rollPos}/${rollS.length} windows positive (min ${Math.min(...rollS).toFixed(2)}, median ${[...rollS].sort((a, b) => a - b)[Math.floor(rollS.length / 2)]!.toFixed(2)}, max ${Math.max(...rollS).toFixed(2)})`);
// corr of 2wk-LS weekly returns to BTC weekly returns over the same rebalance grid
const btcWk: number[] = [];
for (let i = 2 * HOLD; i + HOLD < timeline.length; i += HOLD) { const r = ret('BTCUSDT', i, i + HOLD); if (r !== null) btcWk.push(r); }
const m = Math.min(best.net.length, btcWk.length);
const a = best.net.slice(0, m), b = btcWk.slice(0, m);
const ma = mean(a), mb = mean(b);
let cov = 0, va = 0, vb = 0;
for (let i = 0; i < m; i++) { cov += (a[i]! - ma) * (b[i]! - mb); va += (a[i]! - ma) ** 2; vb += (b[i]! - mb) ** 2; }
console.log(`2wk long-short vs BTC weekly-return correlation: ${(cov / Math.sqrt(va * vb)).toFixed(3)} (low ⇒ diversifies the directional book)`);
console.log('\nRead: long-SHORT netSharpe>1 with both split-halves>0 ⇒ real momentum factor. long-ONLY must beat market (momo−mkt Sharpe>0) ⇒ selection adds value, not just beta.');
