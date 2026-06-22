/**
 * Portfolio sizing — PURE, dependency-injected money-path math.
 *
 * Four governance layers, all computed strictly from data BEFORE the bar
 * (no look-ahead) and ALL on FUNDING-DEBITED returns (Task 4 ledger /
 * funding-net return series), never gross:
 *
 *   1. annualizedVol / volTargetLeverage — constant-vol targeting.
 *   2. noTradeBand — suppress churn (funding/fee bleed) on tiny target moves.
 *   3. fractionalKellyVolTarget — half-Kelly target vol off rolling deflated
 *      Sharpe; stand down to 0 when the deflated Sharpe is non-positive.
 *   4. cppiExposureMultiplier — continuous drawdown cut anchored to the
 *      retirement E[MaxDD]/hardKillDD bounds, off a TRAILING peak.
 *
 * Design note (multiplier stacking): every layer here returns a multiplier
 * bounded in [0, something]. They are intended to compose multiplicatively with
 * the discrete circuit-breaker / kill-switch, which is kept INDEPENDENT. The
 * CPPI floor is RECOVERABLE — it un-cuts as drawdown recovers — unlike the
 * latched kill. So CPPI driving sizing to 0 does NOT permanently pin the book
 * flat; only the latched kill does that, and that is an explicit manual-reset
 * decision, not an emergent product of the sizing stack.
 *
 * NO Date.now(), NO fetch, NO DB — every input is an argument.
 *
 * References:
 *   - Carver, "Systematic Trading" (vol targeting, no-trade buffer).
 *   - Rising & Wyner / MacLean-Thorp-Ziemba (fractional Kelly).
 *   - Black & Jones / Perold-Sharpe (CPPI cushion).
 *   - Bailey & de Prado (deflated Sharpe — the Kelly scalar's input).
 */

/** Bars per year for a 1-hour crypto series (24*365). NOT the equities 252. */
export const BARS_PER_YEAR_1H = 8760;
/** Bars per year for a daily crypto series (crypto trades 365 days). NOT 252. */
export const BARS_PER_YEAR_DAILY = 365;

