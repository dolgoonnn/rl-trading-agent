/**
 * Retirement halt decision — PURE and fully dependency-injected.
 *
 * Pre-committed halts that do NOT trade the live equity curve. Every input
 * (clock, drawdown, rolling Sharpe, trial count, snapshot count, charter-path
 * breach state, frozen-at-deploy thresholds) is passed in. There is NO
 * `Date.now()`, NO `fetch`, NO DB access in this file, so every branch of the
 * confluence logic is unit-testable in isolation.
 *
 * Confluence philosophy (Layer-2/regime):
 *   - A SINGLE Layer-2/regime trip ⇒ SOFT de-risk (halve gross), never hard.
 *   - HARD halt only when an ABSOLUTE stop is hit (drawdown >= hardKillDD, or a
 *     sustained charter 5th-pct path breach), OR when the DSR layer is
 *     CONCLUSIVE (deflated Sharpe insignificant AND the live track record is
 *     long enough, n >= MinTRL) AND there is a corroborating regime/mechanism
 *     cause. We never cut hard at the bottom of a normal drawdown on a short
 *     track record.
 *
 * References:
 *   - Bailey & de Prado, "The Deflated Sharpe Ratio" (2014).
 *   - E[MaxDD] ≈ σ·√(2·ln(T·252))/SR — drawdown magnitude under a GBM equity
 *     curve at the chosen vol/Sharpe (anchors hardKillDD to chosen live vol,
 *     NOT the raw in-sample 63.3%).
 */

import { calculateDeflatedSharpe } from '@/lib/rl/utils/deflated-sharpe';

export type HaltAction = 'trade' | 'derisk' | 'halt';

export interface RetirementDecision {
  action: HaltAction;
  cause: string;
  /** Gross-exposure multiplier: 1 = full, 0.5 = de-risk, 0 = halt. */
  multiplier: number;
}

/** Trading days per year used by the E[MaxDD] horizon term. */
const TRADING_DAYS_PER_YEAR = 252;

/**
 * Expected maximum drawdown of a GBM equity curve at the chosen vol and Sharpe.
 *
 *   E[MaxDD] = σ_annual · √(2 · ln(horizonYears · 252)) / SR
 *
 * This anchors the hard-kill threshold to the *chosen live volatility*, not the
 * raw in-sample 63.3% (which was measured at a different, higher sizing).
 */
export function expectedMaxDD(args: {
  sigmaAnnual: number;
  sharpe: number;
  horizonYears: number;
}): number {
  const { sigmaAnnual, sharpe, horizonYears } = args;
  const horizonObs = horizonYears * TRADING_DAYS_PER_YEAR;
  return (sigmaAnnual * Math.sqrt(2 * Math.log(horizonObs))) / sharpe;
}

/**
 * Hard-kill drawdown threshold: a 1.5× buffer over the WORSE of the analytic
 * E[MaxDD] and the bootstrap 5th-percentile drawdown. Frozen at deploy.
 */
export function hardKillDD(args: { eMaxDD: number; bootstrapP5DD: number }): number {
  return 1.5 * Math.max(args.eMaxDD, args.bootstrapP5DD);
}

export interface RetirementHaltInputs {
  /** Injected clock (ms). Present for symmetry/auditing; logic is clock-free. */
  nowMs: number;

  /** Current drawdown from peak (fraction, e.g. 0.20 = 20%). */
  drawdown: number;
  /** Expected max drawdown at chosen vol/Sharpe (frozen at deploy). */
  eMaxDD: number;
  /** Hard-kill drawdown threshold (frozen at deploy). */
  hardKillDD: number;

  /** Rolling Sharpe over the live equity curve (null when too little data). */
  rollingSharpe: number | null;
  /** Number of independent trials (selection-bias count) for DSR deflation. */
  trialCount: number;
  /** Number of live observations (snapshots) backing the rolling Sharpe. */
  snapshotCount: number;
  /** Minimum track-record length before the DSR layer may HARD-halt. */
  minTrackRecordLength: number;
  /** Benchmark Sharpe `c` the deflated Sharpe must clear (NOT zero; default 0.5). */
  minAcceptableSharpe: number;
  /** PSR threshold (e.g. 0.95). Kept for config symmetry; DSR>c is the gate. */
  psr: number;

  /** A corroborating regime/mechanism cause is present (e.g. regime decay). */
  regimeCause: boolean;

  /** Consecutive checks the cumulative PnL has been below the charter p5 path. */
  charterBreachConsecutive: number;
  /** k — consecutive breaches that escalate yellow → red (hard halt). */
  charterBreachK: number;
}

