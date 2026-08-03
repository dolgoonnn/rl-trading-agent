/**
 * Sweep → Displacement → FVG Retrace — the full ICT scalp composite.
 *
 * This is the canonical sequence taught by ICT-derived courses (incl. the
 * "OT theory" family): a liquidity sweep raids stops beyond a swing, a
 * displacement candle reverses through it leaving a fair value gap, and the
 * entry is the retrace into the gap's consequent encroachment (CE), stop
 * beyond the sweep extreme, fixed-R target.
 *
 * Sequence per signal (all on the execution TF, no HTF dependency):
 *   1. Session filter: London open → NY close (07:00-21:00 UTC).
 *   2. SWEEP: within the last `sweepMaxAgeBars`, a bar wicked through a
 *      previously-untouched swing high/low and closed back inside
 *      (same semantics as sweep-choch.ts).
 *   3. DISPLACEMENT + FVG: after the sweep bar, a displacement-flagged FVG
 *      forms in the REVERSAL direction (module's own displacement gate).
 *   4. RETRACE: the current bar is the FIRST to touch the FVG's CE zone;
 *      entry at current close, SL beyond the sweep extreme ± ATR buffer,
 *      TP at `targetR` multiples of risk.
 *
 * Everything reuses src/lib/ict detection modules; only sequencing is new.
 */

import type { Candle } from '@/types/candle';
import type { StrategyExitSignal } from '@/lib/rl/strategies/ict-strategies';
import type { SwingPoint, FairValueGap } from '@/types';
import { detectSwingHighs, detectSwingLows } from '@/lib/ict/market-structure';
import { detectFairValueGaps } from '@/lib/ict';
import { calculateATR } from '../indicators';
import type { ScalpStrategy, ScalpStrategySignal } from './types';

const LOOKBACK_BARS = 200;
const SESSION_START_UTC = 7;
const SESSION_END_UTC = 21;

export interface SweepDisplacementFVGConfig {
  swingLookback: number;
  /** Sweep must have occurred within this many bars before now */
  sweepMaxAgeBars: number;
  /** FVG CE touch tolerance as fraction of price */
  ceTolerance: number;
  /** SL buffer beyond sweep extreme, in ATR multiples */
  slAtrBuffer: number;
  targetR: number;
  /** FVG min size in ATR-14 multiples (auto-scales across assets) */
  fvgMinSizeATR: number;
  /**
   * 'reversal' = the textbook ICT read (fade the sweep).
   * 'continuation' = trade WITH the sweep — this repo's own OOS finding is
   * that gold sweeps carry continuation information, not reversal.
   */
  mode: 'reversal' | 'continuation';
}

export const DEFAULT_SDF_CONFIG: SweepDisplacementFVGConfig = {
  swingLookback: 5,
  sweepMaxAgeBars: 12,
  ceTolerance: 0.0005,
  slAtrBuffer: 0.25,
  targetR: 2,
  fvgMinSizeATR: 0.5,
  mode: 'reversal',
};

interface SweepEvent {
  direction: 'long' | 'short'; // reversal direction implied by the sweep
  barIndex: number; // local slice index of the sweep bar
  extreme: number; // sweep wick extreme (SL anchor in reversal mode)
  barHigh: number;
  barLow: number;
  level: SwingPoint;
}

export class SweepDisplacementFVGStrategy implements ScalpStrategy {
  name = 'sweep_disp_fvg' as const;

  private config: SweepDisplacementFVGConfig;

  constructor(config?: Partial<SweepDisplacementFVGConfig>) {
    this.config = { ...DEFAULT_SDF_CONFIG, ...config };
  }

