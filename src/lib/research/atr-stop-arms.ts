/**
 * Multi-arm ATR-stop counterfactual — pure replay engine (Task 9 PROBE).
 *
 * DIAGNOSTIC ONLY. Replays each closed Run-20 `bot_trade` forward over the
 * SAME candle series under four different EXIT rules, never recreating any
 * strategy/entry logic. Each arm reports its metrics NET OF FUNDING, because a
 * wider / chandelier / longer-horizon arm holds the position longer ⇒ crosses
 * more 00/08/16 UTC settlements ⇒ pays more funding. Comparing arms on GROSS R
 * would falsely favor the longest-hold arm, so funding (via the shared
 * `funding-ledger` keystone) is debited per arm over that arm's ACTUAL hold.
 *
 * Arms:
 *   A baseline          — current SL/TP as stored (reconstructed from fields).
 *   B atr_floor         — SL = max(SL_orig, k·ATR14@entry), R:R preserved.
 *   C chandelier        — trailing stop = highest-high-since-entry − k·ATR (long;
 *                         mirror: lowest-low + k·ATR for a short); exit when a bar
 *                         crosses the trailing level.
 *   D vertical_barrier  — exit at min(SL hit, TP hit, N-bar horizon). Time-stop,
 *                         per Lopez de Prado, "Advances in Financial Machine
 *                         Learning" (2018) §3 triple-barrier / vertical barrier.
 *
 * R convention: 1R = the ORIGINAL stop distance in price (slDist). Every arm's
 * R-multiple normalizes its price P&L by the SAME slDist so arms are
 * comparable. Funding (a fraction-of-notional return) is converted to R via
 * `fundingR = fundingReturnFraction · entry / slDist`.
 */

import { fundingReturn, type Direction } from '../cost/funding-ledger';

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface Trade {
  id: string;
  symbol: string;
  direction: Direction;
  entry_price: number;
  exit_price: number;
  entry_timestamp: number;
  exit_timestamp: number;
  stop_loss: number;
  take_profit: number;
  bars_held: number;
  exit_reason: string;
}

export type ArmExitReason = 'stop_loss' | 'take_profit' | 'max_bars' | 'trailing_stop' | 'time_stop';

/** A single replayed outcome under one arm. `pnlR` is GROSS (before funding). */
export interface ArmOutcome {
  exitReason: ArmExitReason;
  barsHeld: number;
  /** Gross R-multiple, normalized by the ORIGINAL stop distance (slDist). */
  grossR: number;
  exitPrice: number;
  entryTs: number;
  exitTs: number;
  /** Funding paid in R units for THIS arm's actual hold (signed; long pays positive funding ⇒ negative R). */
  fundingR: number;
  /** Net-of-funding R = grossR + fundingR. The headline metric. */
  netR: number;
}

/** Rate lookup injected so the engine stays pure (no file/DB access here). */
export type RateAt = (settlementMs: number) => number;

/**
 * Binary-search the entry bar: the bar whose timestamp matches `entryTs`, else
 * the largest bar with timestamp ≤ entryTs. Returns -1 if before the series.
 */
export function findEntryIndex(candles: Candle[], entryTs: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid]!.timestamp < entryTs) lo = mid + 1;
    else hi = mid;
  }
  if (candles[lo]?.timestamp === entryTs) return lo;
  if (lo > 0 && candles[lo - 1]!.timestamp <= entryTs) return lo - 1;
  return -1;
}

/** Wilder-style simple ATR over `period` bars ending at `idx`. 0 if insufficient history. */
export function atrAt(candles: Candle[], idx: number, period = 14): number {
  if (idx < period) return 0;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    sum += tr;
  }
  return sum / period;
}

/**
 * Convert a fraction-of-notional funding return into R units for an arm,
 * then attach `fundingR`/`netR` to a gross outcome. `slDist` is the ORIGINAL
 * stop distance (price) that defines 1R. A long with positive funding gets a
 * negative `fundingR` (it pays).
 */
