#!/usr/bin/env tsx
/**
 * Funding-Arb Parameter Sweep
 *
 * Sweeps (minFundingRate, closeBelowRate) over a coarse grid. For each config,
 * computes Sharpe + WF pass rate + Deflated Sharpe with proper selection-bias
 * correction (numTrials = total config count). Ranks by deflated Sharpe.
 *
 * Output: experiments/funding-arb-sweep-results.json
 *
 * The top-ranked config from this run becomes the candidate for re-validation
 * via `validate-funding-arb.ts --min-rate X --close-rate Y`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  loadFundingData,
  backtestSymbol,
  type ArbTrade,
  type BacktestConfig,
} from './backtest-funding-arb';
import {
  walkForwardValWindows,
  tradesInWindow,
  computeAnnualizedSharpeFromReturns,
} from '@/lib/funding-arb-validation';
import { calculateDeflatedSharpe } from '@/lib/rl/utils/deflated-sharpe';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const POSITION_SIZE = 2000;
const TRAIN_DAYS = 180;
const VAL_DAYS = 30;
const SLIDE_DAYS = 30;

const MIN_RATES = [0.00005, 0.0001, 0.00015, 0.0002, 0.0003, 0.0005];
const CLOSE_RATES = [0.00001, 0.000025, 0.00005, 0.0001];

interface SweepResult {
  minFundingRate: number;
  closeBelowRate: number;
  totalTrades: number;
  netPnl: number;
  sharpe: number;
  deflatedSharpe: number;
  wfPassRate: number;
  wfWindowsTotal: number;
  skipped?: string;
}

const baseConfig: Omit<BacktestConfig, 'minFundingRate' | 'closeBelowRate'> = {
  symbols: SYMBOLS,
  positionSizeUSDT: POSITION_SIZE,
  maxHoldTimeHours: 168,
  commissionPerSide: 0.00055,
  spreadAssumption: { BTCUSDT: 0.0002, ETHUSDT: 0.0003, SOLUSDT: 0.0003 },
  maxArbPositions: 3,
};

console.log('='.repeat(76));
console.log('Funding-Arb Parameter Sweep');
console.log('='.repeat(76));

// Pre-load all data once across the sweep
const dataBySymbol = new Map<string, ReturnType<typeof loadFundingData>>();
for (const sym of SYMBOLS) {
  dataBySymbol.set(sym, loadFundingData(sym));
}

const results: SweepResult[] = [];
const validConfigs = MIN_RATES.flatMap((mr: number) =>
  CLOSE_RATES.filter((cr: number) => cr < mr).map((cr: number) => [mr, cr] as const),
);
const numTrials = validConfigs.length;

console.log(`Grid: ${MIN_RATES.length} min-rates × ${CLOSE_RATES.length} close-rates = ${MIN_RATES.length * CLOSE_RATES.length} cells`);
console.log(`Valid configs (closeRate < minRate): ${numTrials}`);
console.log('');

for (const [minFundingRate, closeBelowRate] of validConfigs) {
  const config: BacktestConfig = { ...baseConfig, minFundingRate, closeBelowRate };
  const allTrades: ArbTrade[] = [];
  for (const sym of SYMBOLS) {
    const records = dataBySymbol.get(sym)!;
    allTrades.push(...backtestSymbol(sym, records, config));
  }
  allTrades.sort((a: ArbTrade, b: ArbTrade) => a.entryTimestamp - b.entryTimestamp);

  if (allTrades.length < 5) {
    results.push({
      minFundingRate, closeBelowRate,
      totalTrades: allTrades.length,
      netPnl: allTrades.reduce((s: number, t: ArbTrade) => s + t.netPnl, 0),
      sharpe: 0, deflatedSharpe: 0, wfPassRate: 0, wfWindowsTotal: 0,
      skipped: 'too few trades for stats',
    });
    continue;
  }

  const netPnl = allTrades.reduce((s: number, t: ArbTrade) => s + t.netPnl, 0);
  const rangeStart = allTrades[0]!.entryTimestamp;
  const rangeEnd = allTrades[allTrades.length - 1]!.entryTimestamp;
  const yearsSpan = (rangeEnd - rangeStart) / (365.25 * 86_400_000);
  const tradesPerYear = yearsSpan > 0 ? allTrades.length / yearsSpan : 0;
  const returns = allTrades.map((t: ArbTrade) => t.netPnl / POSITION_SIZE);
  const sharpe = computeAnnualizedSharpeFromReturns(returns, tradesPerYear) ?? 0;
  const dsr = calculateDeflatedSharpe(sharpe, allTrades.length, numTrials);

  const windows = walkForwardValWindows(rangeStart, rangeEnd, TRAIN_DAYS, VAL_DAYS, SLIDE_DAYS);
  let wfPass = 0;
  let wfTotal = 0;
  for (const w of windows) {
    const wt = tradesInWindow(allTrades, w.startMs, w.endMs);
    if (wt.length === 0) continue;
    wfTotal += 1;
    if (wt.reduce((s: number, t: ArbTrade) => s + t.netPnl, 0) > 0) wfPass += 1;
  }
  const wfPassRate = wfTotal > 0 ? wfPass / wfTotal : 0;

  results.push({
    minFundingRate, closeBelowRate,
    totalTrades: allTrades.length,
    netPnl,
    sharpe,
    deflatedSharpe: dsr.deflatedSharpe,
    wfPassRate,
    wfWindowsTotal: wfTotal,
  });
}

// Rank by deflated Sharpe desc
results.sort((a: SweepResult, b: SweepResult) => b.deflatedSharpe - a.deflatedSharpe);

// Print summary
console.log('\nTop 10 configs (ranked by deflated Sharpe, numTrials=' + numTrials + '):');
console.log(' rank | minRate    | closeRate  | trades | net PnL  | Sharpe | DSR    | WF%    | WF win');
console.log('------|-----------|------------|--------|----------|--------|--------|--------|-------');
for (let i = 0; i < Math.min(10, results.length); i++) {
  const r = results[i]!;
  console.log(
    `  ${String(i + 1).padStart(2)}  | ` +
      `${(r.minFundingRate * 100).toFixed(4).padStart(8)}% | ` +
      `${(r.closeBelowRate * 100).toFixed(4).padStart(8)}% | ` +
      `${String(r.totalTrades).padStart(6)} | ` +
      `$${r.netPnl.toFixed(0).padStart(7)} | ` +
      `${r.sharpe.toFixed(2).padStart(6)} | ` +
      `${r.deflatedSharpe.toFixed(2).padStart(6)} | ` +
      `${(r.wfPassRate * 100).toFixed(1).padStart(5)}% | ` +
      `${r.wfWindowsTotal}`,
  );
}

const skipped = results.filter((r: SweepResult) => r.skipped).length;
if (skipped > 0) {
  console.log(`\n(${skipped}/${results.length} configs skipped due to too few trades)`);
}

const best = results[0]!;
console.log('\n' + '='.repeat(76));
console.log(`BEST: minRate=${(best.minFundingRate * 100).toFixed(4)}% closeRate=${(best.closeBelowRate * 100).toFixed(4)}%`);
console.log(`     Sharpe=${best.sharpe.toFixed(2)}  DSR=${best.deflatedSharpe.toFixed(2)}  trades=${best.totalTrades}  WF=${(best.wfPassRate * 100).toFixed(1)}%`);
console.log('='.repeat(76));

const out = path.resolve('experiments/funding-arb-sweep-results.json');
fs.writeFileSync(out, JSON.stringify({ numTrials, gridShape: { minRates: MIN_RATES, closeRates: CLOSE_RATES }, results }, null, 2));
console.log(`\nWrote ${out}`);
console.log('\nNext: validate the best config end-to-end:');
console.log(`  npx tsx scripts/validate-funding-arb.ts --min-rate ${best.minFundingRate} --close-rate ${best.closeBelowRate}`);
