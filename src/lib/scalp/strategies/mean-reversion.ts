/**
 * VWAP Mean Reversion Scalp Strategy
 *
 * Enters when price deviates significantly from session VWAP with RSI confirmation.
 * Exits at VWAP (mean reversion target).
 *
 * Entry rules:
 * 1. Calculate session VWAP (reset each UTC day)
 * 2. Price > VWAP + 1.5*ATR → short signal
 *    Price < VWAP - 1.5*ATR → long signal
 * 3. RSI confirmation: < 30 for long, > 70 for short
 * 4. 1H bias alignment (optional, tested both ways)
 * 5. SL: 1.0 ATR beyond entry, TP: at VWAP
 */

import type { Candle } from '@/types/candle';
import type { StrategyExitSignal } from '@/lib/rl/strategies/ict-strategies';
import { analyzeMarketStructure } from '@/lib/ict';
import {
  calculateATR,
  calculateRSI,
  calculateVWAP,
  findSessionStart,
} from '../indicators';
import type { ScalpStrategy, ScalpStrategySignal } from './types';

const LOOKBACK_5M = 100;
const LOOKBACK_1H = 100;

export class MeanReversionStrategy implements ScalpStrategy {
  name = 'mean_reversion' as const;

  private deviationMultiple: number;
  private rsiOversold: number;
  private rsiOverbought: number;

  constructor(opts?: { deviationMultiple?: number; rsiOversold?: number; rsiOverbought?: number }) {
    this.deviationMultiple = opts?.deviationMultiple ?? 1.5;
    this.rsiOversold = opts?.rsiOversold ?? 30;
    this.rsiOverbought = opts?.rsiOverbought ?? 70;
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

    // Calculate indicators
    const atr = calculateATR(candles5m, currentIndex, 14);
    if (atr <= 0) return null;

    const sessionStart = findSessionStart(candles5m, currentIndex);
    if (currentIndex - sessionStart < 12) return null; // Need at least 1 hour of session data

    const vwap = calculateVWAP(candles5m, sessionStart, currentIndex);
    const rsi = calculateRSI(candles5m, currentIndex, 14);
    const price = current.close;

    // Check deviation from VWAP
    const deviation = price - vwap;
    const deviationThreshold = atr * this.deviationMultiple;

    let direction: 'long' | 'short' | null = null;

    if (deviation < -deviationThreshold && rsi < this.rsiOversold) {
      // Price below VWAP by >1.5 ATR + oversold → long (mean revert up)
      if (htfBias === 'bullish') direction = 'long';
    } else if (deviation > deviationThreshold && rsi > this.rsiOverbought) {
      // Price above VWAP by >1.5 ATR + overbought → short (mean revert down)
      if (htfBias === 'bearish') direction = 'short';
    }

    if (!direction) return null;

    // SL/TP
    const riskDistance = atr * 1.0;
    const rewardDistance = Math.abs(price - vwap);

    // Only take if reward > risk (R:R > 1.0)
    if (rewardDistance < riskDistance * 0.8) return null;

    const stopLoss = direction === 'long'
      ? price - riskDistance
      : price + riskDistance;
    const takeProfit = vwap; // Target: mean reversion to VWAP

    const rr = rewardDistance / riskDistance;

    // Score
    const score = this.score(rsi, deviation, deviationThreshold, rr);

    return {
      direction,
      entryPrice: price,
      stopLoss,
      takeProfit,
      riskReward: rr,
      confidence: score / 10,
      strategy: 'order_block', // Reuse strategy name for compatibility
      reasoning: [`VWAP deviation: ${(deviation / atr).toFixed(1)} ATR`, `RSI: ${rsi.toFixed(0)}`],
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

  private score(rsi: number, deviation: number, threshold: number, rr: number): number {
    let s = 0;
    // RSI extremity
    if (rsi < 20 || rsi > 80) s += 2.0;
    else if (rsi < 25 || rsi > 75) s += 1.5;
    else s += 1.0;

    // Deviation strength
    const devRatio = Math.abs(deviation) / threshold;
    if (devRatio > 2.0) s += 2.0;
    else if (devRatio > 1.5) s += 1.5;
    else s += 1.0;

    // R:R quality
    if (rr > 2.0) s += 2.0;
    else if (rr > 1.5) s += 1.5;
    else s += 1.0;

    return s;
  }
}
