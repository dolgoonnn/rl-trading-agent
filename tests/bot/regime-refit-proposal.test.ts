import { describe, it, expect } from 'vitest';
import {
  computeRegimeThresholdProposal,
  type RegimeRefitProposal,
} from '../../scripts/refit-regime-thresholds';
import { DEFAULT_REGIME_CONFIG } from '@/lib/ict/regime-detector';
import { RUN20_STRATEGY_CONFIG } from '@/lib/bot/config';
import type { Candle } from '@/types/candle';

/**
 * Task 7 — charter-cadence regime re-fit.
 *
 * The script recomputes the ATR-percentile volatility breakpoints (low/high)
 * on refreshed data and EMITS A PROPOSAL (old vs proposed). It must be a pure,
 * read-only computation: it NEVER mutates the deployed config.
 */

/** Synthetic ascending-vol candle series so percentile breakpoints are well-defined. */
function makeSeries(n: number): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    // Range grows over time → ATR% spreads out across the window.
    const range = 0.5 + (i / n) * 3; // 0.5 → 3.5
    const open = price;
    const high = price + range;
    const low = price - range * 0.4;
    const close = price + range * 0.2;
    out.push({
      timestamp: 1_700_000_000_000 + i * 3_600_000,
      open,
      high,
      low,
      close,
      volume: 1000,
    });
    price = close;
  }
  return out;
}

describe('computeRegimeThresholdProposal — pure, non-mutating', () => {
  it('emits a proposal object with old vs proposed volatility breakpoints', () => {
    const candles = makeSeries(800);
    const proposal: RegimeRefitProposal = computeRegimeThresholdProposal(candles);

    expect(proposal).toBeTruthy();
    expect(proposal.old).toBeDefined();
    expect(proposal.proposed).toBeDefined();

    // Old reflects the deployed regime detector defaults.
    expect(proposal.old.lowVolatilityPercentile).toBe(
      DEFAULT_REGIME_CONFIG.lowVolatilityPercentile,
    );
    expect(proposal.old.highVolatilityPercentile).toBe(
      DEFAULT_REGIME_CONFIG.highVolatilityPercentile,
    );

    // Proposed breakpoints are finite, ordered low < high, in (0,1).
    expect(Number.isFinite(proposal.proposed.lowAtrPct)).toBe(true);
    expect(Number.isFinite(proposal.proposed.highAtrPct)).toBe(true);
    expect(proposal.proposed.lowAtrPct).toBeLessThan(proposal.proposed.highAtrPct);
    expect(proposal.proposed.lowAtrPct).toBeGreaterThan(0);
    expect(proposal.proposed.highAtrPct).toBeLessThan(1);

    // It is a PROPOSAL: it carries the never-auto-apply marker + charter cadence.
    expect(proposal.autoApply).toBe(false);
    expect(proposal.charterReviewDate).toBe('2026-09-11');
  });

  it('does NOT mutate RUN20_STRATEGY_CONFIG.regimeThresholds', () => {
    const before = JSON.stringify(RUN20_STRATEGY_CONFIG.regimeThresholds);
    const candles = makeSeries(800);

    computeRegimeThresholdProposal(candles);

    const after = JSON.stringify(RUN20_STRATEGY_CONFIG.regimeThresholds);
    expect(after).toBe(before);
  });

  it('does NOT mutate DEFAULT_REGIME_CONFIG', () => {
    const before = JSON.stringify(DEFAULT_REGIME_CONFIG);
    const candles = makeSeries(800);

    computeRegimeThresholdProposal(candles);

    const after = JSON.stringify(DEFAULT_REGIME_CONFIG);
    expect(after).toBe(before);
  });
});
