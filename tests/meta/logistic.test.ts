import { describe, it, expect } from 'vitest';
import { fitLogistic, predictProbaLogistic } from '@/lib/meta/logistic';
import { auc } from '@/lib/meta/eval';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate linearly separable 2D data. Two Gaussians separated by a margin. */
function makeSeparableData(n: number): { X: number[][]; y: number[] } {
  const X: number[][] = [];
  const y: number[] = [];
  // Positive class: centered at (3, 3), negative at (-3, -3)
  // Use a simple deterministic pattern (no Math.random)
  for (let i = 0; i < n; i++) {
    const sign = i % 2 === 0 ? 1 : -1;
    const offset = (i % (n / 2)) * (3 / (n / 2));
    X.push([sign * 3 + offset * sign, sign * 3 - offset * sign]);
    y.push(i % 2 === 0 ? 1 : 0);
  }
  return { X, y };
}

/** Generate pure-noise data: alternating labels, features centered at 0. */
function makeNoiseData(n: number): { X: number[][]; y: number[] } {
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < n; i++) {
    // Features are all the same (no signal) — logistic regression should learn nothing
    X.push([0.1, -0.1]);
    y.push(i % 2 === 0 ? 1 : 0);
  }
  return { X, y };
}

// ---------------------------------------------------------------------------
// 1. Linearly separable data → high AUC
// ---------------------------------------------------------------------------

describe('fitLogistic + predictProbaLogistic — separable data', () => {
  it('achieves AUC > 0.95 on linearly separable 2-feature data (~40 pts)', () => {
    const n = 40;
    const { X, y } = makeSeparableData(n);
    const model = fitLogistic(X, y, { iterations: 500, learningRate: 0.1, l2: 1.0 });
    const probas = predictProbaLogistic(model, X);
    const score = auc(probas, y);
    expect(score).toBeGreaterThan(0.95);
  });
});

// ---------------------------------------------------------------------------
// 2. Pure-noise data → AUC ≈ 0.5
// ---------------------------------------------------------------------------

describe('fitLogistic — noise labels → AUC ≈ 0.5', () => {
  it('pure-noise labels produce AUC within 0.15 of 0.5', () => {
    const n = 40;
    const { X, y } = makeNoiseData(n);
    const model = fitLogistic(X, y, { iterations: 500, learningRate: 0.1, l2: 1.0 });
    const probas = predictProbaLogistic(model, X);
    const score = auc(probas, y);
    // With identical features and alternating labels, model learns nothing → AUC ≈ 0.5
    expect(Math.abs(score - 0.5)).toBeLessThanOrEqual(0.15);
  });
});

// ---------------------------------------------------------------------------
// 3. Determinism — two fits on identical input → identical weights
// ---------------------------------------------------------------------------

describe('fitLogistic — determinism', () => {
  it('two fits on identical input produce identical weights and bias', () => {
    const X = [[1, 2], [3, 4], [5, 6], [7, 8]];
    const y = [1, 0, 1, 0];
    const model1 = fitLogistic(X, y, { iterations: 300, learningRate: 0.05, l2: 0.5 });
    const model2 = fitLogistic(X, y, { iterations: 300, learningRate: 0.05, l2: 0.5 });
    expect(model1.weights).toEqual(model2.weights);
    expect(model1.bias).toBe(model2.bias);
    expect(model1.mean).toEqual(model2.mean);
    expect(model1.std).toEqual(model2.std);
  });

  it('different inputs produce different weights', () => {
    const X1 = [[1, 2], [3, 4]];
    const y1 = [1, 0];
    const X2 = [[10, 20], [30, 40]];
    const y2 = [0, 1];
    const model1 = fitLogistic(X1, y1);
    const model2 = fitLogistic(X2, y2);
    // Weights should differ (at least one weight differs)
    const allSame = model1.weights.every((w, i) => w === model2.weights[i]);
    expect(allSame).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Standardization stored in model — predictProba uses train stats
// ---------------------------------------------------------------------------

describe('fitLogistic — internal standardization', () => {
  it('model stores mean and std from training data', () => {
    // Features: [2,4], [6,8] → col0 mean=4, std=2; col1 mean=6, std=2
    const X = [[2, 4], [6, 8]];
    const y = [1, 0];
    const model = fitLogistic(X, y, { iterations: 1 }); // 1 iter to just check storage
    expect(model.mean[0]).toBeCloseTo(4);
    expect(model.mean[1]).toBeCloseTo(6);
    expect(model.std[0]).toBeGreaterThan(0);
    expect(model.std[1]).toBeGreaterThan(0);
  });

  it('std=0 features use std=1 (no division by zero)', () => {
    // Col1 is constant → std=0
    const X = [[1, 5], [2, 5], [3, 5]];
    const y = [1, 0, 1];
    const model = fitLogistic(X, y, { iterations: 10 });
    // std of constant feature must be stored as 1 (not 0)
    expect(model.std[1]).toBe(1);
  });

  it('predictProba returns values strictly between 0 and 1 (sigmoid output)', () => {
    const X = [[1, 2], [3, 4], [5, 6]];
    const y = [1, 0, 1];
    const model = fitLogistic(X, y, { iterations: 200 });
    const probas = predictProbaLogistic(model, X);
    for (const p of probas) {
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
  });

  it('returns one probability per row', () => {
    const X = [[1, 2], [3, 4], [5, 6]];
    const y = [1, 0, 1];
    const model = fitLogistic(X, y);
    const probas = predictProbaLogistic(model, X);
    expect(probas).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 5. Weights init to 0 — bias init to 0 (implied determinism)
// ---------------------------------------------------------------------------

describe('fitLogistic — weight initialization', () => {
  it('zero iterations → weights all zero, bias zero', () => {
    const X = [[1, 2], [3, 4]];
    const y = [1, 0];
    const model = fitLogistic(X, y, { iterations: 0 });
    expect(model.weights).toEqual([0, 0]);
    expect(model.bias).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Default options are applied
// ---------------------------------------------------------------------------

describe('fitLogistic — default options', () => {
  it('calling without opts uses defaults (no error, produces valid model)', () => {
    const X = [[1, 2], [3, 4], [5, 6]];
    const y = [1, 0, 1];
    expect(() => fitLogistic(X, y)).not.toThrow();
    const model = fitLogistic(X, y);
    expect(model.weights).toHaveLength(2);
    expect(typeof model.bias).toBe('number');
  });
});
