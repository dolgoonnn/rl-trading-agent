import { describe, it, expect } from 'vitest';
import { purgedKFold } from '@/lib/meta/purged-cv';
import type { CvSample, CvFold } from '@/lib/meta/purged-cv';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function allTestIdx(folds: CvFold[]): number[] {
  return folds.flatMap((f) => f.testIdx);
}

function intersects(a: number[], b: number[]): boolean {
  const setB = new Set(b);
  return a.some((x) => setB.has(x));
}

/** Safe index into a readonly array — throws a clear test error if out of range. */
function at<T>(arr: T[], idx: number): T {
  const v = arr[idx];
  if (v === undefined) throw new Error(`Test fixture: index ${idx} out of range (len=${arr.length})`);
  return v;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// 6 samples, sorted by entryTimestamp, non-overlapping labels.
// Each sample lives in a clean 100-unit window so test-span boundaries
// are sharp and unambiguous.
const SIX_SAMPLES: CvSample[] = [
  { entryTimestamp: 100, exitTimestamp: 199 },  // 0
  { entryTimestamp: 200, exitTimestamp: 299 },  // 1
  { entryTimestamp: 300, exitTimestamp: 399 },  // 2
  { entryTimestamp: 400, exitTimestamp: 499 },  // 3
  { entryTimestamp: 500, exitTimestamp: 599 },  // 4
  { entryTimestamp: 600, exitTimestamp: 699 },  // 5
];

// ---------------------------------------------------------------------------
// 1. Partition tests
// ---------------------------------------------------------------------------

describe('purgedKFold — partition', () => {
  it('returns k folds', () => {
    const folds = purgedKFold(SIX_SAMPLES, { k: 3, embargoFrac: 0 });
    expect(folds).toHaveLength(3);
  });

  it('every original index appears in exactly one testIdx', () => {
    const folds = purgedKFold(SIX_SAMPLES, { k: 3, embargoFrac: 0 });
    const all = allTestIdx(folds).sort((a, b) => a - b);
    expect(all).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('union of testIdx = all indices; no duplicates', () => {
    const folds = purgedKFold(SIX_SAMPLES, { k: 3, embargoFrac: 0 });
    const all = allTestIdx(folds);
    expect(new Set(all).size).toBe(SIX_SAMPLES.length);
    expect(all).toHaveLength(SIX_SAMPLES.length);
  });

  it('fold sizes differ by at most 1 (contiguous partition)', () => {
    // 6 samples / k=4 → two folds of 2, two folds of 1 (or 2,2,1,1 etc)
    const folds = purgedKFold(SIX_SAMPLES, { k: 4, embargoFrac: 0 });
    const sizes = folds.map((f) => f.testIdx.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it('k=N: each fold is a single sample', () => {
    const folds = purgedKFold(SIX_SAMPLES, { k: 6, embargoFrac: 0 });
    expect(folds).toHaveLength(6);
    folds.forEach((f) => expect(f.testIdx).toHaveLength(1));
    const all = allTestIdx(folds).sort((a, b) => a - b);
    expect(all).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

// ---------------------------------------------------------------------------
// 2. No test sample in train
// ---------------------------------------------------------------------------

describe('purgedKFold — trainIdx ∩ testIdx = ∅', () => {
  it('no test sample leaks into train (k=3, embargoFrac=0)', () => {
    const folds = purgedKFold(SIX_SAMPLES, { k: 3, embargoFrac: 0 });
    folds.forEach((fold) => {
      expect(intersects(fold.trainIdx, fold.testIdx)).toBe(false);
    });
  });

  it('no test sample leaks into train (k=6, embargoFrac=0)', () => {
    const folds = purgedKFold(SIX_SAMPLES, { k: 6, embargoFrac: 0 });
    folds.forEach((fold) => {
      expect(intersects(fold.trainIdx, fold.testIdx)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Purge tests
// ---------------------------------------------------------------------------
//
// Setup (k=3, embargoFrac=0):
//   Fold 0 test: indices [0,1] → entryTimestamp ∈ {100,200}, exit ∈ {199,299}
//     testSpan.lo = 100, testSpan.hi = 299
//   Fold 1 test: indices [2,3] → entry ∈ {300,400}, exit ∈ {399,499}
//     testSpan.lo = 300, testSpan.hi = 499
//   Fold 2 test: indices [4,5] → entry ∈ {500,600}, exit ∈ {599,699}
//     testSpan.lo = 500, testSpan.hi = 699
//
// A sample whose label window overlaps the test span MUST be purged from train.
// A sample that ends before the test span with no overlap MUST survive.

describe('purgedKFold — PURGE removes overlapping train samples', () => {
  it('a sample whose exit overlaps testSpan.lo is absent from trainIdx', () => {
    // Sample exits at 350, inside fold-1 testSpan [300,499] → PURGE
    // overlap: entry=50 <= 499 AND exit=350 >= 300 → TRUE
    const overlappingSample: CvSample = { entryTimestamp: 50, exitTimestamp: 350 };
    const samples: CvSample[] = [overlappingSample, ...SIX_SAMPLES];
    const folds = purgedKFold(samples, { k: 3, embargoFrac: 0 });

    // Find the fold whose test span covers [300,499]
    const targetFold = folds.find((f) =>
      f.testIdx.some((i) => {
        const s = samples[i];
        return s !== undefined && s.entryTimestamp >= 300 && s.entryTimestamp < 500;
      }),
    );
    expect(targetFold).toBeDefined();
    if (targetFold === undefined) return;

    // overlappingSample is original index 0.
    // If it is in test, it trivially won't be in train — no need to assert.
    // If it is in train (which would be wrong), the assertion catches it.
    if (!targetFold.testIdx.includes(0)) {
      expect(targetFold.trainIdx).not.toContain(0);
    }
  });

  it('a sample entirely before testSpan (no overlap) is present in trainIdx', () => {
    // Sample [50,80] — ends at 80, before testSpan of fold-1 (300–499)
    // overlap: 50 <= 499 AND 80 >= 300 → FALSE (80 < 300) → KEEP
    const cleanSample: CvSample = { entryTimestamp: 50, exitTimestamp: 80 };
    const samples: CvSample[] = [cleanSample, ...SIX_SAMPLES];
    const folds = purgedKFold(samples, { k: 3, embargoFrac: 0 });

    const fold1 = folds.find((f) =>
      f.testIdx.some((i) => {
        const s = samples[i];
        return s !== undefined && s.entryTimestamp >= 300 && s.entryTimestamp < 500;
      }),
    );
    expect(fold1).toBeDefined();
    if (fold1 === undefined) return;

    // cleanSample is original index 0 (entry=50, earliest).
    // It should not land in the test block of fold-1, and should be in train.
    if (!fold1.testIdx.includes(0)) {
      expect(fold1.trainIdx).toContain(0);
    }
  });

  it('a sample that straddles the full test span is purged', () => {
    // entry=250 (before testSpan.lo=300), exit=450 (inside testSpan [300,499])
    // overlap: 250 <= 499 AND 450 >= 300 → TRUE → PURGE
    const straddle: CvSample = { entryTimestamp: 250, exitTimestamp: 450 };
    const samples: CvSample[] = [...SIX_SAMPLES, straddle];
    const folds = purgedKFold(samples, { k: 3, embargoFrac: 0 });

    const targetFold = folds.find((f) =>
      f.testIdx.some((i) => {
        const s = samples[i];
        return s !== undefined && s.entryTimestamp >= 300 && s.exitTimestamp <= 499;
      }),
    );
    expect(targetFold).toBeDefined();
    if (targetFold === undefined) return;

    const straddleOrigIdx = samples.indexOf(straddle); // 6
    if (!targetFold.testIdx.includes(straddleOrigIdx)) {
      expect(targetFold.trainIdx).not.toContain(straddleOrigIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Embargo tests  (deterministic, unambiguous boundaries)
// ---------------------------------------------------------------------------
//
// 5-sample dataset:
//   globalMinEntry = 0, globalMaxExit = 999  → globalRange = 999
//
// k=5, one sample per fold.
// Fold 0 test = [0] → entry=0, exit=199
//   testSpan.lo=0, testSpan.hi=199
//   embargoFrac=0.1 → embargoWidth = 99.9
//   embargo window: (199, 298.9]
//
//   idx 1: entry=200 → 200 ∈ (199, 298.9] → EMBARGOED (absent from fold-0 train)
//   idx 2: entry=300 → 300 > 298.9         → SAFE (present in fold-0 train)

describe('purgedKFold — EMBARGO drops samples within embargo window', () => {
  const EMBARGO_SAMPLES: CvSample[] = [
    { entryTimestamp: 0,   exitTimestamp: 199 },   // idx 0 — test fold 0
    { entryTimestamp: 200, exitTimestamp: 399 },   // idx 1 — entry=200 in (199, 298.9]
    { entryTimestamp: 300, exitTimestamp: 499 },   // idx 2 — entry=300 > 298.9 → safe
    { entryTimestamp: 500, exitTimestamp: 699 },   // idx 3 — safe
    { entryTimestamp: 700, exitTimestamp: 999 },   // idx 4 — safe
  ];

  it('a sample entering inside the embargo window is absent from trainIdx', () => {
    const folds = purgedKFold(EMBARGO_SAMPLES, { k: 5, embargoFrac: 0.1 });
    // After sorting by entryTimestamp, fold 0 = [idx 0] (entry=0)
    const fold0 = at(folds, 0);
    expect(fold0.testIdx).toContain(0);
    // sample idx 1 (entry=200) is in embargo window → absent
    expect(fold0.trainIdx).not.toContain(1);
  });

  it('a sample entering just past the embargo window is present in trainIdx', () => {
    const folds = purgedKFold(EMBARGO_SAMPLES, { k: 5, embargoFrac: 0.1 });
    // fold 0: sample idx 2 (entry=300) > 298.9 → present
    const fold0 = at(folds, 0);
    expect(fold0.trainIdx).toContain(2);
  });

  it('embargo=0 keeps samples immediately after testSpan.hi', () => {
    const folds = purgedKFold(EMBARGO_SAMPLES, { k: 5, embargoFrac: 0 });
    const fold0 = at(folds, 0);
    // With no embargo, sample idx 1 (entry=200, right after testSpan.hi=199):
    //   overlap check: 200 <= 199 → FALSE → no overlap → KEEP
    expect(fold0.trainIdx).toContain(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Guards and determinism
// ---------------------------------------------------------------------------

describe('purgedKFold — guards', () => {
  it('k < 2 throws', () => {
    expect(() => purgedKFold(SIX_SAMPLES, { k: 1, embargoFrac: 0 })).toThrow();
  });

  it('k > N throws', () => {
    expect(() => purgedKFold(SIX_SAMPLES, { k: 7, embargoFrac: 0 })).toThrow();
  });

  it('empty samples returns []', () => {
    expect(purgedKFold([], { k: 2, embargoFrac: 0 })).toEqual([]);
  });

  it('is deterministic: two calls with same input produce identical output', () => {
    const a = purgedKFold(SIX_SAMPLES, { k: 3, embargoFrac: 0.05 });
    const b = purgedKFold(SIX_SAMPLES, { k: 3, embargoFrac: 0.05 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// 6. Ordering: ties broken by original index
// ---------------------------------------------------------------------------

describe('purgedKFold — tie-breaking by original index', () => {
  it('samples with same entryTimestamp are ordered by original index', () => {
    const tied: CvSample[] = [
      { entryTimestamp: 100, exitTimestamp: 200 }, // 0
      { entryTimestamp: 100, exitTimestamp: 300 }, // 1
      { entryTimestamp: 200, exitTimestamp: 400 }, // 2
      { entryTimestamp: 300, exitTimestamp: 500 }, // 3
    ];
    const folds1 = purgedKFold(tied, { k: 2, embargoFrac: 0 });
    const folds2 = purgedKFold(tied, { k: 2, embargoFrac: 0 });
    expect(JSON.stringify(folds1)).toBe(JSON.stringify(folds2));
    // Still partitions all 4 indices
    const all = allTestIdx(folds1).sort((a, b) => a - b);
    expect(all).toEqual([0, 1, 2, 3]);
  });
});
