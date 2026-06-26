#!/usr/bin/env tsx
/**
 * FULL VALIDATION of xs-momentum (research loop) — the project's real bar.
 *
 * Runs the same suite used to gate deployed strategies, on the 2wk long-short
 * cross-sectional momentum book (19-coin panel, weekly rebalance):
 *   1. PBO (CSCV)  — config-selection overfitting   [src/lib/rl/utils/pbo.ts]
 *   2. DSR         — deflated Sharpe vs trial count  [deflated-sharpe.ts]
 *   3. Monte Carlo — reshuffle / bootstrap / skip    [monte-carlo.ts]
 *
 * Observation unit = one WEEKLY long-short period return (the natural "trade").
 * All configs share ONE rebalance grid (start = max lookback) so series align.
 *
 * HONESTY NOTE printed at the end: NONE of these test survivorship bias — they
 * test overfitting/luck/robustness on the SURVIVING 19-coin universe only. The
 * survivorship haircut (separate, larger risk) needs a point-in-time universe.
 */
import { readFileSync } from 'node:fs';
import { calculatePBO, type WindowResult } from '../src/lib/rl/utils/pbo';
import { calculateDeflatedSharpe } from '../src/lib/rl/utils/deflated-sharpe';
import { reshuffleTrades, bootstrapTrades, skipTrades, type MCTradeResult } from '../src/lib/rl/utils/monte-carlo';

interface Candle { timestamp: number; close: number }
const COINS = [
  'AAVEUSDT', 'ADAUSDT', 'APTUSDT', 'ARBUSDT', 'ATOMUSDT', 'AVAXUSDT', 'BNBUSDT',
  'BTCUSDT', 'DOGEUSDT', 'DOTUSDT', 'ETHUSDT', 'FILUSDT', 'ICPUSDT', 'LINKUSDT',
  'LTCUSDT', 'NEARUSDT', 'SOLUSDT', 'UNIUSDT', 'XRPUSDT',
];
const FRICTION = 0.0005;
const HOLD = 168;                 // weekly
const WK_PER_YR = 52;
const ANN = Math.sqrt(WK_PER_YR); // weekly→annual Sharpe factor
const LOOKBACKS = [1, 2, 3, 4, 6, 8, 12]; // weeks — the config grid (also the DSR trial set)
const CHOSEN = 2;                 // the config under validation (2wk LS)

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)); }
function annSharpe(xs: number[]): number { const s = std(xs); return s === 0 ? 0 : (mean(xs) / s) * ANN; }
function skew(xs: number[]): number { const m = mean(xs), n = xs.length, sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / n); return sd === 0 ? 0 : xs.reduce((s, x) => s + (x - m) ** 3, 0) / n / sd ** 3; }
function kurt(xs: number[]): number { const m = mean(xs), n = xs.length, m2 = xs.reduce((s, x) => s + (x - m) ** 2, 0) / n; return m2 === 0 ? 3 : xs.reduce((s, x) => s + (x - m) ** 4, 0) / n / m2 ** 2; }

