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
 * ACTIVE vs DISABLED legs (FIX-3 — be HONEST about what can fire):
 *   With the DEFAULT config (both feature flags FALSE) the ACTIVE confluence is
 *   EXACTLY:
 *     1. absolute-DD HARD halt        (drawdown >= hardKillDD)
 *     2. sustained-DSR streak HARD halt (dsrBreachConsecutive >= dsrBreachK, n>=MinTRL)
 *     3. soft de-risk band            (drawdown in [eMaxDD, hardKillDD) ⇒ ×0.5)
 *   The other TWO legs are DISABLED-pending-inputs and are PROVABLY SKIPPED while
 *   their flag is false (a stray/stale `regimeCause=true` or a nonzero
 *   `charterBreachConsecutive` can NOT trigger anything):
 *     - regimeHaltEnabled=false  → the DSR-conclusive-WITH-regime-cause HARD halt
 *       AND the standalone regime de-risk are both gated OFF. Reason: run-bot's
 *       `consumeRegimeCause()` returns a hardcoded `false` (no regime-decay
 *       detector wired), so this leg could never fire — the flag makes that
 *       inactive state explicit instead of leaving dead code that LOOKS live.
 *     - charterPathHaltEnabled=false → the charter-p5 RED HARD halt AND the
 *       YELLOW de-risk are both gated OFF. Reason: run-bot's
 *       `charterBreachConsecutive` is declared `=0` and never mutated (no
 *       cumulative-PnL-vs-p5 probe wired), so this leg could never fire.
 *   See `RetirementConfig` for the one-line TODO of the input each flag needs.
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
  /**
   * Realized live trade count. The DSR edge-decay HARD-halt legs additionally
   * require a real TRADE track record — `snapshotCount` alone counts hourly
   * equity marks, so ~50 marks of a FLAT, untraded curve would otherwise satisfy
   * MinTRL and (with ~0 Sharpe) trip a spurious "edge decay" halt. A strategy
   * that hasn't traded has no edge to decay. Defaults to +Infinity (permissive)
   * so existing callers/tests that omit it are unchanged. The absolute-DD stop
   * (leg 1) is NEVER gated by this. */
  tradeCount?: number;
  /**
   * Minimum realized trades before the DSR layer may HARD-halt for edge decay.
   * Defaults to 0 (gate disabled) for back-compat; the live path sets it from
   * RETIREMENT_CONFIG.minTradesForHalt. */
  minTradesForHalt?: number;
  /** Benchmark Sharpe `c` the deflated Sharpe must clear (NOT zero; default 0.5). */
  minAcceptableSharpe: number;
  /** PSR threshold (e.g. 0.95). Kept for config symmetry; DSR>c is the gate. */
  psr: number;

  /**
   * Feature flag — is the regime/mechanism halt leg WIRED? (FIX-3, default false).
   *
   * When false (the production default today), BOTH regime legs are PROVABLY
   * SKIPPED: the DSR-conclusive-WITH-regime-cause HARD halt and the standalone
   * regime de-risk. This is NOT cosmetic — a stray/stale `regimeCause=true` can
   * NOT trigger a halt or de-risk while this flag is false. The flag exists
   * because `run-bot.ts:consumeRegimeCause()` returns a hardcoded `false`, so the
   * leg can never fire; we make that inactive state explicit rather than ship
   * dead code that looks live. Defaults false for back-compat.
   */
  regimeHaltEnabled?: boolean;

  /**
   * Feature flag — is the charter-p5 path halt leg WIRED? (FIX-3, default false).
   *
   * When false (the production default today), BOTH charter-path legs are PROVABLY
   * SKIPPED: the charter-p5 RED HARD halt and the YELLOW de-risk. A nonzero
   * `charterBreachConsecutive` can NOT trigger anything while this flag is false.
   * The flag exists because `run-bot.ts:charterBreachConsecutive` is declared `=0`
   * and never mutated (no cumulative-PnL-vs-p5 probe), so the leg can never fire.
   * Defaults false for back-compat.
   */
  charterPathHaltEnabled?: boolean;

  /**
   * A corroborating regime/mechanism cause is present (e.g. regime decay).
   *
   * CONTRACT (Issue A): this MUST be an EDGE-TRIGGERED signal — i.e. true ONLY on
   * the tick where a FRESH regime-decay / mechanism-break is newly detected, NOT
   * a level-latched boolean that stays true for the whole episode. A latched
   * level would pin an otherwise-healthy book at 0.5× (or hard-halt under a
   * confluence) forever after a single transient regime blip. The caller derives
   * it from a recent detection (a one-shot transition), and the sustained-DSR
   * escalation below (dsrBreachConsecutive) is what carries the "this is durable"
   * signal across ticks — NOT a sticky regimeCause.
   */
  regimeCause: boolean;

  /** Consecutive checks the cumulative PnL has been below the charter p5 path. */
  charterBreachConsecutive: number;
  /** k — consecutive breaches that escalate yellow → red (hard halt). */
  charterBreachK: number;

  /**
   * Consecutive checks the deflated Sharpe has been below `minAcceptableSharpe`
   * WHILE the track record is long enough (snapshotCount >= MinTRL). Counts the
   * CURRENT check too. Defaults to 0 when the caller does not track it (back-compat).
   */
  dsrBreachConsecutive?: number;
  /**
   * k — consecutive sub-floor DSR breaches (n >= MinTRL each) that escalate the
   * DSR layer to a HARD halt even WITHOUT a regime cause. <= 0 disables the
   * sustained-DSR escalation (back-compat default).
   */
  dsrBreachK?: number;
}

