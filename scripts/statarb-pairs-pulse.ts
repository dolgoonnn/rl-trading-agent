/**
 * Stat-arb cointegration pairs — PULSE CHECK (research loop, iteration 3)
 *
 * Thesis: a relative-value family where MULTI-DAY holds amortize the per-trade
 * cost wall that killed cross-sectional reversal (iter 1, net Sharpe −43). Trade
 * the mean-reverting spread of a cointegrated pair, not a 1-bar bounce.
 *
 * Honest design (the failure mode is SPURIOUS in-sample cointegration):
 *  1. Split each series IN-SAMPLE (first 50%) / OUT-OF-SAMPLE (second 50%).
 *  2. IS: Engle-Granger — OLS log(A)~log(B) → hedge ratio β, residual spread e;
 *     Dickey-Fuller t-stat on e ranks stationarity. Keep pairs with DF t < −3.0
 *     (≈ Engle-Granger 5% for 2 series) AND β>0.
 *  3. OOS: z-score the spread with IS μ/σ (no look-ahead), trade |z|>2 enter /
 *     |z|<0.5 exit, β-hedged, net of (1+β)×5bps per position change.
 *  4. Compare cointegrated-pair OOS net Sharpe to the ALL-PAIRS baseline.
 *     If selection adds nothing OOS → cointegration was spurious → family dead here.
 *
 * Survives only if IS-cointegrated pairs beat the baseline AND net Sharpe>1 OOS.
 */
import { readFileSync } from 'node:fs';

interface Candle { timestamp: number; close: number }

const COINS = [
  'AAVEUSDT', 'ADAUSDT', 'APTUSDT', 'ARBUSDT', 'ATOMUSDT', 'AVAXUSDT', 'BNBUSDT',
  'BTCUSDT', 'DOGEUSDT', 'DOTUSDT', 'ETHUSDT', 'FILUSDT', 'ICPUSDT', 'LINKUSDT',
  'LTCUSDT', 'MATICUSDT', 'NEARUSDT', 'SOLUSDT', 'UNIUSDT', 'XRPUSDT',
];

const FRICTION = Number(process.env.FRICTION ?? 0.0005);   // 5 bps per leg-side (override via FRICTION env)
const ENTER = 2.0;         // |z| entry
const EXIT = 0.5;          // |z| exit
const DF_CRIT = -3.0;      // DF t-stat threshold for "cointegrated" (EG 2-var ≈ 5%)
const HOUR = 3_600_000;

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); }

// load per-coin timestamp->close, then build a common timeline present in ALL coins
const closeByCoin = new Map<string, Map<number, number>>();
for (const c of COINS) {
  try {
    const raw = JSON.parse(readFileSync(`data/${c}_1h.json`, 'utf8')) as Candle[];
    const m = new Map<number, number>();
    for (const k of raw) if (k.close > 0) m.set(k.timestamp, k.close);
    closeByCoin.set(c, m);
  } catch { /* skip missing coin */ }
}
const live = COINS.filter((c) => closeByCoin.has(c));
const btcTs = [...closeByCoin.get('BTCUSDT')!.keys()].sort((a, b) => a - b);
const timeline = btcTs.filter((t) => live.every((c) => closeByCoin.get(c)!.has(t)));

// log-price matrix aligned to common timeline
const logp = new Map<string, number[]>();
for (const c of live) logp.set(c, timeline.map((t) => Math.log(closeByCoin.get(c)!.get(t)!)));

const split = Math.floor(timeline.length / 2);
const PERIODS_YR = 24 * 365;

/** OLS of y on x → {alpha, beta} */
function ols(y: number[], x: number[]): { alpha: number; beta: number } {
  const mx = mean(x), my = mean(y);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < x.length; i++) { const dx = x[i]! - mx; sxx += dx * dx; sxy += dx * (y[i]! - my); }
  const beta = sxx === 0 ? 0 : sxy / sxx;
  return { alpha: my - beta * mx, beta };
}

