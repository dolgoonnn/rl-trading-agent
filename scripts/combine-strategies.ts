#!/usr/bin/env tsx
/**
 * Strategy combination backtest — find the best way to run all validated
 * strategies as ONE book.
 *
 * Input: experiments/runs/strategy-daily-returns.json (from
 * scripts/extract-strategy-returns.ts) — daily LOG returns per strategy.
 *
 * Scaffold (per portfolio-construction literature: DeMiguel 1/N, Carver
 * handcrafting, Maillard-Roncalli ERC, Rising-Wyner fractional Kelly):
 *   1. Calendar-align sleeves on the union of dates, zero when flat.
 *   2. Vol-normalize each sleeve to a common 10% annualized target using a
 *      TRAILING blended vol estimate (EWMA λ=0.97 + 252d simple, 70/30),
 *      leverage capped per sleeve.
 *   3. Weighting methods, all walk-forward (weights estimated on data strictly
 *      before each monthly rebalance date):
 *        ew         equal weight (the DeMiguel-robust baseline)
 *        handcraft  Carver: bucketed correlations + damped SR tilt
 *        erc        equal risk contribution on trailing 252d covariance
 *        mvshrunk   shrunk mean-variance (falsification arm — expected loser)
 *      Each method also gets Carver's diversification multiplier
 *      DM = 1/√(wᵀHw), ρ floored at 0, capped 2.5.
 *   4. Portfolio vol-target overlay (12% ann, 20d EWMA, leverage cap 3×) —
 *      reported alongside raw. Fractional-Kelly enters as the vol-target
 *      LEVEL (0.5 × haircut book Sharpe), not as relative weights.
 *
 * Outputs a comparison table + experiments/runs/strategy-combination-results.json
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================
// Math helpers
// ============================================

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function annSharpe(xs: number[]): number { const s = std(xs); return s > 0 ? (mean(xs) / s) * Math.sqrt(252) : 0; }
function maxDDCompounded(logRets: number[]): number {
  let eq = 0, pk = 0, dd = 0;
  for (const r of logRets) { eq += r; if (eq > pk) pk = eq; dd = Math.max(dd, 1 - Math.exp(eq - pk)); }
  return dd;
}
function corrOf(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; db += (b[i]! - mb) ** 2; }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : 0;
}
function fmt(x: number, dp = 2): string { return x.toFixed(dp); }

// ============================================
// Config
// ============================================

const SLEEVE_VOL_TARGET_ANN = 0.10;   // each sleeve normalized to 10% ann vol
const SLEEVE_LEVERAGE_CAP = 4;        // max scale-up for quiet sleeves (F2F)
const PORTFOLIO_VOL_TARGET_ANN = 0.12;
const PORTFOLIO_LEVERAGE_CAP = 3;
const WARMUP_DAYS = 252;              // history needed before first weights
const EWMA_LAMBDA = 0.97;
const DM_CAP = 2.5;
const MV_MEAN_SHRINK = 0.75;          // shrink sleeve means 75% toward cross-sleeve mean
const MV_COV_SHRINK = 0.5;            // shrink covariance toward diagonal
const MV_WEIGHT_BOUNDS: [number, number] = [0.10, 0.60];

// ============================================
// Data loading & alignment
// ============================================

interface AlignedData {
  dates: string[];
  names: string[];
  raw: number[][];      // [sleeve][day] log returns, 0 when flat
}

function loadAligned(names: string[], minDate?: string): AlignedData {
  const file = path.resolve(__dirname, '..', 'experiments', 'runs', 'strategy-daily-returns.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as { series: Record<string, Record<string, number>> };
  const series = names.map((n) => {
    const s = data.series[n];
    if (!s) throw new Error(`Missing series '${n}' in ${file}`);
    return s;
  });
  // Combined window: from the latest first-date (every sleeve must be live) to
  // the earliest last-date — avoids periods where a sleeve doesn't exist yet.
  const firsts = series.map((s) => Object.keys(s).sort()[0]!);
  const lasts = series.map((s) => Object.keys(s).sort().at(-1)!);
  const start = minDate ?? firsts.reduce((a, b) => (a > b ? a : b));
  const end = lasts.reduce((a, b) => (a < b ? a : b));
  const dateSet = new Set<string>();
  for (const s of series) for (const d of Object.keys(s)) if (d >= start && d <= end) dateSet.add(d);
  const dates = [...dateSet].sort();
  const raw = series.map((s) => dates.map((d) => s[d] ?? 0));
  return { dates, names, raw };
}

// ============================================
// Step 2: trailing vol-normalization per sleeve
// ============================================

/** Returns [sleeve][day] normalized log returns. Uses only PAST data at each t. */
function volNormalize(raw: number[][]): { norm: number[][]; scaleLog: string[] } {
  const dailyTarget = SLEEVE_VOL_TARGET_ANN / Math.sqrt(252);
  const scaleLog: string[] = [];
  const norm = raw.map((rets) => {
    let ewmaVar = 0;
    let initialized = false;
    const window: number[] = [];
    const out = new Array<number>(rets.length).fill(0);
    let capHits = 0;
    for (let t = 0; t < rets.length; t++) {
      // scale decided from info available BEFORE day t
      if (t >= WARMUP_DAYS && initialized) {
        const longVar = window.length >= 60 ? std(window) ** 2 : ewmaVar;
        const sigma = Math.sqrt(0.7 * ewmaVar + 0.3 * longVar);
        const scale = sigma > 0 ? Math.min(SLEEVE_LEVERAGE_CAP, dailyTarget / sigma) : 0;
        if (scale === SLEEVE_LEVERAGE_CAP) capHits++;
        out[t] = scale * rets[t]!;
      }
      // update estimators with day t
      const r = rets[t]!;
      ewmaVar = initialized ? EWMA_LAMBDA * ewmaVar + (1 - EWMA_LAMBDA) * r * r : r * r;
      initialized = true;
      window.push(r);
      if (window.length > 252) window.shift();
    }
    scaleLog.push(`capHits=${capHits}`);
    return out;
  });
  return { norm, scaleLog };
}