/**
 * The confluence halt decision. Returns the most severe applicable action.
 *
 * Severity order (checked high → low; first match wins):
 *   1. ABSOLUTE drawdown stop: drawdown >= hardKillDD ⇒ HARD (unconditional).
 *   2. Charter 5th-pct path: k consecutive breaches ⇒ RED hard halt.
 *   3. DSR conclusive: deflated Sharpe < c AND snapshotCount >= MinTRL AND a
 *      regime cause ⇒ HARD.
 *   4. SOFT de-risk (multiplier 0.5) if ANY single Layer-2 trip is present:
 *        - drawdown in [eMaxDD, hardKillDD), OR
 *        - DSR insignificant (deflated Sharpe < c) at ANY track-record length, OR
 *        - a single charter breach (yellow).
 *   5. Otherwise TRADE (multiplier 1).
 */
export function checkRetirementHalt(inputs: RetirementHaltInputs): RetirementDecision {
  const {
    drawdown,
    eMaxDD,
    hardKillDD: hardDD,
    rollingSharpe,
    trialCount,
    snapshotCount,
    minTrackRecordLength: minTRL,
    minAcceptableSharpe,
    regimeCause,
    charterBreachConsecutive,
    charterBreachK,
  } = inputs;

  // 1. ABSOLUTE drawdown stop — unconditional HARD (ignores MinTRL).
  if (drawdown >= hardDD) {
    return {
      action: 'halt',
      cause: `hard drawdown: DD ${(drawdown * 100).toFixed(1)}% >= hardKillDD ${(hardDD * 100).toFixed(1)}%`,
      multiplier: 0,
    };
  }

  // 2. Charter 5th-pct path — k consecutive breaches escalate to RED.
  if (charterBreachConsecutive >= charterBreachK && charterBreachK > 0) {
    return {
      action: 'halt',
      cause: `charter p5 path: RED — ${charterBreachConsecutive} consecutive breaches (>= k=${charterBreachK})`,
      multiplier: 0,
    };
  }

  // Deflated-Sharpe significance (benchmarked vs c, NOT zero).
  // Insignificant ≡ the deflated Sharpe does not clear the minimum acceptable
  // Sharpe `c`. rollingSharpe === null ⇒ not enough data ⇒ NOT a trip (cold start).
  let dsrInsignificant = false;
  if (rollingSharpe !== null) {
    const dsr = calculateDeflatedSharpe(rollingSharpe, snapshotCount, Math.max(1, trialCount));
    dsrInsignificant = dsr.deflatedSharpe < minAcceptableSharpe;
  }

  // 3. DSR CONCLUSIVE hard halt — requires MinTRL gate AND a regime cause.
  if (dsrInsignificant && snapshotCount >= minTRL && regimeCause) {
    return {
      action: 'halt',
      cause: `DSR conclusive: deflated Sharpe < c=${minAcceptableSharpe} (n=${snapshotCount} >= MinTRL=${minTRL}) + regime cause`,
      multiplier: 0,
    };
  }

  // 4. SOFT de-risk on any single Layer-2 trip.
  const inDerriskBand = drawdown >= eMaxDD && drawdown < hardDD;
  const charterYellow = charterBreachConsecutive >= 1;

  if (inDerriskBand) {
    return {
      action: 'derisk',
      cause: `drawdown in derisk band: ${(drawdown * 100).toFixed(1)}% in [${(eMaxDD * 100).toFixed(1)}%, ${(hardDD * 100).toFixed(1)}%)`,
      multiplier: 0.5,
    };
  }
  if (dsrInsignificant) {
    // DSR insignificant but not conclusive (n < MinTRL, or no regime cause) ⇒ de-risk only.
    return {
      action: 'derisk',
      cause:
        snapshotCount < minTRL
          ? `DSR insignificant but n=${snapshotCount} < MinTRL=${minTRL} — de-risk only (never hard at the bottom of a normal DD)`
          : `DSR insignificant (deflated Sharpe < c=${minAcceptableSharpe}) — single Layer-2 trip, de-risk only`,
      multiplier: 0.5,
    };
  }
  if (charterYellow) {
    return {
      action: 'derisk',
      cause: `charter p5 path: YELLOW — ${charterBreachConsecutive} breach(es) (< k=${charterBreachK})`,
      multiplier: 0.5,
    };
  }
  if (regimeCause) {
    // A standalone regime/mechanism trip is a single Layer-2 event ⇒ de-risk
    // (halve), never hard on its own. HARD requires it to corroborate a
    // conclusive DSR (handled above) or an absolute stop.
    return {
      action: 'derisk',
      cause: 'regime/mechanism cause: single Layer-2 trip — de-risk only',
      multiplier: 0.5,
    };
  }

  // 5. All clear.
  return { action: 'trade', cause: 'all clear', multiplier: 1 };
}
