/**
 * Sweep + CHoCH Scalp Strategy
 *
 * Reverse-engineered from the "Bullish Traders AI" TradingView indicator
 * (see docs/superpowers/specs/2026-06-10-gold-1m-sweep-choch-design.md):
 *
 * 1. Track swing pivots (small lookback — vendor's dots are dense)
 * 2. Liquidity = most recent UNSWEPT swing low (longs) / high (shorts)
 * 3. Sweep trigger: candle wicks through the level but closes back inside
 * 4. Bias filter: latest structure break (BOS/CHoCH) must align ('choch' mode)
 * 5. SL at sweep wick extreme ± ATR buffer, TP at targetR (vendor: 4R)
 *    Vendor bracket = harness --partial-tp "0.5,1.5,0" + TP at 4R
 *
 * Entry fill at next bar open and 1.5R partial/BE handling are done by the
 * harness (scripts/backtest-scalp.ts), not here.
 */

import type { Candle } from '@/types/candle';
import type { StrategyExitSignal } from '@/lib/rl/strategies/ict-strategies';
import type { SwingPoint, StructureBreak } from '@/types';
import {
  detectSwingHighs,
  detectSwingLows,
  detectBOS,
  detectCHoCH,
} from '@/lib/ict/market-structure';
import { calculateATR } from '../indicators';
import type { ScalpStrategy, ScalpStrategySignal, SweepChochConfig } from './types';
import { DEFAULT_SWEEP_CHOCH_CONFIG } from './types';

/** Bars of history examined for swings and structure on each call */
const LOOKBACK_BARS = 200;

/** London open → NY close, the liquid gold sessions */
const SESSION_START_UTC = 7;
const SESSION_END_UTC = 21;

interface SweepCandidate {
  direction: 'long' | 'short';
  level: SwingPoint;
  sweepDepth: number;
}

export class SweepChochStrategy implements ScalpStrategy {
  name = 'sweep_choch' as const;

  private config: SweepChochConfig;

  constructor(config?: Partial<SweepChochConfig>) {
    this.config = { ...DEFAULT_SWEEP_CHOCH_CONFIG, ...config };
  }

  // 1H context params are unused: bias comes from execution-TF structure
  detectEntry(
    candles: Candle[],
    currentIndex: number,
  ): ScalpStrategySignal | null {
    if (currentIndex < LOOKBACK_BARS) return null;

    const current = candles[currentIndex];
    if (!current) return null;

    if (this.config.sessionFilter && !inSession(current.timestamp)) return null;

    const atr = calculateATR(candles, currentIndex, 14);
    if (atr <= 0) return null;

    // Slice ends at the current bar: detectSwingHighs/Lows require a full
    // right side inside the array, so every returned pivot is already
    // confirmed by bar `currentIndex` — no look-ahead.
    const sliceStart = currentIndex - LOOKBACK_BARS;
    const slice = candles.slice(sliceStart, currentIndex + 1);
    const localCurrent = slice.length - 1;

    const swingConfig = { lookback: this.config.swingLookback, minStrength: 1 };
    const swingHighs = detectSwingHighs(slice, swingConfig);
    const swingLows = detectSwingLows(slice, swingConfig);

    const candidate = this.findSweep(slice, localCurrent, swingHighs, swingLows);
    if (!candidate) return null;

    const bias = this.config.biasMode === 'choch'
      ? latestStructureDirection(slice, swingHighs, swingLows)
      : null;

    if (this.config.biasMode === 'choch') {
      if (!bias) return null;
      if (bias === 'bullish' && candidate.direction !== 'long') return null;
      if (bias === 'bearish' && candidate.direction !== 'short') return null;
    }

    const entryPrice = current.close;
    const buffer = this.config.slAtrBuffer * atr;
    const stopLoss = candidate.direction === 'long'
      ? current.low - buffer
      : current.high + buffer;

    const riskDistance = Math.abs(entryPrice - stopLoss);
    if (riskDistance <= 0) return null;

    const takeProfit = candidate.direction === 'long'
      ? entryPrice + riskDistance * this.config.targetR
      : entryPrice - riskDistance * this.config.targetR;

    const sweepDepthAtr = candidate.sweepDepth / atr;
    const confidence = this.score(sweepDepthAtr, bias !== null);

    return {
      direction: candidate.direction,
      entryPrice,
      stopLoss,
      takeProfit,
      riskReward: this.config.targetR,
      confidence,
      strategy: 'choch_reversal',
      reasoning: [
        `Sweep of swing ${candidate.level.type} @ ${candidate.level.price.toFixed(2)}`,
        `Sweep depth: ${sweepDepthAtr.toFixed(2)} ATR`,
        bias ? `Structure bias: ${bias}` : 'No bias filter',
      ],
      htfBias: candidate.direction === 'long' ? 'bullish' : 'bearish',
      barIndex5m: currentIndex,
    };
  }