// ============================================
// Weighting methods (all estimate from trailing slice only)
// ============================================

type WeightFn = (trailing: number[][], names: string[]) => number[];

function covMatrix(slice: number[][]): number[][] {
  const n = slice.length;
  const mu = slice.map(mean);
  const cov: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const len = slice[0]!.length;
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0;
      for (let t = 0; t < len; t++) s += (slice[i]![t]! - mu[i]!) * (slice[j]![t]! - mu[j]!);
      cov[i]![j] = cov[j]![i] = s / Math.max(1, len - 1);
    }
  }
  return cov;
}

function corrMatrix(slice: number[][]): number[][] {
  const n = slice.length;
  const out: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(1));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    out[i]![j] = out[j]![i] = corrOf(slice[i]!, slice[j]!);
  }
  return out;
}

const weightEqual: WeightFn = (trailing) => trailing.map(() => 1 / trailing.length);

/** Carver handcrafting: bucket pairwise correlations to {0,0.5,0.9}, weights from
 * his candidate-matrix logic (favor the diversifier), then a damped SR tilt. */
const weightHandcraft: WeightFn = (trailing) => {
  const n = trailing.length;
  const rho = corrMatrix(trailing);
  const bucket = (r: number): number => (r < 0.25 ? 0 : r < 0.7 ? 0.5 : 0.9);
  // Base: inverse of average bucketed correlation to others → diversifiers get more
  const base = new Array<number>(n).fill(0).map((_, i) => {
    let avg = 0;
    for (let j = 0; j < n; j++) if (j !== i) avg += bucket(rho[i]![j]!);
    avg /= Math.max(1, n - 1);
    return 1 / (1 + avg); // ρ̄=0 → 1.0, ρ̄=0.5 → 0.67, ρ̄=0.9 → 0.53
  });
  // Damped SR tilt: rank-based multiplier in [0.85, 1.15] (Carver caps tilts hard)
  const srs = trailing.map(annSharpe);
  const order = srs.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s);
  const tilt = new Array<number>(n).fill(1);
  order.forEach((o, rank) => {
    tilt[o.i] = n === 1 ? 1 : 0.85 + (0.30 * rank) / (n - 1);
  });
  const w = base.map((b, i) => b * tilt[i]!);
  const sum = w.reduce((s, x) => s + x, 0);
  return w.map((x) => x / sum);
};