/** Dickey-Fuller t-stat on residual series e (no const/trend; e is mean-zero by OLS) */
function dfTstat(e: number[]): number {
  let sxx = 0, sxy = 0;
  for (let t = 1; t < e.length; t++) { const x = e[t - 1]!; sxx += x * x; sxy += x * (e[t]! - e[t - 1]!); }
  if (sxx === 0) return 0;
  const phi = sxy / sxx;
  let sse = 0;
  for (let t = 1; t < e.length; t++) { const r = (e[t]! - e[t - 1]!) - phi * e[t - 1]!; sse += r * r; }
  const sigma2 = sse / (e.length - 2);
  const se = Math.sqrt(sigma2 / sxx);
  return se === 0 ? 0 : phi / se;
}

/** trade the OOS spread; returns net/gross Sharpe, net ann return, #trades, and the per-bar net P&L series */
function tradeOOS(logA: number[], logB: number[], alpha: number, beta: number, mu: number, sigma: number): {
  netSharpe: number; grossSharpe: number; netAnn: number; nTrades: number; net: number[];
} {
  const e = logA.map((a, i) => a - alpha - beta * logB[i]!);
  const changeCost = (1 + Math.abs(beta)) * FRICTION; // both legs traded on each position change
  let pos = 0; let nTrades = 0;
  const net: number[] = []; const gross: number[] = [];
  for (let i = 1; i < e.length; i++) {
    const z = (e[i - 1]! - mu) / sigma; // signal from prior bar — no look-ahead
    let newPos = pos;
    if (pos === 0) { if (z > ENTER) newPos = -1; else if (z < -ENTER) newPos = 1; }
    else if (pos === 1 && z > -EXIT) newPos = 0;
    else if (pos === -1 && z < EXIT) newPos = 0;
    let cost = 0;
    if (newPos !== pos) { nTrades++; cost = changeCost; }
    const dS = e[i]! - e[i - 1]!;
    const g = newPos * dS;            // P&L of β-hedged spread over the bar
    gross.push(g); net.push(g - cost);
    pos = newPos;
  }
  const sg = std(gross), sn = std(net);
  return {
    netSharpe: sn === 0 ? 0 : (mean(net) / sn) * Math.sqrt(PERIODS_YR),
    grossSharpe: sg === 0 ? 0 : (mean(gross) / sg) * Math.sqrt(PERIODS_YR),
    netAnn: mean(net) * PERIODS_YR * 100,
    nTrades,
    net,
  };
}

interface PairRes { a: string; b: string; df: number; beta: number; netSharpe: number; grossSharpe: number; netAnn: number; nTrades: number; net: number[] }
const all: PairRes[] = [];
for (let i = 0; i < live.length; i++) {
  for (let j = i + 1; j < live.length; j++) {
    const A = live[i]!, B = live[j]!;
    const la = logp.get(A)!, lb = logp.get(B)!;
    const laIS = la.slice(0, split), lbIS = lb.slice(0, split);
    const laOOS = la.slice(split), lbOOS = lb.slice(split);
    // pick the regression direction with the larger |β-stability|: just regress A~B (β>0 filter handles sign)
    const { alpha, beta } = ols(laIS, lbIS);
    if (beta <= 0) continue;
    const eIS = laIS.map((a, k) => a - alpha - beta * lbIS[k]!);
    const df = dfTstat(eIS);
    const mu = mean(eIS), sigma = std(eIS);
    if (sigma === 0) continue;
    const t = tradeOOS(laOOS, lbOOS, alpha, beta, mu, sigma);
    all.push({ a: A, b: B, df, beta, netSharpe: t.netSharpe, grossSharpe: t.grossSharpe, netAnn: t.netAnn, nTrades: t.nTrades, net: t.net });
  }
}

const coint = all.filter((p) => p.df < DF_CRIT);
const traded = coint.filter((p) => p.nTrades >= 3); // need real OOS activity to judge

