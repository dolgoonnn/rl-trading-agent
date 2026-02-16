/**
 * ICT 5m Scalp Strategy
 *
 * ICT concepts (order blocks, FVGs, market structure) on 5-minute candles,
 * filtered by 1H directional bias and kill zone timing.
 *
 * Key differences from 1H OB strategy:
 * - Multi-timeframe: 5m entries with 1H bias
 * - Kill zone emphasis: only trade London/NY sessions
 * - Scalp-tuned: tighter thresholds, shorter hold times
 * - Higher friction: 0.05% per side (maker fees)
 *
 * Reuses all existing ICT detection modules — only the strategy wrapper is new.
 */

import type { Candle } from '@/types/candle';
import type { StrategyExitSignal } from '@/lib/rl/strategies/ict-strategies';
import {
  analyzeMarketStructure,
  detectOrderBlocks,
  detectFairValueGaps,
  checkKillZone,
  detectLiquidityLevels,
  detectLiquiditySweeps,
} from '@/lib/ict';
import { DEFAULT_OB_CONFIG, type OrderBlockConfig } from '@/lib/ict/order-blocks';
import type { FVGConfig } from '@/lib/ict/fair-value-gaps';
import type { ScalpStrategy, ScalpStrategySignal } from './types';

/** Lookback window for 5m ICT analysis */
const LOOKBACK_5M = 100;

/** Lookback window for 1H structure */
const LOOKBACK_1H = 100;

/**
 * ICT 5m Strategy with 1H Bias Filter
 *
 * Entry logic:
 * 1. Determine 1H bias from market structure (bullish/bearish)
 * 2. Only trade in kill zones (London: 02-05 UTC, NY: 08-11 UTC)
 * 3. On 5m: detect OBs, FVGs, structure breaks
 * 4. Only generate signals aligned with 1H bias
 * 5. Score confluence factors for quality filtering
 */
export class ICT5mStrategy implements ScalpStrategy {
  name = 'ict_5m' as const;

