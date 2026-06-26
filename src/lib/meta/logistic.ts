/**
 * Logistic regression classifier (pure gradient descent, L2 regularization).
 *
 * Pure, deterministic. No Date/random/IO.
 *
 * Key design:
 *   - Standardizes INTERNALLY on the training X passed to fitLogistic.
 *   - Stores mean/std in the returned model so predictProbaLogistic applies
 *     the exact same standardization — keeps CV leakage-free.
 *   - Weights init to 0 (NOT random) → deterministic from identical inputs.
 *   - L2 penalty on weights only (not bias).
 *   - std === 0 features use std = 1 (no division by zero).
 */

export interface LogisticModel {
  /** Feature weights (one per column). */
  weights: number[];
  /** Bias term. */
  bias: number;
  /** Per-feature mean from training X (used to standardize test X). */
  mean: number[];
  /** Per-feature std from training X (std=0 stored as 1 to avoid div-by-zero). */
  std: number[];
}

export interface FitOpts {
  /** Number of gradient descent iterations. Default: 500. */
  iterations?: number;
  /** Learning rate. Default: 0.1. */
  learningRate?: number;
  /** L2 regularization strength. Default: 1.0. */
  l2?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Numerically stable sigmoid: σ(z) = 1 / (1 + e^{-z}) */
function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Safe indexed add — reads arr[j], adds val, writes back.
 * Used to avoid noUncheckedIndexedAccess errors on mutable accumulators.
 */
function addAt(arr: number[], j: number, val: number): void {
  const cur = arr[j];
  if (cur !== undefined) {
    arr[j] = cur + val;
  }
}

/**
 * Compute per-column mean and std of a matrix.
 * std = 0 → stored as 1 (to avoid division by zero during standardization).
 */
function computeStats(X: number[][], nFeatures: number): { mean: number[]; std: number[] } {
  const n = X.length;
  const mean: number[] = new Array<number>(nFeatures).fill(0);
  const std: number[] = new Array<number>(nFeatures).fill(0);

  if (n === 0) {
    return { mean, std };
  }

  // Compute mean for each feature
  for (const row of X) {
    for (let j = 0; j < nFeatures; j++) {
      addAt(mean, j, row[j] ?? 0);
    }
  }
  for (let j = 0; j < nFeatures; j++) {
    const cur = mean[j];
    if (cur !== undefined) {
      mean[j] = cur / n;
    }
  }

  // Compute population std for each feature (using updated means)
  for (const row of X) {
    for (let j = 0; j < nFeatures; j++) {
      const diff = (row[j] ?? 0) - (mean[j] ?? 0);
      addAt(std, j, diff * diff);
    }
  }
  for (let j = 0; j < nFeatures; j++) {
    const sumSq = std[j];
    if (sumSq !== undefined) {
      const variance = sumSq / n;
      const rawStd = Math.sqrt(variance);
      // If std === 0 (constant feature), use 1 to avoid division by zero
      std[j] = rawStd === 0 ? 1 : rawStd;
    }
  }

  return { mean, std };
}

/**
 * Standardize matrix X using provided mean/std.
 * Returns a new matrix (does not mutate input).
 */
function standardize(X: number[][], mean: number[], std: number[]): number[][] {
  return X.map((row) =>
    row.map((val, j) => (val - (mean[j] ?? 0)) / (std[j] ?? 1)),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fit a logistic regression model on training data.
 *
 * Standardizes X internally using training statistics (stored in model).
 * Gradient descent with L2 regularization on weights.
 *
 * @param X  Training feature matrix (n × p).
 * @param y  Binary labels (0 or 1), length n.
 * @param opts Optional hyperparameters.
 * @returns Fitted LogisticModel.
 */
export function fitLogistic(
  X: number[][],
  y: number[],
  opts?: FitOpts,
): LogisticModel {
  const iterations = opts?.iterations ?? 500;
  const learningRate = opts?.learningRate ?? 0.1;
  const l2 = opts?.l2 ?? 1.0;

  const n = X.length;
  const nFeatures = n > 0 ? (X[0]?.length ?? 0) : 0;

  // Compute standardization stats from training X
  const { mean, std } = computeStats(X, nFeatures);

  // Standardize training data
  const Xstd = standardize(X, mean, std);

  // Initialize weights and bias to 0 (deterministic)
  const weights: number[] = new Array<number>(nFeatures).fill(0);
  let bias = 0;

  // Gradient descent
  for (let iter = 0; iter < iterations; iter++) {
    // Compute predictions
    const yHat: number[] = Xstd.map((row) => {
      let z = bias;
      for (let j = 0; j < nFeatures; j++) {
        z += (weights[j] ?? 0) * (row[j] ?? 0);
      }
      return sigmoid(z);
    });

    // Compute gradients
    const dw: number[] = new Array<number>(nFeatures).fill(0);
    let db = 0;

    for (let i = 0; i < n; i++) {
      const err = (yHat[i] ?? 0) - (y[i] ?? 0);
      const row = Xstd[i];
      if (row === undefined) continue;
      for (let j = 0; j < nFeatures; j++) {
        addAt(dw, j, err * (row[j] ?? 0));
      }
      db += err;
    }

    // Update weights with L2 regularization (on weights, not bias)
    for (let j = 0; j < nFeatures; j++) {
      const wj = weights[j];
      const dwj = dw[j];
      if (wj !== undefined && dwj !== undefined) {
        weights[j] = wj - learningRate * (dwj / n + l2 * wj);
      }
    }
    bias -= learningRate * (db / n);
  }

  return { weights, bias, mean, std };
}

/**
 * Predict class probabilities using a fitted LogisticModel.
 *
 * Applies the same standardization as training (using model.mean / model.std)
 * before computing sigmoid(Xw + b).
 *
 * @param model Fitted model from fitLogistic.
 * @param X     Feature matrix to predict on (m × p).
 * @returns Array of probabilities in (0, 1), length m.
 */
export function predictProbaLogistic(model: LogisticModel, X: number[][]): number[] {
  const { weights, bias, mean, std } = model;
  const nFeatures = weights.length;

  // Standardize using stored training statistics
  const Xstd = standardize(X, mean, std);

  return Xstd.map((row) => {
    let z = bias;
    for (let j = 0; j < nFeatures; j++) {
      z += (weights[j] ?? 0) * (row[j] ?? 0);
    }
    return sigmoid(z);
  });
}
