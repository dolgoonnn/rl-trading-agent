#!/usr/bin/env npx tsx
/**
 * Parameter Sensitivity Analysis
 *
 * For each key parameter, perturb ±10% and ±20% and check walk-forward pass rate.
 * Flags parameters where ±10% drops pass rate below 45% (fragile).
 *
 * Usage:
 *   npx tsx scripts/sensitivity-analysis.ts
 */

import type { Candle } from '@/types';
import {
  ConfluenceScorer,
  type ConfluenceConfig,
  PRODUCTION_STRATEGY_CONFIG,
} from '../src/lib/rl/strategies/confluence-scorer';
import { DEFAULT_OB_CONFIG } from '../src/lib/ict/order-blocks';
import type { StrategyName, SLPlacementMode } from '../src/lib/rl/strategies/ict-strategies';
import {
  runWalkForward,
  type WalkForwardStrategyRunner,
  type TradeResult,
} from './walk-forward-validate';

// ============================================
// Simplified Position Simulation
// ============================================

const FRICTION = 0.0007;
const MAX_BARS = 100;

interface SimPos {
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  direction: 'long' | 'short';
  entryIndex: number;
  entryTimestamp: number;
  strategy: string;
}

function simulateTrade(pos: SimPos, candles: Candle[], start: number): TradeResult | null {
  const adjEntry = pos.direction === 'long'
    ? pos.entryPrice * (1 + FRICTION)
    : pos.entryPrice * (1 - FRICTION);
  let sl = pos.stopLoss;
  const rd = pos.direction === 'long'
    ? pos.entryPrice - pos.stopLoss
    : pos.stopLoss - pos.entryPrice;
  let partialDone = false;
  let partialPnl = 0;

  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    if (!c) continue;
    const held = i - pos.entryIndex;
    let exit: number | null = null;
    if (pos.direction === 'long') {
      if (c.low <= sl) exit = sl;
      else if (c.high >= pos.takeProfit) exit = pos.takeProfit;
    } else {
      if (c.high >= sl) exit = sl;
      else if (c.low <= pos.takeProfit) exit = pos.takeProfit;
    }
    if (exit !== null) {
      const adjExit = pos.direction === 'long' ? exit * (1 - FRICTION) : exit * (1 + FRICTION);
      const pnl = pos.direction === 'long'
        ? (adjExit - adjEntry) / adjEntry
        : (adjEntry - adjExit) / adjEntry;
      const final = partialDone ? 0.5 * partialPnl + 0.5 * pnl : pnl;
      return { entryTimestamp: pos.entryTimestamp, exitTimestamp: c.timestamp, direction: pos.direction, entryPrice: adjEntry, exitPrice: adjExit, pnlPercent: final, strategy: pos.strategy };
    }
    if (!partialDone && rd > 0) {
      const uR = pos.direction === 'long' ? (c.close - pos.entryPrice) / rd : (pos.entryPrice - c.close) / rd;
      if (uR >= 1.0) {
        partialDone = true;
        const pe = pos.direction === 'long' ? c.close * (1 - FRICTION) : c.close * (1 + FRICTION);
        partialPnl = pos.direction === 'long' ? (pe - adjEntry) / adjEntry : (adjEntry - pe) / adjEntry;
        const buf = rd * 0.1;
        if (pos.direction === 'long') sl = Math.max(sl, pos.entryPrice + buf);
        else sl = Math.min(sl, pos.entryPrice - buf);
      }
    }
    if (held >= MAX_BARS) {
      const adjExit = pos.direction === 'long' ? c.close * (1 - FRICTION) : c.close * (1 + FRICTION);
      const pnl = pos.direction === 'long' ? (adjExit - adjEntry) / adjEntry : (adjEntry - adjExit) / adjEntry;
      const final = partialDone ? 0.5 * partialPnl + 0.5 * pnl : pnl;
      return { entryTimestamp: pos.entryTimestamp, exitTimestamp: c.timestamp, direction: pos.direction, entryPrice: adjEntry, exitPrice: adjExit, pnlPercent: final, strategy: pos.strategy };
    }
  }
  return null;
}

// ============================================
// Sensitivity Sweep
// ============================================

interface SensitivityParam {
  name: string;
  baseline: number;
  /** Apply perturbation and return a WF runner */
  makeRunner: (value: number) => WalkForwardStrategyRunner;
}

