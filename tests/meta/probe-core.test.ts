/**
 * TDD tests for runProbe (probe-core.ts).
 *
 * Two synthetic fixture types (per the brief):
 *   1. Clean-signal: label = f(one feature) deterministically → auc > 0.9
 *   2. Pure-noise: label independent of all features → auc ≈ 0.5 (±0.15)
 */

import { describe, it, expect } from 'vitest';
import { runProbe } from '@/lib/meta/probe-core';
import type { TradeFeatureRow } from '@/lib/meta/dataset';

// ---------------------------------------------------------------------------
// Helpers — synthetic dataset factories
// ---------------------------------------------------------------------------

/**
 * Build a clean-signal dataset.
 * Feature "signal" is uniformly spaced in [0, 1].
 * label = signal >= 0.5 ? 1 : 0 (perfectly separable by logistic regression).
 *
 * Timestamps are synthetic but monotonically increasing so purgedKFold works.
 * Each trade lasts 1 hour (3_600_000 ms). Trades start at hour 0, 1, 2, …
 */
function makeCleanDataset(n: number, symbol = 'BTCUSDT'): TradeFeatureRow[] {
  const rows: TradeFeatureRow[] = [];
  for (let i = 0; i < n; i++) {
    const signal = i / (n - 1); // uniform [0, 1]
    const label: 0 | 1 = signal >= 0.5 ? 1 : 0;
    const entryTimestamp = i * 3_600_000; // 1h apart
    const exitTimestamp = entryTimestamp + 1_800_000; // 30m trade duration
    rows.push({
      symbol,
      entryTimestamp,
      exitTimestamp,
      direction: 'long',
      features: { signal, noise: 0.5 },
      label,
    });
  }
  return rows;
}

/**
 * Build a pure-noise dataset.
 *
 * Labels are derived from a deterministic pseudo-random bit sequence (linear
 * congruential generator seed=42). Features are also pseudo-random but
 * generated from a DIFFERENT independent LCG (seed=137), so features carry
 * zero mutual information with labels.
 *
 * Important: we must NOT use the augmented sequence features (priorOutcome,
 * recentWinRate) as a signal — `augmentFeatures` adds these based on PAST
 * outcomes, which for a truly random label sequence contain no forward info.
 * The LCG ensures labels are not simply periodic (which priorOutcome could
 * exploit), so the model has nothing to learn.
 */
