/**
 * Order-flow imbalance — PULSE CHECK (research loop, iteration 9)
 *
 * The MOST on-thesis candidate: the project's standing conclusion is that the
 * surviving retail edge is microstructure/order-flow, not OHLC patterns. The
 * candles carry takerBuyVolume, so we have a COARSE (1h-aggregated) order-flow
 * proxy: imbalance = (2·takerBuyVol − volume)/volume ∈ [−1,1] (net aggressive
 * buy fraction). Does cross-sectional flow imbalance predict returns?
 *
 * Test BOTH directions (flow-momentum: long high-imbalance; flow-reversal: long
 * low-imbalance) at SHORT (24h) and weekly (168h) holds — flow signals are
 * short-lived, so the cost÷turnover ratio is the kill switch (cf. lead-lag).
 * WF-first: split-half. Report GROSS (does flow predict?) and NET (survives cost?).
 *
 * GROSS>0 but NET≈0 ⇒ real flow signal eaten by cost = microstructure edge that
 * needs L2/sub-hour execution (confirms thesis, not tradeable on candles).
 */
import { readFileSync } from 'node:fs';

interface Candle { timestamp: number; close: number; volume: number; takerBuyVolume: number }
const COINS = [
  'AAVEUSDT', 'ADAUSDT', 'APTUSDT', 'ARBUSDT', 'ATOMUSDT', 'AVAXUSDT', 'BNBUSDT',
  'BTCUSDT', 'DOGEUSDT', 'DOTUSDT', 'ETHUSDT', 'FILUSDT', 'ICPUSDT', 'LINKUSDT',
  'LTCUSDT', 'NEARUSDT', 'SOLUSDT', 'UNIUSDT', 'XRPUSDT',
];
const FRICTION = Number(process.env.FRICTION ?? 0.0005);

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); }

const closeByCoin = new Map<string, Map<number, number>>();
const ofiByCoin = new Map<string, Map<number, number>>();   // per-bar net buy fraction
const volByCoin = new Map<string, Map<number, number>>();
for (const c of COINS) {
  try {
    const raw = JSON.parse(readFileSync(`data/${c}_1h.json`, 'utf8')) as Candle[];
    const cm = new Map<number, number>(), om = new Map<number, number>(), vm = new Map<number, number>();
    for (const k of raw) {
      if (k.close > 0) cm.set(k.timestamp, k.close);
      if (k.volume > 0) { om.set(k.timestamp, (2 * k.takerBuyVolume - k.volume) / k.volume); vm.set(k.timestamp, k.volume); }
    }
    closeByCoin.set(c, cm); ofiByCoin.set(c, om); volByCoin.set(c, vm);
  } catch { /* skip */ }
}
const live = COINS.filter((c) => closeByCoin.has(c) && ofiByCoin.get(c)!.size > 0);
const btcTs = [...closeByCoin.get('BTCUSDT')!.keys()].sort((a, b) => a - b);
const timeline = btcTs.filter((t) => live.every((c) => closeByCoin.get(c)!.has(t) && ofiByCoin.get(c)!.has(t)));

function ret(c: string, i0: number, i1: number): number | null {
  const m = closeByCoin.get(c)!; const a = m.get(timeline[i0]!), b = m.get(timeline[i1]!);
  return a === undefined || b === undefined || a <= 0 ? null : b / a - 1;
}
/** volume-weighted mean net-buy imbalance for coin c over (i-look, i] */
function trailingOFI(c: string, i: number, look: number): number | null {
  const om = ofiByCoin.get(c)!, vm = volByCoin.get(c)!;
  let num = 0, den = 0;
  for (let k = i - look + 1; k <= i; k++) {
    const ts = timeline[k]; if (ts === undefined) continue;
    const o = om.get(ts), v = vm.get(ts);
    if (o !== undefined && v !== undefined) { num += o * v; den += v; }
  }
  return den > 0 ? num / den : null;
}