function withFunding(
  gross: Omit<ArmOutcome, 'fundingR' | 'netR'>,
  direction: Direction,
  entry: number,
  slDist: number,
  rateAt: RateAt,
): ArmOutcome {
  const fundingFraction = fundingReturn({
    entryMs: gross.entryTs,
    exitMs: gross.exitTs,
    direction,
    rateAt,
  });
  // 1R = slDist in price ⇒ slDist/entry as a return fraction. Scale funding to R.
  const fundingR = slDist > 0 ? (fundingFraction * entry) / slDist : 0;
  return { ...gross, fundingR, netR: gross.grossR + fundingR };
}

/**
 * Core SL/TP replay used by baseline, atr_floor, and (with an injected horizon)
 * vertical_barrier. Walks bars after entry, checks SL first then TP each bar
 * (conservative: a bar that touches both is scored as a stop), and on horizon
 * exhaustion marks-to-close. `slDistForR` defines the R denominator (always the
 * ORIGINAL slDist so arms are comparable).
 */
function replaySlTp(args: {
  candles: Candle[];
  entryIdx: number;
  direction: Direction;
  entry: number;
  sl: number;
  tp: number;
  slDistForR: number;
  maxBars: number;
  /** Exit reason to report when the horizon is reached without SL/TP. */
  horizonReason: ArmExitReason;
}): Omit<ArmOutcome, 'fundingR' | 'netR'> {
  const { candles, entryIdx, direction, entry, sl, tp, slDistForR, maxBars, horizonReason } = args;
  const entryTs = candles[entryIdx]!.timestamp;
  const lastIdx = Math.min(entryIdx + maxBars, candles.length - 1);

  for (let i = entryIdx + 1; i <= lastIdx; i++) {
    const c = candles[i]!;
    const barsHeld = i - entryIdx;
    if (direction === 'long') {
      if (c.low <= sl) {
        return { exitReason: 'stop_loss', barsHeld, grossR: (sl - entry) / slDistForR, exitPrice: sl, entryTs, exitTs: c.timestamp };
      }
      if (c.high >= tp) {
        return { exitReason: 'take_profit', barsHeld, grossR: (tp - entry) / slDistForR, exitPrice: tp, entryTs, exitTs: c.timestamp };
      }
    } else {
      if (c.high >= sl) {
        return { exitReason: 'stop_loss', barsHeld, grossR: (entry - sl) / slDistForR, exitPrice: sl, entryTs, exitTs: c.timestamp };
      }
      if (c.low <= tp) {
        return { exitReason: 'take_profit', barsHeld, grossR: (entry - tp) / slDistForR, exitPrice: tp, entryTs, exitTs: c.timestamp };
      }
    }
  }
  const exitCandle = candles[lastIdx]!;
  const exit = exitCandle.close;
  const gross = direction === 'long' ? (exit - entry) / slDistForR : (entry - exit) / slDistForR;
  return { exitReason: horizonReason, barsHeld: lastIdx - entryIdx, grossR: gross, exitPrice: exit, entryTs, exitTs: exitCandle.timestamp };
}

/** ARM A — baseline replay with the trade's stored SL/TP. */
export function simulateBaseline(args: {
  candles: Candle[];
  entryIdx: number;
  direction: Direction;
  entry: number;
  sl: number;
  tp: number;
  maxBars: number;
  rateAt: RateAt;
}): ArmOutcome {
  const slDist = Math.abs(args.entry - args.sl);
  const gross = replaySlTp({
    candles: args.candles,
    entryIdx: args.entryIdx,
    direction: args.direction,
    entry: args.entry,
    sl: args.sl,
    tp: args.tp,
    slDistForR: slDist || 1e-9,
    maxBars: args.maxBars,
    horizonReason: 'max_bars',
  });
  return withFunding(gross, args.direction, args.entry, slDist || 1e-9, args.rateAt);
}

/**
 * ARM B — atr_floor. Widen the stop to `max(slDist_orig, k·ATR14@entry)` and
 * move the TP symmetrically to PRESERVE R:R. R is still measured against the
 * widened stop (the arm's own risk), matching the existing harness semantics.
 */