/**
 * The confluence halt decision. Returns the most severe applicable action.
 *
 * Severity order (checked high → low; first match wins). Legs marked [GATED] are
 * SKIPPED entirely unless their feature flag is explicitly true (default false):
 *   1. ABSOLUTE drawdown stop: drawdown >= hardKillDD ⇒ HARD (unconditional). [ACTIVE]
 *   2. [GATED charterPathHaltEnabled] Charter 5th-pct path: k consecutive
 *      breaches ⇒ RED hard halt.
 *   3. [GATED regimeHaltEnabled] DSR conclusive: deflated Sharpe < c AND
 *      snapshotCount >= MinTRL AND a regime cause ⇒ HARD.
 *   3b. Sustained-DSR streak: dsrBreachConsecutive >= dsrBreachK (n>=MinTRL) ⇒
 *      HARD, no regime cause needed. [ACTIVE]
 *   4. SOFT de-risk (multiplier 0.5) if ANY single Layer-2 trip is present:
 *        - drawdown in [eMaxDD, hardKillDD), [ACTIVE] OR
 *        - DSR insignificant (deflated Sharpe < c) at ANY track-record length, [ACTIVE] OR
 *        - [GATED charterPathHaltEnabled] a single charter breach (yellow), OR
 *        - [GATED regimeHaltEnabled] a standalone regime cause.
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
    tradeCount = Number.POSITIVE_INFINITY,
    minTradesForHalt = 0,
    minAcceptableSharpe,
    regimeHaltEnabled = false,
    charterPathHaltEnabled = false,
    regimeCause,
    charterBreachConsecutive,
    charterBreachK,
    dsrBreachConsecutive = 0,
    dsrBreachK = 0,
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
  // [GATED] Only fires when charterPathHaltEnabled (FIX-3). With the flag false
  // (production default — no cumulative-PnL-vs-p5 probe is wired) this leg is
  // PROVABLY SKIPPED, so a stale/nonzero charterBreachConsecutive can NOT halt.
  if (charterPathHaltEnabled && charterBreachConsecutive >= charterBreachK && charterBreachK > 0) {
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
  // [GATED] Only fires when regimeHaltEnabled (FIX-3). With the flag false
  // (production default — consumeRegimeCause() returns a hardcoded false) this
  // leg is PROVABLY SKIPPED, so a stray/stale regimeCause=true can NOT escalate a
  // sub-floor DSR to a HARD halt. The ACTIVE durable-edge-collapse signal is the
  // sustained-DSR streak (3b), which needs no regime cause.
  if (
    regimeHaltEnabled &&
    dsrInsignificant &&
    snapshotCount >= minTRL &&
    tradeCount >= minTradesForHalt &&
    regimeCause
  ) {
    return {
      action: 'halt',
      cause: `DSR conclusive: deflated Sharpe < c=${minAcceptableSharpe} (n=${snapshotCount} >= MinTRL=${minTRL}, trades=${tradeCount} >= minTradesForHalt=${minTradesForHalt}) + regime cause`,
      multiplier: 0,
    };
  }

  // 3b. SUSTAINED-DSR hard halt (Issue B) — k consecutive sub-floor DSR checks,
  // each with n >= MinTRL, escalate to RED even WITHOUT a regime cause. This
  // mirrors the charter-path yellow→red escalation: one sub-floor reading is
  // noise (handled as a single Layer-2 de-risk below), but a SUSTAINED breach is
  // a conclusive edge collapse. We still require the MinTRL gate so we never
  // hard-cut on a short, noisy track record.
  if (
    dsrInsignificant &&
    snapshotCount >= minTRL &&
    tradeCount >= minTradesForHalt &&
    dsrBreachK > 0 &&
    dsrBreachConsecutive >= dsrBreachK
  ) {
    return {
      action: 'halt',
      cause: `sustained DSR breach: deflated Sharpe < c=${minAcceptableSharpe} for ${dsrBreachConsecutive} consecutive checks (>= dsrBreachK=${dsrBreachK}, n=${snapshotCount} >= MinTRL=${minTRL}, trades=${tradeCount} >= minTradesForHalt=${minTradesForHalt})`,
      multiplier: 0,
    };
  }

  // 4. SOFT de-risk on any single Layer-2 trip.
  const inDerriskBand = drawdown >= eMaxDD && drawdown < hardDD;
  // [GATED] charter YELLOW only counts when charterPathHaltEnabled (FIX-3); with
  // the flag false a nonzero charterBreachConsecutive does NOT de-risk.
  const charterYellow = charterPathHaltEnabled && charterBreachConsecutive >= 1;

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
  // [GATED] Standalone regime de-risk only fires when regimeHaltEnabled (FIX-3).
  // With the flag false (production default — no regime-decay detector wired) a
  // stray/stale regimeCause=true does NOT de-risk a healthy book.
  if (regimeHaltEnabled && regimeCause) {
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

// ===========================================================================
// Runtime wiring helpers (PURE / DI) — called once per live tick.
// ===========================================================================

import type { KillFlag } from './kill-switch';

/**
 * EFFECTIVE kill flag for a tick (Issue 1, PRIORITY 2).
 *
 * A LATCHED kill flag (file/env/DB, incl. the retirement latch) always wins. If
 * nothing is latched but the data feed is STALE, we synthesize a TRANSIENT
 * heartbeat kill that blocks NEW entries while the feed is wedged. This transient
 * gate is NOT persisted via setKillFlag: a stale feed is an operational condition
 * that auto-resumes the moment fresh data arrives (the next tick recomputes
 * `heartbeat.stale = false` and entries resume). Open-position management is
 * unaffected — the gate only blocks opening, never closing (reduce-only).
 *
 * Rationale for transient (documented decision): unlike an edge collapse, a wedged
 * feed is self-clearing. Latching it would force a manual reset after every
 * exchange hiccup. The latched sources remain the durable halts; heartbeat is the
 * one acceptable transient gate.
 */
