#!/usr/bin/env tsx
/**
 * Funding-Arb Validation
 *
 * Runs the existing funding-arb strategy at shipped defaults through:
 *   1. Baseline backtest (full data)
 *   2. Walk-forward (6mo train / 1mo val / 1mo slide)
 *   3. DSR (1-trial selection bias correction)
 *   4. MC bootstrap (1000 iter, Sharpe + PnL 5th percentile)
 *   5. MC skip-trades (20% drop, 1000 iter, profitable fraction)
 *
 * Output: experiments/funding-arb-validation-results.json (shape-compatible
 * with experiments/f2f-validation-results.json so path A's bootstrap-floors
 * loader can consume it later).
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
  tradesInWindow,
  walkForwardValWindows,
  computeAnnualizedSharpeFromReturns,
  arbTradesToMcTrades,
  assembleVerdict,
  type ValidationCheck,
  type ValidationResult,
} from '@/lib/funding-arb-validation';
import {
  bootstrapTrades,
  skipTrades,
} from '@/lib/rl/utils/monte-carlo';
import { calculateDeflatedSharpe } from '@/lib/rl/utils/deflated-sharpe';

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const TRAIN_DAYS = 180;
const VAL_DAYS = 30;
const SLIDE_DAYS = 30;
const MC_ITERATIONS = 1000;
const SKIP_RATE = 0.20;
const MIN_DATA_YEARS = 2.5;
const OUT_VALIDATION = path.resolve(
  'experiments/funding-arb-validation-results.json',
);
const OUT_BASELINE = path.resolve(
  'experiments/funding-arb-baseline.json',
);

const SHIPPED_DEFAULTS: BacktestConfig = {
  symbols: DEFAULT_SYMBOLS,
  minFundingRate: 0.0002,
  closeBelowRate: 0.00005,
  positionSizeUSDT: 2000,
  maxHoldTimeHours: 168,
  commissionPerSide: 0.00055,
  spreadAssumption: {
    BTCUSDT: 0.0002,
    ETHUSDT: 0.0003,
    SOLUSDT: 0.0003,
  },
  maxArbPositions: 3,
};

function preflight(symbols: string[]): {
  rangeStart: number;
  rangeEnd: number;
  totalBars: number;
} {
  let rangeStart = Infinity;
  let rangeEnd = -Infinity;
  let totalBars = 0;
  for (const sym of symbols) {
    const records = loadFundingData(sym);
    if (records.length === 0) {
      throw new Error(`Pre-flight: no data for ${sym}`);
    }
    rangeStart = Math.min(rangeStart, records[0]!.timestamp);
    rangeEnd = Math.max(rangeEnd, records[records.length - 1]!.timestamp);
    totalBars += records.length;
  }
  const years = (rangeEnd - rangeStart) / (365.25 * 86_400_000);
  if (years < MIN_DATA_YEARS) {
    throw new Error(
      `Pre-flight: data span ${years.toFixed(2)}y < required ${MIN_DATA_YEARS}y`,
    );
  }
  console.log(
    `Pre-flight OK: ${symbols.length} symbols, ${years.toFixed(2)}y span, ${totalBars} bars total`,
  );
  return { rangeStart, rangeEnd, totalBars };
}

function runBaseline(symbols: string[]): ArbTrade[] {
  const allTrades: ArbTrade[] = [];
  for (const sym of symbols) {
    const records = loadFundingData(sym);
    const trades = backtestSymbol(sym, records, SHIPPED_DEFAULTS);
    allTrades.push(...trades);
    console.log(
      `  ${sym}: ${trades.length} trades, total netPnl $${trades.reduce((s: number, t: ArbTrade) => s + t.netPnl, 0).toFixed(2)}`,
    );
  }
  return allTrades.sort((a: ArbTrade, b: ArbTrade) => a.entryTimestamp - b.entryTimestamp);
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const symbols = DEFAULT_SYMBOLS;

  console.log('='.repeat(60));
  console.log('Funding-Arb Validation');
  console.log('='.repeat(60));

  const { rangeStart, rangeEnd, totalBars } = preflight(symbols);
  console.log('\n--- Baseline backtest ---');
  const trades = runBaseline(symbols);

  if (trades.length === 0) {
    throw new Error(
      'Baseline produced 0 trades. Strategy never triggered. Check data shape and `fundingRate` field.',
    );
  }

  fs.writeFileSync(OUT_BASELINE, JSON.stringify({ trades }, null, 2));
  console.log(`Wrote baseline trade ledger to ${OUT_BASELINE}`);

  // ---- Trade-level metrics ----
  const totalPnl = trades.reduce((s: number, t: ArbTrade) => s + t.netPnl, 0);
  const totalFunding = trades.reduce(
    (s: number, t: ArbTrade) => s + t.totalFundingCollected,
    0,
  );
  const yearsSpan = (rangeEnd - rangeStart) / (365.25 * 86_400_000);
  const tradesPerYear = trades.length / yearsSpan;

  const returns = trades.map((t: ArbTrade) => t.netPnl / SHIPPED_DEFAULTS.positionSizeUSDT);
  const sharpe = computeAnnualizedSharpeFromReturns(returns, tradesPerYear) ?? 0;

  console.log(
    `Total trades: ${trades.length}, total funding: $${totalFunding.toFixed(2)}, net PnL: $${totalPnl.toFixed(2)}, Sharpe: ${sharpe.toFixed(2)}`,
  );

  // ---- Walk-forward ----
  console.log('\n--- Walk-forward ---');
  const windows = walkForwardValWindows(
    rangeStart,
    rangeEnd,
    TRAIN_DAYS,
    VAL_DAYS,
    SLIDE_DAYS,
  );
  let wfPass = 0;
  let wfTotal = 0;
  for (const w of windows) {
    const wt = tradesInWindow(trades, w.startMs, w.endMs);
    if (wt.length === 0) continue; // skip empty windows
    wfTotal += 1;
    const wPnl = wt.reduce((s: number, t: ArbTrade) => s + t.netPnl, 0);
    if (wPnl > 0) wfPass += 1;
  }
  const wfPassRate = wfTotal > 0 ? wfPass / wfTotal : 0;
  console.log(
    `Walk-forward: ${wfPass}/${wfTotal} windows positive (${fmtPct(wfPassRate)})`,
  );

  // ---- DSR ----
  const dsrResult = calculateDeflatedSharpe(sharpe, trades.length, 1);
  console.log(`DSR: ${dsrResult.deflatedSharpe.toFixed(2)} (haircut ${dsrResult.haircut.toFixed(2)})`);

  // ---- MC ----
  console.log('\n--- Monte Carlo ---');
  const mcInput = arbTradesToMcTrades(trades, SHIPPED_DEFAULTS.positionSizeUSDT);
  const annFactor = Math.sqrt(tradesPerYear);
  const boot = bootstrapTrades(mcInput, MC_ITERATIONS, undefined, annFactor);
  const skip = skipTrades(mcInput, SKIP_RATE, MC_ITERATIONS, annFactor);

  console.log(
    `Bootstrap Sharpe 5th: ${boot.sharpe.p5.toFixed(2)}, PnL 5th: ${(boot.finalPnl.p5 * 100).toFixed(1)}%`,
  );
  console.log(
    `Skip 20% profitable fraction: ${fmtPct(skip.profitableFraction)}`,
  );

  // ---- Verdict ----
  const checks: ValidationCheck[] = [
    {
      name: 'Walk-Forward >=60%',
      value: fmtPct(wfPassRate),
      threshold: '>=60%',
      pass: wfPassRate >= 0.60,
    },
    {
      name: 'DSR >0',
      value: dsrResult.deflatedSharpe.toFixed(2),
      threshold: '>0',
      pass: dsrResult.deflatedSharpe > 0,
    },
    {
      name: 'MC Bootstrap Sharpe 5th >0',
      value: boot.sharpe.p5.toFixed(2),
      threshold: '>0',
      pass: boot.sharpe.p5 > 0,
    },
    {
      name: 'MC Bootstrap PnL 5th >0%',
      value: fmtPct(boot.finalPnl.p5),
      threshold: '>0%',
      pass: boot.finalPnl.p5 > 0,
    },
    {
      name: 'MC Skip 20% >=95%',
      value: fmtPct(skip.profitableFraction),
      threshold: '>=95%',
      pass: skip.profitableFraction >= 0.95,
    },
  ];

  const verdict = assembleVerdict(checks);
  const result: ValidationResult = {
    timestamp: new Date().toISOString(),
    dataRange: {
      start: new Date(rangeStart).toISOString().slice(0, 10),
      end: new Date(rangeEnd).toISOString().slice(0, 10),
      bars: totalBars,
    },
    config: SHIPPED_DEFAULTS as unknown as Record<string, unknown>,
    checks,
    details: {
      totalTrades: trades.length,
      totalFundingCollected: totalFunding,
      netPnl: totalPnl,
      sharpe,
      deflatedSharpe: dsrResult.deflatedSharpe,
      bootstrapSharpe5: boot.sharpe.p5,
      bootstrapPnl5Pct: boot.finalPnl.p5,
      skip20PassRate: skip.profitableFraction,
      wfWindowsPass: wfPass,
      wfWindowsTotal: wfTotal,
    },
  };

  fs.writeFileSync(OUT_VALIDATION, JSON.stringify(result, null, 2));
  console.log('\n' + '='.repeat(60));
  console.log(`VERDICT: ${verdict.recommendation}`);
  console.log('='.repeat(60));
  console.log(`Wrote ${OUT_VALIDATION}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