/** ERC via cyclical coordinate descent (Spinu-style fixed point). */
const weightERC: WeightFn = (trailing) => {
  const n = trailing.length;
  const cov = covMatrix(trailing);
  let w = new Array<number>(n).fill(1 / n);
  for (let iter = 0; iter < 200; iter++) {
    const next = [...w];
    for (let i = 0; i < n; i++) {
      let other = 0;
      for (let j = 0; j < n; j++) if (j !== i) other += cov[i]![j]! * next[j]!;
      const a = cov[i]![i]!;
      if (a <= 0) continue;
      // solve a·w² + other·w − σp²/n ≈ 0 with σp² from current weights
      let sp2 = 0;
      for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) sp2 += next[x]! * next[y]! * cov[x]![y]!;
      const target = sp2 / n;
      next[i] = (-other + Math.sqrt(other * other + 4 * a * target)) / (2 * a);
    }
    const sum = next.reduce((s, x) => s + x, 0);
    for (let i = 0; i < n; i++) next[i] = next[i]! / sum;
    const delta = Math.max(...next.map((x, i) => Math.abs(x - w[i]!)));
    w = next;
    if (delta < 1e-8) break;
  }
  return w;
};

/** Shrunk mean-variance tangency: w ∝ Σ_shrunk⁻¹ μ_shrunk, long-only, bounded. */
const weightMVShrunk: WeightFn = (trailing) => {
  const n = trailing.length;
  const mu = trailing.map(mean);
  const grand = mean(mu);
  const muS = mu.map((m) => (1 - MV_MEAN_SHRINK) * m + MV_MEAN_SHRINK * grand);
  const cov = covMatrix(trailing);
  const covS: number[][] = cov.map((row, i) =>
    row.map((c, j) => (i === j ? c : (1 - MV_COV_SHRINK) * c)),
  );
  // 3x3 (or n×n) solve via Gaussian elimination
  const A = covS.map((row) => [...row]);
  const b = [...muS];
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[piv]![col]!)) piv = r;
    [A[col], A[piv]] = [A[piv]!, A[col]!];
    [b[col], b[piv]] = [b[piv]!, b[col]!];
    const d = A[col]![col]!;
    if (Math.abs(d) < 1e-18) return new Array<number>(n).fill(1 / n);
    for (let r = col + 1; r < n; r++) {
      const f = A[r]![col]! / d;
      for (let c = col; c < n; c++) A[r]![c] = A[r]![c]! - f * A[col]![c]!;
      b[r] = b[r]! - f * b[col]!;
    }
  }
  const w = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]!;
    for (let c = r + 1; c < n; c++) s -= A[r]![c]! * w[c]!;
    w[r] = s / A[r]![r]!;
  }
  // long-only clip, bound, renormalize
  let clipped = w.map((x) => Math.max(0, x));
  const total = clipped.reduce((s, x) => s + x, 0);
  clipped = total > 0 ? clipped.map((x) => x / total) : new Array<number>(n).fill(1 / n);
  clipped = clipped.map((x) => Math.min(MV_WEIGHT_BOUNDS[1], Math.max(MV_WEIGHT_BOUNDS[0], x)));
  const total2 = clipped.reduce((s, x) => s + x, 0);
  return clipped.map((x) => x / total2);
};

/** Carver diversification multiplier on trailing correlations. */
function diversificationMultiplier(trailing: number[][], w: number[]): number {
  const H = corrMatrix(trailing).map((row) => row.map((r) => Math.max(0, r)));
  let q = 0;
  for (let i = 0; i < w.length; i++) for (let j = 0; j < w.length; j++) q += w[i]! * w[j]! * H[i]![j]!;
  return q > 0 ? Math.min(DM_CAP, 1 / Math.sqrt(q)) : 1;
}

// ============================================
// Walk-forward combination engine
// ============================================

interface MethodResult {
  name: string;
  raw: { annRetPct: number; sharpe: number; maxDDPct: number };
  volTargeted: { annRetPct: number; sharpe: number; maxDDPct: number };
  avgWeights: number[];
  avgDM: number;
  rebalances: number;
  dailyRaw: number[];
  dailyVT: number[];
}