export function resolveEffectiveKill(
  killFlag: KillFlag,
  heartbeat: { stale: boolean; reason: string },
): KillFlag {
  if (killFlag.halted) return killFlag;
  if (heartbeat.stale) {
    return { halted: true, source: 'heartbeat', reason: heartbeat.reason };
  }
  return killFlag;
}

/**
 * Advance the sustained-DSR breach counter (Issue B, PRIORITY 5).
 *
 * Increments while the deflated Sharpe is conclusively below the floor (with the
 * MinTRL gate satisfied); resets to 0 the moment a check clears (or the track
 * record is too short). Edge-triggered escalation lives in `checkRetirementHalt`
 * via `dsrBreachConsecutive >= dsrBreachK`.
 */
export function nextDsrBreachCounter(args: {
  prev: number;
  dsrInsignificant: boolean;
  snapshotCount: number;
  minTrackRecordLength: number;
}): number {
  const { prev, dsrInsignificant, snapshotCount, minTrackRecordLength } = args;
  if (dsrInsignificant && snapshotCount >= minTrackRecordLength) {
    return prev + 1;
  }
  return 0;
}

/** Per-tick retirement evaluation inputs (REAL values, gathered by the caller). */
export interface RetirementTickInputs {
  nowMs: number;
  /** Current drawdown from peak (fraction). */
  drawdown: number;
  /** Rolling DEFLATED Sharpe on a PER-OBSERVATION scale (null ⇒ cold start). */
  deflatedSharpe: number | null;
  /** Number of live return observations backing the deflated Sharpe. */
  snapshotCount: number;
  /** Realized live trade count — gates the DSR edge-decay HARD halts so a flat,
   * untraded curve can never retire the strategy. Defaults to +Infinity. */
  tradeCount?: number;
  /** Edge-triggered regime/mechanism cause (fresh detection only — see contract). */
  regimeCause: boolean;
  /** Consecutive charter-p5 breaches (caller-tracked). */
  charterBreachConsecutive: number;
  /** Prior sustained-DSR breach counter (caller-tracked, persisted in memory). */
  dsrBreachConsecutive: number;
  /** Frozen-at-deploy retirement parameters. */
  config: {
    sigmaAnnual: number;
    sharpe: number;
    horizonYears: number;
    bootstrapP5DD: number;
    minAcceptableSharpe: number;
    psr: number;
    minTrackRecordLength: number;
    /** Minimum realized trades before the DSR layer may HARD-halt (default 0). */
    minTradesForHalt?: number;
    charterBreachK: number;
    dsrBreachK: number;
    /** FIX-3 feature flag — gate the regime/mechanism legs (default false). */
    regimeHaltEnabled: boolean;
    /** FIX-3 feature flag — gate the charter-p5 path legs (default false). */
    charterPathHaltEnabled: boolean;
  };
}

