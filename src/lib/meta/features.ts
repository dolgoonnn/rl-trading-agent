/**
 * Augmented meta-labeler features.
 *
 * Pure functions only — no Date.now(), no new Date(), no Math.random(),
 * no fetch, no DB access. All time arithmetic uses epoch-ms directly.
 *
 * Leakage rule (critical): sequence features (priorOutcome, recentWinRate,
 * priorCount) may ONLY look at trades whose exitTimestamp <= this trade's
 * entryTimestamp. A still-open or future trade is never included.
 */

import type { TradeFeatureRow } from './dataset';

/** Number of most-recent prior closed trades to use for recentWinRate. */
const RECENT_WIN_RATE_N = 5;

/**
 * Walk through all rows on a single symbol and attach sequence features.
 * Returns new augmented rows (inputs never mutated).
 *
 * @param symbolRows Rows for ONE symbol, sorted ascending by entryTimestamp.
 * @param globalBaseRate Fallback win-rate when there is no prior history.
 */
function augmentSymbolRows(
  symbolRows: TradeFeatureRow[],
  globalBaseRate: number,
): TradeFeatureRow[] {
  return symbolRows.map((current) => {
    // Collect already-closed trades: exitTimestamp <= current.entryTimestamp.
    // The filter over all symbolRows ensures we apply the leakage rule strictly
    // regardless of input ordering. O(n²) — acceptable for dataset sizes here.
    const closedBefore: TradeFeatureRow[] = symbolRows
      .filter((r) => r !== current && r.exitTimestamp <= current.entryTimestamp)
      .sort((a, b) => a.exitTimestamp - b.exitTimestamp); // ascending by close time

    // priorCount: raw count of closed prior same-symbol trades
    const priorCount = closedBefore.length;

    // priorOutcome: label of the most-recent closed prior trade.
    // Encoded as +1 (win) / -1 (loss); 0 if no prior trade.
    let priorOutcome = 0;
    const mostRecent = closedBefore.at(-1); // undefined-safe (at() returns T | undefined)
    if (mostRecent !== undefined) {
      priorOutcome = mostRecent.label === 1 ? 1 : -1;
    }

    // recentWinRate: win-rate over the up-to-N most recent closed trades.
    // Falls back to globalBaseRate when there is no history.
    let recentWinRate: number;
    if (closedBefore.length === 0) {
      recentWinRate = globalBaseRate;
    } else {
      const recentWindow = closedBefore.slice(-RECENT_WIN_RATE_N);
      const wins = recentWindow.filter((r) => r.label === 1).length;
      recentWinRate = wins / recentWindow.length;
    }

    // hourOfDay: pure epoch arithmetic, UTC hour 0–23.
    // Ban: new Date() / Date.now() — use raw ms arithmetic.
    const hourOfDay = Math.floor((current.entryTimestamp / 3_600_000) % 24);

    // dayOfWeek: pure epoch arithmetic, 0–6.
    // Epoch day 0 = 1970-01-01 (Thursday). This is an absolute-epoch weekday
    // proxy (0 ≠ Sunday). Consistent and fine as a feature — document that.
    const dayOfWeek = Math.floor((current.entryTimestamp / 86_400_000) % 7);

    return {
      ...current,
      features: {
        ...current.features,
        priorOutcome,
        recentWinRate,
        priorCount,
        hourOfDay,
        dayOfWeek,
      },
    };
  });
}

/**
 * Augment every row in the dataset with sequence/time context features.
 *
 * New features attached to each row's `features` map:
 *   - `priorOutcome`:   +1/−1/0 — outcome of most-recent prior closed trade
 *   - `recentWinRate`:  win-rate over last N=5 prior closed trades (or global
 *                       base rate when no history)
 *   - `priorCount`:     count of already-closed same-symbol trades
 *   - `hourOfDay`:      UTC hour 0–23 via epoch arithmetic
 *   - `dayOfWeek`:      epoch-day weekday proxy 0–6 via epoch arithmetic
 *
 * Leakage rule: a trade counts as "prior" only when
 * `exitTimestamp <= current.entryTimestamp`. Never uses a still-open trade.
 *
 * Pure, deterministic — no Date.now(), no new Date(), no Math.random(),
 * no fetch, no DB. Returns new row objects (inputs not mutated).
 */
export function augmentFeatures(rows: TradeFeatureRow[]): TradeFeatureRow[] {
  if (rows.length === 0) return [];

  // Global base rate: wins / total rows. Used as fallback for recentWinRate
  // when a trade has no prior same-symbol history.
  const totalWins = rows.filter((r) => r.label === 1).length;
  const globalBaseRate = totalWins / rows.length;

  // Group rows by symbol. Map keys are symbol strings; values are row arrays.
  const bySymbol = new Map<string, TradeFeatureRow[]>();
  for (const row of rows) {
    const existing = bySymbol.get(row.symbol);
    if (existing !== undefined) {
      existing.push(row);
    } else {
      bySymbol.set(row.symbol, [row]);
    }
  }

  // Sort each group by entryTimestamp ascending and augment.
  // Build a lookup map from original row → augmented row so we can
  // reconstruct the output in input order below.
  const augmentedLookup = new Map<TradeFeatureRow, TradeFeatureRow>();
  for (const [, group] of bySymbol) {
    group.sort((a, b) => a.entryTimestamp - b.entryTimestamp);
    const augmented = augmentSymbolRows(group, globalBaseRate);
    // Pair originals with their augmented counterparts (same length, same order).
    group.forEach((original, idx) => {
      const aug = augmented[idx];
      if (aug === undefined) {
        throw new Error(
          `Internal: augmented array shorter than input for symbol group`,
        );
      }
      augmentedLookup.set(original, aug);
    });
  }

  // Reconstruct output preserving input ordering.
  return rows.map((r) => {
    const aug = augmentedLookup.get(r);
    if (aug === undefined) {
      throw new Error(
        `Internal: no augmented row for ${r.symbol}@${r.entryTimestamp}`,
      );
    }
    return aug;
  });
}
