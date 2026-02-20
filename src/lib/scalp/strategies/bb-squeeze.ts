/**
 * Bollinger Band Squeeze Breakout Strategy
 *
 * Detects BB compression (squeeze) then trades the expansion breakout
 * in the direction of 1H bias.
 *
 * Entry rules:
 * 1. Detect squeeze: BB width < ATR * threshold for N consecutive bars
 * 2. Wait for expansion: BB width breaks above threshold
 * 3. Direction: 1H bias + close above/below middle band
 * 4. Entry on first 5m close outside the squeeze range
 * 5. SL: opposite BB band or 1.5 ATR, TP: 2.0 ATR extension
 */

import type { Candle } from '@/types/candle';
import type { StrategyExitSignal } from '@/lib/rl/strategies/ict-strategies';
import { analyzeMarketStructure } from '@/lib/ict';
import {
  calculateATR,
  calculateBollingerBands,
  detectBBSqueeze,
  getVolumeRatio,
} from '../indicators';
import type { ScalpStrategy, ScalpStrategySignal } from './types';

const LOOKBACK_5M = 100;
const LOOKBACK_1H = 100;

export class BBSqueezeStrategy implements ScalpStrategy {
  name = 'bb_squeeze' as const;

  private bbPeriod: number;
  private atrPeriod: number;
  private squeezeThreshold: number;
  private minSqueezeBars: number;

  constructor(opts?: {
    bbPeriod?: number;
    atrPeriod?: number;
    squeezeThreshold?: number;
    minSqueezeBars?: number;
  }) {
    this.bbPeriod = opts?.bbPeriod ?? 20;
    this.atrPeriod = opts?.atrPeriod ?? 14;
    this.squeezeThreshold = opts?.squeezeThreshold ?? 2.5; // Crypto 5m needs wider threshold
    this.minSqueezeBars = opts?.minSqueezeBars ?? 3;
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

    // 1H bias
    const htfBias = this.getHTFBias(candles1h, htfIndex);
    if (!htfBias) return null;

    // Detect squeeze state
    const squeeze = detectBBSqueeze(
      candles5m, currentIndex,
      this.bbPeriod, this.atrPeriod,
      this.squeezeThreshold, this.minSqueezeBars,
    );

    // We want the bar where squeeze JUST expanded
    if (!squeeze.justExpanded) return null;

    const bb = calculateBollingerBands(candles5m, currentIndex, this.bbPeriod);
    const atr = calculateATR(candles5m, currentIndex, this.atrPeriod);
    if (atr <= 0) return null;

    const price = current.close;

    // Direction: must align with 1H bias AND close above/below middle band
    let direction: 'long' | 'short' | null = null;
    if (htfBias === 'bullish' && price > bb.middle) {
      direction = 'long';
    } else if (htfBias === 'bearish' && price < bb.middle) {
      direction = 'short';
    }

    if (!direction) return null;

    // Momentum confirmation: breakout candle should be strong
    const bodySize = Math.abs(current.close - current.open);
    const candleRange = current.high - current.low;
    if (candleRange === 0) return null;
    if (bodySize / candleRange < 0.4) return null;

    // Direction of body should match
    if (direction === 'long' && current.close <= current.open) return null;
    if (direction === 'short' && current.close >= current.open) return null;

    // SL/TP
    const riskDistance = direction === 'long'
      ? Math.max(price - bb.lower, atr * 1.0)
      : Math.max(bb.upper - price, atr * 1.0);
    // Cap risk at 2 ATR to avoid huge SL from wide squeeze
    const cappedRisk = Math.min(riskDistance, atr * 2.0);

    const targetRR = 1.5;
    const stopLoss = direction === 'long'
      ? price - cappedRisk
      : price + cappedRisk;
    const takeProfit = direction === 'long'
      ? price + cappedRisk * targetRR
      : price - cappedRisk * targetRR;

    const rr = targetRR;

    // Volume confirmation bonus
    const volRatio = getVolumeRatio(candles5m, currentIndex, 20);

    // Score
    const score = this.score(squeeze.squeezeBars, volRatio, rr);

    return {
      direction,
      entryPrice: price,
      stopLoss,
      takeProfit,
      riskReward: rr,
      confidence: score / 10,
      strategy: 'order_block',
      reasoning: [
        `BB squeeze expanded after ${squeeze.squeezeBars} bars`,
        `Volume: ${volRatio.toFixed(1)}x avg`,
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

  private score(squeezeBars: number, volRatio: number, rr: number): number {
    let s = 0;

    // Longer squeeze = more energy
    if (squeezeBars > 15) s += 2.0;
    else if (squeezeBars > 10) s += 1.5;
    else s += 1.0;

    // Volume expansion
    if (volRatio > 2.0) s += 2.0;
    else if (volRatio > 1.5) s += 1.5;
    else if (volRatio > 1.0) s += 1.0;
    else s += 0.5;

    // R:R
    if (rr > 2.0) s += 2.0;
    else if (rr > 1.5) s += 1.5;
    else s += 1.0;

    return s;
  }
}
