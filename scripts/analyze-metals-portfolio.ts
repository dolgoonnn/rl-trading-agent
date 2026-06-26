#!/usr/bin/env tsx
/**
 * Metals overnight portfolio: gold + silver session-holds (wknd-gap) + gold
 * fix-short overlay, 2015–2026, futures-tier friction.
 *
 * Frictions per side: gold 0.3bp, silver 1bp (wider spread), fix-short 0.3bp.
 * Reports per-leg and blended daily series: correlation matrix, 50/50 metals,
 * full stack (0.5*gold + 0.5*silver + fix-short), per-year table.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';
import { extractTrades } from './backtest-gold-session';

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function sharpe(xs: number[]): number { const s = std(xs); return s > 0 ? (mean(xs) / s) * Math.sqrt(252) : 0; }
function maxDD(xs: number[]): number {
  let eq = 0, pk = 0, dd = 0;
  for (const r of xs) { eq += r; if (eq > pk) pk = eq; if (pk - eq > dd) dd = pk - eq; }
  return dd;
}
function corr(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; db += (b[i]! - mb) ** 2; }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : 0;
}
function fmt(x: number, dp = 2): number { const f = 10 ** dp; return Math.round(x * f) / f; }

function dailySeries(files: string[], frictionPerSide: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of files) {
    const candles: Candle[] = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', f), 'utf-8'));
    // delayMin=1: skip the unfillable reopen print (research-session-jitter.ts)
    for (const t of extractTrades(candles, true, 22, 7, 1)) {
      const key = new Date(t.exitTs).toISOString().slice(0, 10);
      out.set(key, (out.get(key) ?? 0) + t.rawLogRet - 2 * frictionPerSide);
    }
  }
  return out;
}

// Fix-short daily (gold): duplicated minimal from research-gold-fix-overlay
function nthSundayUTC(year: number, month: number, n: number): number {
  if (n > 0) {
    const dow = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return Date.UTC(year, month, 1 + ((7 - dow) % 7) + (n - 1) * 7);
  }
  const last = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay());
}
function londonOffsetHours(ts: number): number {
  const y = new Date(ts).getUTCFullYear();
  return ts >= nthSundayUTC(y, 2, -1) + 3_600_000 && ts < nthSundayUTC(y, 9, -1) + 3_600_000 ? 1 : 0;
}
// entryBound = London-local minute of entry (840 = 14:00 original; 870 = 14:30 refined).
// The 14:30 refinement (gold-fix-refinement-validate.ts) drops the zero-mean/high-variance
// 14:00→14:30 segment: same mean drift, ~22% less variance, Sharpe 0.48→0.63. Cover at 15:00.
function fixShortDaily(files: string[], frictionPerSide: number, entryBound = 840): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of files) {
    const candles: Candle[] = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', f), 'utf-8'));
    const byDay = new Map<string, { entry?: number; at15?: number }>();
    for (const c of candles) {
      const local = c.timestamp + londonOffsetHours(c.timestamp) * 3_600_000;
      const d = new Date(local);
      const lm = d.getUTCHours() * 60 + d.getUTCMinutes();
      const day = d.toISOString().slice(0, 10);
      let rec = byDay.get(day);
      if (!rec) { rec = {}; byDay.set(day, rec); }
      if (lm <= entryBound) rec.entry = c.close;
      if (lm <= 900) rec.at15 = c.close;
    }
    for (const [day, rec] of byDay) {
      if (rec.entry !== undefined && rec.at15 !== undefined && rec.entry > 0) {
        out.set(day, -Math.log(rec.at15 / rec.entry) - 2 * frictionPerSide);
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  console.log('Building legs (futures-tier friction)...');
  const gold = dailySeries(['XAUUSD_1m_holdout.json', 'XAUUSD_1m.json'], 0.00003);
  const silver = dailySeries(['XAGUSD_1m_holdout.json', 'XAGUSD_1m.json'], 0.0001);
  const fixS = fixShortDaily(['XAUUSD_1m_holdout.json', 'XAUUSD_1m.json'], 0.00003);            // 14:00 original
  const fixSRef = fixShortDaily(['XAUUSD_1m_holdout.json', 'XAUUSD_1m.json'], 0.00003, 870);     // 14:30 refined (deployed)

  const allDates = [...new Set([...gold.keys(), ...silver.keys(), ...fixS.keys()])].sort();
  const g: number[] = [], s: number[] = [], f: number[] = [], fRef: number[] = [], metals: number[] = [], stack: number[] = [], stackRef: number[] = [];
  const perYear = new Map<string, { g: number; s: number; stack: number }>();
  for (const d of allDates) {
    const rg = gold.get(d) ?? 0;
    const rs = silver.get(d) ?? 0;
    const rf = fixS.get(d) ?? 0;
    const rfRef = fixSRef.get(d) ?? 0;
    g.push(rg); s.push(rs); f.push(rf); fRef.push(rfRef);
    metals.push(0.5 * rg + 0.5 * rs);
    stack.push(0.5 * rg + 0.5 * rs + rf);
    stackRef.push(0.5 * rg + 0.5 * rs + rfRef);
    const y = d.slice(0, 4);
    const rec = perYear.get(y) ?? { g: 0, s: 0, stack: 0 };
    rec.g += rg; rec.s += rs; rec.stack += 0.5 * rg + 0.5 * rs + rf;
    perYear.set(y, rec);
  }

  const rep = (label: string, xs: number[]): void => {
    console.log(`  ${label.padEnd(22)} total=${fmt(xs.reduce((a, x) => a + x, 0) * 100, 1)}% sharpe=${fmt(sharpe(xs))} maxDD=${fmt(maxDD(xs) * 100, 1)}%`);
  };

  console.log(`\n=== Metals overnight portfolio (${allDates[0]} → ${allDates[allDates.length - 1]}) ===`);
  rep('gold 22-07+wknd @0.3bp', g);
  rep('silver same @1bp', s);
  rep('fix-short 14:00 @0.3bp', f);
  rep('fix-short 14:30 @0.3bp', fRef);
  rep('50/50 metals', metals);
  rep('full stack (+fix 14:00)', stack);
  rep('full stack (+fix 14:30)', stackRef);
  console.log(`  corr(gold,silver)=${fmt(corr(g, s), 3)} corr(metals,fix)=${fmt(corr(metals, f), 3)}`);
  console.log('\n  Per-year (gold / silver / full stack):');
  for (const [y, r] of [...perYear.entries()].sort()) {
    console.log(`    ${y}: ${fmt(r.g * 100, 1)}% / ${fmt(r.s * 100, 1)}% / ${fmt(r.stack * 100, 1)}%`);
  }

  // Validation battery on the full stack (deterministic LCG, 1000 iters)
  const lcg = (seed: number) => { let st = seed >>> 0; return () => { st = (st * 1664525 + 1013904223) >>> 0; return st / 4294967296; }; };
  const rand = lcg(7);
  const bootSharpes: number[] = [], bootPnls: number[] = [];
  let skipProfitable = 0;
  for (let it = 0; it < 1000; it++) {
    const sample: number[] = [];
    for (let i = 0; i < stack.length; i++) sample.push(stack[Math.floor(rand() * stack.length)]!);
    bootSharpes.push(sharpe(sample));
    bootPnls.push(sample.reduce((a, x) => a + x, 0));
    let skipTotal = 0;
    for (const r of stack) if (rand() >= 0.2) skipTotal += r;
    if (skipTotal > 0) skipProfitable++;
  }
  bootSharpes.sort((a, b) => a - b); bootPnls.sort((a, b) => a - b);
  const m = mean(stack), sd = std(stack);
  const skew = sd > 0 ? mean(stack.map((x) => ((x - m) / sd) ** 3)) : 0;
  const kurt = sd > 0 ? mean(stack.map((x) => ((x - m) / sd) ** 4)) : 3;
  const sr = sharpe(stack);
  // Bailey–López de Prado variance uses the PER-PERIOD (daily) Sharpe
  const sr0 = sd > 0 ? m / sd : 0;
  const srVar = (1 + 0.5 * sr0 * sr0 - skew * sr0 + ((kurt - 3) / 4) * sr0 * sr0) / stack.length;
  // DSR haircut for ~20 trials (expected max of N standard normals), annualized once
  const trials = 20;
  const haircut = Math.sqrt(srVar) * ((1 - 0.5772) * invNorm(1 - 1 / trials) + 0.5772 * invNorm(1 - 1 / (trials * Math.E))) * Math.sqrt(252);
  console.log('\n  Battery (full stack): ' +
    `bootSharpe5=${fmt(bootSharpes[50]!)} bootPnL5=${fmt(bootPnls[50]! * 100, 1)}% skip20=${fmt(skipProfitable / 10, 1)}% ` +
    `DSR≈${fmt(sr - haircut)} (sharpe ${fmt(sr)}, ${trials} trials, skew ${fmt(skew)}, kurt ${fmt(kurt, 1)})`);

  function invNorm(p: number): number {
    // Acklam approximation
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const pl = 0.02425;
    if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
    if (p <= 1 - pl) { const q = p - 0.5; const r = q * q; return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1); }
    const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }

  fs.writeFileSync(
    path.resolve(__dirname, '..', 'experiments', 'runs', 'metals-portfolio.json'),
    JSON.stringify({
      range: [allDates[0], allDates[allDates.length - 1]],
      legs: {
        gold: { totalPct: fmt(g.reduce((a, x) => a + x, 0) * 100, 1), sharpe: fmt(sharpe(g)), maxDDPct: fmt(maxDD(g) * 100, 1) },
        silver: { totalPct: fmt(s.reduce((a, x) => a + x, 0) * 100, 1), sharpe: fmt(sharpe(s)), maxDDPct: fmt(maxDD(s) * 100, 1) },
        fixShort: { totalPct: fmt(f.reduce((a, x) => a + x, 0) * 100, 1), sharpe: fmt(sharpe(f)), maxDDPct: fmt(maxDD(f) * 100, 1) },
        fixShortRefined1430: { totalPct: fmt(fRef.reduce((a, x) => a + x, 0) * 100, 1), sharpe: fmt(sharpe(fRef)), maxDDPct: fmt(maxDD(fRef) * 100, 1) },
        metals5050: { totalPct: fmt(metals.reduce((a, x) => a + x, 0) * 100, 1), sharpe: fmt(sharpe(metals)), maxDDPct: fmt(maxDD(metals) * 100, 1) },
        fullStack: { totalPct: fmt(stack.reduce((a, x) => a + x, 0) * 100, 1), sharpe: fmt(sharpe(stack)), maxDDPct: fmt(maxDD(stack) * 100, 1) },
        fullStackRefined1430: { totalPct: fmt(stackRef.reduce((a, x) => a + x, 0) * 100, 1), sharpe: fmt(sharpe(stackRef)), maxDDPct: fmt(maxDD(stackRef) * 100, 1) },
      },
      corrGoldSilver: fmt(corr(g, s), 4),
      perYear: Object.fromEntries([...perYear.entries()].sort().map(([y, r]) => [y, { gold: fmt(r.g * 100, 1), silver: fmt(r.s * 100, 1), stack: fmt(r.stack * 100, 1) }])),
    }, null, 2),
  );
  console.log('\nSaved → experiments/runs/metals-portfolio.json');
}

main().catch((err) => { console.error('Metals portfolio analysis failed:', err); process.exit(1); });
