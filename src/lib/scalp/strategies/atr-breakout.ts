/**
 * ATR Volatility Breakout Strategy
 *
 * Trades ATR expansion during session opens as signal of institutional participation.
 *
 * Entry rules:
 * 1. ATR(14) current > 1.5 * ATR(14) 20-bar-ago (volatility expansion)
 * 2. 3 consecutive 5m candles in same direction (momentum)
 * 3. 1H bias alignment required
 * 4. SL: low/high of breakout candle, TP: 1.5 R:R
 */

import type { Candle } from '@/types/candle';
import type { StrategyExitSignal } from '@/lib/rl/strategies/ict-strategies';
import { analyzeMarketStructure } from '@/lib/ict';
import { calculateATR, getVolumeRatio } from '../indicators';
import type { ScalpStrategy, ScalpStrategySignal } from './types';

const LOOKBACK_5M = 100;
const LOOKBACK_1H = 100;

export class ATRBreakoutStrategy implements ScalpStrategy {
  name = 'atr_breakout' as const;

  private atrExpansionMultiple: number;
  private momentumBars: number;
  private targetRR: number;

  constructor(opts?: {
    atrExpansionMultiple?: number;
    momentumBars?: number;
    targetRR?: number;
  }) {
    this.atrExpansionMultiple = opts?.atrExpansionMultiple ?? 1.5;
    this.momentumBars = opts?.momentumBars ?? 3;
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

    // 1H bias
    const htfBias = this.getHTFBias(candles1h, htfIndex);
    if (!htfBias) return null;

    // ATR expansion check
    const currentATR = calculateATR(candles5m, currentIndex, 14);
    const pastATR = calculateATR(candles5m, currentIndex - 20, 14);
    if (currentATR <= 0 || pastATR <= 0) return null;

    const atrExpansion = currentATR / pastATR;
    if (atrExpansion < this.atrExpansionMultiple) return null;

    // Momentum: N consecutive candles in same direction
    const direction = this.detectMomentum(candles5m, currentIndex);
    if (!direction) return null;

    // Must align with 1H bias
    if (htfBias === 'bullish' && direction !== 'long') return null;
    if (htfBias === 'bearish' && direction !== 'short') return null;

    // SL/TP
    const price = current.close;
    const riskDistance = direction === 'long'
      ? price - this.getMomentumLow(candles5m, currentIndex)
      : this.getMomentumHigh(candles5m, currentIndex) - price;

    if (riskDistance <= 0) return null;
    // Cap risk at 2 ATR
    const cappedRisk = Math.min(riskDistance, currentATR * 2.0);

    const stopLoss = direction === 'long'
      ? price - cappedRisk
      : price + cappedRisk;
    const takeProfit = direction === 'long'
      ? price + cappedRisk * this.targetRR
      : price - cappedRisk * this.targetRR;

    const volRatio = getVolumeRatio(candles5m, currentIndex, 20);
    const score = this.score(atrExpansion, volRatio);

    return {
      direction,
      entryPrice: price,
      stopLoss,
      takeProfit,
      riskReward: this.targetRR,
      confidence: score / 10,
      strategy: 'order_block',
      reasoning: [
        `ATR expansion: ${atrExpansion.toFixed(1)}x`,
        `${this.momentumBars} bars momentum ${direction}`,
        `Volume: ${volRatio.toFixed(1)}x avg`,
      ],
      htfBias,
      barIndex5m: currentIndex,
    };
  }

  detectExit(): StrategyExitSignal {
    return { shouldExit: false, confidence: 0 };
  }

  private detectMomentum(candles5m: Candle[], index: number): 'long' | 'short' | null {
    // Check N consecutive bullish/bearish candles
    let bullish = 0;
    let bearish = 0;

    for (let i = index - this.momentumBars + 1; i <= index; i++) {
      const c = candles5m[i];
      if (!c) return null;
      if (c.close > c.open) bullish++;
      else if (c.close < c.open) bearish++;
    }

    if (bullish === this.momentumBars) return 'long';
    if (bearish === this.momentumBars) return 'short';
    return null;
  }

  private getMomentumLow(candles5m: Candle[], index: number): number {
    let low = Infinity;
    for (let i = index - this.momentumBars + 1; i <= index; i++) {
      const c = candles5m[i];
      if (c && c.low < low) low = c.low;
    }
    return low;
  }

  private getMomentumHigh(candles5m: Candle[], index: number): number {
    let high = -Infinity;
    for (let i = index - this.momentumBars + 1; i <= index; i++) {
      const c = candles5m[i];
      if (c && c.high > high) high = c.high;
    }
    return high;
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

  private score(atrExpansion: number, volRatio: number): number {
    let s = 0;

    // ATR expansion strength
    if (atrExpansion > 2.5) s += 3.0;
    else if (atrExpansion > 2.0) s += 2.0;
    else if (atrExpansion > 1.5) s += 1.5;
    else s += 1.0;

    // Volume expansion
    if (volRatio > 2.0) s += 2.0;
    else if (volRatio > 1.5) s += 1.5;
    else s += 1.0;

    return s;
  }
}