/** Sample (n-1) standard deviation of a return series. 0 for < 2 obs. */
function sampleStd(returns: number[]): number {
  const n = returns.length;
  if (n < 2) return 0;
  const mean = returns.reduce((s, x) => s + x, 0) / n;
  const variance = returns.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

/**
 * Annualized volatility of a (funding-net) return series.
 *
 *   annVol = perBarStd * sqrt(barsPerYear)
 *
 * CRITICAL: `barsPerYear` MUST match the series cadence — 8760 for 1h crypto,
 * 365 for daily crypto. Using the equities 252 on an hourly series understates
 * vol by ~sqrt(252/8760) ≈ 0.17×, which would silently OVER-lever the book by
 * ~5.9×. Always pass the correct constant for the series.
 */
export function annualizedVol(returns: number[], barsPerYear: number): number {
  return sampleStd(returns) * Math.sqrt(barsPerYear);
}

/**
 * Constant-vol-target leverage: scale a sleeve so its realized vol hits the
 * target, capped at `maxLeverage`.
 *
 *   leverage = min(targetVol / realizedVol, maxLeverage)
 *
 * No lower floor — a hot series correctly delevers BELOW 1×. Returns 0 for a
 * dead (zero-vol) series (cannot size off nothing).
 */
export function volTargetLeverage(args: {
  realizedVol: number;
  targetVol: number;
  maxLeverage: number;
}): number {
  const { realizedVol, targetVol, maxLeverage } = args;
  if (realizedVol <= 0) return 0;
  return Math.min(targetVol / realizedVol, maxLeverage);
}

export interface NoTradeBandResult {
  /** True ⇒ move to target; false ⇒ hold the current leverage. */
  rebalance: boolean;
  /** The leverage to carry forward (target if rebalancing, else current). */
  newLev: number;
}

/**
 * No-trade band: rebalance ONLY when the leverage gap exceeds the band, else
 * HOLD the current leverage (suppress churn → less funding/fee bleed).
 *
 *   band     = max(absTol, relTol * targetLev)
 *   rebalance = |currentLev - targetLev| > band   (STRICT >; the edge holds)
 *   newLev    = rebalance ? targetLev : currentLev
 *
 * The strict `>` means a gap exactly AT the band edge holds — we only act once
 * the move is genuinely larger than the buffer.
 *
 * PROTECTIVE STAND-DOWN OVERRIDE: a target of EXACTLY 0 is a protective move to
 * flat (the Kelly stand-down when the deflated Sharpe is non-positive). Going
 * flat is always honored — the band must NEVER swallow it — otherwise a tiny
 * current leverage sitting inside `max(absTol, 0)` would keep the book exposed
 * after the edge has gone non-positive. The band only suppresses churn BETWEEN
 * non-trivial positive targets.
 */
export function noTradeBand(args: {
  currentLev: number;
  targetLev: number;
  absTol: number;
  relTol: number;
}): NoTradeBandResult {
  const { currentLev, targetLev, absTol, relTol } = args;
  // Protective stand-down: a 0 target always goes flat, bypassing the band.
  if (targetLev === 0) {
    return { rebalance: true, newLev: 0 };
  }
  const band = Math.max(absTol, relTol * Math.abs(targetLev));
  const gap = Math.abs(currentLev - targetLev);
  if (gap > band) {
    return { rebalance: true, newLev: targetLev };
  }
  return { rebalance: false, newLev: currentLev };
}

/**
 * Fractional-Kelly vol target off the rolling DEFLATED Sharpe.
 *
 * Half-Kelly (fraction = 0.5) scales the base target vol by the (clamped)
 * fractional-Kelly scalar:
 *
 *   scale      = clamp(fraction * deflatedSharpeRolling, 0, 1)
 *   usedTarget = baseTargetVol * scale
 *
 * Relationship to `baseTargetVol`: `baseTargetVol` is the MAXIMUM vol we will
 * ever run (the scale is clamped to 1, so we never lever ABOVE base). A strong
 * edge (frac*SR >= 1) runs the full base target; a weak-but-positive edge runs
 * a proportionally smaller target; a non-positive deflated Sharpe STANDS DOWN to
 * 0 vol (no exposure). Using the DEFLATED Sharpe (selection-bias corrected) as
 * the Kelly input is deliberate — it prevents Kelly from over-betting an
 * inflated in-sample Sharpe.
 */
export function fractionalKellyVolTarget(args: {
  deflatedSharpeRolling: number;
  baseTargetVol: number;
  fraction: number;
}): number {
  const { deflatedSharpeRolling, baseTargetVol, fraction } = args;
  if (deflatedSharpeRolling <= 0) return 0; // stand down — no positive edge
  const scale = Math.min(1, Math.max(0, fraction * deflatedSharpeRolling));
  return baseTargetVol * scale;
}

/**
 * CPPI continuous drawdown cut, anchored to the retirement E[MaxDD]/hardKillDD.
 *
 *   mult = clamp(1 - (drawdown - eMaxDD) / (hardKillDD - eMaxDD), 0, 1)
 *
 *   - drawdown <= eMaxDD      ⇒ 1.0  (full exposure inside the expected band)
 *   - drawdown >= hardKillDD  ⇒ 0.0  (cushion exhausted)
 *   - linear taper in between.
 *
 * The `drawdown` input is measured from a TRAILING PEAK (see
 * `trailingPeakDrawdown`), so the cushion RESETS (multiplier rises back toward
 * 1.0) on new equity highs and as drawdown recovers. This is the key property
 * that keeps CPPI RECOVERABLE and distinct from the latched kill-switch: sizing
 * going to 0 from CPPI is undone automatically as equity recovers, whereas the
 * kill latch requires a manual reset. Use the SAME eMaxDD/hardKillDD that the
 * retirement layer uses (frozen at deploy) so the two layers agree on bounds.
 */
export function cppiExposureMultiplier(args: {
  drawdown: number;
  eMaxDD: number;
  hardKillDD: number;
}): number {
  const { drawdown, eMaxDD, hardKillDD } = args;
  const span = hardKillDD - eMaxDD;
  if (span <= 0) {
    // Degenerate bounds: collapse to a hard step at hardKillDD.
    return drawdown >= hardKillDD ? 0 : 1;
  }
  const raw = 1 - (drawdown - eMaxDD) / span;
  return Math.min(1, Math.max(0, raw));
}

export interface TrailingPeakResult {
  /** Ratcheted peak: max(priorPeak, equity). */
  peak: number;
  /** Drawdown from the (ratcheted) peak as a fraction in [0, 1). */
  drawdown: number;
}

/**
 * Trailing-peak drawdown. Ratchets the peak up on new equity highs and reports
 * the drawdown from that peak. A new high zeroes the drawdown — this is the
 * floor that makes the CPPI cushion recover.
 */
export function trailingPeakDrawdown(args: {
  equity: number;
  priorPeak: number;
}): TrailingPeakResult {
  const { equity, priorPeak } = args;
  const peak = Math.max(priorPeak, equity);
  const drawdown = peak > 0 ? Math.max(0, 1 - equity / peak) : 0;
  return { peak, drawdown };
}