function makeNoiseDataset(n: number, symbol = 'ETHUSDT'): TradeFeatureRow[] {
  // Deterministic LCG: x_{i+1} = (a * x_i + c) % m.  Knuth params.
  // Use bit 15 (mid-range) for the label, not bit 0 — LCGs have poor low-bit
  // randomness; bit 15 has full-period randomness.
  const lcgNext = (x: number): number => ((1664525 * x + 1013904223) % 2 ** 32);

  let labelSeed = 42;
  let featureSeed = 137;

  const rows: TradeFeatureRow[] = [];
  for (let i = 0; i < n; i++) {
    labelSeed = lcgNext(labelSeed);
    featureSeed = lcgNext(featureSeed);
    // Use bit 15 (mid-range bit) — avoids the period-2 pattern of bit 0.
    const label: 0 | 1 = ((labelSeed >> 15) & 1) === 0 ? 0 : 1;
    const featureVal = featureSeed / 2 ** 32; // in [0, 1)
    const entryTimestamp = i * 3_600_000;
    const exitTimestamp = entryTimestamp + 1_800_000;
    rows.push({
      symbol,
      entryTimestamp,
      exitTimestamp,
      direction: 'long',
      features: { noise: featureVal },
      label,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 1. Clean-signal dataset — should recover strong OOS signal
// ---------------------------------------------------------------------------

describe('runProbe — clean-signal dataset', () => {
  const rows = makeCleanDataset(100);

  it('returns auc > 0.9 on perfectly separable signal (n=100, k=5)', () => {
    const result = runProbe(rows, { k: 5, embargoFrac: 0, topQ: 0.2 });
    expect(result.auc).toBeGreaterThan(0.9);
  });

  it('returns positive lift on clean signal', () => {
    const result = runProbe(rows, { k: 5, embargoFrac: 0, topQ: 0.2 });
    expect(result.lift).toBeGreaterThan(0);
  });

  it('passes the gate (auc > 0.55 && lift > 0)', () => {
    const result = runProbe(rows, { k: 5, embargoFrac: 0, topQ: 0.2 });
    expect(result.passed).toBe(true);
  });

  it('n and baseRate match input', () => {
    const result = runProbe(rows, { k: 5, embargoFrac: 0 });
    expect(result.n).toBe(100);
    // labels: 0 for i<50, 1 for i>=50 → base rate = 50/100 = 0.5
    expect(result.baseRate).toBeCloseTo(0.5);
  });

  it('foldStats has k entries', () => {
    const result = runProbe(rows, { k: 5, embargoFrac: 0 });
    expect(result.foldStats).toHaveLength(5);
  });

  it('mean test size ≈ n/k = 20', () => {
    const result = runProbe(rows, { k: 5, embargoFrac: 0 });
    expect(result.meanTestSize).toBeCloseTo(20, 0);
  });

  it('total OOS predictions = n (no embargo → no purge of these synthetic trades)', () => {
    // With embargoFrac=0, no purge between non-overlapping 30m trades; all test samples scored.
    // The sum of all test sizes equals n.
    const result = runProbe(rows, { k: 5, embargoFrac: 0 });
    const totalTest = result.foldStats.reduce((s, f) => s + f.testSize, 0);
    expect(totalTest).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// 2. Pure-noise dataset — AUC should be ≈ 0.5 (within ±0.15)
// ---------------------------------------------------------------------------

describe('runProbe — pure-noise dataset', () => {
  // n=200 to give logistic enough samples to confirm no signal.
  // Use k=4 to keep train folds large enough (50 test / 150 train per fold).
  const rows = makeNoiseDataset(200);

  it('returns auc within 0.15 of 0.5 (no learnable signal)', () => {
    const result = runProbe(rows, { k: 4, embargoFrac: 0, topQ: 0.2 });
    expect(result.auc).toBeGreaterThanOrEqual(0.35);
    expect(result.auc).toBeLessThanOrEqual(0.65);
  });

  it('does NOT pass the gate when auc ≤ 0.55', () => {
    const result = runProbe(rows, { k: 4, embargoFrac: 0, topQ: 0.2 });
    // For pure noise, auc ≈ 0.5 — almost certainly ≤ 0.55.
    // We check the gate logic is consistent with the auc value.
    expect(result.passed).toBe(result.auc > 0.55 && result.lift > 0);
  });
});

// ---------------------------------------------------------------------------
// 3. Structural / invariant tests
// ---------------------------------------------------------------------------

describe('runProbe — structural invariants', () => {
  it('accepts default opts (no opts argument)', () => {
    const rows = makeCleanDataset(30);
    // k=5 default, 30 rows: works fine
    const result = runProbe(rows);
    expect(result.k).toBe(5);
    expect(result.embargoFrac).toBe(0.01);
    expect(result.topQ).toBe(0.2);
  });

  it('respects custom k', () => {
    const rows = makeCleanDataset(40);
    const result = runProbe(rows, { k: 4, embargoFrac: 0 });
    expect(result.k).toBe(4);
    expect(result.foldStats).toHaveLength(4);
  });

  it('meanPurgedCount is non-negative', () => {
    const rows = makeCleanDataset(50);
    const result = runProbe(rows, { k: 5, embargoFrac: 0 });
    expect(result.meanPurgedCount).toBeGreaterThanOrEqual(0);
  });

  it('auc is in [0, 1]', () => {
    const rows = makeCleanDataset(40);
    const result = runProbe(rows, { k: 4, embargoFrac: 0 });
    expect(result.auc).toBeGreaterThanOrEqual(0);
    expect(result.auc).toBeLessThanOrEqual(1);
  });

  it('featureKeys are aligned across folds (verified indirectly: no column-mismatch error)', () => {
    // Mix two symbols with different feature sets to exercise featureKeys alignment.
    const btc = makeCleanDataset(30, 'BTCUSDT');
    const eth: TradeFeatureRow[] = makeNoiseDataset(20, 'ETHUSDT').map((r) => ({
      ...r,
      features: { ...r.features, extraFeature: 1.0 },
    }));
    const rows = [...btc, ...eth];
    // If featureKeys alignment breaks, vectorize would produce different-width matrices
    // and logistic would silently diverge. This just checks no error is thrown.
    expect(() => runProbe(rows, { k: 5, embargoFrac: 0 })).not.toThrow();
  });

  it('passed field matches gate condition (auc > 0.55 && lift > 0)', () => {
    const rows = makeCleanDataset(80);
    const result = runProbe(rows, { k: 5, embargoFrac: 0 });
    const expectedPassed = result.auc > 0.55 && result.lift > 0;
    expect(result.passed).toBe(expectedPassed);
  });

  it('multi-symbol dataset runs without error', () => {
    const rows = [
      ...makeCleanDataset(30, 'BTCUSDT'),
      ...makeCleanDataset(30, 'ETHUSDT'),
    ];
    expect(() => runProbe(rows, { k: 5, embargoFrac: 0 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Larger clean-signal: stress test for AUC > 0.9
// ---------------------------------------------------------------------------

describe('runProbe — larger clean-signal (n=200)', () => {
  it('auc > 0.9 with n=200, k=5', () => {
    const rows = makeCleanDataset(200);
    const result = runProbe(rows, { k: 5, embargoFrac: 0, topQ: 0.2 });
    expect(result.auc).toBeGreaterThan(0.9);
  });
});
