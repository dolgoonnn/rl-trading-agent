/**
 * Meta-label probe runner — pure orchestration.
 *
 * Composes the pure building blocks from @/lib/meta into a single out-of-fold
 * cross-validation loop that returns OOS AUC + top-quantile lift + gate verdict.
 *
 * Leakage discipline:
 *   - featureKeys computed ONCE from all augmented rows (name-only schema).
 *   - Per-fold vectorize(trainRows, featureKeys) + vectorize(testRows, featureKeys)
 *     guarantees identical column ordering across folds.
 *   - fitLogistic standardizes on TRAIN only (mean/std stored in model).
 *   - purgedKFold enforces purge + embargo gaps between train and test spans.
 *
 * Pure, deterministic. No Date.now(), no Math.random(), no I/O.
 */

import { augmentFeatures } from './features';
import { purgedKFold } from './purged-cv';
import { vectorize } from './vectorize';
import { fitLogistic, predictProbaLogistic } from './logistic';
import { auc, topQuantileLift } from './eval';
import type { TradeFeatureRow } from './dataset';
import type { FitOpts } from './logistic';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProbeOpts {
  /** Number of CV folds (k ≥ 2). Default: 5. */
  k?: number;
  /** Fraction of overall time range used as embargo gap. Default: 0.01. */
  embargoFrac?: number;
  /** Top quantile for lift computation, e.g. 0.2 = top 20%. Default: 0.2. */
  topQ?: number;
  /** Logistic regression hyperparameters. */
  logistic?: FitOpts;
}

export interface FoldStat {
  trainSize: number;
  testSize: number;
  /** How many train samples purge+embargo dropped. */
  purgedCount: number;
}

export interface ProbeResult {
  n: number;
  baseRate: number;
  k: number;
  embargoFrac: number;
  /** OOS AUC across all out-of-fold test samples. */
  auc: number;
  /** top-{topQ} lift across all out-of-fold test samples. */
  lift: number;
  topQ: number;
  /** Mean per-fold train size (after purge). */
  meanTrainSize: number;
  /** Mean per-fold test size. */
  meanTestSize: number;
  /** Mean number of samples purge+embargo dropped per fold. */
  meanPurgedCount: number;
  foldStats: FoldStat[];
  /** True iff auc > 0.55 && lift > 0. */
  passed: boolean;
}

// ---------------------------------------------------------------------------
// Pure orchestration
// ---------------------------------------------------------------------------

/**
 * Run the meta-label probe on a dataset of raw trade feature rows.
 *
 * Steps (matching the brief):
 *   1. augmentFeatures(rows) — add sequence/time context.
 *   2. Compute global featureKeys ONCE (column schema, name-only).
 *   3. purgedKFold — produce k train/test index splits.
 *   4. Per fold: vectorize with shared featureKeys, fit, predict OOS.
 *   5. Aggregate OOS predictions → AUC + lift + gate.
 *
 * @param rows   Raw TradeFeatureRow[]. Must have ≥ 2 rows to run CV.
 * @param opts   Optional probe configuration.
 * @returns      ProbeResult with AUC, lift, gate verdict, and fold metadata.
 */
export function runProbe(rows: TradeFeatureRow[], opts?: ProbeOpts): ProbeResult {
  const k = opts?.k ?? 5;
  const embargoFrac = opts?.embargoFrac ?? 0.01;
  const topQ = opts?.topQ ?? 0.2;
  const logisticOpts = opts?.logistic;

  const n = rows.length;
  const baseRate = n > 0 ? rows.filter((r) => r.label === 1).length / n : 0;

  // -------------------------------------------------------------------------
  // Step 1: Augment features (sequence + time context)
  // -------------------------------------------------------------------------
  const augmented = augmentFeatures(rows);

  // -------------------------------------------------------------------------
  // Step 2: Compute GLOBAL featureKeys once (name-only schema).
  // vectorize without featureKeys arg builds the sorted union of all keys.
  // We extract only featureKeys — no values leaked (train-test agnostic).
  // -------------------------------------------------------------------------
  const { featureKeys } = vectorize(augmented);

  // -------------------------------------------------------------------------
  // Step 3: Purged k-fold CV — returns index arrays into `augmented`
  // -------------------------------------------------------------------------
  const folds = purgedKFold(
    augmented.map((r) => ({
      entryTimestamp: r.entryTimestamp,
      exitTimestamp: r.exitTimestamp,
    })),
    { k, embargoFrac },
  );

  // -------------------------------------------------------------------------
  // Step 4: Per-fold train/predict loop
  // -------------------------------------------------------------------------
  const allScores: number[] = [];
  const allLabels: number[] = [];
  const foldStats: FoldStat[] = [];

  for (const fold of folds) {
    const { trainIdx, testIdx } = fold;

    const trainRows = trainIdx.map((i) => {
      const row = augmented[i];
      if (row === undefined) throw new Error(`probe-core: trainIdx[${i}] out of range`);
      return row;
    });
    const testRows = testIdx.map((i) => {
      const row = augmented[i];
      if (row === undefined) throw new Error(`probe-core: testIdx[${i}] out of range`);
      return row;
    });

    // Count how many original non-test samples were purged/embargoed.
    // Non-test = n − testIdx.length; trainIdx is what survived purge.
    const nonTestCount = n - testIdx.length;
    const purgedCount = nonTestCount - trainIdx.length;

    foldStats.push({
      trainSize: trainRows.length,
      testSize: testRows.length,
      purgedCount,
    });

    // Vectorize BOTH folds against the SAME featureKeys (no column drift).
    const { X: Xtr, y: ytr } = vectorize(trainRows, featureKeys);
    const { X: Xte, y: yte } = vectorize(testRows, featureKeys);

    // Skip fold if train set is empty (can happen with small N + large embargo).
    if (Xtr.length === 0 || Xte.length === 0) continue;

    // Fit on train — logistic standardizes internally on Xtr.
    const model = fitLogistic(Xtr, ytr, logisticOpts);

    // Predict OOS on test — model applies TRAIN standardization to Xte.
    const scores = predictProbaLogistic(model, Xte);

    // Accumulate out-of-fold predictions.
    for (const score of scores) {
      allScores.push(score);
    }
    for (const label of yte) {
      allLabels.push(label);
    }
  }

  // -------------------------------------------------------------------------
  // Step 5: Aggregate OOS metrics
  // -------------------------------------------------------------------------
  const aucVal = allScores.length > 0 ? auc(allScores, allLabels) : 0.5;
  const lift = allScores.length > 0 ? topQuantileLift(allScores, allLabels, topQ) : 0;

  // Gate: PASS iff AUC > 0.55 AND lift > 0.
  const passed = aucVal > 0.55 && lift > 0;

  // Fold metadata averages.
  const meanTrainSize =
    foldStats.length > 0
      ? foldStats.reduce((s, f) => s + f.trainSize, 0) / foldStats.length
      : 0;
  const meanTestSize =
    foldStats.length > 0
      ? foldStats.reduce((s, f) => s + f.testSize, 0) / foldStats.length
      : 0;
  const meanPurgedCount =
    foldStats.length > 0
      ? foldStats.reduce((s, f) => s + f.purgedCount, 0) / foldStats.length
      : 0;

  return {
    n,
    baseRate,
    k,
    embargoFrac,
    auc: aucVal,
    lift,
    topQ,
    meanTrainSize,
    meanTestSize,
    meanPurgedCount,
    foldStats,
    passed,
  };
}
