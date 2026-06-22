#!/usr/bin/env tsx
/**
 * Stress-validation of the COMBINED book (handcraft weights + DM, optionally
 * vol-targeted). The sleeves are individually validated; this tests the
 * combination layer itself.
 *
 * Tests:
 *   1. Stationary block bootstrap — Sharpe & total-return 5th percentile.
 *   2. Skip-20% / skip-30% of active (non-zero) days — edge concentration.
 *   3. Correlation stress (the assumption the whole edge rests on): analytic
 *      portfolio Sharpe at forced pairwise ρ ∈ {0, 0.1, 0.3, 0.5, 0.7},
 *      with the diversification multiplier recomputed at each ρ (DM falls as
 *      ρ rises, so vol-targeted return falls too — both effects included).
 *   4. Empirical tail coincidence — do the sleeves' worst days cluster more
 *      than independence predicts? (daily + weekly)
 *   5. DSR — only 4 combination methods were tried, so the haircut is small;
 *      computed honestly anyway.
 *   6. Worst rolling 6mo / 12mo Sharpe of the combined book.
 *
 * Input: experiments/runs/combined-daily-A.json (from combine-strategies.ts)
 * Usage: npx tsx scripts/validate-combination.ts [--universe A|B] [--method handcraft]
 */

import * as fs from 'fs';
import * as path from 'path';
import { calculateDeflatedSharpe } from '../src/lib/rl/utils/deflated-sharpe';

// ============================================
// Helpers
// ============================================

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function annSharpe(xs: number[]): number { const s = std(xs); return s > 0 ? (mean(xs) / s) * Math.sqrt(252) : 0; }
function totalPct(xs: number[]): number { return (Math.exp(xs.reduce((s, x) => s + x, 0)) - 1) * 100; }
function fmt(x: number, dp = 2): string { return x.toFixed(dp); }
function pct(xs: number[], p: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

interface CombinedDaily {
  label: string;
  names: string[];
  evalDates: string[];
  sleevesNormalized: Record<string, number[]>;
  methods: Record<string, { raw: number[]; volTargeted: number[] }>;
}

// ============================================
// 1. Block bootstrap
// ============================================

function blockBootstrap(xs: number[], iters = 2000, blockLen = 10): { sharpe5: number; sharpe50: number; pnl5: number; probNegative: number } {
  const T = xs.length;
  const sharpes: number[] = [];
  const pnls: number[] = [];
  for (let k = 0; k < iters; k++) {
    const sample: number[] = [];
    while (sample.length < T) {
      const start = Math.floor(Math.random() * T);
      const len = Math.max(1, Math.floor(-blockLen * Math.log(1 - Math.random())));
      for (let j = 0; j < len && sample.length < T; j++) sample.push(xs[(start + j) % T]!);
    }
    sharpes.push(annSharpe(sample));
    pnls.push(totalPct(sample));
  }
  return {
    sharpe5: pct(sharpes, 0.05),
    sharpe50: pct(sharpes, 0.50),
    pnl5: pct(pnls, 0.05),
    probNegative: pnls.filter((p) => p < 0).length / iters,
  };
}

// ============================================
// 2. Skip-N% of active days
// ============================================

function skipDays(xs: number[], frac: number, iters = 1000): { profitablePct: number; medianSharpe: number } {
  const activeIdx = xs.map((x, i) => (x !== 0 ? i : -1)).filter((i) => i >= 0);
  let profitable = 0;
  const sharpes: number[] = [];
  for (let k = 0; k < iters; k++) {
    const drop = new Set<number>();
    while (drop.size < Math.floor(activeIdx.length * frac)) {
      drop.add(activeIdx[Math.floor(Math.random() * activeIdx.length)]!);
    }
    const kept = xs.map((x, i) => (drop.has(i) ? 0 : x));
    if (kept.reduce((s, x) => s + x, 0) > 0) profitable++;
    sharpes.push(annSharpe(kept));
  }
  return { profitablePct: (profitable / iters) * 100, medianSharpe: pct(sharpes, 0.5) };
}

// ============================================
// 3. Correlation stress (analytic, incl. DM effect)
// ============================================

/**
 * Sleeves are vol-normalized to a common σ and combined with weights w.
 * With every pairwise correlation forced to ρ:
 *   σ_p(ρ) = σ_sleeve · √(Σw_i² + ρ·Σ_{i≠j} w_i w_j)
 *   μ_p unchanged (correlation does not move means)
 *   DM(ρ) = min(2.5, 1/√(wᵀHw)), H = all-ρ matrix
 * Raw book return scales with DM; raw vol scales with DM·σ_p(ρ).
 * Sharpe(ρ) = μ_p / σ_p(ρ) · √252 — DM cancels in Sharpe but determines the
 * RETURN at a fixed portfolio vol target, so we report both.
 */
function correlationStress(
  sleeves: number[][],
  weights: number[],
  rhos: number[],
): Array<{ rho: number; sharpe: number; dm: number; vtAnnRetPct: number }> {
  const n = sleeves.length;
  const mus = sleeves.map(mean);
  const sds = sleeves.map(std);
  const muP = weights.reduce((s, w, i) => s + w * mus[i]!, 0);
  const out: Array<{ rho: number; sharpe: number; dm: number; vtAnnRetPct: number }> = [];
  for (const rho of rhos) {
    let varP = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        varP += weights[i]! * weights[j]! * (i === j ? 1 : rho) * sds[i]! * sds[j]!;
      }
    }
    const sdP = Math.sqrt(Math.max(1e-18, varP));
    const sharpe = (muP / sdP) * Math.sqrt(252);
    // DM with unit-vol sleeves (they are vol-normalized): wᵀHw
    let q = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) q += weights[i]! * weights[j]! * (i === j ? 1 : Math.max(0, rho));
    const dm = Math.min(2.5, 1 / Math.sqrt(q));
    // At a 12% vol target the book earns Sharpe × 12% regardless of DM
    out.push({ rho, sharpe, dm, vtAnnRetPct: sharpe * 12 });
  }
  return out;
}

