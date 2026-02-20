/**
 * ICT Silver Bullet Strategy
 *
 * The Silver Bullet model focuses on a specific 1-hour window
 * (10:00-11:00 AM EST = 15:00-16:00 UTC) where a FVG forms and gets filled.
 * Higher hit rate than general ICT because of the narrow, high-probability window.
 *
 * Entry rules:
 * 1. Time window: 15:00-16:00 UTC only
 * 2. Detect FVG formed within the window on 5m
 * 3. Wait for price to return to FVG CE (consequent encroachment)
 * 4. Direction from 1H bias
 * 5. Reaction confirmation (bullish/bearish candle body at CE)
 * 6. SL: beyond FVG, TP: nearest liquidity level or 1.5R
 */

import type { Candle } from '@/types/candle';
import type { StrategyExitSignal } from '@/lib/rl/strategies/ict-strategies';
import {
  analyzeMarketStructure,
  detectFairValueGaps,
} from '@/lib/ict';
import type { FVGConfig } from '@/lib/ict/fair-value-gaps';
import { calculateATR } from '../indicators';
import type { ScalpStrategy, ScalpStrategySignal } from './types';

const LOOKBACK_5M = 100;
const LOOKBACK_1H = 100;

/** Silver Bullet window: 15:00-16:00 UTC (10:00-11:00 AM EST) */
const SB_HOUR_START = 15;
const SB_HOUR_END = 16;

export class SilverBulletStrategy implements ScalpStrategy {
  name = 'silver_bullet' as const;

  private targetRR: number;
  private ceTolerance: number; // How close price must be to FVG CE

  constructor(opts?: { targetRR?: number; ceTolerance?: number }) {
    this.targetRR = opts?.targetRR ?? 1.5;
    this.ceTolerance = opts?.ceTolerance ?? 0.003; // 0.3% of price
  }

  detectEntry(
    candles5m: Candle[],
    currentIndex: number,
    candles1h: Candle[],
    htfIndex: number,
  ): ScalpStrategySignal | null {
    if (currentIndex < LOOKBACK_5M || htfIndex < LOOKBACK_1H) return null;

    const current = candles5m[currentIndex];
    if (!current) return null;

    // 1. Time window filter: 15:00-16:00 UTC only
    const hour = new Date(current.timestamp).getUTCHours();
    if (hour < SB_HOUR_START || hour >= SB_HOUR_END) return null;

    // 2. 1H bias
    const htfBias = this.getHTFBias(candles1h, htfIndex);
    if (!htfBias) return null;

    const direction = htfBias === 'bullish' ? 'long' : 'short';

    // 3. Detect FVGs in recent 5m candles (within the SB window)
    const sliceStart = Math.max(0, currentIndex - 30); // Look back up to 30 bars (2.5 hours)
    const lookback = candles5m.slice(sliceStart, currentIndex + 1);
    const localIndex = lookback.length - 1;

    const medianAtrPct = this.getMedianAtrPct(lookback);
    const volatilityScale = medianAtrPct >= 0.002 ? 1.0 : Math.max(0.05, medianAtrPct / 0.006);

    const fvgConfig: FVGConfig = {
      minSizePercent: 0.3 * volatilityScale,
      maxAgeCandles: 24, // 2 hours on 5m
      displacementMultiple: 1.5,
      avgBodyLookback: 14,
    };

    const fvgs = detectFairValueGaps(lookback, fvgConfig);

    // Filter for direction-aligned, unfilled FVGs
    const targetFVGs = fvgs.filter((fvg) => {
      if (fvg.status === 'filled') return false;
      if (direction === 'long' && fvg.type !== 'bullish') return false;
      if (direction === 'short' && fvg.type !== 'bearish') return false;
      // Must be formed recently (within SB window or just before)
      const age = localIndex - fvg.index;
      if (age > 24 || age < 0) return false;
      return true;
    });

    if (targetFVGs.length === 0) return null;

    // 4. Check if price is at FVG CE (consequent encroachment = midpoint)
    const price = current.close;
    const atr = calculateATR(candles5m, currentIndex, 14);
    if (atr <= 0) return null;

    let bestFVG = targetFVGs[0]!;
    let bestDist = Infinity;
    for (const fvg of targetFVGs) {
      const ce = (fvg.high + fvg.low) / 2;
      const dist = Math.abs(price - ce) / price;
      if (dist < bestDist) {
        bestDist = dist;
        bestFVG = fvg;
      }
    }

    // Price must be within tolerance of FVG CE
    if (bestDist > this.ceTolerance) return null;

    // 5. Reaction confirmation
    if (!this.hasReaction(current, direction)) return null;

    // 6. SL/TP
    const fvgSize = bestFVG.high - bestFVG.low;
    const riskDistance = direction === 'long'
      ? Math.max(price - bestFVG.low + atr * 0.3, atr * 0.5)
      : Math.max(bestFVG.high - price + atr * 0.3, atr * 0.5);

    const stopLoss = direction === 'long'
      ? price - riskDistance
      : price + riskDistance;
    const takeProfit = direction === 'long'
      ? price + riskDistance * this.targetRR
      : price - riskDistance * this.targetRR;

    const rr = this.targetRR;

    const score = this.score(bestDist, fvgSize, atr, rr);

    return {
      direction,
      entryPrice: price,
      stopLoss,
      takeProfit,
      riskReward: rr,
      confidence: score / 10,
      strategy: 'order_block',
      reasoning: [
        `Silver Bullet window (${SB_HOUR_START}:00-${SB_HOUR_END}:00 UTC)`,
        `FVG CE distance: ${(bestDist * 100).toFixed(2)}%`,
        `FVG size: ${((fvgSize / price) * 100).toFixed(2)}%`,
      ],
      htfBias,
      barIndex5m: currentIndex,
    };
  }