  detectEntry(
    candles5m: Candle[],
    currentIndex: number,
    candles1h: Candle[],
    htfIndex: number,
  ): ScalpStrategySignal | null {
    if (currentIndex < LOOKBACK_5M || htfIndex < LOOKBACK_1H) return null;

    const current5m = candles5m[currentIndex];
    if (!current5m) return null;

    // 1. Determine 1H directional bias
    const htfBias = this.getHTFBias(candles1h, htfIndex);
    if (!htfBias) return null; // No clear bias → skip

    // 2. Kill zone filter — only trade during London/NY sessions
    const killZone = checkKillZone(current5m.timestamp);
    if (!killZone.inKillZone) return null;
    // Only trade London Open or NY Open (highest probability)
    if (killZone.type !== 'london_open' && killZone.type !== 'ny_open') return null;

    // 3. Build 5m ICT context
    const sliceStart = Math.max(0, currentIndex - LOOKBACK_5M);
    const lookback5m = candles5m.slice(sliceStart, currentIndex + 1);
    const localIndex = lookback5m.length - 1;

    const atr = this.calculateATR(lookback5m);
    if (atr <= 0) return null;

    // Volatility scale (crypto: 1.0)
    const medianAtrPct = this.getMedianAtrPct(lookback5m);
    const volatilityScale = medianAtrPct >= 0.002 ? 1.0 : Math.max(0.05, medianAtrPct / 0.006);

    // Scale OB/FVG detection thresholds
    const scaledOBConfig: OrderBlockConfig = {
      ...DEFAULT_OB_CONFIG,
      minMovePercent: DEFAULT_OB_CONFIG.minMovePercent * volatilityScale,
    };
    const scaledFVGConfig: FVGConfig = {
      minSizePercent: 0.4 * volatilityScale,
      maxAgeCandles: 30,
      displacementMultiple: 1.5,
      avgBodyLookback: 14,
    };

    const structure = analyzeMarketStructure(lookback5m);
    const orderBlocks = detectOrderBlocks(lookback5m, scaledOBConfig);
    const fvgs = detectFairValueGaps(lookback5m, scaledFVGConfig);
    const liquidityLevels = detectLiquidityLevels(lookback5m);
    const recentSweeps = detectLiquiditySweeps(lookback5m, liquidityLevels);

    const currentPrice = current5m.close;

    // 4. Only trade aligned with 1H bias
    // Check 5m structure alignment with HTF
    const fiveMinBias = structure.bias;
    if (htfBias === 'bullish' && fiveMinBias === 'bearish') return null;
    if (htfBias === 'bearish' && fiveMinBias === 'bullish') return null;

    // 5. Look for OB entry aligned with bias
    const direction = htfBias === 'bullish' ? 'long' : 'short';

    // Find nearest unmitigated OB in the right direction
    const targetOBs = orderBlocks.filter((ob) => {
      if (ob.status !== 'unmitigated') return false;
      if (direction === 'long' && ob.type !== 'bullish') return false;
      if (direction === 'short' && ob.type !== 'bearish') return false;
      // Check freshness (within 50 bars on 5m)
      if (localIndex - ob.index > 50) return false;
      return true;
    });

    if (targetOBs.length === 0) return null;

    // Find the closest OB to current price
    let bestOB = targetOBs[0]!;
    let bestDist = Infinity;
    for (const ob of targetOBs) {
      const mid = (ob.high + ob.low) / 2;
      const dist = Math.abs(currentPrice - mid) / currentPrice;
      if (dist < bestDist) {
        bestDist = dist;
        bestOB = ob;
      }
    }

    // Check proximity — price must be near the OB
    const obMid = (bestOB.high + bestOB.low) / 2;
    const proximityPct = Math.abs(currentPrice - obMid) / currentPrice;
    if (proximityPct > 0.005) return null; // Must be within 0.5% of OB

    // Check for reaction confirmation (candle body showing rejection)
    if (!this.hasReactionConfirmation(lookback5m, localIndex, direction)) return null;

    // 6. Calculate SL/TP using dynamic R:R (matching 1H model)
    const riskDistance = direction === 'long'
      ? currentPrice - (bestOB.low - atr * 0.5)
      : (bestOB.high + atr * 0.5) - currentPrice;

    if (riskDistance <= 0) return null;

    const targetRR = 2.0; // Scalp R:R target
    const stopLoss = direction === 'long'
      ? currentPrice - riskDistance
      : currentPrice + riskDistance;
    const takeProfit = direction === 'long'
      ? currentPrice + riskDistance * targetRR
      : currentPrice - riskDistance * targetRR;

    const actualRR = Math.abs(takeProfit - currentPrice) / riskDistance;
    if (actualRR < 1.5) return null; // Hard minimum R:R

    // 7. Score confluence factors
    const confluenceFactors = this.scoreConfluence(
      direction,
      structure,
      killZone,
      fvgs,
      bestOB,
      recentSweeps.length > 0,
      actualRR,
      currentPrice,
      lookback5m,
      localIndex,
    );

    return {
      direction,
      entryPrice: currentPrice,
      stopLoss,
      takeProfit,
      riskReward: actualRR,
      confidence: confluenceFactors.totalScore / 10, // Normalize to 0-1
      strategy: 'order_block',
      reasoning: confluenceFactors.reasons,
      orderBlock: bestOB,
      htfBias,
      barIndex5m: currentIndex,
    };
  }

  detectExit(
    _candles5m: Candle[],
    _currentIndex: number,
    _entryIndex: number,
    _direction: 'long' | 'short',
  ): StrategyExitSignal {
    // Simple exits — no strategy-based exit logic (proven to be NET NEGATIVE)
    return { shouldExit: false, confidence: 0 };
  }

  // ============================================
  // Private helpers
  // ============================================

  private getHTFBias(candles1h: Candle[], htfIndex: number): 'bullish' | 'bearish' | null {
    const sliceStart = Math.max(0, htfIndex - LOOKBACK_1H);
    const lookback1h = candles1h.slice(sliceStart, htfIndex + 1);

    if (lookback1h.length < 30) return null;

    const structure = analyzeMarketStructure(lookback1h);

    // Only trade with clear bias
    if (structure.bias === 'bullish') return 'bullish';
    if (structure.bias === 'bearish') return 'bearish';
    return null; // Ranging → no trade
  }

