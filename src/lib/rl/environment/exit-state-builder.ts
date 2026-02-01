/**
 * Exit State Builder
 * Builds 22-feature state for exit-only RL agent
 * Includes position info, market context, and price action
 */

import type { Candle, OrderBlock, FairValueGap } from '@/types';
import type {
  ExitState,
  ExitPositionInfo,
  ExitMarketContext,
  ExitPriceAction,
  HybridPosition,
} from '../types';
import {
  analyzeMarketStructure,
  detectOrderBlocks,
  detectFairValueGaps,
} from '@/lib/ict';

export interface ExitStateBuilderConfig {
  // Feature noise for anti-overfitting
  featureNoiseLevel: number; // 0-0.1
}

const DEFAULT_CONFIG: ExitStateBuilderConfig = {
  featureNoiseLevel: 0.02, // 2% noise - less than full state builder
};

export class ExitStateBuilder {
  private config: ExitStateBuilderConfig;

  constructor(config: Partial<ExitStateBuilderConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Build exit state from current market data and position
   * Total: 22 features (6 position + 8 market + 8 price action)
   */
  build(
    candles: Candle[],
    currentIndex: number,
    position: HybridPosition,
    training: boolean = false
  ): ExitState {
    const currentCandle = candles[currentIndex];
    if (!currentCandle) {
      throw new Error(`No candle at index ${currentIndex}`);
    }

    const currentPrice = currentCandle.close;

    // Build feature components
    const positionInfo = this.buildPositionInfo(position, currentPrice, currentIndex);
    const marketContext = this.buildMarketContext(candles, currentIndex, position, currentPrice);
    const priceAction = this.buildPriceAction(candles, currentIndex, position);

    // Flatten to feature array (22 features total)
    let features = this.flattenFeatures(positionInfo, marketContext, priceAction);

    // Add noise during training
    if (training && this.config.featureNoiseLevel > 0) {
      features = this.addFeatureNoise(features);
    }

    return {
      features,
      positionInfo,
      marketContext,
      priceAction,
      currentIndex,
      currentPrice,
      timestamp: currentCandle.timestamp,
    };
  }

  /**
   * Build position info features (6 features)
   */
  private buildPositionInfo(
    position: HybridPosition,
    currentPrice: number,
    currentIndex: number
  ): ExitPositionInfo {
    // Unrealized PnL as percentage of entry
    const pnlPercent = position.side === 'long'
      ? (currentPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - currentPrice) / position.entryPrice;

    // Normalize PnL to [-1, 1] range (±10% maps to ±1)
    const unrealizedPnL = Math.max(-1, Math.min(1, pnlPercent * 10));

    // Bars in position normalized (50 bars = 1.0)
    const barsInPosition = Math.min((currentIndex - position.entryIndex) / 50, 1);

    // Distance to SL (ATR-normalized)
    const slDistance = position.side === 'long'
      ? (currentPrice - position.stopLoss) / position.entryATR
      : (position.stopLoss - currentPrice) / position.entryATR;
    const distanceToSL = Math.max(0, Math.min(1, slDistance / 3)); // 3 ATR = max

    // Distance to TP (ATR-normalized)
    const tpDistance = position.side === 'long'
      ? (position.takeProfit - currentPrice) / position.entryATR
      : (currentPrice - position.takeProfit) / position.entryATR;
    const distanceToTP = Math.max(0, Math.min(1, tpDistance / 6)); // 6 ATR = max

    // NEW: Drawdown from peak - how much we've given back
    // (peakPnL - currentPnL) / peakPnL, clamped to [0, 1]
    let drawdownFromPeak = 0;
    if (position.peakPnL > 0) {
      const currentPnL = pnlPercent * position.entryPrice * position.size;
      const peakPnL = position.peakPnL;
      drawdownFromPeak = Math.max(0, Math.min(1, (peakPnL - currentPnL) / peakPnL));
    }

    // NEW: Entry confluence quality - normalize from A+/A/B/C to 0-1
    // A+ = 1.0, A = 0.75, B = 0.5, C = 0.25
    let entryConfluence = 0.5;
    switch (position.confluenceLevel) {
      case 'A+': entryConfluence = 1.0; break;
      case 'A': entryConfluence = 0.75; break;
      case 'B': entryConfluence = 0.5; break;
      case 'C': entryConfluence = 0.25; break;
    }

    return {
      unrealizedPnL,
      barsInPosition,
      distanceToSL,
      distanceToTP,
      drawdownFromPeak,
      entryConfluence,
    };
  }

  /**
   * Build market context features (8 features)
   */
  private buildMarketContext(
    candles: Candle[],
    currentIndex: number,
    position: HybridPosition,
    currentPrice: number
  ): ExitMarketContext {
    // Get candles for analysis
    const lookbackCandles = candles.slice(
      Math.max(0, currentIndex - 60),
      currentIndex + 1
    );

    // Price vs entry (normalized)
    const priceVsEntryRaw = (currentPrice - position.entryPrice) / position.entryPrice;
    const priceVsEntry = Math.max(-1, Math.min(1, priceVsEntryRaw * 20));

    // Current ATR
    const currentATR = this.calculateATR(lookbackCandles);

    // Volatility ratio (current / entry)
    const volatilityRatio = position.entryATR > 0
      ? Math.min(2, currentATR / position.entryATR)
      : 1;

    // Trend strength from market structure
    const structure = analyzeMarketStructure(lookbackCandles);
    const trendStrength = this.calculateTrendStrength(structure);

    // Nearest OB distance (ATR-normalized)
    const orderBlocks = detectOrderBlocks(lookbackCandles);
    const nearestOBDistance = this.findNearestOBDistance(
      orderBlocks,
      currentPrice,
      position.side,
      currentATR
    );

    // FVG proximity
    const fvgs = detectFairValueGaps(lookbackCandles);
    const fvgProximity = this.calculateFVGProximity(fvgs, currentPrice, position.side);

    // Session progress (0-1 within kill zone)
    const sessionProgress = this.calculateSessionProgress(candles[currentIndex]?.timestamp ?? 0);

    // NEW: BOS/CHoCH analysis for position direction confirmation/warning
    const { recentBOSConfirmation, recentCHoCHWarning } = this.analyzeBOSCHoCH(
      structure,
      position.side,
      position.entryIndex,
      currentIndex
    );

    return {
      priceVsEntry,
      volatilityRatio,
      trendStrength,
      nearestOBDistance,
      fvgProximity,
      sessionProgress,
      recentBOSConfirmation,
      recentCHoCHWarning,
    };
  }

  /**
   * Build price action features (8 features)
   */
  private buildPriceAction(
    candles: Candle[],
    currentIndex: number,
    position: HybridPosition
  ): ExitPriceAction {
    // Returns at various lookbacks
    const returns1bar = this.calculateReturn(candles, currentIndex, 1);
    const returns3bar = this.calculateReturn(candles, currentIndex, 3);
    const returns5bar = this.calculateReturn(candles, currentIndex, 5);
    const returns10bar = this.calculateReturn(candles, currentIndex, 10);

    // Highest/lowest since entry
    const entryIndex = position.entryIndex;
    const candlesSinceEntry = candles.slice(entryIndex, currentIndex + 1);

    let highestSinceEntry = 0;
    let lowestSinceEntry = 0;

    if (candlesSinceEntry.length > 0) {
      const maxHigh = Math.max(...candlesSinceEntry.map((c) => c.high));
      const minLow = Math.min(...candlesSinceEntry.map((c) => c.low));

      highestSinceEntry = (maxHigh - position.entryPrice) / position.entryPrice;
      lowestSinceEntry = (position.entryPrice - minLow) / position.entryPrice;

      // Normalize to [-1, 1]
      highestSinceEntry = Math.min(1, highestSinceEntry * 10);
      lowestSinceEntry = Math.min(1, lowestSinceEntry * 10);
    }

    // Candle pattern score (-1 to 1)
    const candlePatternScore = this.calculateCandlePatternScore(candles, currentIndex);

    // Volume ratio (current / average) - use candle body size as proxy
    const volumeRatio = this.calculateVolumeRatio(candles, currentIndex);

    return {
      returns1bar,
      returns3bar,
      returns5bar,
      returns10bar,
      highestSinceEntry,
      lowestSinceEntry,
      candlePatternScore,
      volumeRatio,
    };
  }

  /**
   * Flatten features into array (22 total: 6 + 8 + 8)
   */
  private flattenFeatures(
    positionInfo: ExitPositionInfo,
    marketContext: ExitMarketContext,
    priceAction: ExitPriceAction
  ): number[] {
    return [
      // Position info (6)
      positionInfo.unrealizedPnL,
      positionInfo.barsInPosition,
      positionInfo.distanceToSL,
      positionInfo.distanceToTP,
      positionInfo.drawdownFromPeak,
      positionInfo.entryConfluence,

      // Market context (8)
      marketContext.priceVsEntry,
      marketContext.volatilityRatio,
      marketContext.trendStrength,
      marketContext.nearestOBDistance,
      marketContext.fvgProximity,
      marketContext.sessionProgress,
      marketContext.recentBOSConfirmation,
      marketContext.recentCHoCHWarning,

      // Price action (8)
      priceAction.returns1bar,
      priceAction.returns3bar,
      priceAction.returns5bar,
      priceAction.returns10bar,
      priceAction.highestSinceEntry,
      priceAction.lowestSinceEntry,
      priceAction.candlePatternScore,
      priceAction.volumeRatio,
    ];
  }

  /**
   * Add random noise to features
   */
  private addFeatureNoise(features: number[]): number[] {
    const noiseLevel = this.config.featureNoiseLevel;
    return features.map((f) => {
      const noise = (Math.random() * 2 - 1) * noiseLevel;
      return f * (1 + noise);
    });
  }

  /**
   * Get feature vector size
   */
  getFeatureSize(): number {
    return 22;
  }

  // ============================================
  // Helper methods
  // ============================================

  private calculateATR(candles: Candle[]): number {
    if (candles.length < 2) return 1;

    const trueRanges: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i]!.high;
      const low = candles[i]!.low;
      const prevClose = candles[i - 1]!.close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trueRanges.push(tr);
    }