  detectExit(): StrategyExitSignal {
    return { shouldExit: false, confidence: 0 };
  }

  private getHTFBias(candles1h: Candle[], htfIndex: number): 'bullish' | 'bearish' | null {
    const sliceStart = Math.max(0, htfIndex - LOOKBACK_1H);
    const lookback = candles1h.slice(sliceStart, htfIndex + 1);
    if (lookback.length < 30) return null;
    const structure = analyzeMarketStructure(lookback);
    if (structure.bias === 'bullish') return 'bullish';
    if (structure.bias === 'bearish') return 'bearish';
    return null;
  }

  private hasReaction(candle: Candle, direction: 'long' | 'short'): boolean {
    const bodySize = Math.abs(candle.close - candle.open);
    const range = candle.high - candle.low;
    if (range === 0) return false;
    if (bodySize / range < 0.3) return false;
    if (direction === 'long' && candle.close <= candle.open) return false;
    if (direction === 'short' && candle.close >= candle.open) return false;
    return true;
  }

  private getMedianAtrPct(candles: Candle[]): number {
    const window = Math.min(50, candles.length - 1);
    const trPcts: number[] = [];
    for (let k = candles.length - window; k < candles.length; k++) {
      const c = candles[k]!;
      const prev = candles[k - 1];
      const prevClose = prev ? prev.close : c.open;
      const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
      trPcts.push(c.close > 0 ? tr / c.close : 0);
    }
    trPcts.sort((a, b) => a - b);
    return trPcts[Math.floor(trPcts.length / 2)] ?? 0.006;
  }

  private score(ceDist: number, fvgSize: number, atr: number, rr: number): number {
    let s = 0;

    // CE proximity (closer = better)
    if (ceDist < 0.001) s += 2.0;
    else if (ceDist < 0.002) s += 1.5;
    else s += 1.0;

    // FVG size relative to ATR
    const fvgToAtr = fvgSize / atr;
    if (fvgToAtr > 0.5) s += 2.0;
    else if (fvgToAtr > 0.3) s += 1.5;
    else s += 1.0;

    // R:R
    if (rr > 2.0) s += 2.0;
    else if (rr > 1.5) s += 1.5;
    else s += 1.0;

    return s;
  }
}
