/**
 * Meta-labeler dataset helpers.
 *
 * Pure functions (no I/O) for building {features, label} rows from
 * backtest trades. Used to train the López de Prado meta-labeler that
 * predicts Run-20 trade win/loss probability.
 */

/** A single training row for the meta-labeler. */
export interface TradeFeatureRow {
  symbol: string;
  entryTimestamp: number;
  exitTimestamp: number;
  direction: 'long' | 'short';
  /**
   * Flat feature vector:
   *   - all factorBreakdown keys (weighted confluence factors)
   *   - confluenceScore (total weighted score)
   *   - dirLong: 1 if long, 0 if short
   *   - regime_<label>: 1 (one-hot encoding of regime string)
   */
  features: Record<string, number>;
  /** 1 if netReturn > 0, 0 otherwise. */
  label: 0 | 1;
}

/** Arguments for building a single training row. */
export interface BuildTradeFeatureRowArgs {
  symbol: string;
  entryTimestamp: number;
  exitTimestamp: number;
  direction: 'long' | 'short';
  /** The factorBreakdown from ScoredSignal (10 confluence factors). */
  factorBreakdown: Record<string, number>;
  /** The totalScore from ScoredSignal. */
  confluenceScore: number;
  /** Human-readable regime string, e.g. 'uptrend+normal'. */
  regimeLabel: string;
  /** Realized net-of-friction return (trade.pnlPercent in backtest). */
  netReturn: number;
}

/**
 * Build a single meta-labeler training row.
 *
 * Features are a flat record combining:
 *   1. All factorBreakdown entries (weighted factor contributions)
 *   2. confluenceScore (the total score)
 *   3. dirLong (binary: 1 = long, 0 = short)
 *   4. One-hot regime key: `regime_<regimeLabel>` = 1
 *
 * Label is 1 if netReturn > 0, else 0.
 *
 * Pure function — no side effects, no I/O.
 */
export function buildTradeFeatureRow(args: BuildTradeFeatureRowArgs): TradeFeatureRow {
  const {
    symbol,
    entryTimestamp,
    exitTimestamp,
    direction,
    factorBreakdown,
    confluenceScore,
    regimeLabel,
    netReturn,
  } = args;

  const features: Record<string, number> = {
    ...factorBreakdown,
    confluenceScore,
    dirLong: direction === 'long' ? 1 : 0,
    [`regime_${regimeLabel}`]: 1,
  };

  const label: 0 | 1 = netReturn > 0 ? 1 : 0;

  return {
    symbol,
    entryTimestamp,
    exitTimestamp,
    direction,
    features,
    label,
  };
}