export function simulateAtrFloor(args: {
  candles: Candle[];
  entryIdx: number;
  direction: Direction;
  entry: number;
  sl: number;
  tp: number;
  k: number;
  maxBars: number;
  rateAt: RateAt;
}): ArmOutcome {
  const { candles, entryIdx, direction, entry, sl, tp, k, maxBars, rateAt } = args;
  const slDist = Math.abs(entry - sl);
  const tpDist = Math.abs(tp - entry);
  const rr = slDist > 0 ? tpDist / slDist : 0;
  const atr = atrAt(candles, entryIdx, 14);
  const newSlDist = Math.max(slDist, k * atr);
  const newTpDist = newSlDist * rr; // RR preserved
  const newSl = direction === 'long' ? entry - newSlDist : entry + newSlDist;
  const newTp = direction === 'long' ? entry + newTpDist : entry - newTpDist;
  const gross = replaySlTp({
    candles,
    entryIdx,
    direction,
    entry,
    sl: newSl,
    tp: newTp,
    slDistForR: newSlDist || 1e-9, // R measured vs the widened risk (RR-preservation invariant)
    maxBars,
    horizonReason: 'max_bars',
  });
  return withFunding(gross, direction, entry, newSlDist || 1e-9, rateAt);
}

/**
 * ARM C — chandelier trailing stop. For a long the trail is
 * `highestHighSinceEntry − k·ATR`; exit when a bar's low crosses it. The hard
 * original stop still applies as a floor (the trail starts at entry − k·ATR but
 * can only ratchet UP). Mirror for a short (`lowestLow + k·ATR`, exit on cross
 * up). R normalized by ORIGINAL slDist.
 */
export function simulateChandelier(args: {
  candles: Candle[];
  entryIdx: number;
  direction: Direction;
  entry: number;
  sl: number;
  atr: number;
  k: number;
  maxBars: number;
  rateAt: RateAt;
}): ArmOutcome {
  const { candles, entryIdx, direction, entry, sl, atr, k, maxBars, rateAt } = args;
  const slDist = Math.abs(entry - sl) || 1e-9;
  const entryTs = candles[entryIdx]!.timestamp;
  const lastIdx = Math.min(entryIdx + maxBars, candles.length - 1);
  const gap = k * atr;

  if (direction === 'long') {
    let highest = candles[entryIdx]!.high;
    let trail = highest - gap;
    for (let i = entryIdx + 1; i <= lastIdx; i++) {
      const c = candles[i]!;
      const barsHeld = i - entryIdx;
      // Check the trail from the PRIOR bar's high first (intrabar order: a gap-down
      // hits the existing trail before this bar's high can raise it).
      if (c.low <= trail) {
        const gross = { exitReason: 'trailing_stop' as ArmExitReason, barsHeld, grossR: (trail - entry) / slDist, exitPrice: trail, entryTs, exitTs: c.timestamp };
        return withFunding(gross, direction, entry, slDist, rateAt);
      }
      if (c.high > highest) {
        highest = c.high;
        trail = highest - gap; // ratchet up only
      }
    }
    const exitCandle = candles[lastIdx]!;
    const exit = exitCandle.close;
    const gross = { exitReason: 'max_bars' as ArmExitReason, barsHeld: lastIdx - entryIdx, grossR: (exit - entry) / slDist, exitPrice: exit, entryTs, exitTs: exitCandle.timestamp };
    return withFunding(gross, direction, entry, slDist, rateAt);
  }

  let lowest = candles[entryIdx]!.low;
  let trail = lowest + gap;
  for (let i = entryIdx + 1; i <= lastIdx; i++) {
    const c = candles[i]!;
    const barsHeld = i - entryIdx;
    if (c.high >= trail) {
      const gross = { exitReason: 'trailing_stop' as ArmExitReason, barsHeld, grossR: (entry - trail) / slDist, exitPrice: trail, entryTs, exitTs: c.timestamp };
      return withFunding(gross, direction, entry, slDist, rateAt);
    }
    if (c.low < lowest) {
      lowest = c.low;
      trail = lowest + gap; // ratchet down only
    }
  }
  const exitCandle = candles[lastIdx]!;
  const exit = exitCandle.close;
  const gross = { exitReason: 'max_bars' as ArmExitReason, barsHeld: lastIdx - entryIdx, grossR: (entry - exit) / slDist, exitPrice: exit, entryTs, exitTs: exitCandle.timestamp };
  return withFunding(gross, direction, entry, slDist, rateAt);
}