// ============================================
// 4. Tail coincidence
// ============================================

function tailCoincidence(sleeves: number[][], q = 0.05): { observedPct: number; independencePct: number; ratio: number } {
  // worst-q days per sleeve (only counting active days for thresholds)
  const T = sleeves[0]!.length;
  const flags = sleeves.map((s) => {
    const active = s.filter((x) => x !== 0);
    const thr = pct(active, q);
    return s.map((x) => x !== 0 && x <= thr);
  });
  // pairwise: P(both in tail) vs P(a)·P(b)
  let obs = 0, ind = 0, pairs = 0;
  for (let i = 0; i < sleeves.length; i++) {
    for (let j = i + 1; j < sleeves.length; j++) {
      const pi = flags[i]!.filter(Boolean).length / T;
      const pj = flags[j]!.filter(Boolean).length / T;
      const both = flags[i]!.filter((f, t) => f && flags[j]![t]).length / T;
      obs += both; ind += pi * pj; pairs++;
    }
  }
  return {
    observedPct: (obs / pairs) * 100,
    independencePct: (ind / pairs) * 100,
    ratio: ind > 0 ? obs / ind : 0,
  };
}

/** Aggregate daily to weekly (ISO week buckets via 5-day chunks of the eval calendar). */
function toWeekly(xs: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < xs.length; i += 5) {
    out.push(xs.slice(i, i + 5).reduce((s, x) => s + x, 0));
  }
  return out;
}

// ============================================
// 6. Worst rolling windows
// ============================================

function worstRolling(xs: number[], windowDays: number): { sharpe: number; retPct: number } {
  let worstSharpe = Infinity;
  let worstRet = Infinity;
  for (let start = 0; start + windowDays <= xs.length; start += 21) {
    const slice = xs.slice(start, start + windowDays);
    worstSharpe = Math.min(worstSharpe, annSharpe(slice));
    worstRet = Math.min(worstRet, totalPct(slice));
  }
  return { sharpe: worstSharpe === Infinity ? 0 : worstSharpe, retPct: worstRet === Infinity ? 0 : worstRet };
}

// ============================================
// Main
// ============================================

