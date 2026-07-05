import { describe, it, expect } from 'vitest';
import { auc, topQuantileLift } from '@/lib/meta/eval';

// ---------------------------------------------------------------------------
// 1. AUC — hand-checked literals
// ---------------------------------------------------------------------------

describe('auc — hand-checked literals', () => {
  it('perfect ranking → 1.0', () => {
    // scores: [0.9, 0.8] for positives, [0.3, 0.2] for negatives
    // All positives ranked above all negatives → AUC = 1.0
    expect(auc([0.9, 0.8, 0.3, 0.2], [1, 1, 0, 0])).toBe(1.0);
  });

  it('inverse ranking → 0.0', () => {
    // 2 samples: score 0.2 is positive, score 0.8 is negative
    // positive ranked below negative → AUC = 0.0
    expect(auc([0.2, 0.8], [1, 0])).toBe(0.0);
  });

  it('tie case → 0.5 (average rank disambiguation)', () => {
    // Scores tied at 0.5: one positive, one negative
    // Average ranks = 1.5 each → AUC = (1.5 − 1*(1+1)/2) / (1*1) = (1.5−1)/1 = 0.5
    expect(auc([0.5, 0.5], [1, 0])).toBe(0.5);
  });

  it('one-class (all positive) → 0.5', () => {
    expect(auc([0.9, 0.8, 0.7], [1, 1, 1])).toBe(0.5);
  });

  it('one-class (all negative) → 0.5', () => {
    expect(auc([0.9, 0.8, 0.7], [0, 0, 0])).toBe(0.5);
  });

  it('random ordering (50% AUC region)', () => {
    // 4 samples: alternating positive/negative in score order
    // Not exactly 0.5 in general, but verify formula consistency
    // scores [0.9,0.8,0.7,0.6], labels [1,0,1,0]
    // Positives: rank 4, rank 2 (by score desc: ranks 1,2,3,4)
    // pos gets ranks 4,2 in ascending rank; negatives get 3,1
    // sum_ranks_pos (ascending) = 4+2 = 6; n_pos=2, n_neg=2
    // AUC = (6 − 2*3/2) / (2*2) = (6-3)/4 = 0.75
    expect(auc([0.9, 0.8, 0.7, 0.6], [1, 0, 1, 0])).toBeCloseTo(0.75);
  });

  it('verified 4-sample case with explicit rank calculation', () => {
    // scores [0.9,0.7,0.3,0.1], labels [1,0,0,1]
    // sorted ascending: 0.1(idx3,pos), 0.3(idx2,neg), 0.7(idx1,neg), 0.9(idx0,pos)
    // ranks (1-based): 0.1→1, 0.3→2, 0.7→3, 0.9→4
    // positives (0.9 and 0.1): ranks 4 and 1 → sum = 5
    // n_pos=2, n_neg=2
    // AUC = (5 − 2*3/2) / (2*2) = (5−3)/4 = 0.5
    expect(auc([0.9, 0.7, 0.3, 0.1], [1, 0, 0, 1])).toBeCloseTo(0.5);
  });

  it('empty scores → returns 0.5 (one-class / degenerate)', () => {
    // Edge: empty arrays, no positives, no negatives → one-class guard → 0.5
    expect(auc([], [])).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// 2. AUC — Mann-Whitney U formula verification
// ---------------------------------------------------------------------------

describe('auc — Mann-Whitney U formula', () => {
  it('3 positives, 3 negatives — perfectly ordered → 1.0', () => {
    // All positives score higher than all negatives
    expect(auc([0.9, 0.8, 0.7, 0.4, 0.3, 0.2], [1, 1, 1, 0, 0, 0])).toBe(1.0);
  });

  it('all negatives score higher than all positives → 0.0', () => {
    expect(auc([0.4, 0.3, 0.2, 0.9, 0.8, 0.7], [1, 1, 1, 0, 0, 0])).toBe(0.0);
  });

  it('multiple ties are handled via average ranks', () => {
    // scores: [0.5,0.5,0.5,0.5], labels: [1,1,0,0]
    // All tied → all get avg rank (1+2+3+4)/4 = 2.5
    // sum_ranks_pos = 2.5*2=5; n_pos=2,n_neg=2
    // AUC = (5 − 2*3/2)/(2*2) = (5-3)/4 = 0.5
    expect(auc([0.5, 0.5, 0.5, 0.5], [1, 1, 0, 0])).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// 3. topQuantileLift — hand-checked literals
// ---------------------------------------------------------------------------

describe('topQuantileLift — hand-checked', () => {
  /**
   * 10 samples, base rate = 5/10 = 0.5
   * Top 30% = ceil(0.3*10) = 3 samples
   * All 3 top-scoring samples are wins (label=1) → win-rate = 3/3 = 1.0
   * lift = 1.0 − 0.5 = 0.5
   *
   * Labels: [1,1,1,0,0,0,0,0,1,1] → 5 wins out of 10 (base=0.5)
   * Top 3 by score: scores 0.9,0.8,0.7 → labels 1,1,1 → wr=1.0
   */
  it('top-30% all wins with base rate 0.5 → lift = 0.5', () => {
    const scores = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.15, 0.1];
    const labels = [1, 1, 1, 0, 0, 0, 0, 0, 1, 1];
    // base rate = 4/10 = 0.4... let me recount
    // labels: indices 0→1,1→1,2→1,3→0,4→0,5→0,6→0,7→0,8→1,9→1 = 5 wins → base=0.5
    // top 3 (scores 0.9,0.8,0.7): labels 1,1,1 → wr=1.0; lift=1.0-0.5=0.5
    const lift = topQuantileLift(scores, labels, 0.3);
    expect(lift).toBeCloseTo(0.5);
  });

  it('top-50% all wins with base rate 0.4 → positive lift', () => {
    const scores = [0.9, 0.8, 0.7, 0.6, 0.1, 0.05];
    const labels = [1, 1, 1, 0, 0, 0]; // top 3 = wins; base rate 3/6=0.5
    // q=0.5 → top ceil(0.5*6)=3; top 3 are all wins → wr=1.0; lift=1.0-0.5=0.5
    const lift = topQuantileLift(scores, labels, 0.5);
    expect(lift).toBeCloseTo(0.5);
  });

  it('q=1.0 (whole set) → lift = 0 (win-rate equals base rate)', () => {
    const scores = [0.9, 0.8, 0.3, 0.2];
    const labels = [1, 1, 0, 0];
    const lift = topQuantileLift(scores, labels, 1.0);
    expect(lift).toBeCloseTo(0.0);
  });

  it('no wins in top quantile → negative lift', () => {
    // scores desc: 0.9(neg), 0.8(neg), 0.3(pos), 0.2(pos) → top 2 both neg
    const scores = [0.9, 0.8, 0.3, 0.2];
    const labels = [0, 0, 1, 1]; // base rate = 2/4 = 0.5
    // q=0.5 → top 2 = labels [0,0] → wr=0.0; lift=0.0-0.5=-0.5
    const lift = topQuantileLift(scores, labels, 0.5);
    expect(lift).toBeCloseTo(-0.5);
  });

  it('top-quantile uses ceil(q*N) samples', () => {
    // N=7, q=0.3 → ceil(0.3*7)=ceil(2.1)=3 samples
    const scores = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];
    const labels = [1, 1, 0, 0, 0, 0, 0]; // top 3: 1,1,0 → wr=2/3; base=2/7
    const wr = 2 / 3;
    const base = 2 / 7;
    const lift = topQuantileLift(scores, labels, 0.3);
    expect(lift).toBeCloseTo(wr - base);
  });
});

// ---------------------------------------------------------------------------
// 4. Edge cases
// ---------------------------------------------------------------------------

describe('topQuantileLift — edge cases', () => {
  it('q=1.0 on all wins → lift = 0 (wr=1.0, base=1.0)', () => {
    const scores = [0.9, 0.8, 0.7];
    const labels = [1, 1, 1];
    expect(topQuantileLift(scores, labels, 1.0)).toBeCloseTo(0.0);
  });
});