/**
 * ARM D — vertical barrier / time-stop. Exit at `min(SL hit, TP hit, N-bar
 * horizon)` using the trade's stored SL/TP. Lopez de Prado triple-barrier with
 * the horizon as the vertical barrier. R normalized by ORIGINAL slDist.
 */
export function simulateVerticalBarrier(args: {
  candles: Candle[];
  entryIdx: number;
  direction: Direction;
  entry: number;
  sl: number;
  tp: number;
  horizonBars: number;
  rateAt: RateAt;
}): ArmOutcome {
  const slDist = Math.abs(args.entry - args.sl) || 1e-9;
  const gross = replaySlTp({
    candles: args.candles,
    entryIdx: args.entryIdx,
    direction: args.direction,
    entry: args.entry,
    sl: args.sl,
    tp: args.tp,
    slDistForR: slDist,
    maxBars: args.horizonBars,
    horizonReason: 'time_stop',
  });
  return withFunding(gross, args.direction, args.entry, slDist, args.rateAt);
}

export interface ArmStats {
  n: number;
  winRate: number;
  /** SL-hit rate (stop_loss + trailing_stop both count as protective stops). */
  slRate: number;
  /** Mean net-of-funding R — the headline metric. */
  meanNetR: number;
  /** Mean gross R (before funding) — for transparency. */
  meanGrossR: number;
  /** Fraction of trades stopped within 15 bars (noise-floor diagnostic). */
  fastStopRate: number;
  /** Mean funding paid in R (negative = arm paid funding on net). */
  meanFundingR: number;
  totalNetR: number;
  meanBars: number;
}

export function summarizeArm(outcomes: ArmOutcome[]): ArmStats {
  const n = outcomes.length;
  if (n === 0) {
    return { n: 0, winRate: 0, slRate: 0, meanNetR: 0, meanGrossR: 0, fastStopRate: 0, meanFundingR: 0, totalNetR: 0, meanBars: 0 };
  }
  const wins = outcomes.filter((o) => o.netR > 0).length;
  const slHits = outcomes.filter((o) => o.exitReason === 'stop_loss' || o.exitReason === 'trailing_stop').length;
  const fastStops = outcomes.filter(
    (o) => (o.exitReason === 'stop_loss' || o.exitReason === 'trailing_stop') && o.barsHeld <= 15,
  ).length;
  const totalNetR = outcomes.reduce((s, o) => s + o.netR, 0);
  const totalGrossR = outcomes.reduce((s, o) => s + o.grossR, 0);
  const totalFundingR = outcomes.reduce((s, o) => s + o.fundingR, 0);
  const totalBars = outcomes.reduce((s, o) => s + o.barsHeld, 0);
  return {
    n,
    winRate: wins / n,
    slRate: slHits / n,
    meanNetR: totalNetR / n,
    meanGrossR: totalGrossR / n,
    fastStopRate: fastStops / n,
    meanFundingR: totalFundingR / n,
    totalNetR,
    meanBars: totalBars / n,
  };
}

/** Build a `rateAt` lookup from a futures snapshot series keyed by settlement timestamp. */
export function rateAtFromSnapshots(snapshots: { timestamp: number; fundingRate: number }[]): RateAt {
  const map = new Map<number, number>();
  for (const s of snapshots) map.set(s.timestamp, s.fundingRate);
  return (ms: number): number => map.get(ms) ?? 0;
}
