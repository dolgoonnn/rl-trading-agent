import { describe, it, expect } from 'vitest';
import { vectorize } from '@/lib/meta/vectorize';
import type { TradeFeatureRow } from '@/lib/meta/dataset';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(
  symbol: string,
  features: Record<string, number>,
  label: 0 | 1,
): TradeFeatureRow {
  return {
    symbol,
    entryTimestamp: 100,
    exitTimestamp: 200,
    direction: 'long',
    features,
    label,
  };
}

// ---------------------------------------------------------------------------
// 1. Empty input
// ---------------------------------------------------------------------------

describe('vectorize — empty input', () => {
  it('returns empty X, y, featureKeys when rows is empty and no featureKeys given', () => {
    const result = vectorize([]);
    expect(result.X).toEqual([]);
    expect(result.y).toEqual([]);
    expect(result.featureKeys).toEqual([]);
  });

  it('returns empty X and y but uses given featureKeys when rows is empty', () => {
    const result = vectorize([], ['a', 'b']);
    expect(result.X).toEqual([]);
    expect(result.y).toEqual([]);
    expect(result.featureKeys).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// 2. Sorted-union of keys when featureKeys not provided
// ---------------------------------------------------------------------------

describe('vectorize — key derivation (no featureKeys arg)', () => {
  it('derives featureKeys as SORTED UNION of all row.features keys', () => {
    const row1 = makeRow('BTC', { a: 1, c: 3 }, 1);
    const row2 = makeRow('ETH', { b: 2, c: 4 }, 0);
    const result = vectorize([row1, row2]);
    // Sorted union: ['a', 'b', 'c']
    expect(result.featureKeys).toEqual(['a', 'b', 'c']);
  });

  it('single row: featureKeys sorted from that row', () => {
    const row = makeRow('BTC', { z: 9, a: 1, m: 5 }, 1);
    const result = vectorize([row]);
    expect(result.featureKeys).toEqual(['a', 'm', 'z']);
  });
});

// ---------------------------------------------------------------------------
// 3. X matrix construction — missing keys → 0
// ---------------------------------------------------------------------------

describe('vectorize — X matrix values', () => {
  it('builds correct X matrix with missing key → 0 fill', () => {
    const row1 = makeRow('BTC', { a: 1, c: 3 }, 1);
    const row2 = makeRow('ETH', { b: 2, c: 4 }, 0);
    const result = vectorize([row1, row2]);
    // featureKeys = ['a', 'b', 'c']
    // row1: a=1, b=0 (missing), c=3
    // row2: a=0 (missing), b=2, c=4
    expect(result.X[0]).toEqual([1, 0, 3]);
    expect(result.X[1]).toEqual([0, 2, 4]);
  });

  it('y vector maps row.label correctly', () => {
    const row1 = makeRow('BTC', { a: 1 }, 1);
    const row2 = makeRow('ETH', { a: 2 }, 0);
    const result = vectorize([row1, row2]);
    expect(result.y).toEqual([1, 0]);
  });

  it('all features present — no zero fill needed', () => {
    const row1 = makeRow('BTC', { x: 10, y: 20 }, 1);
    const row2 = makeRow('ETH', { x: 30, y: 40 }, 0);
    const result = vectorize([row1, row2]);
    expect(result.X[0]).toEqual([10, 20]);
    expect(result.X[1]).toEqual([30, 40]);
  });
});

// ---------------------------------------------------------------------------
// 4. Explicit featureKeys — alignment critical for CV
// ---------------------------------------------------------------------------

describe('vectorize — explicit featureKeys alignment', () => {
  it('vectorize(rows, ["a","c"]) uses exactly ["a","c"], ignores key "b"', () => {
    const row = makeRow('BTC', { a: 1, b: 99, c: 3 }, 1);
    const result = vectorize([row], ['a', 'c']);
    expect(result.featureKeys).toEqual(['a', 'c']);
    expect(result.X[0]).toEqual([1, 3]);
  });

  it('row missing key "c" → 0 when explicit featureKeys contains "c"', () => {
    const row = makeRow('BTC', { a: 5 }, 0);
    const result = vectorize([row], ['a', 'c']);
    expect(result.featureKeys).toEqual(['a', 'c']);
    expect(result.X[0]).toEqual([5, 0]);
  });

  it('explicit featureKeys preserved verbatim (not re-sorted)', () => {
    const row = makeRow('BTC', { z: 1, a: 2 }, 1);
    const result = vectorize([row], ['z', 'a']); // intentionally NOT sorted
    expect(result.featureKeys).toEqual(['z', 'a']);
    expect(result.X[0]).toEqual([1, 2]);
  });

  it('train and test rows share same feature column order via featureKeys', () => {
    const trainRow = makeRow('BTC', { a: 1, b: 2, regime_uptrend: 1 }, 1);
    const testRow = makeRow('BTC', { a: 3, b: 4, regime_downtrend: 1 }, 0);

    const trainResult = vectorize([trainRow]);
    // trainResult.featureKeys = ['a','b','regime_uptrend'] (sorted)

    // Re-vectorize test with train's featureKeys
    const testResult = vectorize([testRow], trainResult.featureKeys);

    // testRow has regime_downtrend but NOT regime_uptrend → 0 fill
    expect(testResult.featureKeys).toEqual(trainResult.featureKeys);
    expect(testResult.X[0]).toEqual([3, 4, 0]); // a=3, b=4, regime_uptrend=0 (missing)
  });
});

// ---------------------------------------------------------------------------
// 5. Determinism
// ---------------------------------------------------------------------------

describe('vectorize — determinism', () => {
  it('two calls on identical input produce identical output', () => {
    const rows = [
      makeRow('BTC', { a: 1, b: 2 }, 1),
      makeRow('ETH', { b: 3, c: 4 }, 0),
    ];
    const r1 = vectorize(rows);
    const r2 = vectorize(rows);
    expect(r1.featureKeys).toEqual(r2.featureKeys);
    expect(r1.X).toEqual(r2.X);
    expect(r1.y).toEqual(r2.y);
  });
});
