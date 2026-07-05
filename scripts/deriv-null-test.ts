#!/usr/bin/env tsx
/**
 * Deriv Synthetics — Null / Falsification Test
 *
 * Before running any pattern-based bot on a Deriv synthetic, we ask the only
 * questions that can pre-empt the whole exercise:
 *
 *   1. Is there serial dependence a strategy could exploit?  (return autocorr)
 *   2. Is there a directional drift?                          (mean return / Sharpe)
 *   3. What is the structural asymmetry?                      (skew, up vs down moves)
 *
 * Expectation (grounded in edge-source-vs-signal-hunting):
 *   - Volatility indices (R_*) are constant-vol GBM → autocorr ≈ 0 → NO timing
 *     edge is mathematically possible (martingale). Pure null control.
 *   - Boom/Crash add Poisson spikes (one-directional) → strong skew, but the
 *     spike timing is random and the drift/spike trade-off is calibrated to
 *     ~zero EV net of spread (house edge lives in the spread).
 *
 * Usage:
 *   npx tsx scripts/deriv-null-test.ts --symbols BOOM500,CRASH500,R_75 --tf 1h
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types/candle';

function getArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

function logReturns(candles: Candle[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!.close;
    const cur = candles[i]!.close;
    if (prev > 0 && cur > 0) r.push(Math.log(cur / prev));
  }
  return r;
}

function mean(x: number[]): number {
  return x.reduce((s, v) => s + v, 0) / x.length;
}

function std(x: number[], m = mean(x)): number {
  const v = x.reduce((s, val) => s + (val - m) ** 2, 0) / (x.length - 1);
  return Math.sqrt(v);
}

function skewness(x: number[]): number {
  const m = mean(x);
  const s = std(x, m);
  if (s === 0) return 0;
  const n = x.length;
  return x.reduce((acc, v) => acc + ((v - m) / s) ** 3, 0) / n;
}

function excessKurtosis(x: number[]): number {
  const m = mean(x);
  const s = std(x, m);
  if (s === 0) return 0;
  const n = x.length;
  return x.reduce((acc, v) => acc + ((v - m) / s) ** 4, 0) / n - 3;
}

/** Sample autocorrelation at a given lag. */
function autocorr(x: number[], lag: number): number {
  const m = mean(x);
  const n = x.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) den += (x[i]! - m) ** 2;
  for (let i = lag; i < n; i++) num += (x[i]! - m) * (x[i - lag]! - m);
  return den === 0 ? 0 : num / den;
}

/** Bars per year for annualization. */
function barsPerYear(tf: string): number {
  const map: Record<string, number> = {
    '1m': 525_600,
    '5m': 105_120,
    '15m': 35_040,
    '1h': 8_760,
    '4h': 2_190,
    '1d': 365,
  };
  return map[tf] ?? 8_760;
}

function main(): void {
  const symbolsArg = getArg('symbols') ?? 'BOOM500,CRASH500,BOOM1000,CRASH1000,R_25,R_75,R_100';
  const tf = getArg('tf') ?? '1h';
  const symbols = symbolsArg.split(',').map((s) => s.trim()).filter(Boolean);
  const bpy = barsPerYear(tf);

  console.log(`\n=== Deriv Null Test (${tf}) ===`);
  console.log(
    'symbol'.padEnd(11) +
      'N'.padStart(8) +
      'annRet%'.padStart(10) +
      'annVol%'.padStart(9) +
      'Sharpe'.padStart(8) +
      'skew'.padStart(8) +
      'exKurt'.padStart(8) +
      '  ac1     ac2     ac3     ac5    ac10',
  );

  for (const sym of symbols) {
    const p = path.resolve(__dirname, '..', 'data', `${sym}_${tf}.json`);
    if (!fs.existsSync(p)) {
      console.log(`${sym.padEnd(11)}  (no data at ${p})`);
      continue;
    }
    const candles = JSON.parse(fs.readFileSync(p, 'utf-8')) as Candle[];
    const r = logReturns(candles);
    if (r.length < 50) {
      console.log(`${sym.padEnd(11)}  (only ${r.length} returns)`);
      continue;
    }

    const m = mean(r);
    const s = std(r, m);
    const annRet = m * bpy * 100;
    const annVol = s * Math.sqrt(bpy) * 100;
    const sharpe = s === 0 ? 0 : (m / s) * Math.sqrt(bpy);
    const sk = skewness(r);
    const ek = excessKurtosis(r);

    // 2-sigma noise band for autocorrelation: |ac| < 2/sqrt(N) is indistinguishable from 0
    const band = 2 / Math.sqrt(r.length);
    const mark = (ac: number) => (Math.abs(ac) > band ? '*' : ' ');
    const fmtAc = (lag: number) => {
      const ac = autocorr(r, lag);
      return `${ac >= 0 ? '+' : ''}${ac.toFixed(3)}${mark(ac)}`;
    };

    console.log(
      sym.padEnd(11) +
        String(r.length).padStart(8) +
        annRet.toFixed(1).padStart(10) +
        annVol.toFixed(1).padStart(9) +
        sharpe.toFixed(2).padStart(8) +
        sk.toFixed(2).padStart(8) +
        ek.toFixed(1).padStart(8) +
        '  ' +
        [fmtAc(1), fmtAc(2), fmtAc(3), fmtAc(5), fmtAc(10)].join(' '),
    );
  }

  console.log(`\n  * = |autocorrelation| exceeds the 2/sqrt(N) noise band (potentially exploitable serial dependence)`);
  console.log(`  GBM nulls (R_*) should show NO marked autocorrelation → no timing edge is possible.`);
  console.log(`  Skew is the Boom/Crash spike signature (Boom: +, Crash: -); it is NOT a timing edge by itself.\n`);
}

main();