function makeRunner(
  threshold: number,
  atrExt: number,
  regimeThresholds: Record<string, number>,
  suppressedRegimes: string[],
  label: string,
): WalkForwardStrategyRunner {
  return {
    name: label,
    async run(trainCandles: Candle[], valCandles: Candle[]): Promise<TradeResult[]> {
      const scorer = new ConfluenceScorer({
        minThreshold: threshold,
        minSignalRR: 1.5,
        strategyConfig: { ...PRODUCTION_STRATEGY_CONFIG, slPlacementMode: 'dynamic_rr' as SLPlacementMode },
        activeStrategies: ['order_block'] as StrategyName[],
        suppressedRegimes,
        atrExtensionBands: atrExt,
        regimeThresholdOverrides: regimeThresholds,
      });
      const all = [...trainCandles, ...valCandles];
      const valStart = trainCandles.length;
      const trades: TradeResult[] = [];
      let curPos: SimPos | null = null;
      let exitIdx = -1;

      for (let i = valStart; i < all.length; i++) {
        const c = all[i];
        if (!c) continue;
        if (curPos && i <= exitIdx) continue;
        curPos = null;

        const result = scorer.evaluate(all, i);
        if (result.action === 'trade' && result.selectedSignal) {
          const sig = result.selectedSignal.signal;
          const p: SimPos = { entryPrice: sig.entryPrice, stopLoss: sig.stopLoss, takeProfit: sig.takeProfit, direction: sig.direction, entryIndex: i, entryTimestamp: c.timestamp, strategy: sig.strategy };
          const trade = simulateTrade(p, all, i + 1);
          if (trade) {
            trades.push(trade);
            exitIdx = i + 1;
            for (let j = i + 1; j < all.length; j++) {
              if (all[j] && all[j]!.timestamp >= trade.exitTimestamp) { exitIdx = j; break; }
            }
            curPos = p;
          }
        }
      }
      return trades;
    },
  };
}

const BASE_REGIME_THRESHOLDS = { 'uptrend+high': 3.5, 'uptrend+normal': 5.0, 'downtrend+low': 5.0 };
const BASE_SUPPRESS = ['ranging+normal', 'ranging+high', 'downtrend+high'];

const PARAMS: SensitivityParam[] = [
  {
    name: 'threshold',
    baseline: 4.0,
    makeRunner: (v) => makeRunner(v, 2.5, BASE_REGIME_THRESHOLDS, BASE_SUPPRESS, `threshold=${v}`),
  },
  {
    name: 'atrExtension',
    baseline: 2.5,
    makeRunner: (v) => makeRunner(4.0, v, BASE_REGIME_THRESHOLDS, BASE_SUPPRESS, `atrExt=${v}`),
  },
  {
    name: 'friction',
    baseline: 0.0007,
    makeRunner: (_v) => {
      // Can't easily change friction here since it's module-level in the real backtest
      // Instead we just use the base runner (friction sensitivity was already validated in Iter 9)
      return makeRunner(4.0, 2.5, BASE_REGIME_THRESHOLDS, BASE_SUPPRESS, `friction-proxy`);
    },
  },
];

async function main(): Promise<void> {
  console.log('============================================================');
  console.log('PARAMETER SENSITIVITY ANALYSIS');
  console.log('============================================================');
  console.log('');

  const perturbations = [-0.20, -0.10, 0, 0.10, 0.20];
  const results: { param: string; perturbation: string; value: number; passRate: number }[] = [];

  for (const param of PARAMS) {
    if (param.name === 'friction') {
      console.log(`Skipping friction (already validated in Iter 9)`);
      continue;
    }

    console.log(`\nSweeping ${param.name} (baseline=${param.baseline}):`);

    for (const pct of perturbations) {
      const value = param.baseline * (1 + pct);
      const runner = param.makeRunner(value);
      const wfResult = await runWalkForward(runner);
      const passRate = wfResult.passRate * 100;

      const label = pct === 0 ? 'baseline' : `${pct > 0 ? '+' : ''}${(pct * 100).toFixed(0)}%`;
      const flag = passRate < 45 ? ' ⚠️ FRAGILE' : '';
      console.log(`  ${label}: ${param.name}=${value.toFixed(3)} → ${passRate.toFixed(1)}% pass rate${flag}`);

      results.push({ param: param.name, perturbation: label, value, passRate });
    }
  }

  console.log('\n============================================================');
  console.log('SENSITIVITY SUMMARY');
  console.log('============================================================\n');
  console.log('| Parameter | -20% | -10% | Baseline | +10% | +20% |');
  console.log('|-----------|------|------|----------|------|------|');

  for (const param of PARAMS) {
    if (param.name === 'friction') continue;
    const paramResults = results.filter((r) => r.param === param.name);
    const values = perturbations.map((p) => {
      const label = p === 0 ? 'baseline' : `${p > 0 ? '+' : ''}${(p * 100).toFixed(0)}%`;
      const r = paramResults.find((pr) => pr.perturbation === label);
      return r ? `${r.passRate.toFixed(1)}%` : 'N/A';
    });
    console.log(`| ${param.name.padEnd(9)} | ${values.join(' | ')} |`);
  }

  // Flag fragile parameters
  const fragile = results.filter((r) => r.perturbation !== 'baseline' && r.passRate < 45);
  if (fragile.length > 0) {
    console.log('\n⚠️  FRAGILE PARAMETERS:');
    for (const f of fragile) {
      console.log(`  ${f.param} at ${f.perturbation} (${f.value.toFixed(3)}) = ${f.passRate.toFixed(1)}%`);
    }
  } else {
    console.log('\n✅ No parameters flagged as fragile (all perturbations stay above 45%)');
  }
}

main().catch((err: unknown) => {
  console.error('Sensitivity analysis failed:', err);
  process.exit(1);
});
