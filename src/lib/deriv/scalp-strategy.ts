/**
 * Deriv Scalp Strategy — "the brother's setup", mechanized.
 *
 * Reverse-engineered from 49 trade screenshots (see experiments/brother-trades.md):
 * a multi-EMA ribbon fade-to-mean SCALP.
 *
 *   SETUP  : fast EMA (his thin red line) + anchor EMA (his thick blue line) + slow EMA (context).
 *   ENTRY  : price stretches >= extAtr * ATR away from the anchor, then the fast EMA rolls back
 *            toward it  ->  enter TOWARD the anchor (fade the extension).
 *   EXIT   : take profit when price returns to the anchor EMA (the mean); fixed protective stop
 *            beyond the extreme; time-stop if it stalls. SCALP — take the reversion, do not ride.
 *   BIAS   : per-instrument directional filter (long-only Boom, short-only Crash, both elsewhere).
 *   SCALE  : optional adds at deeper extensions in the same direction.
 *
 * HONEST EV NOTE: on Deriv synthetics (audited random walks) this entry is ~0 EV before cost and
 * net-negative by the spread (proven in experiments/brother-trades.md §3c). This module is the
 * shared signal source for both backtest and the PAPER runner so we can study/iterate on the exact
 * behaviour and layer discretionary or microstructure filters on top. Pick LOW-SPREAD instruments
 * (Step Index ~0.2bp, gold ~0.4bp) to minimise the bleed.
 */

import type { Candle } from '@/types/candle';

export interface ScalpConfig {
  fastPeriod: number;       // "red" trigger EMA
  anchorPeriod: number;     // "blue" anchor EMA = mean-reversion target
  slowPeriod: number;       // slow ribbon line (trend context)
  atrPeriod: number;
  extAtr: number;           // extension from anchor (in ATR) required to enter
  slAtr: number;            // protective stop distance (in ATR) from entry
  maxHoldBars: number;      // time-stop
  bias: 'long' | 'short' | 'both';
  scaleInMax: number;       // max concurrent positions in one direction (0 = no scaling)
  scaleInStepAtr: number;   // extra extension (ATR) required before each additional add
}

export const DEFAULT_SCALP: ScalpConfig = {
  fastPeriod: 6,
  anchorPeriod: 30,
  slowPeriod: 60,
  atrPeriod: 14,
  extAtr: 1.5,
  slAtr: 3,
  maxHoldBars: 15,
  bias: 'both',
  scaleInMax: 3,
  scaleInStepAtr: 1.0,
};

/** Per-instrument defaults: bias + a sensible spread (bp) for fill simulation. */
export const INSTRUMENT_PROFILE: Record<string, { bias: ScalpConfig['bias']; spreadBp: number }> = {
  stpRNG: { bias: 'both', spreadBp: 0.25 },   // Step Index — lowest spread, his #1
  frxXAUUSD: { bias: 'both', spreadBp: 0.4 }, // Gold
  R_75: { bias: 'both', spreadBp: 3 },        // Volatility 75
  R_100: { bias: 'both', spreadBp: 3 },       // Volatility 100
  BOOM1000: { bias: 'long', spreadBp: 1 },    // up-spike bias
  BOOM500: { bias: 'long', spreadBp: 1 },
  CRASH1000: { bias: 'short', spreadBp: 1 },  // down-spike bias
  CRASH500: { bias: 'short', spreadBp: 1 },
  RB100: { bias: 'both', spreadBp: 0.5 },     // Range Break — REAL mean-reversion edge (range-bounded)
  RB200: { bias: 'both', spreadBp: 0.5 },     // RB200 holds range longer → stronger edge, but break-gaps hurt
};

// ---------- O(n) indicators (match scripts/backtest-ribbon.ts exactly) ----------
export function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out = new Array<number>(values.length);
  out[0] = values[0] ?? 0;
  for (let i = 1; i < values.length; i++) out[i] = values[i]! * k + out[i - 1]! * (1 - k);
  return out;
}

export function atrSeries(candles: Candle[], period: number): number[] {
  const n = candles.length;
  const tr = new Array<number>(n);
  tr[0] = n ? candles[0]!.high - candles[0]!.low : 0;
  for (let i = 1; i < n; i++) {
    const c = candles[i]!, pc = candles[i - 1]!.close;
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  }
  const out = new Array<number>(n).fill(0);
  let seed = 0;
  for (let i = 0; i < period && i < n; i++) seed += tr[i]!;
  let atr = period ? seed / period : 0;
  for (let i = 0; i < n; i++) {
    if (i < period) { out[i] = atr; continue; }
    atr = (atr * (period - 1) + tr[i]!) / period;
    out[i] = atr;
  }
  return out;
}