function sharpe(xs: number[], periodsYr: number): number { const s = std(xs); return s === 0 ? 0 : (mean(xs) / s) * Math.sqrt(periodsYr); }
function half<T>(xs: T[]): [T[], T[]] { const h = Math.floor(xs.length / 2); return [xs.slice(0, h), xs.slice(h)]; }

/** dir=+1 flow-momentum (long high imbalance), dir=−1 flow-reversal */
function run(look: number, hold: number, dir: number): { net: number[]; gross: number[]; periodsYr: number } {
  const net: number[] = [], gross: number[] = [];
  let prevSet = new Set<string>();
  for (let i = look; i + hold < timeline.length; i += hold) {
    const scored: { c: string; s: number }[] = [];
    for (const c of live) { const o = trailingOFI(c, i, look); if (o !== null) scored.push({ c, s: o }); }
    if (scored.length < 6) continue;
    scored.sort((a, b) => a.s - b.s);
    const t = Math.floor(scored.length / 3);
    const lowImb = scored.slice(0, t).map((x) => x.c);
    const highImb = scored.slice(scored.length - t).map((x) => x.c);
    const longs = dir > 0 ? highImb : lowImb;
    const shorts = dir > 0 ? lowImb : highImb;
    const curSet = new Set<string>(); longs.forEach((c) => curSet.add('L' + c)); shorts.forEach((c) => curSet.add('S' + c));
    let changed = 0; for (const c of new Set([...curSet, ...prevSet])) if (curSet.has(c) !== prevSet.has(c)) changed++;
    const cost = (changed / (2 * t)) * FRICTION; prevSet = curSet;
    const lf: number[] = [], sf: number[] = [];
    for (const c of longs) { const r = ret(c, i, i + hold); if (r !== null) lf.push(r); }
    for (const c of shorts) { const r = ret(c, i, i + hold); if (r !== null) sf.push(r); }
    if (lf.length === 0 || sf.length === 0) continue;
    const pr = mean(lf) - mean(sf);
    gross.push(pr); net.push(pr - cost);
  }
  return { net, gross, periodsYr: (24 * 365) / hold };
}

console.log(`Order-flow imbalance pulse — ${live.length} coins, ${timeline.length} 1h bars, imbalance=(2·takerBuy−vol)/vol, cost ${FRICTION * 10000}bps\n`);
console.log('  dir        | look(h) | hold(h) |  n  | grossSharpe | netSharpe | netAnn% | splitH (1st/2nd)');
console.log('  -----------|---------|---------|-----|-------------|-----------|---------|------------------');
for (const dir of [1, -1]) {
  for (const [look, hold] of [[24, 24], [72, 24], [168, 168], [336, 168]] as [number, number][]) {
    const r = run(look, hold, dir);
    if (r.net.length < 10) { console.log(`  ${(dir > 0 ? 'momentum' : 'reversal').padEnd(10)} | ${String(look).padStart(7)} | ${String(hold).padStart(7)} | insufficient`); continue; }
    const [h1, h2] = half(r.net);
    console.log(
      `  ${(dir > 0 ? 'momentum' : 'reversal').padEnd(10)} | ${String(look).padStart(7)} | ${String(hold).padStart(7)} | ${String(r.net.length).padStart(3)} | ${sharpe(r.gross, r.periodsYr).toFixed(2).padStart(11)} | ${sharpe(r.net, r.periodsYr).toFixed(2).padStart(9)} | ${(mean(r.net) * r.periodsYr * 100).toFixed(1).padStart(6)}% | ${sharpe(h1, r.periodsYr).toFixed(2)} / ${sharpe(h2, r.periodsYr).toFixed(2)}`,
    );
  }
}
console.log('\nRead: GROSS>0 ⇒ flow predicts returns (thesis support). NET>1 + both split-halves>0 ⇒ tradeable on candles. GROSS>0 NET≈0 ⇒ microstructure edge, needs sub-hour/L2.');
