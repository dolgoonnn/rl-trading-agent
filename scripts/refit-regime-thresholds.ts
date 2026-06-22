/**
 * Regime threshold RE-FIT — PROPOSAL ONLY (charter cadence: 2026-09-11).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * CADENCE & SAFETY CONTRACT
 * ──────────────────────────────────────────────────────────────────────────
 * This script is run ONLY on the charter review calendar (next review:
 * 2026-09-11). It NEVER auto-applies anything. It recomputes the ATR-percentile
 * volatility breakpoints on the refreshed data and EMITS A PROPOSED DIFF
 * (old vs proposed) to stdout + experiments/runs/regime-refit-proposal.json,
 * for a human to review and (if they choose) hand-apply at the review.
 *
 * WHY proposal-only: recency-overfit is a DOCUMENTED failure mode in this
 * project (Run 18 → 60.6% after a data refresh; Run 21 rejected for window-
 * fitting). Reacting to the latest data automatically is exactly the trap. So
 * the re-fit is deliberately NOT reactive: it surfaces a candidate diff and
 * stops. `computeRegimeThresholdProposal` is a PURE function — it does not
 * mutate RUN20_STRATEGY_CONFIG, DEFAULT_REGIME_CONFIG, or any deployed object.
 * ──────────────────────────────────────────────────────────────────────────
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from '@/types/candle';
import {
  DEFAULT_REGIME_CONFIG,
  getDeployedVolatilityThresholds,
} from '@/lib/ict/regime-detector';

/** Next charter review date — the only cadence on which this runs. */
export const CHARTER_REVIEW_DATE = '2026-09-11';

/** Symbols whose 1h data the breakpoints are recomputed over. */
const REFIT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as const;

export interface RegimeRefitProposal {
  /** Currently-deployed volatility breakpoints (percentiles). */
  old: {
    lowVolatilityPercentile: number;
    highVolatilityPercentile: number;
  };
  /**
   * Proposed ATR% levels that the deployed low/high PERCENTILES map to in the
   * refreshed distribution. If these have drifted materially from the levels at
   * deploy time, the regime classification has shifted — a human decides whether
   * to act. We surface the ATR% levels (not new percentiles) because the
   * percentiles themselves are fixed by design; what changes is where they land.
   */
  proposed: {
    /** ATR% at the deployed low-volatility percentile in the refreshed data. */
    lowAtrPct: number;
    /** ATR% at the deployed high-volatility percentile in the refreshed data. */
    highAtrPct: number;
    /** Median ATR% of the refreshed distribution (context). */
    medianAtrPct: number;
    /** Number of ATR% samples the proposal is computed over. */
    sampleCount: number;
  };
  /** ALWAYS false. This is a proposal; it is never auto-applied. */
  autoApply: false;
  /** The charter review date this proposal is queued for. */
  charterReviewDate: string;
  /** When the proposal was computed (ms), for the human reviewing it. */
  computedAtMs: number;
}

/** True-range-based ATR% (TR / close) at bar `i`, single-bar TR. */
function trueRangePct(candles: Candle[], i: number): number | null {
  const curr = candles[i];
  const prev = candles[i - 1];
  if (!curr || !prev || curr.close <= 0) return null;
  const tr = Math.max(
    curr.high - curr.low,
    Math.abs(curr.high - prev.close),
    Math.abs(curr.low - prev.close),
  );
  return tr / curr.close;
}

/** Value at percentile `p` (0..1) of a sorted-ascending array (linear interp). */
function percentileOf(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const idx = p * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = idx - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

/**
 * PURE: recompute the ATR% levels that the deployed volatility PERCENTILES map
 * to in the supplied (refreshed) candle data, and return them as a PROPOSAL.
 *
 * Does NOT mutate any deployed config — it only reads
 * `getDeployedVolatilityThresholds()` (a frozen copy) for the `old` block.
 */
export function computeRegimeThresholdProposal(
  candles: Candle[],
  nowMs: number = Date.now(),
): RegimeRefitProposal {
  const deployed = getDeployedVolatilityThresholds(DEFAULT_REGIME_CONFIG);

  const atrPcts: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const v = trueRangePct(candles, i);
    if (v !== null && Number.isFinite(v) && v > 0) atrPcts.push(v);
  }
  atrPcts.sort((a, b) => a - b);

  const lowAtrPct = percentileOf(atrPcts, deployed.lowVolatilityPercentile);
  const highAtrPct = percentileOf(atrPcts, deployed.highVolatilityPercentile);
  const medianAtrPct = percentileOf(atrPcts, 0.5);

  return {
    old: {
      lowVolatilityPercentile: deployed.lowVolatilityPercentile,
      highVolatilityPercentile: deployed.highVolatilityPercentile,
    },
    proposed: {
      lowAtrPct,
      highAtrPct,
      medianAtrPct,
      sampleCount: atrPcts.length,
    },
    autoApply: false,
    charterReviewDate: CHARTER_REVIEW_DATE,
    computedAtMs: nowMs,
  };
}

// ===========================================================================
// CLI entry — emit the proposal. Never mutates deployed config.
// ===========================================================================

function loadCandles(symbol: string): Candle[] {
  const file = path.resolve(__dirname, '..', 'data', `${symbol}_1h.json`);
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Candle[];
}

function main(): void {
  // Pool ATR% across the charter universe so one symbol can't dominate.
  const pooled: Candle[] = [];
  for (const symbol of REFIT_SYMBOLS) {
    try {
      pooled.push(...loadCandles(symbol));
    } catch (err) {
      console.warn(`[refit] could not load ${symbol}: ${(err as Error).message}`);
    }
  }

  const proposal = computeRegimeThresholdProposal(pooled);

  const outDir = path.resolve(__dirname, '..', 'experiments', 'runs');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'regime-refit-proposal.json');
  fs.writeFileSync(outFile, JSON.stringify(proposal, null, 2));

  console.log('=== REGIME THRESHOLD RE-FIT — PROPOSAL ONLY (NOT applied) ===');
  console.log(`Charter review cadence: ${proposal.charterReviewDate}`);
  console.log(`Samples: ${proposal.proposed.sampleCount}`);
  console.log('OLD (deployed percentiles):', proposal.old);
  console.log('PROPOSED (ATR% levels at those percentiles in refreshed data):');
  console.log(`  low  p${proposal.old.lowVolatilityPercentile}: ATR% = ${proposal.proposed.lowAtrPct.toFixed(5)}`);
  console.log(`  high p${proposal.old.highVolatilityPercentile}: ATR% = ${proposal.proposed.highAtrPct.toFixed(5)}`);
  console.log(`  median:        ATR% = ${proposal.proposed.medianAtrPct.toFixed(5)}`);
  console.log(`autoApply: ${proposal.autoApply} (review by hand at the charter date)`);
  console.log(`Written: ${outFile}`);
}

if (require.main === module) {
  main();
}