export interface ScalpState {
  fast: number[];
  anchor: number[];
  slow: number[];
  atr: number[];
  close: number[];
}

export function computeState(candles: Candle[], cfg: ScalpConfig): ScalpState {
  const close = candles.map((c) => c.close);
  return {
    fast: emaSeries(close, cfg.fastPeriod),
    anchor: emaSeries(close, cfg.anchorPeriod),
    slow: emaSeries(close, cfg.slowPeriod),
    atr: atrSeries(candles, cfg.atrPeriod),
    close,
  };
}

/** Extension of price from the anchor at bar i, in ATR units (signed). */
export function extensionAtr(s: ScalpState, i: number): number {
  const a = s.atr[i]!;
  return a > 0 ? (s.close[i]! - s.anchor[i]!) / a : 0;
}

/**
 * Entry signal at bar i (evaluated on the CLOSED bar i; act on bar i+1 open).
 * Returns +1 (long), -1 (short), or 0.
 * Long  : price stretched >= extAtr BELOW the anchor AND fast EMA ticks up (roll back toward mean).
 * Short : price stretched >= extAtr ABOVE the anchor AND fast EMA ticks down.
 */
export function entrySignal(s: ScalpState, i: number, cfg: ScalpConfig): 1 | -1 | 0 {
  if (i < 1) return 0;
  const ext = extensionAtr(s, i);
  const rollUp = s.fast[i]! > s.fast[i - 1]!;
  const rollDn = s.fast[i]! < s.fast[i - 1]!;
  let dir: 1 | -1 | 0 = 0;
  if (ext <= -cfg.extAtr && rollUp) dir = 1;
  else if (ext >= cfg.extAtr && rollDn) dir = -1;
  if (cfg.bias === 'long' && dir === -1) return 0;
  if (cfg.bias === 'short' && dir === 1) return 0;
  return dir;
}

export interface ScalpPosition {
  dir: 1 | -1;
  entryPrice: number;
  entryIndex: number;
  stop: number;        // fixed protective stop price
  entryExtAtr: number; // |extension| at entry — used to gate scale-ins
}

/** Build a fresh position from an entry fill at `fillPrice` on bar `i`. */
export function openPosition(dir: 1 | -1, fillPrice: number, i: number, s: ScalpState, cfg: ScalpConfig): ScalpPosition {
  const risk = cfg.slAtr * s.atr[i]!;
  return {
    dir,
    entryPrice: fillPrice,
    entryIndex: i,
    stop: dir === 1 ? fillPrice - risk : fillPrice + risk,
    entryExtAtr: Math.abs(extensionAtr(s, i)),
  };
}

export type ExitReason = 'target' | 'stop' | 'timeout';

/**
 * Exit decision for an open position evaluated on bar i (OHLC of bar i).
 * Returns the fill price + reason, or null to hold. Stop is checked first
 * (conservative). Target = the anchor EMA at bar i (the mean).
 */
export function exitDecision(
  pos: ScalpPosition, s: ScalpState, candle: Candle, i: number, cfg: ScalpConfig,
): { price: number; reason: ExitReason } | null {
  const tgt = s.anchor[i]!;
  if (pos.dir === 1) {
    if (candle.low <= pos.stop) return { price: pos.stop, reason: 'stop' };
    if (candle.high >= tgt) return { price: tgt, reason: 'target' };
  } else {
    if (candle.high >= pos.stop) return { price: pos.stop, reason: 'stop' };
    if (candle.low <= tgt) return { price: tgt, reason: 'target' };
  }
  if (i - pos.entryIndex >= cfg.maxHoldBars) return { price: candle.close, reason: 'timeout' };
  return null;
}

/** May we add another scale-in unit, given current open positions in this direction? */
export function canScaleIn(open: ScalpPosition[], dir: 1 | -1, s: ScalpState, i: number, cfg: ScalpConfig): boolean {
  const sameDir = open.filter((p) => p.dir === dir);
  if (sameDir.length === 0 || sameDir.length > cfg.scaleInMax) return sameDir.length === 0;
  const deepest = Math.max(...sameDir.map((p) => p.entryExtAtr));
  return Math.abs(extensionAtr(s, i)) >= deepest + cfg.scaleInStepAtr;
}