function runMethod(
  name: string,
  fn: WeightFn,
  data: AlignedData,
  norm: number[][],
): MethodResult {
  const { dates } = data;
  const n = norm.length;
  const T = dates.length;
  const dailyRaw = new Array<number>(T).fill(0);
  let w = new Array<number>(n).fill(1 / n);
  let dm = 1;
  let lastRebalMonth = '';
  let rebalances = 0;
  const weightSums = new Array<number>(n).fill(0);
  let dmSum = 0;
  let activeDays = 0;

  for (let t = WARMUP_DAYS; t < T; t++) {
    const month = dates[t]!.slice(0, 7);
    if (month !== lastRebalMonth) {
      const lo = Math.max(0, t - 504); // up to 2y trailing for estimates
      const trailing = norm.map((s) => s.slice(lo, t));
      w = fn(trailing, data.names);
      dm = diversificationMultiplier(trailing, w);
      lastRebalMonth = month;
      rebalances++;
    }
    let r = 0;
    for (let i = 0; i < n; i++) r += w[i]! * norm[i]![t]!;
    dailyRaw[t] = dm * r;
    for (let i = 0; i < n; i++) weightSums[i] = weightSums[i]! + w[i]!;
    dmSum += dm;
    activeDays++;
  }

  // Portfolio vol-target overlay (EWMA 20d ≈ λ=0.905, scale capped)
  const dailyVT = new Array<number>(T).fill(0);
  const lam = 0.905;
  let ewmaVar = 0;
  let init = false;
  const dailyTarget = PORTFOLIO_VOL_TARGET_ANN / Math.sqrt(252);
  for (let t = WARMUP_DAYS; t < T; t++) {
    if (init && ewmaVar > 0) {
      const scale = Math.min(PORTFOLIO_LEVERAGE_CAP, dailyTarget / Math.sqrt(ewmaVar));
      dailyVT[t] = scale * dailyRaw[t]!;
    }
    const r = dailyRaw[t]!;
    ewmaVar = init ? lam * ewmaVar + (1 - lam) * r * r : r * r;
    init = true;
  }

  const evalRaw = dailyRaw.slice(WARMUP_DAYS);
  const evalVT = dailyVT.slice(WARMUP_DAYS);
  const stats = (xs: number[]): { annRetPct: number; sharpe: number; maxDDPct: number } => ({
    annRetPct: Math.round(mean(xs) * 252 * 1000) / 10,
    sharpe: Math.round(annSharpe(xs) * 100) / 100,
    maxDDPct: Math.round(maxDDCompounded(xs) * 1000) / 10,
  });
  return {
    name,
    raw: stats(evalRaw),
    volTargeted: stats(evalVT),
    avgWeights: weightSums.map((s) => Math.round((s / Math.max(1, activeDays)) * 1000) / 1000),
    avgDM: Math.round((dmSum / Math.max(1, activeDays)) * 100) / 100,
    rebalances,
    dailyRaw: evalRaw,
    dailyVT: evalVT,
  };
}

/** Stationary block bootstrap of Sharpe difference vs a benchmark series. */
function bootstrapSharpeDiff(a: number[], b: number[], iters = 2000, blockLen = 10): { meanDiff: number; pct5: number; probAWins: number } {
  const T = Math.min(a.length, b.length);
  const diffs: number[] = [];
  let wins = 0;
  for (let k = 0; k < iters; k++) {
    const idx: number[] = [];
    while (idx.length < T) {
      const start = Math.floor(Math.random() * T);
      const len = Math.max(1, Math.floor(-blockLen * Math.log(1 - Math.random())));
      for (let j = 0; j < len && idx.length < T; j++) idx.push((start + j) % T);
    }
    const sa = annSharpe(idx.map((i) => a[i]!));
    const sb = annSharpe(idx.map((i) => b[i]!));
    diffs.push(sa - sb);
    if (sa > sb) wins++;
  }
  diffs.sort((x, y) => x - y);
  return {
    meanDiff: Math.round(mean(diffs) * 100) / 100,
    pct5: Math.round(diffs[Math.floor(0.05 * iters)]! * 100) / 100,
    probAWins: Math.round((wins / iters) * 1000) / 10,
  };
}

// ============================================
// Main
// ============================================