  detectExit(): StrategyExitSignal {
    return { shouldExit: false, confidence: 0 };
  }

  /**
   * Find a liquidity sweep at the current bar: the most recent swing level
   * that (a) was never traded through between its pivot bar and the previous
   * bar, and (b) is wicked through but rejected (close back inside) now.
   */
  private findSweep(
    slice: Candle[],
    localCurrent: number,
    swingHighs: SwingPoint[],
    swingLows: SwingPoint[],
  ): SweepCandidate | null {
    const current = slice[localCurrent];
    if (!current) return null;

    let long: SweepCandidate | null = null;
    let short: SweepCandidate | null = null;

    // Walk most-recent-first; the first unswept level hit by this bar wins.
    for (let k = swingLows.length - 1; k >= 0; k--) {
      const swing = swingLows[k]!;
      if (swing.index >= localCurrent) continue;
      const swept = current.low < swing.price && current.close > swing.price;
      if (!swept) continue;
      if (!this.isUntouched(slice, swing, localCurrent, 'low')) continue;
      long = { direction: 'long', level: swing, sweepDepth: swing.price - current.low };
      break;
    }

    for (let k = swingHighs.length - 1; k >= 0; k--) {
      const swing = swingHighs[k]!;
      if (swing.index >= localCurrent) continue;
      const swept = current.high > swing.price && current.close < swing.price;
      if (!swept) continue;
      if (!this.isUntouched(slice, swing, localCurrent, 'high')) continue;
      short = { direction: 'short', level: swing, sweepDepth: current.high - swing.price };
      break;
    }

    if (long && short) {
      // Both sides swept in one bar (huge range candle) — ambiguous, skip.
      return null;
    }
    return long ?? short;
  }

  /** True if no bar after the pivot (exclusive) and before now traded through the level. */
  private isUntouched(
    slice: Candle[],
    swing: SwingPoint,
    localCurrent: number,
    side: 'low' | 'high',
  ): boolean {
    for (let j = swing.index + 1; j < localCurrent; j++) {
      const c = slice[j];
      if (!c) continue;
      if (side === 'low' && c.low < swing.price) return false;
      if (side === 'high' && c.high > swing.price) return false;
    }
    return true;
  }

  private score(sweepDepthAtr: number, biasAligned: boolean): number {
    let s = 0.4;
    if (biasAligned) s += 0.2;
    if (sweepDepthAtr >= 0.5) s += 0.2;
    else if (sweepDepthAtr >= 0.25) s += 0.1;
    return Math.min(s + 0.1, 1); // small base bump so default threshold 4 passes
  }
}

function inSession(timestamp: number): boolean {
  const hour = new Date(timestamp).getUTCHours();
  return hour >= SESSION_START_UTC && hour < SESSION_END_UTC;
}

/**
 * Direction of the most recent structure break (BOS or CHoCH) in the slice.
 * Body-close break semantics come from src/lib/ict/market-structure.ts.
 */
function latestStructureDirection(
  slice: Candle[],
  swingHighs: SwingPoint[],
  swingLows: SwingPoint[],
): 'bullish' | 'bearish' | null {
  const breaks: StructureBreak[] = [
    ...detectBOS(slice, swingHighs, swingLows),
    ...detectCHoCH(slice, swingHighs, swingLows),
  ];
  if (breaks.length === 0) return null;

  let latest = breaks[0]!;
  for (const b of breaks) {
    if (b.breakIndex > latest.breakIndex) latest = b;
  }
  return latest.direction;
}
