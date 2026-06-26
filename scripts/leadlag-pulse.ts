/**
 * Lead-lag cross-predictability — PULSE CHECK (research loop, iteration 4)
 *
 * Question: does the leader's LAST-bar return (BTC, or the equal-weight panel)
 * predict an alt's NEXT-bar return — beyond the alt's own autocorrelation — and
 * does it survive cost? Lit prior: intraday cross-predictability + a documented
 * *negative* lead-lag ("seesaw"). This is a relative-value/spillover family the
 * project never tested directly.
 *
 * Iter-3 lesson baked in: NO single-split headline. Everything is rolling
 * walk-forward — learn the sign/scale on trailing IS, trade the next OOS window,
 * demand >60% windows positive AND positive mean. Report GROSS (does the signal
 * exist?) and NET (does it survive the 1h turnover cost wall — the reversal killer?).
 *
 * Signal: pos_A[t] = sign(IS corr(r_A[t], r_lead[t-1])) · clip(r_lead[t-1]/σ_lead_IS, ±3)
 *  (magnitude-scaled so small leader moves take small positions → less churn).
 * Basket = equal-weight across alts. Cost = friction · |Δpos| each bar.
 */
import { readFileSync } from 'node:fs';

interface Candle { timestamp: number; close: number }
const COINS = [
  'AAVEUSDT', 'ADAUSDT', 'APTUSDT', 'ARBUSDT', 'ATOMUSDT', 'AVAXUSDT', 'BNBUSDT',
  'BTCUSDT', 'DOGEUSDT', 'DOTUSDT', 'ETHUSDT', 'FILUSDT', 'ICPUSDT', 'LINKUSDT',
  'LTCUSDT', 'MATICUSDT', 'NEARUSDT', 'SOLUSDT', 'UNIUSDT', 'XRPUSDT',
];
const LEADER = 'BTCUSDT';
const FRICTION = Number(process.env.FRICTION ?? 0.0005); // 5 bps per unit position traded
const CAP = 3;
const PERIODS_YR = 24 * 365;
const IS_LEN = Number(process.env.IS_LEN ?? 3000);
const OOS_LEN = Number(process.env.OOS_LEN ?? 1500);

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); }
function clip(x: number, c: number): number { return Math.max(-c, Math.min(c, x)); }
function corr(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) { const da = a[i]! - ma, db = b[i]! - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return saa === 0 || sbb === 0 ? 0 : sab / Math.sqrt(saa * sbb);
}

// load closes, align to common timeline
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
const alts = live.filter((c) => c !== LEADER);
const btcTs = [...closeByCoin.get(LEADER)!.keys()].sort((a, b) => a - b);
const timeline = btcTs.filter((t) => live.every((c) => closeByCoin.get(c)!.has(t)));

// per-coin simple returns aligned to timeline[1..] (ret[i] is return over [i-1,i])
const ret = new Map<string, number[]>();
for (const c of live) {
  const r: number[] = [];
  for (let i = 1; i < timeline.length; i++) r.push(closeByCoin.get(c)!.get(timeline[i]!)! / closeByCoin.get(c)!.get(timeline[i - 1]!)! - 1);
  ret.set(c, r);
}
const rLead = ret.get(LEADER)!;
const N = rLead.length;

/**
 * Trade one alt over [ooS,ooE) using sign+scale learned on [isS,isE).
 * Signal uses r_lead[t-1] to position for bar t. Returns per-bar net+gross P&L.
 */
function tradeAlt(rA: number[], isS: number, isE: number, ooS: number, ooE: number): { gross: number[]; net: number[] } | null {
  // IS: align r_A[t] with r_lead[t-1] → pairs (lead[t-1], A[t]) for t in [isS+1, isE)
  const x: number[] = [], y: number[] = [];
  for (let t = isS + 1; t < isE; t++) { x.push(rLead[t - 1]!); y.push(rA[t]!); }
  if (x.length < 100) return null;
  const sign = Math.sign(corr(y, x)) || 1;
  const sigLead = std(x); if (sigLead === 0) return null;
  // OOS trade
  const gross: number[] = [], net: number[] = [];
  let prevPos = 0;
  for (let t = Math.max(ooS, 1); t < ooE; t++) {
    const pos = sign * clip(rLead[t - 1]! / sigLead, CAP);
    gross.push(pos * rA[t]!);
    net.push(pos * rA[t]! - FRICTION * Math.abs(pos - prevPos));
    prevPos = pos;
  }
  return { gross, net };
}

function basketStats(series: number[][]): { sharpe: number; ann: number; maxdd: number } {
  const n = series[0]!.length;
  const port = new Array<number>(n).fill(0);
  for (const s of series) for (let i = 0; i < n; i++) port[i]! += s[i]! / series.length;
  const sd = std(port);
  let eq = 1, peak = 1, dd = 0; for (const r of port) { eq *= (1 + r); if (eq > peak) peak = eq; dd = Math.max(dd, (peak - eq) / peak); }
  return { sharpe: sd === 0 ? 0 : (mean(port) / sd) * Math.sqrt(PERIODS_YR), ann: mean(port) * PERIODS_YR * 100, maxdd: dd };
}

console.log(`Lead-lag pulse — leader=${LEADER}, ${alts.length} alts, ${N} return bars`);
console.log(`signal pos=sign(IS corr)·clip(r_lead[t-1]/σ_IS,±${CAP}) · cost ${FRICTION * 10000}bps/Δpos · WF IS=${IS_LEN}/OOS=${OOS_LEN}\n`);
console.log('  window | OOS range       | grossSharpe | grossAnn% | netSharpe | netAnn% | maxDD%');
console.log('  -------|-----------------|-------------|-----------|-----------|---------|-------');
const grossS: number[] = [], netS: number[] = [];
for (let start = 0; start + IS_LEN + OOS_LEN <= N; start += OOS_LEN) {
  const gAll: number[][] = [], nAll: number[][] = [];
  for (const a of alts) {
    const r = tradeAlt(ret.get(a)!, start, start + IS_LEN, start + IS_LEN, start + IS_LEN + OOS_LEN);
    if (r) { gAll.push(r.gross); nAll.push(r.net); }
  }
  if (gAll.length === 0) continue;
  const g = basketStats(gAll), nb = basketStats(nAll);
  grossS.push(g.sharpe); netS.push(nb.sharpe);
  console.log(`  ${String(grossS.length).padStart(6)} | ${String(start + IS_LEN).padStart(6)}-${String(start + IS_LEN + OOS_LEN).padEnd(8)} | ${g.sharpe.toFixed(2).padStart(11)} | ${g.ann.toFixed(1).padStart(8)}% | ${nb.sharpe.toFixed(2).padStart(9)} | ${nb.ann.toFixed(1).padStart(6)}% | ${(nb.maxdd * 100).toFixed(1).padStart(5)}%`);
}
const gPos = grossS.filter((s) => s > 0).length, nPos = netS.filter((s) => s > 0).length;
console.log(`\nGROSS: ${gPos}/${grossS.length} windows positive, mean Sharpe ${mean(grossS).toFixed(2)} ⇒ does the lead-lag signal exist?`);
console.log(`NET:   ${nPos}/${netS.length} windows positive, mean Sharpe ${mean(netS).toFixed(2)} ⇒ does it survive 1h turnover cost?`);
console.log('Read: GROSS>0 but NET≈0/neg ⇒ real signal eaten by cost (execution edge, not candle). NET>60% & mean>0 ⇒ survivor.');