function runUniverse(key: string, label: string, names: string[]): Record<string, unknown> {
  console.log(`\n${'='.repeat(70)}\n${label}: ${names.join(' + ')}\n${'='.repeat(70)}`);
  const data = loadAligned(names);
  console.log(`Window: ${data.dates[0]} → ${data.dates.at(-1)} (${data.dates.length} days, eval after ${WARMUP_DAYS}d warmup)`);

  const { norm } = volNormalize(data.raw);

  // Correlations (full window, normalized sleeves) — context for the reader
  console.log('\nPairwise correlations (vol-normalized, full window):');
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      console.log(`  ${names[i]} × ${names[j]}: ${fmt(corrOf(norm[i]!, norm[j]!), 3)}`);
    }
  }

  // Single-sleeve benchmarks (vol-normalized, same eval window)
  console.log('\nSingle-sleeve benchmarks (vol-normalized to 10% ann):');
  const sleeveStats: Record<string, unknown> = {};
  for (let i = 0; i < names.length; i++) {
    const xs = norm[i]!.slice(WARMUP_DAYS);
    const s = { annRetPct: Math.round(mean(xs) * 252 * 1000) / 10, sharpe: Math.round(annSharpe(xs) * 100) / 100, maxDDPct: Math.round(maxDDCompounded(xs) * 1000) / 10 };
    sleeveStats[names[i]!] = s;
    console.log(`  ${names[i]!.padEnd(12)} annRet=${s.annRetPct}% sharpe=${s.sharpe} maxDD=${s.maxDDPct}%`);
  }

  const methods: Array<[string, WeightFn]> = [
    ['ew', weightEqual],
    ['handcraft', weightHandcraft],
    ['erc', weightERC],
    ['mvshrunk', weightMVShrunk],
  ];
  const results = methods.map(([name, fn]) => runMethod(name, fn, data, norm));

  console.log('\nMethod comparison (raw = weights+DM only; vt = +12% vol-target overlay):');
  console.log('method     | raw: annRet% sharpe maxDD% | vt: annRet% sharpe maxDD% | avgW | avgDM');
  for (const r of results) {
    console.log(
      `${r.name.padEnd(10)} | ${String(r.raw.annRetPct).padStart(7)} ${String(r.raw.sharpe).padStart(6)} ${String(r.raw.maxDDPct).padStart(6)} | ` +
      `${String(r.volTargeted.annRetPct).padStart(7)} ${String(r.volTargeted.sharpe).padStart(6)} ${String(r.volTargeted.maxDDPct).padStart(6)} | ` +
      `[${r.avgWeights.join(', ')}] | ${r.avgDM}`,
    );
  }

  // Bootstrap: does any method beat EW?
  const ew = results.find((r) => r.name === 'ew')!;
  console.log('\nBlock-bootstrap Sharpe diff vs EW (raw series, 2000 iters):');
  const boots: Record<string, unknown> = {};
  for (const r of results) {
    if (r.name === 'ew') continue;
    const bRes = bootstrapSharpeDiff(r.dailyRaw, ew.dailyRaw);
    boots[r.name] = bRes;
    console.log(`  ${r.name.padEnd(10)} meanΔ=${bRes.meanDiff} 5thPct=${bRes.pct5} P(beats EW)=${bRes.probAWins}%`);
  }

  // Persist daily series for downstream stress validation (validate-combination.ts)
  const seriesPath = path.resolve(__dirname, '..', 'experiments', 'runs', `combined-daily-${key}.json`);
  fs.writeFileSync(seriesPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    label,
    names,
    evalDates: data.dates.slice(WARMUP_DAYS),
    sleevesNormalized: Object.fromEntries(names.map((n, i) => [n, norm[i]!.slice(WARMUP_DAYS)])),
    methods: Object.fromEntries(results.map((r) => [r.name, { raw: r.dailyRaw, volTargeted: r.dailyVT }])),
  }));
  console.log(`Daily series saved → ${seriesPath}`);

  return {
    label,
    names,
    window: { start: data.dates[0], end: data.dates.at(-1), days: data.dates.length },
    sleeveStats,
    methods: results.map((r) => ({
      name: r.name, raw: r.raw, volTargeted: r.volTargeted,
      avgWeights: r.avgWeights, avgDM: r.avgDM, rebalances: r.rebalances,
    })),
    bootstrapVsEW: boots,
  };
}

function main(): void {
  const out: Record<string, unknown>[] = [];
  // Universe A: everything (window limited by crypto OOS start)
  out.push(runUniverse('A', 'UNIVERSE A — all three sleeves', ['crypto', 'sessionBook', 'f2f']));
  // Universe B: long history (2015+), sessionBook + f2f only
  out.push(runUniverse('B', 'UNIVERSE B — long history', ['sessionBook', 'f2f']));
  // Universe C: realistic retail frictions (sessionBookRetail from audit-leg-friction.ts)
  try {
    out.push(runUniverse('C', 'UNIVERSE C — retail-friction book', ['crypto', 'sessionBookRetail', 'f2f']));
  } catch {
    console.log('\n(Universe C skipped — run scripts/audit-leg-friction.ts first to emit sessionBookRetail)');
  }

  const outPath = path.resolve(__dirname, '..', 'experiments', 'runs', 'strategy-combination-results.json');
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), universes: out }, null, 2));
  console.log(`\nSaved → ${outPath}`);
}

main();
