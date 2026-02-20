/**
 * Session Range Breakout Strategy
 *
 * Asian session (00:00-08:00 UTC) establishes a range.
 * London/NY sessions break out of this range.
 * Trade the breakout with volume confirmation.
 *
 * Entry rules:
 * 1. Define Asian range: high/low of 5m candles from 00:00-08:00 UTC
 * 2. Breakout: price closes above/below range by 0.1%
 * 3. Volume confirmation: current bar volume > 1.5x avg session volume
 * 4. Direction must align with 1H bias
 * 5. SL: opposite side of range (or midpoint), TP: range width extension
 */

import type { Candle } from '@/types/candle';
import type { StrategyExitSignal } from '@/lib/rl/strategies/ict-strategies';
import { analyzeMarketStructure } from '@/lib/ict';
import { calculateATR, getVolumeRatio } from '../indicators';
import type { ScalpStrategy, ScalpStrategySignal } from './types';

const LOOKBACK_5M = 100;
const LOOKBACK_1H = 100;

/** Asian session: 00:00-08:00 UTC */
const ASIAN_START_HOUR = 0;
const ASIAN_END_HOUR = 8;

/** Breakout window: 08:00-17:00 UTC (London + NY) */
const BREAKOUT_START_HOUR = 8;
const BREAKOUT_END_HOUR = 17;

interface AsianRange {
  high: number;
  low: number;
  rangeWidth: number;
  midpoint: number;
  barCount: number;
}

export class SessionRangeStrategy implements ScalpStrategy {
  name = 'session_range' as const;

  private breakoutPct: number;
  private volumeThreshold: number;
  private targetRR: number;

  constructor(opts?: {
    breakoutPct?: number;
    volumeThreshold?: number;
    targetRR?: number;
  }) {
    this.breakoutPct = opts?.breakoutPct ?? 0.001; // 0.1% beyond range
    this.volumeThreshold = opts?.volumeThreshold ?? 1.5;
    this.targetRR = opts?.targetRR ?? 1.5;
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

    // Only trade during breakout window (08:00-17:00 UTC)
    const hour = new Date(current.timestamp).getUTCHours();
    if (hour < BREAKOUT_START_HOUR || hour >= BREAKOUT_END_HOUR) return null;

    // 1H bias
    const htfBias = this.getHTFBias(candles1h, htfIndex);
    if (!htfBias) return null;

    // Find today's Asian range
    const asianRange = this.findAsianRange(candles5m, currentIndex);
    if (!asianRange || asianRange.barCount < 12) return null; // Need at least 1 hour of Asian data

    const price = current.close;
    const rangeHigh = asianRange.high;
    const rangeLow = asianRange.low;
    const breakoutBuffer = price * this.breakoutPct;

    // Check breakout
    let direction: 'long' | 'short' | null = null;
    if (price > rangeHigh + breakoutBuffer && htfBias === 'bullish') {
      direction = 'long';
    } else if (price < rangeLow - breakoutBuffer && htfBias === 'bearish') {
      direction = 'short';
    }

    if (!direction) return null;

    // Volume confirmation
    const volRatio = getVolumeRatio(candles5m, currentIndex, 20);
    if (volRatio < this.volumeThreshold) return null;

    // Breakout candle should be strong
    if (!this.isStrongBreakout(current, direction)) return null;

    // SL/TP
    const atr = calculateATR(candles5m, currentIndex, 14);
    if (atr <= 0) return null;

    const rangeWidth = asianRange.rangeWidth;

    // SL: midpoint of range or 1.5 ATR, whichever is tighter
    const slFromRange = direction === 'long'
      ? price - asianRange.midpoint
      : asianRange.midpoint - price;
    const riskDistance = Math.min(Math.max(slFromRange, atr * 0.5), atr * 2.0);

    const stopLoss = direction === 'long'
      ? price - riskDistance
      : price + riskDistance;

    // TP: range width extension or targetRR
    const tpDistance = Math.max(rangeWidth, riskDistance * this.targetRR);
    const takeProfit = direction === 'long'
      ? price + tpDistance
      : price - tpDistance;

    const rr = tpDistance / riskDistance;

    const score = this.score(volRatio, rangeWidth, atr, rr);

    return {
      direction,
      entryPrice: price,
      stopLoss,
      takeProfit,
      riskReward: rr,
      confidence: score / 10,
      strategy: 'order_block',
      reasoning: [
        `Asian range breakout ${direction}`,
        `Range: ${((rangeWidth / price) * 100).toFixed(2)}%`,
        `Volume: ${volRatio.toFixed(1)}x avg`,
      ],
      htfBias,
      barIndex5m: currentIndex,
    };
  }

  detectExit(): StrategyExitSignal {
    return { shouldExit: false, confidence: 0 };
  }

  private findAsianRange(candles5m: Candle[], currentIndex: number): AsianRange | null {
    const currentTs = candles5m[currentIndex]!.timestamp;
    const currentDate = new Date(currentTs);

    // Find today's Asian session start (00:00 UTC)
    const todayStart = Date.UTC(
      currentDate.getUTCFullYear(),
      currentDate.getUTCMonth(),
      currentDate.getUTCDate(),
    );
    const asianEnd = todayStart + ASIAN_END_HOUR * 3600_000;

    // Walk backwards to find Asian session candles
    let high = -Infinity;
    let low = Infinity;
    let count = 0;

    for (let i = currentIndex; i >= Math.max(0, currentIndex - 200); i--) {
      const c = candles5m[i]!;
      if (c.timestamp < todayStart) break; // Before today
      if (c.timestamp >= asianEnd) continue; // After Asian session

      const candleHour = new Date(c.timestamp).getUTCHours();
      if (candleHour >= ASIAN_START_HOUR && candleHour < ASIAN_END_HOUR) {
        if (c.high > high) high = c.high;
        if (c.low < low) low = c.low;
        count++;
      }
    }

    if (count === 0 || high === -Infinity || low === Infinity) return null;

    return {
      high,
      low,
      rangeWidth: high - low,
      midpoint: (high + low) / 2,
      barCount: count,
    };
  }

  private isStrongBreakout(candle: Candle, direction: 'long' | 'short'): boolean {
    const bodySize = Math.abs(candle.close - candle.open);
    const range = candle.high - candle.low;
    if (range === 0) return false;
    if (bodySize / range < 0.4) return false;
    if (direction === 'long' && candle.close <= candle.open) return false;
    if (direction === 'short' && candle.close >= candle.open) return false;
    return true;
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

  private score(volRatio: number, rangeWidth: number, atr: number, rr: number): number {
    let s = 0;

    // Volume expansion
    if (volRatio > 2.5) s += 2.5;
    else if (volRatio > 2.0) s += 2.0;
    else if (volRatio > 1.5) s += 1.5;
    else s += 1.0;

    // Range tightness (tighter range = more explosive breakout)
    const rangeToAtr = rangeWidth / atr;
    if (rangeToAtr < 2.0) s += 2.0; // Very tight range
    else if (rangeToAtr < 3.0) s += 1.5;
    else s += 1.0;

    // R:R
    if (rr > 2.0) s += 2.0;
    else if (rr > 1.5) s += 1.5;
    else s += 1.0;

    return s;
  }
}