function report(label: string, ps: PairRes[]): void {
  if (ps.length === 0) { console.log(`${label}: none`); return; }
  const ns = ps.map((p) => p.netSharpe);
  const pctWin = 100 * ns.filter((s) => s > 1).length / ps.length;
  console.log(
    `${label.padEnd(34)} | pairs ${String(ps.length).padStart(3)} | meanNetSharpe ${mean(ns).toFixed(2).padStart(6)} | medNetSharpe ${[...ns].sort((a, b) => a - b)[Math.floor(ns.length / 2)]!.toFixed(2).padStart(6)} | %netSharpe>1 ${pctWin.toFixed(0).padStart(3)} | meanNetAnn ${mean(ps.map((p) => p.netAnn)).toFixed(1).padStart(6)}%`,
  );
}

console.log(`Stat-arb cointegration pulse — ${live.length} coins, ${timeline.length} common 1h bars (IS=${split}/OOS=${timeline.length - split})`);
console.log(`cointegration: DF t < ${DF_CRIT} on IS residual · trade |z|>${ENTER} enter / |z|<${EXIT} exit · cost (1+β)×${FRICTION * 10000}bps/change\n`);
report('ALL pairs (baseline)', all.filter((p) => p.nTrades >= 3));
report('COINTEGRATED IS (df<-3)', traded);
console.log('');

// --- BASKET test: equal-weight portfolio of IS-selected pairs traded OOS (no look-ahead) ---
// This is the real strategy shape — many small uncorrelated market-neutral spreads.
function basket(label: string, ps: PairRes[]): { sharpe: number; ann: number; maxdd: number; netSeries: number[] } | null {
  if (ps.length === 0) { console.log(`${label}: empty`); return null; }
  const n = ps[0]!.net.length;
  const port: number[] = new Array(n).fill(0);
  for (const p of ps) for (let i = 0; i < n; i++) port[i]! += p.net[i]! / ps.length; // equal weight
  const sd = std(port);
  const sharpe = sd === 0 ? 0 : (mean(port) / sd) * Math.sqrt(PERIODS_YR);
  const ann = mean(port) * PERIODS_YR * 100;
  let eq = 1, peak = 1, dd = 0; for (const r of port) { eq *= (1 + r); if (eq > peak) peak = eq; dd = Math.max(dd, (peak - eq) / peak); }
  console.log(`${label.padEnd(40)} | pairs ${String(ps.length).padStart(3)} | netSharpe ${sharpe.toFixed(2).padStart(5)} | netAnn ${ann.toFixed(1).padStart(6)}% | maxDD ${(dd * 100).toFixed(1).padStart(5)}%`);
  return { sharpe, ann, maxdd: dd, netSeries: port };
}
console.log('EQUAL-WEIGHT BASKET (OOS, no look-ahead selection):');
basket('all-pairs basket', all.filter((p) => p.nTrades >= 3));
const cb = basket('cointegrated-IS basket (df<-3)', traded);

// basket correlation to BTC spot returns over OOS (market-neutrality check)
if (cb) {
  const oosTs = timeline.slice(split + 1); // net series starts at OOS bar 1
  const bc = closeByCoin.get('BTCUSDT')!;
  const cs: number[] = [], ss: number[] = [];
  for (let i = 1; i < oosTs.length; i++) {
    const c0 = bc.get(oosTs[i - 1]!), c1 = bc.get(oosTs[i]!);
    if (c0 !== undefined && c1 !== undefined && i < cb.netSeries.length) { cs.push(cb.netSeries[i]!); ss.push(c1 / c0 - 1); }
  }
  if (cs.length > 30) {
    const mc = mean(cs), ms = mean(ss);
    const cov = mean(cs.map((c, i) => (c - mc) * (ss[i]! - ms)));
    const corr = cov / (std(cs) * std(ss));
    console.log(`\nCointegrated-basket vs BTC-spot return correlation: ${corr.toFixed(3)} (≈0 ⇒ market-neutral diversifier)`);
  }
}
console.log('');

