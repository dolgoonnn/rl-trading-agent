/**
 * Evaluation metrics for the meta-labeler classifier.
 *
 * Pure, deterministic. No Date/random/IO.
 *
 * auc          — rank-based AUC (Mann–Whitney U). Handles ties via average ranks.
 *                One-class input → 0.5 (undefined case).
 * topQuantileLift — win-rate of top-q scoring samples minus overall base rate.
 */

// ---------------------------------------------------------------------------
// AUC — rank-based (Mann–Whitney U)
// ---------------------------------------------------------------------------

/**
 * Compute AUC using the rank-based Mann–Whitney U statistic.
 *
 * AUC = (Σ ranks of positives − n_pos*(n_pos+1)/2) / (n_pos * n_neg)
 *
 * Ties are handled via average ranks (same score → same avg rank).
 *
 * One-class input (all positives or all negatives, or empty) → returns 0.5.
 *
 * @param scores  Predicted probabilities or scores, one per sample.
 * @param labels  Binary labels (1=positive, 0=negative), same length as scores.
 * @returns AUC in [0, 1].
 */
export function auc(scores: number[], labels: number[]): number {
  const n = scores.length;

  // Count positives and negatives
  let nPos = 0;
  let nNeg = 0;
  for (const label of labels) {
    if (label === 1) nPos++;
    else nNeg++;
  }

  // One-class guard: undefined AUC → 0.5
  if (nPos === 0 || nNeg === 0 || n === 0) return 0.5;

  // Build array of (score, label) pairs, sort ascending by score
  const pairs: Array<{ score: number; label: number }> = scores.map((s, i) => ({
    score: s,
    label: labels[i] ?? 0,
  }));
  pairs.sort((a, b) => a.score - b.score);

  // Assign average ranks (1-based) handling ties:
  // Samples with the same score get the average of the ranks they would occupy.
  const ranks: number[] = new Array<number>(n).fill(0);
  let i = 0;
  while (i < n) {
    // Find extent of tie group
    let j = i;
    while (j < n && (pairs[j]?.score ?? 0) === (pairs[i]?.score ?? 0)) {
      j++;
    }
    // Average rank for positions i..j-1 (1-based: positions are i+1..j)
    const avgRank = (i + 1 + j) / 2; // = ((i+1) + j) / 2
    for (let k = i; k < j; k++) {
      ranks[k] = avgRank;
    }
    i = j;
  }

  // Sum ranks of positives
  let sumRanksPos = 0;
  for (let idx = 0; idx < n; idx++) {
    if ((pairs[idx]?.label ?? 0) === 1) {
      sumRanksPos += ranks[idx] ?? 0;
    }
  }

  // Mann–Whitney U formula
  return (sumRanksPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

// ---------------------------------------------------------------------------
// Top-quantile lift
// ---------------------------------------------------------------------------

/**
 * Compute the top-quantile lift: win-rate of the top-q scoring samples
 * minus the overall base rate.
 *
 * @param scores  Predicted scores, one per sample.
 * @param labels  Binary labels (1=win, 0=loss).
 * @param q       Quantile in (0, 1]. Top ceil(q*N) samples are selected.
 * @returns Lift = (top-q win-rate) − (overall base rate).
 */
export function topQuantileLift(scores: number[], labels: number[], q: number): number {
  const n = scores.length;
  if (n === 0) return 0;

  // Overall base rate
  let totalWins = 0;
  for (const label of labels) {
    if (label === 1) totalWins++;
  }
  const baseRate = totalWins / n;

  // Select top ceil(q*n) samples by score (descending)
  const pairs: Array<{ score: number; label: number }> = scores.map((s, i) => ({
    score: s,
    label: labels[i] ?? 0,
  }));
  pairs.sort((a, b) => b.score - a.score); // descending

  const topK = Math.ceil(q * n);
  const topSlice = pairs.slice(0, topK);

  let topWins = 0;
  for (const p of topSlice) {
    if (p.label === 1) topWins++;
  }
  const topWinRate = topSlice.length > 0 ? topWins / topSlice.length : 0;

  return topWinRate - baseRate;
}