const closeByCoin = new Map<string, Map<number, number>>();
for (const c of COINS) {
  const raw = JSON.parse(readFileSync(`data/${c}_1h.json`, 'utf8')) as Candle[];
  const m = new Map<number, number>();
  for (const k of raw) if (k.close > 0) m.set(k.timestamp, k.close);
  closeByCoin.set(c, m);
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

const START = Math.max(...LOOKBACKS) * HOLD; // shared rebalance grid start (12wk)
/** weekly net long-short returns for a given lookback, on the SHARED grid */
function momentumReturns(lookbackWk: number): number[] {
  const lookback = lookbackWk * HOLD;
  const out: number[] = [];
  let prevSet = new Set<string>();
  for (let i = START; i + HOLD < timeline.length; i += HOLD) {
    const scored: { c: string; r: number }[] = [];
    for (const c of live) { const r = ret(c, i - lookback, i); if (r !== null) scored.push({ c, r }); }
    if (scored.length < 6) { out.push(0); continue; }
    scored.sort((a, b) => a.r - b.r);
    const t = Math.floor(scored.length / 3);
    const losers = scored.slice(0, t).map((x) => x.c);
    const winners = scored.slice(scored.length - t).map((x) => x.c);
    const cur = new Set<string>(); winners.forEach((c) => cur.add('L' + c)); losers.forEach((c) => cur.add('S' + c));
    let changed = 0; for (const c of new Set([...cur, ...prevSet])) if (cur.has(c) !== prevSet.has(c)) changed++;
    const cost = (changed / (2 * t)) * FRICTION; prevSet = cur;
    const lf: number[] = [], sf: number[] = [];
    for (const c of winners) { const r = ret(c, i, i + HOLD); if (r !== null) lf.push(r); }
    for (const c of losers) { const r = ret(c, i, i + HOLD); if (r !== null) sf.push(r); }
    out.push((lf.length && sf.length) ? (mean(lf) - mean(sf) - cost) : 0);
  }
  return out;
}

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  FULL VALIDATION — xs-momentum 2wk long-short (19-coin, weekly)');
console.log('═══════════════════════════════════════════════════════════════════');
const seriesByLb = new Map<number, number[]>();
for (const lb of LOOKBACKS) seriesByLb.set(lb, momentumReturns(lb));
const chosen = seriesByLb.get(CHOSEN)!;
console.log(`Observations: ${chosen.length} weekly periods (~${(chosen.length / WK_PER_YR).toFixed(1)} yr) · grid start = ${Math.max(...LOOKBACKS)}wk lookback`);
console.log(`Chosen config: ${CHOSEN}wk LS · annualized Sharpe ${annSharpe(chosen).toFixed(2)} · netAnn ${(mean(chosen) * WK_PER_YR * 100).toFixed(1)}%\n`);

// ── 1. PBO (CSCV) ──────────────────────────────────────────────────────────
const NWIN = 10;
const wlen = Math.floor(chosen.length / NWIN);
const windowResults: WindowResult[] = LOOKBACKS.map((lb) => {
  const s = seriesByLb.get(lb)!;
  const windowMetrics: number[] = [];
  for (let w = 0; w < NWIN; w++) windowMetrics.push(annSharpe(s.slice(w * wlen, (w + 1) * wlen)));
  return { configId: `${lb}wk`, windowMetrics };
});
const pbo = calculatePBO(windowResults, { threshold: 0.25, minWindows: 6, minConfigs: 2 });
console.log('── 1. PBO (CSCV) — config-selection overfitting ─────────────────');
console.log(`   configs=${LOOKBACKS.length}, windows=${NWIN}, combinations=${pbo.numCombinations}`);
console.log(`   PBO = ${(pbo.pbo * 100).toFixed(1)}%  (project bar: <25% strong, <50% pass)  → ${pbo.pbo < 0.25 ? 'STRONG ✅' : pbo.pbo < 0.5 ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`   avg OOS logit=${pbo.avgLogitOOS.toFixed(3)}, IS-winner-underperforms count=${pbo.numOverfit}/${pbo.numCombinations}\n`);

// ── 2. DSR ─────────────────────────────────────────────────────────────────
const perObs = mean(chosen) / std(chosen);          // per-observation (statistically correct)
const annS = perObs * ANN;                           // annualized (project convention)
const sk = skew(chosen), ku = kurt(chosen);
console.log('── 2. Deflated Sharpe Ratio ─────────────────────────────────────');
console.log(`   per-obs Sharpe=${perObs.toFixed(4)}, annualized=${annS.toFixed(2)}, skew=${sk.toFixed(2)}, kurt=${ku.toFixed(2)}, N=${chosen.length}`);
console.log('   trials | DSR(per-obs, CORRECT) | DSR(annualized, project-conv)');
console.log('   -------|-----------------------|------------------------------');
for (const trials of [LOOKBACKS.length, 16, 25, 50, 100]) {
  const correct = calculateDeflatedSharpe(perObs, chosen.length, trials, { skewness: sk, kurtosis: ku });
  const proj = calculateDeflatedSharpe(annS, chosen.length, trials, { skewness: sk, kurtosis: ku });
  console.log(`   ${String(trials).padStart(6)} | ${correct.deflatedSharpe.toFixed(4).padStart(8)} ${correct.deflatedSharpe > 0 ? 'PASS ✅' : 'FAIL ❌'}       | ${proj.deflatedSharpe.toFixed(2).padStart(6)} ${proj.deflatedSharpe > 0 ? 'PASS ✅' : 'FAIL ❌'}`);
}
console.log('   (correct = per-observation SR in the per-obs variance formula; project-conv feeds annualized SR — inflates significance)\n');

// ── 3. Monte Carlo ─────────────────────────────────────────────────────────
const mcTrades: MCTradeResult[] = chosen.map((r) => ({ pnlPercent: r }));
const ITERS = 2000;
const re = reshuffleTrades(mcTrades, ITERS, ANN);
const bs = bootstrapTrades(mcTrades, ITERS, undefined, ANN);
const sk20 = skipTrades(mcTrades, 0.20, ITERS, ANN);
const sk30 = skipTrades(mcTrades, 0.30, ITERS, ANN);
console.log('── 3. Monte Carlo (2000 iters) ──────────────────────────────────');
console.log(`   reshuffle: serial-corr z=${re.sharpe.zScore.toFixed(2)} (|z|<2 ⇒ no adverse serial dependence)`);
console.log(`   bootstrap Sharpe 5th pct = ${bs.sharpe.p5.toFixed(2)}  → ${bs.sharpe.p5 > 0 ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`   bootstrap PnL 5th pct    = ${bs.finalPnl.p5.toFixed(1)}% → ${bs.finalPnl.p5 > 0 ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`   skip 20%: profitable ${(sk20.profitableFraction * 100).toFixed(1)}%  → ${sk20.profitableFraction > 0.95 ? 'PASS ✅' : sk20.profitableFraction > 0.90 ? 'WEAK ⚠️' : 'FAIL ❌'}`);
console.log(`   skip 30%: profitable ${(sk30.profitableFraction * 100).toFixed(1)}%`);
console.log(`   bootstrap Sharpe median ${bs.sharpe.median.toFixed(2)}, PnL median ${bs.finalPnl.median.toFixed(1)}%\n`);

// ── 4. SALVAGE TEST: lookback ENSEMBLE (no selection → dodges the PBO failure) ─
const ensLbs = [1, 2, 3, 4];
const ensSeries = chosen.map((_, i) => mean(ensLbs.map((lb) => seriesByLb.get(lb)![i]!)));
const ensPerObs = mean(ensSeries) / std(ensSeries);
const ensSk = skew(ensSeries), ensKu = kurt(ensSeries);
console.log('── 4. SALVAGE: lookback ensemble (avg 1–4wk, no selection) ──────');
console.log(`   annualized Sharpe ${annSharpe(ensSeries).toFixed(2)}, netAnn ${(mean(ensSeries) * WK_PER_YR * 100).toFixed(1)}%, per-obs SR ${ensPerObs.toFixed(4)}`);
console.log('   trials | DSR(per-obs, CORRECT)');
console.log('   -------|----------------------');
for (const trials of [1, 5, 10, 25, 50]) {
  const d = calculateDeflatedSharpe(ensPerObs, ensSeries.length, trials, { skewness: ensSk, kurtosis: ensKu });
  console.log(`   ${String(trials).padStart(6)} | ${d.deflatedSharpe.toFixed(4).padStart(8)} ${d.deflatedSharpe > 0 ? 'PASS ✅' : 'FAIL ❌'}`);
}
const ensMC = bootstrapTrades(ensSeries.map((r) => ({ pnlPercent: r })), ITERS, undefined, ANN);
console.log(`   MC bootstrap Sharpe p5 = ${ensMC.sharpe.p5.toFixed(2)} ${ensMC.sharpe.p5 > 0 ? 'PASS ✅' : 'FAIL ❌'}, PnL p5 = ${ensMC.finalPnl.p5.toFixed(1)}%`);
console.log('   (ensemble removes LOOKBACK selection, but NOT family-selection across the ~10 loop families, NOR survivorship)\n');

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  ⚠️ SURVIVORSHIP NOT TESTED. PBO/DSR/MC test overfitting/luck/robustness');
console.log('  on the SURVIVING 19-coin universe only. The (larger) survivorship');
console.log('  haircut needs a point-in-time universe incl. delisted coins.');
console.log('═══════════════════════════════════════════════════════════════════');
