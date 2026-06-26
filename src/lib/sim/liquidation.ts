/**
 * Pure liquidation math primitives for isolated-margin USDT-perp positions (Bybit model).
 * No I/O, no side effects.
 */

/**
 * Adverse price move (as a fraction of entry) at which an isolated-margin
 * position is liquidated.  d = 1/L - MMR.  Returns the fraction (e.g. 0.015).
 *
 * @throws if leverage <= 0 or mmr < 0
 * @throws if 1/leverage <= mmr (position is non-viable / instantly liquidatable)
 */
export function liqAdverseMove(leverage: number, mmr: number): number {
  if (leverage <= 0) {
    throw new Error(
      `liqAdverseMove: leverage must be > 0, got ${leverage}`,
    );
  }
  if (mmr < 0) {
    throw new Error(
      `liqAdverseMove: mmr must be >= 0, got ${mmr}`,
    );
  }

  const d = 1 / leverage - mmr;

  if (d <= 0) {
    throw new Error(
      `liqAdverseMove: non-viable position — maintenance margin ratio (${mmr}) ` +
        `already exceeds or equals the margin fraction (1/${leverage} = ${1 / leverage}). ` +
        `Position would be instantly liquidated.`,
    );
  }

  return d;
}

/**
 * Liquidation price for an isolated-margin position.
 *
 * - long:  entry * (1 - d)
 * - short: entry * (1 + d)
 *
 * where d = liqAdverseMove(leverage, mmr).
 *
 * @throws same conditions as liqAdverseMove
 */
export function liquidationPrice(
  entry: number,
  direction: 'long' | 'short',
  leverage: number,
  mmr: number,
): number {
  const d = liqAdverseMove(leverage, mmr);
  return direction === 'long' ? entry * (1 - d) : entry * (1 + d);
}
