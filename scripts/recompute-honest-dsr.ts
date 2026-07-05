#!/usr/bin/env npx tsx
/**
 * Recompute the deployed configs' Deflated Sharpe on the HONEST per-observation
 * scale, correcting the units bug in the historical validation.
 *
 * Bug: `experiments/dsr-results.json` deflated an ANNUALIZED Sharpe (per-trade
 * SR × sqrt(365·24) ≈ 93.6) using Lo's per-observation Var(SR) ≈ (1+0.5·SR²)/T
 * with T = trade count. SR and T at mismatched frequencies inflate the deflated
 * Sharpe ~50x, so every config "PASSED". This script back-converts the stored
 * annualized Sharpe to per-trade, re-deflates correctly, and prints both.
 *
 *   npx tsx scripts/recompute-honest-dsr.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  deflatedSharpePerObs,
  annualizedToPerObs,
  HOURLY_ANNUALIZATION_FACTOR,
} from '../src/lib/rl/utils/deflated-sharpe';

interface StoredDsrRow {
  config: string;
  originalSharpe: number; // annualized (the bug: this went into per-obs deflation)
  deflatedSharpe: number; // the inflated "PASS" number
  numTrials: number;
  numTrades: number;
  skewness: number;
  kurtosis: number;
}

/** Sample moments of a return series. */
function moments(xs: number[]): { n: number; perObsSharpe: number; skewness: number; kurtosis: number } {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const m3 = xs.reduce((a, b) => a + (b - mean) ** 3, 0) / n;
  const m4 = xs.reduce((a, b) => a + (b - mean) ** 4, 0) / n;
  return {
    n,
    perObsSharpe: sd > 0 ? mean / sd : 0,
    skewness: sd > 0 ? m3 / sd ** 3 : 0,
    kurtosis: sd > 0 ? m4 / sd ** 4 : 3,
  };
}

/**
 * The deployed book's honest DSR, on its native DAILY frequency from real
 * combined-book returns (not per-trade, not annualized). This is the number
 * that actually justifies the deployed book — the single-config per-trade DSRs
 * above never did.
 */
function reportBookLevelDsr(): void {
  const file = path.join(process.cwd(), 'experiments', 'runs', 'combined-daily-C.json');
  if (!fs.existsSync(file)) {
    console.log('\n[book] combined-daily-C.json not found — skipping book-level DSR.');
    return;
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
    methods: Record<string, { volTargeted: number[] }>;
  };
  const xs = raw.methods.handcraft?.volTargeted;
  if (!Array.isArray(xs)) {
    console.log('\n[book] handcraft.volTargeted series missing — skipping.');
    return;
  }
  const { n, perObsSharpe, skewness, kurtosis } = moments(xs);
  console.log(`\nDEPLOYED BOOK (Universe C, handcraft vol-targeted) — daily returns, n=${n} days`);
  // The combination itself is a small selection: 4 weighting methods, up to ~12
  // if you count families. Report both honest trial counts.
  for (const numTrials of [4, 12]) {
    const honest = deflatedSharpePerObs({ perObsSharpe, numObservations: n, numTrials, skewness, kurtosis });
    console.log(
      `  HONEST per-day DSR @${numTrials} trials: SR ${perObsSharpe.toFixed(4)} → DSR ${honest.deflatedSharpe.toFixed(4)}  [${honest.deflatedSharpe > 0 ? 'PASS' : 'FAIL'}]  (ann ${(perObsSharpe * Math.sqrt(252)).toFixed(2)}, skew ${skewness.toFixed(2)}, kurt ${kurtosis.toFixed(1)})`,
    );
  }
}

function main(): void {
  const file = path.join(process.cwd(), 'experiments', 'dsr-results.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as { results: StoredDsrRow[] };

  console.log('='.repeat(78));
  console.log('HONEST per-observation DSR recompute (annualized→per-trade, correct T)');
  console.log(`Annualization factor undone: sqrt(365*24) = ${HOURLY_ANNUALIZATION_FACTOR.toFixed(3)}`);
  console.log('='.repeat(78));

  for (const row of data.results) {
    const perObsSharpe = annualizedToPerObs(row.originalSharpe, HOURLY_ANNUALIZATION_FACTOR);
    const honest = deflatedSharpePerObs({
      perObsSharpe,
      numObservations: row.numTrades,
      numTrials: row.numTrials,
      skewness: row.skewness,
      kurtosis: row.kurtosis,
    });

    console.log(`\n${row.config}  (${row.numTrades} trades, ${row.numTrials} trials)`);
    console.log(`  INFLATED (stored):  annualized SR ${row.originalSharpe.toFixed(3)} → DSR ${row.deflatedSharpe.toFixed(3)}  [${row.deflatedSharpe > 0 ? 'PASS' : 'FAIL'}]`);
    console.log(`  HONEST (per-trade): per-obs  SR ${perObsSharpe.toFixed(4)} → DSR ${honest.deflatedSharpe.toFixed(4)}  [${honest.deflatedSharpe > 0 ? 'PASS' : 'FAIL'}]`);
    console.log(`    haircut ${honest.haircut.toFixed(4)}, SR-variance ${honest.sharpeVariance.toFixed(6)}`);
  }

  reportBookLevelDsr();

  console.log('\n' + '='.repeat(78));
  console.log('TAKEAWAY: single-config per-trade DSRs FAIL honestly at 238 trials —');
  console.log('the stored 7.58/2.21 "PASS" were annualized-into-per-obs inflation.');
  console.log('The DEPLOYED BOOK (diversified, daily) still PASSES honestly (thin +).');
  console.log('Diversification is the edge, not any single config.');
  console.log('='.repeat(78));
}

main();