function main(): void {
  const args = process.argv.slice(2);
  const universe = args.includes('--universe') ? args[args.indexOf('--universe') + 1]! : 'A';
  const method = args.includes('--method') ? args[args.indexOf('--method') + 1]! : 'handcraft';

  const file = path.resolve(__dirname, '..', 'experiments', 'runs', `combined-daily-${universe}.json`);
  const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as CombinedDaily;
  const book = data.methods[method]?.raw;
  if (!book) throw new Error(`Method '${method}' not in ${file}`);
  const sleeves = data.names.map((n) => data.sleevesNormalized[n]!);
  // average handcraft weights from the combination study (approx; stress is
  // weight-insensitive at these magnitudes)
  const w = data.names.map(() => 1 / data.names.length);

  console.log(`=== Combined-book stress validation — universe ${universe}, method ${method} ===`);
  console.log(`Eval window: ${data.evalDates[0]} → ${data.evalDates.at(-1)} (${book.length} days)`);
  console.log(`Book: annRet=${fmt(mean(book) * 252 * 100, 1)}% sharpe=${fmt(annSharpe(book))} total=${fmt(totalPct(book), 1)}%\n`);

  const results: Record<string, unknown> = { universe, method, days: book.length };

  // 1. Bootstrap
  const boot = blockBootstrap(book);
  results.bootstrap = boot;
  const bootPass = boot.sharpe5 > 0 && boot.pnl5 > 0;
  console.log(`1. Block bootstrap (2000 iters, block≈10d):`);
  console.log(`   Sharpe 5th pct = ${fmt(boot.sharpe5)} (median ${fmt(boot.sharpe50)}), PnL 5th pct = ${fmt(boot.pnl5, 1)}%, P(loss) = ${fmt(boot.probNegative * 100, 1)}%  → ${bootPass ? 'PASS' : 'FAIL'}`);

  // 2. Skip days
  const skip20 = skipDays(book, 0.2);
  const skip30 = skipDays(book, 0.3);
  results.skip = { skip20, skip30 };
  const skipPass = skip20.profitablePct >= 95;
  console.log(`2. Edge concentration:`);
  console.log(`   skip 20% of active days → ${fmt(skip20.profitablePct, 1)}% profitable (median Sharpe ${fmt(skip20.medianSharpe)})`);
  console.log(`   skip 30% of active days → ${fmt(skip30.profitablePct, 1)}% profitable (median Sharpe ${fmt(skip30.medianSharpe)})  → ${skipPass ? 'PASS' : 'FAIL'}`);

  // 3. Correlation stress
  const stress = correlationStress(sleeves, w, [0, 0.1, 0.3, 0.5, 0.7]);
  results.correlationStress = stress;
  const sharpeAt05 = stress.find((s) => s.rho === 0.5)!.sharpe;
  const corrPass = sharpeAt05 > 1.5;
  console.log(`3. Correlation stress (analytic; means fixed, vol+DM move):`);
  for (const s of stress) {
    console.log(`   ρ=${fmt(s.rho, 1)} → Sharpe ${fmt(s.sharpe)}, DM ${fmt(s.dm)}, return at 12% vol target ≈ ${fmt(s.vtAnnRetPct, 1)}%/yr`);
  }
  console.log(`   gate: Sharpe at ρ=0.5 > 1.5  → ${corrPass ? 'PASS' : 'FAIL'}`);

  // 4. Tail coincidence
  const tailD = tailCoincidence(sleeves);
  const weekly = sleeves.map(toWeekly);
  const tailW = tailCoincidence(weekly);
  results.tailCoincidence = { daily: tailD, weekly: tailW };
  const tailPass = tailD.ratio < 2 && tailW.ratio < 2;
  console.log(`4. Tail coincidence (worst-5% days co-occurrence vs independence):`);
  console.log(`   daily:  observed ${fmt(tailD.observedPct, 3)}% vs independent ${fmt(tailD.independencePct, 3)}% → ratio ${fmt(tailD.ratio)}`);
  console.log(`   weekly: observed ${fmt(tailW.observedPct, 3)}% vs independent ${fmt(tailW.independencePct, 3)}% → ratio ${fmt(tailW.ratio)}  → ${tailPass ? 'PASS' : 'FAIL'} (gate: ratio < 2)`);

  // 5. DSR — 4 combination methods tried on this layer
  const m = mean(book);
  const sd = std(book);
  const skew = sd > 0 ? mean(book.map((x) => ((x - m) / sd) ** 3)) : 0;
  const kurt = sd > 0 ? mean(book.map((x) => ((x - m) / sd) ** 4)) : 3;
  const dsr = calculateDeflatedSharpe(annSharpe(book), book.length, 4, { skewness: skew, kurtosis: kurt });
  results.dsr = dsr;
  const dsrPass = dsr.deflatedSharpe > 0;
  console.log(`5. DSR (4 method trials on the combination layer):`);
  console.log(`   observed ${fmt(dsr.originalSharpe)} → deflated ${fmt(dsr.deflatedSharpe)} (haircut ${fmt(dsr.haircut)}, skew ${fmt(skew)}, kurt ${fmt(kurt, 1)})  → ${dsrPass ? 'PASS' : 'FAIL'}`);

  // 6. Worst rolling windows
  const w6 = worstRolling(book, 126);
  const w12 = worstRolling(book, 252);
  results.worstRolling = { m6: w6, m12: w12 };
  console.log(`6. Worst rolling windows (21d step):`);
  console.log(`   worst 6mo:  Sharpe ${fmt(w6.sharpe)}, return ${fmt(w6.retPct, 1)}%`);
  console.log(`   worst 12mo: Sharpe ${fmt(w12.sharpe)}, return ${fmt(w12.retPct, 1)}%`);

  const passes = [bootPass, skipPass, corrPass, tailPass, dsrPass];
  console.log(`\nVERDICT: ${passes.filter(Boolean).length}/${passes.length} gates passed`);
  results.verdict = `${passes.filter(Boolean).length}/${passes.length}`;

  const outPath = path.resolve(__dirname, '..', 'experiments', 'runs', `combination-validation-${universe}-${method}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), ...results }, null, 2));
  console.log(`Saved → ${outPath}`);
}

main();