  // 1H context params unused: the composite is self-contained on the execution TF
  detectEntry(
    candles: Candle[],
    currentIndex: number,
  ): ScalpStrategySignal | null {
    if (currentIndex < LOOKBACK_BARS) return null;
    const current = candles[currentIndex];
    if (!current) return null;

    const hour = new Date(current.timestamp).getUTCHours();
    if (hour < SESSION_START_UTC || hour >= SESSION_END_UTC) return null;

    const atr = calculateATR(candles, currentIndex, 14);
    if (atr <= 0) return null;

    const sliceStart = currentIndex - LOOKBACK_BARS;
    const slice = candles.slice(sliceStart, currentIndex + 1);
    const localCurrent = slice.length - 1;

    // --- 2. most recent sweep within the age window ---
    const swingConfig = { lookback: this.config.swingLookback, minStrength: 1 };
    const swingHighs = detectSwingHighs(slice, swingConfig);
    const swingLows = detectSwingLows(slice, swingConfig);
    const sweep = this.findRecentSweep(slice, localCurrent, swingHighs, swingLows);
    if (!sweep) return null;

    // Trade direction: textbook reversal, or flipped for continuation mode
    const direction: 'long' | 'short' = this.config.mode === 'reversal'
      ? sweep.direction
      : sweep.direction === 'long' ? 'short' : 'long';

    // --- 3. displacement FVG in the trade direction, formed after the sweep ---
    const fvgs = detectFairValueGaps(slice, {
      minSizePercent: 0.01, // superseded by minSizeATR
      minSizeATR: this.config.fvgMinSizeATR,
      maxAgeCandles: this.config.sweepMaxAgeBars + 6,
      displacementMultiple: 1.5,
      avgBodyLookback: 14,
    });
    const wantType = direction === 'long' ? 'bullish' : 'bearish';
    const fvg = this.pickFVG(fvgs, sweep, wantType, localCurrent);
    if (!fvg) return null;

    // --- 4. first touch of the CE zone, with a reacting close ---
    const ce = fvg.consequentEncroachment;
    const tol = this.config.ceTolerance * current.close;
    const touchesCE = (c: Candle): boolean => c.low <= ce + tol && c.high >= ce - tol;
    if (!touchesCE(current)) return null;
    // first touch only: no earlier bar since FVG formation may have touched CE
    for (let j = fvg.index + 2; j < localCurrent; j++) {
      const c = slice[j];
      if (c && touchesCE(c)) return null;
    }
    // reaction: close back in the trade direction relative to CE
    if (direction === 'long' && current.close < ce) return null;
    if (direction === 'short' && current.close > ce) return null;

    const entryPrice = current.close;
    const buffer = this.config.slAtrBuffer * atr;
    // SL anchor: reversal = beyond the sweep wick; continuation = beyond the
    // sweep bar's opposite extreme (the rejection that continuation fades).
    const stopLoss = this.config.mode === 'reversal'
      ? (direction === 'long' ? sweep.extreme - buffer : sweep.extreme + buffer)
      : (direction === 'long' ? sweep.barLow - buffer : sweep.barHigh + buffer);
    const riskDistance = Math.abs(entryPrice - stopLoss);
    if (riskDistance <= 0) return null;
    const takeProfit = direction === 'long'
      ? entryPrice + riskDistance * this.config.targetR
      : entryPrice - riskDistance * this.config.targetR;

    const sweepAge = localCurrent - sweep.barIndex;
    let confidence = 0.5;
    if (fvg.displacement) confidence += 0.2;
    if (sweepAge <= 6) confidence += 0.1;
    confidence = Math.min(confidence + 0.1, 1);

    return {
      direction,
      entryPrice,
      stopLoss,
      takeProfit,
      riskReward: this.config.targetR,
      confidence,
      strategy: 'fvg', // base StrategyName union; composite identity lives in `name`
      reasoning: [
        `Sweep of swing ${sweep.level.type} @ ${sweep.level.price.toFixed(2)} (${sweepAge} bars ago)`,
        `Displacement FVG ${fvg.low.toFixed(2)}-${fvg.high.toFixed(2)}, CE ${ce.toFixed(2)}`,
        `First CE retrace, close ${sweep.direction === 'long' ? '>=' : '<='} CE`,
      ],
      htfBias: direction === 'long' ? 'bullish' : 'bearish',
      barIndex5m: currentIndex,
    };
  }

  detectExit(): StrategyExitSignal {
    return { shouldExit: false, confidence: 0 };
  }

  /** Most recent qualifying sweep within sweepMaxAgeBars of now. */
  private findRecentSweep(
    slice: Candle[],
    localCurrent: number,
    swingHighs: SwingPoint[],
    swingLows: SwingPoint[],
  ): SweepEvent | null {
    const oldest = Math.max(1, localCurrent - this.config.sweepMaxAgeBars);
    for (let i = localCurrent; i >= oldest; i--) {
      const bar = slice[i];
      if (!bar) continue;

      for (let k = swingLows.length - 1; k >= 0; k--) {
        const swing = swingLows[k]!;
        if (swing.index >= i) continue;
        if (bar.low < swing.price && bar.close > swing.price
          && this.isUntouched(slice, swing, i, 'low')) {
          return { direction: 'long', barIndex: i, extreme: bar.low, barHigh: bar.high, barLow: bar.low, level: swing };
        }
      }
      for (let k = swingHighs.length - 1; k >= 0; k--) {
        const swing = swingHighs[k]!;
        if (swing.index >= i) continue;
        if (bar.high > swing.price && bar.close < swing.price
          && this.isUntouched(slice, swing, i, 'high')) {
          return { direction: 'short', barIndex: i, extreme: bar.high, barHigh: bar.high, barLow: bar.low, level: swing };
        }
      }
    }
    return null;
  }

  private isUntouched(
    slice: Candle[],
    swing: SwingPoint,
    sweepBar: number,
    side: 'low' | 'high',
  ): boolean {
    for (let j = swing.index + 1; j < sweepBar; j++) {
      const c = slice[j];
      if (!c) continue;
      if (side === 'low' && c.low < swing.price) return false;
      if (side === 'high' && c.high > swing.price) return false;
    }
    return true;
  }

  /** Newest displacement FVG of the wanted type formed at/after the sweep bar. */
  private pickFVG(
    fvgs: FairValueGap[],
    sweep: SweepEvent,
    wantType: 'bullish' | 'bearish',
    localCurrent: number,
  ): FairValueGap | null {
    for (let i = fvgs.length - 1; i >= 0; i--) {
      const f = fvgs[i]!;
      if (f.type !== wantType) continue;
      if (!f.displacement) continue;
      if (f.index < sweep.barIndex) continue; // must form at/after the sweep
      if (f.index >= localCurrent) continue; // needs at least one bar after formation
      if (f.status === 'filled') continue;
      return f;
    }
    return null;
  }
}