// top cointegrated pairs by OOS net Sharpe
const top = [...traded].sort((a, b) => b.netSharpe - a.netSharpe).slice(0, 8);
console.log('top cointegrated pairs by OOS net Sharpe:');
console.log('  pair             |  IS df  |   β   | grossSharpe | netSharpe | netAnn% | trades');
console.log('  -----------------|---------|-------|-------------|-----------|---------|-------');
for (const p of top) {
  console.log(
    `  ${(p.a + '/' + p.b).padEnd(16)} | ${p.df.toFixed(2).padStart(6)} | ${p.beta.toFixed(2).padStart(5)} | ${p.grossSharpe.toFixed(2).padStart(11)} | ${p.netSharpe.toFixed(2).padStart(9)} | ${p.netAnn.toFixed(1).padStart(6)}% | ${String(p.nTrades).padStart(5)}`,
  );
}
console.log('\nRead: COINTEGRATED meanNetSharpe >> baseline AND >1 ⇒ selection real & survives cost. ≈baseline ⇒ spurious.');

// --- WALK-FORWARD: rolling IS→OOS, re-estimate β each window (kills single-regime + stale-β caveats) ---
// All-pairs basket (cointegration filter shown not to help). Trade each OOS window on its own IS hedge.
const IS_LEN = Number(process.env.IS_LEN ?? 3000);    // ~4 months trailing in-sample
const OOS_LEN = Number(process.env.OOS_LEN ?? 1500);  // ~2 months out-of-sample
const SLIDE = Number(process.env.OOS_LEN ?? 1500);
console.log(`\nWALK-FORWARD all-pairs basket — IS=${IS_LEN} / OOS=${OOS_LEN} / slide=${SLIDE} bars, β re-estimated per window:`);
console.log('  window | OOS bars range  | pairs | netSharpe | netAnn% | maxDD%');
console.log('  -------|-----------------|-------|-----------|---------|-------');
const wfSharpes: number[] = [];
for (let start = 0; start + IS_LEN + OOS_LEN <= timeline.length; start += SLIDE) {
  const isS = start, isE = start + IS_LEN, ooS = isE, ooE = isE + OOS_LEN;
  const series: number[][] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const la = logp.get(live[i]!)!, lb = logp.get(live[j]!)!;
      const { alpha, beta } = ols(la.slice(isS, isE), lb.slice(isS, isE));
      if (beta <= 0) continue;
      const eIS = la.slice(isS, isE).map((a, k) => a - alpha - beta * lb.slice(isS, isE)[k]!);
      const mu = mean(eIS), sigma = std(eIS);
      if (sigma === 0) continue;
      const t = tradeOOS(la.slice(ooS, ooE), lb.slice(ooS, ooE), alpha, beta, mu, sigma);
      if (t.nTrades >= 1) series.push(t.net);
    }
  }
  if (series.length === 0) continue;
  const n = series[0]!.length;
  const port = new Array<number>(n).fill(0);
  for (const s of series) for (let i = 0; i < n; i++) port[i]! += s[i]! / series.length;
  const sd = std(port);
  const sharpe = sd === 0 ? 0 : (mean(port) / sd) * Math.sqrt(PERIODS_YR);
  const ann = mean(port) * PERIODS_YR * 100;
  let eq = 1, peak = 1, dd = 0; for (const r of port) { eq *= (1 + r); if (eq > peak) peak = eq; dd = Math.max(dd, (peak - eq) / peak); }
  wfSharpes.push(sharpe);
  console.log(`  ${String(wfSharpes.length).padStart(6)} | ${String(ooS).padStart(6)}-${String(ooE).padEnd(8)} | ${String(series.length).padStart(5)} | ${sharpe.toFixed(2).padStart(9)} | ${ann.toFixed(1).padStart(6)}% | ${(dd * 100).toFixed(1).padStart(5)}%`);
}
const wfPos = wfSharpes.filter((s) => s > 0).length;
console.log(`\nWalk-forward: ${wfPos}/${wfSharpes.length} OOS windows positive · mean window Sharpe ${mean(wfSharpes).toFixed(2)} · ${(100 * wfPos / wfSharpes.length).toFixed(0)}% pass`);
console.log('Read: all (or nearly all) windows positive ⇒ regime-robust real edge, not a single lucky OOS window.');
void HOUR;