    const period = Math.min(14, trueRanges.length);
    const atr = trueRanges.slice(-period).reduce((a, b) => a + b, 0) / period;

    return atr > 0 ? atr : 1;
  }

  private calculateTrendStrength(structure: {
    swingHighs: { price: number }[];
    swingLows: { price: number }[];
  }): number {
    const highs = structure.swingHighs;
    const lows = structure.swingLows;

    if (highs.length < 2 || lows.length < 2) return 0;

    let hhCount = 0;
    let lhCount = 0;
    let hlCount = 0;
    let llCount = 0;

    const recentHighs = highs.slice(-3);
    const recentLows = lows.slice(-3);

    for (let i = 1; i < recentHighs.length; i++) {
      if (recentHighs[i]!.price > recentHighs[i - 1]!.price) hhCount++;
      else lhCount++;
    }

    for (let i = 1; i < recentLows.length; i++) {
      if (recentLows[i]!.price > recentLows[i - 1]!.price) hlCount++;
      else llCount++;
    }

    const total = Math.max(1, hhCount + lhCount + hlCount + llCount);
    const bullishScore = (hhCount + hlCount) / total;
    const bearishScore = (lhCount + llCount) / total;

    return bullishScore - bearishScore;
  }

  /**
   * Analyze BOS/CHoCH for position confirmation or warning
   * BOS in position direction = confirmation (good for holding)
   * CHoCH against position direction = warning (consider exiting)
   */
  private analyzeBOSCHoCH(
    structure: {
      structureBreaks: { type: 'bos' | 'choch' | 'mss'; direction: 'bullish' | 'bearish'; breakIndex: number }[];
    },
    positionSide: 'long' | 'short',
    entryIndex: number,
    currentIndex: number
  ): { recentBOSConfirmation: number; recentCHoCHWarning: number } {
    const recentBreaks = structure.structureBreaks.filter((b) => {
      // Only count breaks since entry
      return b.breakIndex >= entryIndex;
    });

    const lookbackBars = Math.min(20, currentIndex - entryIndex);
    let recentBOSConfirmation = 0;
    let recentCHoCHWarning = 0;

    // Count recent BOS/CHoCH events
    for (const brk of recentBreaks) {
      const isBOS = brk.type === 'bos';
      const isCHoCH = brk.type === 'choch';
      const isConfirming =
        (positionSide === 'long' && brk.direction === 'bullish') ||
        (positionSide === 'short' && brk.direction === 'bearish');
      const isWarning =
        (positionSide === 'long' && brk.direction === 'bearish') ||
        (positionSide === 'short' && brk.direction === 'bullish');

      if (isBOS && isConfirming) {
        recentBOSConfirmation = Math.min(1, recentBOSConfirmation + 0.5);
      }
      if (isCHoCH && isWarning) {
        recentCHoCHWarning = Math.min(1, recentCHoCHWarning + 0.7);
      }
    }

    // Decay based on how long ago the last relevant event was
    // (Simple approach - could be enhanced with actual indices)
    if (lookbackBars > 10) {
      recentBOSConfirmation *= Math.max(0, 1 - (lookbackBars - 10) / 20);
      recentCHoCHWarning *= Math.max(0, 1 - (lookbackBars - 10) / 20);
    }

    return { recentBOSConfirmation, recentCHoCHWarning };
  }

  private findNearestOBDistance(
    orderBlocks: OrderBlock[],
    currentPrice: number,
    positionSide: 'long' | 'short',
    atr: number
  ): number {
    // For longs, look for bearish OBs above (potential resistance)
    // For shorts, look for bullish OBs below (potential support)
    const relevantType = positionSide === 'long' ? 'bearish' : 'bullish';

    let minDistance = Infinity;

    for (const ob of orderBlocks) {
      if (ob.type !== relevantType) continue;
      if (ob.status !== 'unmitigated') continue;

      const midPrice = (ob.high + ob.low) / 2;
      const distance = Math.abs(midPrice - currentPrice);

      if (distance < minDistance) {
        minDistance = distance;
      }
    }

    if (minDistance === Infinity) return 1; // No relevant OB found

    // Normalize by ATR (3 ATR = 1.0)
    return Math.min(1, minDistance / (atr * 3));
  }

  private calculateFVGProximity(
    fvgs: FairValueGap[],
    currentPrice: number,
    positionSide: 'long' | 'short'
  ): number {
    // For longs, look for bearish FVGs above (potential target)
    // For shorts, look for bullish FVGs below (potential target)
    const relevantType = positionSide === 'long' ? 'bearish' : 'bullish';

    let minDistance = Infinity;

    for (const fvg of fvgs) {
      if (fvg.type !== relevantType) continue;
      if (fvg.status === 'filled') continue;

      // Check if price is inside FVG
      if (currentPrice >= fvg.low && currentPrice <= fvg.high) {
        return 0; // Inside FVG
      }

      const midPrice = (fvg.high + fvg.low) / 2;
      const distance = Math.abs(midPrice - currentPrice) / currentPrice;

      if (distance < minDistance) {
        minDistance = distance;
      }
    }

    if (minDistance === Infinity) return 1;

    // Normalize (5% = 1.0)
    return Math.min(1, minDistance / 0.05);
  }

  private calculateSessionProgress(timestamp: number): number {
    const date = new Date(timestamp);
    const hour = date.getUTCHours();
    const minute = date.getUTCMinutes();
    const timeInMinutes = hour * 60 + minute;

    // London Kill Zone: 07:00-11:00 UTC (420-660 minutes)
    if (timeInMinutes >= 420 && timeInMinutes < 660) {
      return (timeInMinutes - 420) / 240; // 0 to 1 through London KZ
    }

    // NYC Kill Zone: 13:00-17:00 UTC (780-1020 minutes)
    if (timeInMinutes >= 780 && timeInMinutes < 1020) {
      return (timeInMinutes - 780) / 240; // 0 to 1 through NYC KZ
    }

    // Outside kill zones
    return 0.5;
  }

  private calculateReturn(candles: Candle[], currentIndex: number, lookback: number): number {
    if (currentIndex < lookback) return 0;

    const current = candles[currentIndex]?.close ?? 0;
    const previous = candles[currentIndex - lookback]?.close ?? 0;

    if (previous === 0) return 0;

    const ret = (current - previous) / previous;

    // Normalize to [-1, 1] (±5% = ±1)
    return Math.max(-1, Math.min(1, ret * 20));
  }

  private calculateCandlePatternScore(candles: Candle[], currentIndex: number): number {
    if (currentIndex < 2) return 0;

    const current = candles[currentIndex];
    const prev1 = candles[currentIndex - 1];
    const prev2 = candles[currentIndex - 2];

    if (!current || !prev1 || !prev2) return 0;

    let score = 0;

    // Current candle direction
    const currentBullish = current.close > current.open;
    score += currentBullish ? 0.3 : -0.3;

    // Body size relative to range
    const bodyRatio = Math.abs(current.close - current.open) / (current.high - current.low + 0.0001);
    score += currentBullish ? bodyRatio * 0.2 : -bodyRatio * 0.2;

    // Momentum (3-candle sequence)
    const allBullish = currentBullish && prev1.close > prev1.open && prev2.close > prev2.open;
    const allBearish = !currentBullish && prev1.close < prev1.open && prev2.close < prev2.open;

    if (allBullish) score += 0.3;
    if (allBearish) score -= 0.3;

    return Math.max(-1, Math.min(1, score));
  }

  private calculateVolumeRatio(candles: Candle[], currentIndex: number): number {
    // Use candle body size as volume proxy
    const lookback = 20;
    const start = Math.max(0, currentIndex - lookback);

    const bodies: number[] = [];
    for (let i = start; i <= currentIndex; i++) {
      const candle = candles[i];
      if (candle) {
        bodies.push(Math.abs(candle.close - candle.open));
      }
    }

    if (bodies.length < 2) return 1;

    const currentBody = bodies[bodies.length - 1] ?? 0;
    const avgBody = bodies.slice(0, -1).reduce((a, b) => a + b, 0) / (bodies.length - 1);

    if (avgBody === 0) return 1;

    const ratio = currentBody / avgBody;

    // Normalize to [0, 2] range
    return Math.min(2, ratio);
  }
}
