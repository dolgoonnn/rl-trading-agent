/**
 * Purged + embargoed k-fold cross-validation (López de Prado).
 *
 * Prevents leakage in financial time-series classification:
 *   PURGE  — drops any train sample whose label window overlaps the test fold's span.
 *   EMBARGO — additionally drops train samples whose entry falls within an embargo
 *             buffer after the test fold, eliminating serial-correlation leakage.
 *
 * PURE: no side effects, no randomness, no Date.now(). Fully deterministic.
 */

export interface CvSample {
  /** Timestamp (ms or any monotone integer) when the trade was entered. */
  entryTimestamp: number;
  /** Timestamp when the trade outcome (label) was determined. */
  exitTimestamp: number;
}

export interface CvFold {
  /** Indices into the original samples array that form this fold's test set. */
  testIdx: number[];
  /** Indices into the original samples array that survived purge + embargo. */
  trainIdx: number[];
}

// ---------------------------------------------------------------------------
// Internal helper: safe indexed access (satisfies noUncheckedIndexedAccess)
// ---------------------------------------------------------------------------

function mustGet<T>(arr: readonly T[], i: number, label: string): T {
  const v = arr[i];
  if (v === undefined) {
    throw new Error(`purgedKFold: internal error — ${label}[${i}] out of range`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function purgedKFold(
  samples: CvSample[],
  opts: { k: number; embargoFrac: number },
): CvFold[] {
  const { k, embargoFrac } = opts;
  const n = samples.length;

  // Guard: empty input → trivial output (before k-guards so [] bypasses them)
  if (n === 0) return [];

  // Guards
  if (k < 2) throw new Error(`purgedKFold: k must be ≥ 2, got ${k}`);
  if (k > n) throw new Error(`purgedKFold: k (${k}) must not exceed number of samples (${n})`);

  // -------------------------------------------------------------------------
  // Step 1: Sort indices by entryTimestamp ascending; ties → original index
  // -------------------------------------------------------------------------
  const sortedIdx: number[] = Array.from({ length: n }, (_, i) => i);
  sortedIdx.sort((a, b) => {
    const sa = mustGet(samples, a, 'samples');
    const sb = mustGet(samples, b, 'samples');
    const diff = sa.entryTimestamp - sb.entryTimestamp;
    return diff !== 0 ? diff : a - b; // stable: tie-break by original position
  });

  // -------------------------------------------------------------------------
  // Step 2: Partition sortedIdx into k contiguous blocks (sizes differ by ≤1)
  // -------------------------------------------------------------------------
  // With n items and k folds: (n % k) folds get (⌊n/k⌋ + 1) items, the rest get ⌊n/k⌋.
  const baseSize = Math.floor(n / k);
  const remainder = n % k;

  const testFolds: number[][] = []; // each entry = original indices for that fold's test set
  let cursor = 0;
  for (let f = 0; f < k; f++) {
    const foldSize = baseSize + (f < remainder ? 1 : 0);
    testFolds.push(sortedIdx.slice(cursor, cursor + foldSize));
    cursor += foldSize;
  }

  // -------------------------------------------------------------------------
  // Precompute global range for embargo calculation (done once, outside loop)
  // -------------------------------------------------------------------------
  let globalMinEntry = Infinity;
  let globalMaxExit = -Infinity;
  for (const s of samples) {
    if (s.entryTimestamp < globalMinEntry) globalMinEntry = s.entryTimestamp;
    if (s.exitTimestamp > globalMaxExit) globalMaxExit = s.exitTimestamp;
  }
  const globalRange = globalMaxExit - globalMinEntry;
  const embargoWidth = embargoFrac * globalRange;

  // -------------------------------------------------------------------------
  // Step 3: For each fold, compute trainIdx after purge + embargo
  // -------------------------------------------------------------------------
  const testIdxSets: Set<number>[] = testFolds.map((f) => new Set(f));

  const folds: CvFold[] = testFolds.map((testBlock, foldIdx) => {
    // testSpan = [min entry of test block, max exit of test block]
    let testSpanLo = Infinity;
    let testSpanHi = -Infinity;
    for (const i of testBlock) {
      const s = mustGet(samples, i, 'samples');
      if (s.entryTimestamp < testSpanLo) testSpanLo = s.entryTimestamp;
      if (s.exitTimestamp > testSpanHi) testSpanHi = s.exitTimestamp;
    }

    const embargoEnd = testSpanHi + embargoWidth;
    const testSet = mustGet(testIdxSets, foldIdx, 'testIdxSets');

    const trainIdx: number[] = [];
    for (let i = 0; i < n; i++) {
      // Skip test samples
      if (testSet.has(i)) continue;

      const sample = mustGet(samples, i, 'samples');
      const entry = sample.entryTimestamp;
      const exit = sample.exitTimestamp;

      // PURGE: drop if label window [entry, exit] overlaps [testSpanLo, testSpanHi]
      // Overlap condition: entry <= testSpanHi AND exit >= testSpanLo
      if (entry <= testSpanHi && exit >= testSpanLo) continue;

      // EMBARGO: drop if entry falls in (testSpanHi, testSpanHi + embargoWidth]
      if (embargoWidth > 0 && entry > testSpanHi && entry <= embargoEnd) continue;

      trainIdx.push(i);
    }

    return { testIdx: testBlock, trainIdx };
  });

  return folds;
}