  private calculateATR(candles: Candle[], period = 14): number {
    if (candles.length < period + 1) return 0;

    let sum = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
      const c = candles[i]!;
      const prev = candles[i - 1];
      const prevClose = prev ? prev.close : c.open;
      const tr = Math.max(
        c.high - c.low,
        Math.abs(c.high - prevClose),
        Math.abs(c.low - prevClose),
      );
      sum += tr;
    }

    return sum / period;
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

  private hasReactionConfirmation(
    candles: Candle[],
    index: number,
    direction: 'long' | 'short',
  ): boolean {
    const c = candles[index];
    if (!c) return false;

    const bodySize = Math.abs(c.close - c.open);
    const candleRange = c.high - c.low;
    if (candleRange === 0) return false;

    const bodyPct = bodySize / candleRange;
    if (bodyPct < 0.4) return false; // Need convincing body

    // Direction check: body should close in trade direction
    if (direction === 'long' && c.close <= c.open) return false;
    if (direction === 'short' && c.close >= c.open) return false;

    return true;
  }

  private scoreConfluence(
    direction: 'long' | 'short',
    structure: ReturnType<typeof analyzeMarketStructure>,
    killZone: ReturnType<typeof checkKillZone>,
    fvgs: ReturnType<typeof detectFairValueGaps>,
    ob: ReturnType<typeof detectOrderBlocks>[0],
    hasLiquiditySweep: boolean,
    rr: number,
    currentPrice: number,
    _candles: Candle[],
    currentIndex: number,
  ): { totalScore: number; reasons: string[] } {
    let score = 0;
    const reasons: string[] = [];

    // Structure alignment (1H bias already confirmed, 5m aligned)
    if (
      (direction === 'long' && structure.bias === 'bullish') ||
      (direction === 'short' && structure.bias === 'bearish')
    ) {
      score += 2.0;
      reasons.push('5m structure aligned with 1H bias');
    }

    // Kill zone quality
    if (killZone.priority >= 3) {
      score += 1.0;
      reasons.push(`High-priority kill zone: ${killZone.name}`);
    } else if (killZone.priority >= 2) {
      score += 0.5;
      reasons.push(`Kill zone: ${killZone.name}`);
    }

    // Liquidity sweep
    if (hasLiquiditySweep) {
      score += 1.5;
      reasons.push('Recent liquidity sweep confirmed');
    }

    // OB freshness (within 20 bars is fresh for 5m)
    const obAge = currentIndex - ob.index;
    if (obAge <= 10) {
      score += 1.0;
      reasons.push('Fresh OB (<=10 bars)');
    } else if (obAge <= 25) {
      score += 0.5;
      reasons.push('Recent OB (<=25 bars)');
    }

    // FVG at consequent encroachment
    const nearbyFVGs = fvgs.filter((fvg) => {
      if (fvg.status === 'filled') return false;
      const fvgMid = (fvg.high + fvg.low) / 2;
      return Math.abs(currentPrice - fvgMid) / currentPrice < 0.003;
    });
    if (nearbyFVGs.length > 0) {
      score += 1.5;
      reasons.push('FVG at consequent encroachment');
    }

    // Recent BOS in trade direction
    const recentBreaks = structure.structureBreaks.filter((brk) => {
      const breakAge = currentIndex - brk.breakIndex;
      return breakAge <= 20 && breakAge >= 0;
    });
    const alignedBOS = recentBreaks.some((brk) =>
      (direction === 'long' && brk.type === 'bos' && brk.direction === 'bullish') ||
      (direction === 'short' && brk.type === 'bos' && brk.direction === 'bearish'),
    );
    if (alignedBOS) {
      score += 1.0;
      reasons.push('Recent BOS in trade direction');
    }

    // R:R quality
    if (rr >= 3.0) {
      score += 1.0;
      reasons.push(`Excellent R:R: ${rr.toFixed(1)}`);
    } else if (rr >= 2.0) {
      score += 0.5;
      reasons.push(`Good R:R: ${rr.toFixed(1)}`);
    }

    // OB + FVG confluence (both present near entry)
    if (nearbyFVGs.length > 0 && obAge <= 25) {
      score += 1.0;
      reasons.push('OB + FVG confluence zone');
    }

    return { totalScore: score, reasons };
  }
}