export interface RetirementTickResult {
  decision: RetirementDecision;
  /** Updated sustained-DSR breach counter to carry into the next tick. */
  dsrBreachConsecutive: number;
  /** Derived hard-kill drawdown threshold (for logging/alerting). */
  hardKillDD: number;
}

/**
 * One-shot per-tick retirement evaluation (Issue 2, PRIORITY 1).
 *
 * Takes a PRE-DEFLATED, per-observation Sharpe (Issue D — the caller deflates on
 * the observation scale and passes T = observation count via `snapshotCount`),
 * derives the frozen hardKillDD, advances the sustained-DSR counter, and returns
 * the confluence halt decision. PURE: no DB, no clock, no fetch — the live tick
 * does the IO (read drawdown/snapshots, then setKillFlag / apply multiplier).
 */
export function evaluateRetirementHalt(inputs: RetirementTickInputs): RetirementTickResult {
  const { config } = inputs;
  const eMaxDD = expectedMaxDD({
    sigmaAnnual: config.sigmaAnnual,
    sharpe: config.sharpe,
    horizonYears: config.horizonYears,
  });
  const hkDD = hardKillDD({ eMaxDD, bootstrapP5DD: config.bootstrapP5DD });

  const dsrInsignificant =
    inputs.deflatedSharpe !== null && inputs.deflatedSharpe < config.minAcceptableSharpe;

  const dsrBreachConsecutive = nextDsrBreachCounter({
    prev: inputs.dsrBreachConsecutive,
    dsrInsignificant,
    snapshotCount: inputs.snapshotCount,
    minTrackRecordLength: config.minTrackRecordLength,
  });

  // The per-observation deflated Sharpe is computed by the caller. We pass it
  // straight through as `rollingSharpe` and zero the trialCount so the internal
  // deflation (which would haircut a second time) is a no-op: with numTrials <= 1
  // `calculateHaircut` returns 0, so `deflatedSharpe === rollingSharpe`. This is
  // how `checkRetirementHalt` consumes an already-deflated input on one scale.
  const decision = checkRetirementHalt({
    nowMs: inputs.nowMs,
    drawdown: inputs.drawdown,
    eMaxDD,
    hardKillDD: hkDD,
    rollingSharpe: inputs.deflatedSharpe,
    trialCount: 1, // already deflated by the caller — no second haircut
    snapshotCount: inputs.snapshotCount,
    minTrackRecordLength: config.minTrackRecordLength,
    tradeCount: inputs.tradeCount ?? Number.POSITIVE_INFINITY,
    minTradesForHalt: config.minTradesForHalt ?? 0,
    minAcceptableSharpe: config.minAcceptableSharpe,
    psr: config.psr,
    // FIX-3: pass the feature flags so the gated legs are skipped unless enabled.
    regimeHaltEnabled: config.regimeHaltEnabled,
    charterPathHaltEnabled: config.charterPathHaltEnabled,
    regimeCause: inputs.regimeCause,
    charterBreachConsecutive: inputs.charterBreachConsecutive,
    charterBreachK: config.charterBreachK,
    dsrBreachConsecutive,
    dsrBreachK: config.dsrBreachK,
  });

  return { decision, dsrBreachConsecutive, hardKillDD: hkDD };
}
