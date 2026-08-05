/**
 * Drawdown-based Sharpe revision — decide without waiting for significance.
 *
 * PURE: no clock, no IO. Every input is passed in.
 *
 * WHY THIS EXISTS
 * Proving an edge from live returns requires a Minimum Track Record Length that
 * scales as 1/Sharpe² (Bailey & Lopez de Prado 2012): roughly 6 months for the
 * book at Sharpe 2.26, and over 6 YEARS for a single Sharpe-0.66 leg. Waiting
 * for a t-stat is therefore not a usable decision procedure, and no cleverer
 * significance test escapes the 1/SR² scaling.
 *
 * A DRAWDOWN, by contrast, is decidable fast — precisely because a drawdown
 * deep enough to matter is a LARGE signal. For a drifted Brownian equity curve
 * the all-time maximum drawdown is exponentially distributed:
 *
 *     P(MaxDD >= D | Sharpe S, vol σ) = exp(-2·D·S/σ)
 *
 * Note this is the INFINITE-horizon maximum. Over a finite live window the true
 * probability is lower, so the test is conservative — it under-fires rather
 * than crying wolf, which is the right direction for a rule that de-risks money.
 *
 * WHAT IT RETURNS
 * Inverting the same expression at a chosen confidence gives the highest Sharpe
 * still defensible after observing drawdown D:
 *
 *     S*(D) = -σ·ln(α) / (2·D)
 *
 * S* is a one-sided UPPER bound: after a 12% drawdown on a 12%-vol book you may
 * no longer claim Sharpe 2 — only ~1.5. Two depths fall out of it, and both are
 * computable BEFORE a single trade is placed, which is the operational point:
 *
 *   - rejectAtDrawdown — where S* crosses the assumed Sharpe. The assumption is
 *     no longer credible; halve the allocation.
 *   - cutAtDrawdown    — where S* crosses the minimum Sharpe that earns a slot.
 *     The sleeve no longer deserves capital.
 *
 * This is the Rej/Seager/Bouchaud principle made operational: an excessive
 * drawdown triggers a downward REVISION of the assumed Sharpe rather than a
 * significance test, and you cut when the revised figure stops paying its way.
 */

export interface SharpeRevisionInputs {
  /** Observed drawdown from peak, as a fraction (0.09 = 9%). */
  drawdown: number;
  /** The Sharpe the allocation was sized on (frozen at deploy). */
  assumedSharpe: number;
  /** Annualized volatility the book is run at — sets the drawdown scale. */
  annualizedVol: number;
  /** One-sided significance for rejecting the assumed Sharpe. Default 0.05. */
  alpha?: number;
  /** Below this revised Sharpe a sleeve no longer earns its allocation. Default 0.5. */
  minAllocatableSharpe?: number;
}

export type RevisionVerdict = 'consistent' | 'revise' | 'cut';

export interface SharpeRevision {
  /** P(MaxDD >= observed | assumed Sharpe). Small ⇒ the assumption is in trouble. */
  pValue: number;
  /**
   * Highest Sharpe still defensible given the observed drawdown (upper bound at
   * `alpha`). Null when there is no drawdown yet — nothing to infer from.
   */
  impliedSharpe: number | null;
  /** Drawdown at which the assumed Sharpe stops being credible. Pre-computable. */
  rejectAtDrawdown: number;
  /** Drawdown at which the revised Sharpe drops below the allocation floor. */
  cutAtDrawdown: number;
  /** Drawdown a healthy book at the assumed Sharpe would typically reach. */
  medianDrawdown: number;
  verdict: RevisionVerdict;
  reason: string;
}

/** Drawdown depth at which `P(MaxDD >= D) = p`, for a Sharpe-S, vol-σ curve. */
function depthAtProbability(p: number, sharpe: number, annualizedVol: number): number {
  return (-annualizedVol * Math.log(p)) / (2 * sharpe);
}

/**
 * The drawdown a healthy curve typically reaches — the median all-time MaxDD.
 * Useful context: it says what "normal" looks like at the assumed Sharpe, so a
 * live figure can be read against something other than zero.
 */
export function medianMaxDrawdown(sharpe: number, annualizedVol: number): number {
  return depthAtProbability(0.5, sharpe, annualizedVol);
}

const SAFE: Omit<SharpeRevision, 'reason'> = {
  pValue: 1, impliedSharpe: null, rejectAtDrawdown: Number.POSITIVE_INFINITY,
  cutAtDrawdown: Number.POSITIVE_INFINITY, medianDrawdown: Number.POSITIVE_INFINITY,
  verdict: 'consistent',
};

export function reviseSharpe(inputs: SharpeRevisionInputs): SharpeRevision {
  const {
    drawdown, assumedSharpe, annualizedVol,
    alpha = 0.05, minAllocatableSharpe = 0.5,
  } = inputs;

  // Fail SAFE on unusable inputs: a governance rule that cuts capital must never
  // act on a NaN or a zero-vol config. Silence is the correct failure mode here.
  const usable =
    Number.isFinite(drawdown) && drawdown >= 0 &&
    Number.isFinite(assumedSharpe) && assumedSharpe > 0 &&
    Number.isFinite(annualizedVol) && annualizedVol > 0 &&
    alpha > 0 && alpha < 1 && minAllocatableSharpe > 0;
  if (!usable) {
    return { ...SAFE, reason: 'inputs unusable — no revision attempted' };
  }

  const rejectAtDrawdown = depthAtProbability(alpha, assumedSharpe, annualizedVol);
  const cutAtDrawdown = depthAtProbability(alpha, minAllocatableSharpe, annualizedVol);
  const medianDrawdown = medianMaxDrawdown(assumedSharpe, annualizedVol);

  if (drawdown === 0) {
    return {
      pValue: 1, impliedSharpe: null, rejectAtDrawdown, cutAtDrawdown, medianDrawdown,
      verdict: 'consistent', reason: 'no drawdown — nothing to revise',
    };
  }

  const pValue = Math.exp((-2 * drawdown * assumedSharpe) / annualizedVol);
  // Upper confidence bound on the Sharpe, given the drawdown actually observed.
  const impliedSharpe = (-annualizedVol * Math.log(alpha)) / (2 * drawdown);

  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

  if (pValue >= alpha) {
    return {
      pValue, impliedSharpe, rejectAtDrawdown, cutAtDrawdown, medianDrawdown,
      verdict: 'consistent',
      reason: `drawdown ${pct(drawdown)} is consistent with Sharpe ${assumedSharpe} (p=${pValue.toFixed(3)}); revision would start at ${pct(rejectAtDrawdown)}`,
    };
  }
  if (impliedSharpe < minAllocatableSharpe) {
    return {
      pValue, impliedSharpe, rejectAtDrawdown, cutAtDrawdown, medianDrawdown,
      verdict: 'cut',
      reason: `drawdown ${pct(drawdown)} caps the Sharpe at ${impliedSharpe.toFixed(2)} < floor ${minAllocatableSharpe} — no longer earns its allocation`,
    };
  }
  return {
    pValue, impliedSharpe, rejectAtDrawdown, cutAtDrawdown, medianDrawdown,
    verdict: 'revise',
    reason: `drawdown ${pct(drawdown)} refutes Sharpe ${assumedSharpe} (p=${pValue.toFixed(3)}) — revise to at most ${impliedSharpe.toFixed(2)}; cut at ${pct(cutAtDrawdown)}`,
  };
}
