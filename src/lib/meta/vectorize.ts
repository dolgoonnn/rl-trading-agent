/**
 * Vectorizer — convert TradeFeatureRow[] into a numeric matrix.
 *
 * Pure, deterministic. No Date/random/IO.
 *
 * Key design:
 *   - When featureKeys is provided, align EXACTLY to those columns (critical for CV —
 *     train and test folds must share the same feature schema).
 *   - When featureKeys is NOT provided, derive the sorted union of all keys across rows.
 *   - Missing keys → 0.
 */

import type { TradeFeatureRow } from './dataset';

export interface VectorizeResult {
  /** Row-major feature matrix. X[i][j] = row i, feature j. */
  X: number[][];
  /** Label vector. y[i] = rows[i].label. */
  y: number[];
  /** Ordered feature names corresponding to X columns. */
  featureKeys: string[];
}

/**
 * Convert an array of TradeFeatureRow into a numeric matrix.
 *
 * @param rows        Training/test rows with features and labels.
 * @param featureKeys Optional explicit column list. When given, aligns X to EXACTLY
 *                    these columns (so train/test folds share the same schema in CV).
 *                    When omitted, derived as the sorted union of all keys across rows.
 * @returns { X, y, featureKeys }
 */
export function vectorize(
  rows: TradeFeatureRow[],
  featureKeys?: string[],
): VectorizeResult {
  // Determine feature keys
  let keys: string[];
  if (featureKeys !== undefined) {
    // Use the caller-supplied list verbatim (not re-sorted)
    keys = featureKeys;
  } else if (rows.length === 0) {
    return { X: [], y: [], featureKeys: [] };
  } else {
    // Sorted union of all keys across all rows
    const keySet = new Set<string>();
    for (const row of rows) {
      for (const k of Object.keys(row.features)) {
        keySet.add(k);
      }
    }
    keys = Array.from(keySet).sort();
  }

  if (rows.length === 0) {
    return { X: [], y: [], featureKeys: keys };
  }

  const X: number[][] = [];
  const y: number[] = [];

  for (const row of rows) {
    const xRow: number[] = keys.map((k) => row.features[k] ?? 0);
    X.push(xRow);
    y.push(row.label);
  }

  return { X, y, featureKeys: keys };
}
