/**
 * State Builder
 * Extracts and normalizes features from candle data and ICT detections
 */

import type { Candle, Bias, OrderBlock, FairValueGap, SwingPoint } from '@/types';
import type {
  TradingState,
  ICTContext,
  PriceFeatures,
  PositionFeatures,
  Position,
} from '../types';
import {
  analyzeMarketStructure,
  detectOrderBlocks,
  detectFairValueGaps,
} from '@/lib/ict';
import type { FuturesSnapshot } from '@/lib/data/binance-futures-api';
import {
  buildOrderFlowFeatures,
  flattenOrderFlowFeatures,
  ORDER_FLOW_FEATURE_COUNT,
} from './order-flow-features';

export interface StateBuilderConfig {
  lookbackPeriod: number; // Number of candles for returns
  volatilityWindow: number; // Window for volatility calculation
  rsiPeriod: number; // RSI calculation period
  normalize: boolean; // Whether to normalize features
  // Asset-agnostic normalization: normalize prices relative to ATR
  // This allows the model to generalize across different price scales
  useATRNormalization: boolean;
  // Feature noise injection for anti-overfitting (training only)
  featureNoiseLevel: number; // 0-0.1, percentage of noise to add
}

const DEFAULT_CONFIG: StateBuilderConfig = {
  lookbackPeriod: 60,
  volatilityWindow: 20,
  rsiPeriod: 14,
  normalize: true,
  useATRNormalization: true, // Enable by default for multi-asset training
  featureNoiseLevel: 0.03, // 3% noise - moderate anti-overfitting
};

export class StateBuilder {
  private config: StateBuilderConfig;

  constructor(config: Partial<StateBuilderConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Build complete state from candle data
   * Uses ATR normalization for asset-agnostic representation
   * @param training If true, adds feature noise for anti-overfitting
   */
  build(
    candles: Candle[],
    currentIndex: number,
    currentPrice: number,
    position: Position | null,
    training: boolean = false,
    futuresSnapshots?: FuturesSnapshot[],
  ): TradingState {
    // Calculate ATR for asset-agnostic normalization
    const atr = this.config.useATRNormalization ? this.calculateATR(candles) : 1;

    const price = this.extractPriceFeatures(candles, atr);
    const ict = this.extractICTContext(candles, currentPrice, atr);
    const positionFeatures = this.extractPositionFeatures(position, currentIndex, currentPrice);

    // Flatten all features into a single array
    let features = this.flattenFeatures(price, ict, positionFeatures);

    // Append order flow features if futures data is available
    if (futuresSnapshots && futuresSnapshots.length > 0) {
      const orderFlow = buildOrderFlowFeatures(futuresSnapshots, candles, currentIndex);
      features.push(...flattenOrderFlowFeatures(orderFlow));
    }

    // Add noise during training to prevent overfitting
    if (training && this.config.featureNoiseLevel > 0) {
      features = this.addFeatureNoise(features);
    }

    const currentCandle = candles[candles.length - 1];
    return {
      features,
      price,
      ict,
      position: positionFeatures,
      currentIndex,
      currentPrice,
      timestamp: currentCandle?.timestamp ?? Date.now(),
    };
  }

  /**
   * Add random noise to features for anti-overfitting
   */
  private addFeatureNoise(features: number[]): number[] {
    const noiseLevel = this.config.featureNoiseLevel;
    return features.map((f) => {
      // Add ±noise% random noise
      const noise = (Math.random() * 2 - 1) * noiseLevel;
      return f * (1 + noise);
    });
  }

  /**
   * Calculate ATR for normalization
   */
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

    // Prevent division by zero
    return atr > 0 ? atr : 1;
  }

  /**
   * Extract price-based features
   * Uses ATR normalization for asset-agnostic representation
   */
  private extractPriceFeatures(candles: Candle[], _atr: number = 1): PriceFeatures {
    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);

    // Calculate returns
    const returns: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      const ret = (closes[i]! - closes[i - 1]!) / closes[i - 1]!;
      returns.push(this.config.normalize ? this.clipAndNormalize(ret, -0.1, 0.1) : ret);
    }

    // Pad to fixed length
    while (returns.length < this.config.lookbackPeriod) {
      returns.unshift(0);
    }

    // Volatility (standard deviation of returns)
    const recentReturns = returns.slice(-this.config.volatilityWindow);
    const meanReturn = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;
    const variance = recentReturns.reduce((a, b) => a + Math.pow(b - meanReturn, 2), 0) / recentReturns.length;
    const volatility = Math.sqrt(variance);

    // ATR (Average True Range)
    const trueRanges: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i]!.high;
      const low = candles[i]!.low;
      const prevClose = candles[i - 1]!.close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trueRanges.push(tr);
    }
    const localATR = trueRanges.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trueRanges.length);
    const avgPrice = closes.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, closes.length);
    const normalizedATR = avgPrice > 0 ? localATR / avgPrice : 0;

    // RSI
    const rsi = this.calculateRSI(closes, this.config.rsiPeriod);

    // MACD signal (simplified)
    const ema12 = this.calculateEMA(closes, 12);
    const ema26 = this.calculateEMA(closes, 26);
    const macd = (ema12 - ema26) / avgPrice;
    const macdSignal = this.clipAndNormalize(macd, -0.05, 0.05);

    // Price position relative to recent high/low
    const recentHigh = Math.max(...highs.slice(-20));
    const recentLow = Math.min(...lows.slice(-20));
    const currentPrice = closes[closes.length - 1] ?? 0;
    const priceRange = recentHigh - recentLow;

    const priceFromHigh = priceRange > 0 ? (recentHigh - currentPrice) / priceRange : 0;
    const priceFromLow = priceRange > 0 ? (currentPrice - recentLow) / priceRange : 0;

    return {
      returns: returns.slice(-this.config.lookbackPeriod),
      volatility: this.clipAndNormalize(volatility, 0, 0.05),
      atr: this.clipAndNormalize(normalizedATR, 0, 0.05),
      rsi: (rsi - 50) / 50, // Normalize to -1 to 1
      macdSignal,
      priceFromHigh,
      priceFromLow,
    };
  }

  /**
   * Extract ICT context features
   * Uses ATR normalization for distance calculations
   */
  private extractICTContext(candles: Candle[], currentPrice: number, atr: number = 1): ICTContext {
    // Run ICT detections
    const structure = analyzeMarketStructure(candles);
    const orderBlocks = detectOrderBlocks(candles);
    const fvgs = detectFairValueGaps(candles);

    // Market structure features
    const trendStrength = this.calculateTrendStrength(structure.bias, structure.swingHighs, structure.swingLows);
    const lastBreak = structure.structureBreaks[structure.structureBreaks.length - 1];
    const currentIdx = candles.length - 1;

    // Extract BOS/CHoCH specific features
    const bosBreaks = structure.structureBreaks.filter((b) => b.type === 'bos');
    const chochBreaks = structure.structureBreaks.filter((b) => b.type === 'choch');

    const lastBOS = bosBreaks[bosBreaks.length - 1];
    const lastCHoCH = chochBreaks[chochBreaks.length - 1];

    const lastBOSDirection = lastBOS
      ? (lastBOS.direction === 'bullish' ? 1 : -1)
      : 0;
    const lastBOSConfidence = lastBOS?.confidence ?? 0;
    const barsFromLastBOS = lastBOS ? currentIdx - lastBOS.breakIndex : 999;

    const lastCHoCHDirection = lastCHoCH
      ? (lastCHoCH.direction === 'bullish' ? 1 : -1)
      : 0;
    const lastCHoCHConfidence = lastCHoCH?.confidence ?? 0;
    const barsFromLastCHoCH = lastCHoCH ? currentIdx - lastCHoCH.breakIndex : 999;

    const structureBreakCount = structure.structureBreaks.length;
    const bosChochRatio = structureBreakCount > 0
      ? bosBreaks.length / structureBreakCount
      : 0.5;

    // Find nearest order blocks
    const nearestBullishOB = this.findNearestOB(orderBlocks, currentPrice, 'bullish');
    const nearestBearishOB = this.findNearestOB(orderBlocks, currentPrice, 'bearish');

    // Check if price is in any OB
    const priceInBullishOB = orderBlocks.some(
      (ob) => ob.type === 'bullish' && ob.status === 'unmitigated' && currentPrice >= ob.low && currentPrice <= ob.high
    );
    const priceInBearishOB = orderBlocks.some(
      (ob) => ob.type === 'bearish' && ob.status === 'unmitigated' && currentPrice >= ob.low && currentPrice <= ob.high
    );

    // Find nearest FVGs
    const nearestBullishFVG = this.findNearestFVG(fvgs, currentPrice, 'bullish');
    const nearestBearishFVG = this.findNearestFVG(fvgs, currentPrice, 'bearish');

    // Check if price is in any FVG
    const priceInBullishFVG = fvgs.some(
      (fvg) => fvg.type === 'bullish' && fvg.status !== 'filled' && currentPrice >= fvg.low && currentPrice <= fvg.high
    );
    const priceInBearishFVG = fvgs.some(
      (fvg) => fvg.type === 'bearish' && fvg.status !== 'filled' && currentPrice >= fvg.low && currentPrice <= fvg.high
    );

    // Liquidity detection (simplified - equal highs/lows)
    const nearestBSL = this.findNearestLiquidity(structure.swingHighs, currentPrice, 'bsl');
    const nearestSSL = this.findNearestLiquidity(structure.swingLows, currentPrice, 'ssl');

    // Detect recent liquidity sweep
    const recentSweep = this.detectRecentSweep(candles, structure.swingHighs, structure.swingLows, atr);

    // Session encoding (simplified - would need actual time)
    const sessionEncoding = this.getSessionEncoding(candles[candles.length - 1]?.timestamp ?? 0);
    const inKillZone = sessionEncoding.some((s) => s > 0);

    return {
      bias: structure.bias,
      swingHighCount: structure.swingHighs.length,
      swingLowCount: structure.swingLows.length,
      trendStrength,
      lastStructureBreakType: lastBreak ? (lastBreak.type === 'choch' ? 'choch' : 'bos') : 'none',
      barsFromLastBreak: lastBreak ? currentIdx - lastBreak.breakIndex : 999,
      // New BOS/CHoCH features
      lastBOSDirection: lastBOSDirection as -1 | 0 | 1,
      lastBOSConfidence,
      barsFromLastBOS,
      lastCHoCHDirection: lastCHoCHDirection as -1 | 0 | 1,
      lastCHoCHConfidence,
      barsFromLastCHoCH,
      structureBreakCount,
      bosChochRatio,
      // Existing features
      nearestBullishOB,
      nearestBearishOB,
      priceInBullishOB,
      priceInBearishOB,
      nearestBullishFVG,
      nearestBearishFVG,
      priceInBullishFVG,
      priceInBearishFVG,
      nearestBSL,
      nearestSSL,
      recentSweep,
      inKillZone,
      sessionEncoding,
    };
  }

  /**
   * Detect recent liquidity sweep
   * BSL sweep: price takes out swing high then reverses down
   * SSL sweep: price takes out swing low then reverses up
   */
  private detectRecentSweep(
    candles: Candle[],
    swingHighs: SwingPoint[],
    swingLows: SwingPoint[],
    _atr: number
  ): 'bsl' | 'ssl' | 'none' {
    const lookback = 10; // Check last 10 candles for sweeps
    const currentIdx = candles.length - 1;

    if (candles.length < lookback + 5) return 'none';

    // Find recent swing levels (not too old)
    const recentHighs = swingHighs.filter((s) => currentIdx - s.index < 50);
    const recentLows = swingLows.filter((s) => currentIdx - s.index < 50);

    // Check for BSL sweep (swept high then reversed)
    for (const high of recentHighs) {
      // Look for candles that swept above this high
      for (let i = Math.max(high.index + 1, currentIdx - lookback); i < currentIdx; i++) {
        const candle = candles[i];
        if (!candle) continue;

        // Swept above the high
        if (candle.high > high.price) {
          // Check if price reversed down (current close below the high)
          const currentCandle = candles[currentIdx];
          if (currentCandle && currentCandle.close < high.price) {
            return 'bsl'; // Swept buy-side liquidity, now reversing
          }
        }
      }
    }

    // Check for SSL sweep (swept low then reversed)
    for (const low of recentLows) {
      // Look for candles that swept below this low
      for (let i = Math.max(low.index + 1, currentIdx - lookback); i < currentIdx; i++) {
        const candle = candles[i];
        if (!candle) continue;

        // Swept below the low
        if (candle.low < low.price) {
          // Check if price reversed up (current close above the low)
          const currentCandle = candles[currentIdx];
          if (currentCandle && currentCandle.close > low.price) {
            return 'ssl'; // Swept sell-side liquidity, now reversing
          }
        }
      }
    }

    return 'none';
  }

  /**
   * Extract position-related features
   */
  private extractPositionFeatures(
    position: Position | null,
    currentIndex: number,
    currentPrice: number
  ): PositionFeatures {
    if (!position) {
      return {
        isLong: 0,
        isShort: 0,
        unrealizedPnLNorm: 0,
        holdingPeriod: 0,
      };
    }

    const pnlPercent = position.side === 'long'
      ? (currentPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - currentPrice) / position.entryPrice;

    return {
      isLong: position.side === 'long' ? 1 : 0,
      isShort: position.side === 'short' ? 1 : 0,
      unrealizedPnLNorm: this.clipAndNormalize(pnlPercent, -0.1, 0.1),
      holdingPeriod: Math.min((currentIndex - position.entryIndex) / 100, 1), // Normalize to max 100 bars
    };
  }

  /**
   * Flatten all features into a single array
   * Total: 104 features (was 96, added 8 BOS/CHoCH features)
   */
  private flattenFeatures(
    price: PriceFeatures,
    ict: ICTContext,
    position: PositionFeatures
  ): number[] {
    const features: number[] = [];

    // Price features (66 features)
    features.push(...price.returns); // 60
    features.push(price.volatility);
    features.push(price.atr);
    features.push(price.rsi);
    features.push(price.macdSignal);
    features.push(price.priceFromHigh);
    features.push(price.priceFromLow);

    // ICT features - Market structure basics (6 features)
    features.push(ict.bias === 'bullish' ? 1 : ict.bias === 'bearish' ? -1 : 0);
    features.push(Math.min(ict.swingHighCount / 10, 1));
    features.push(Math.min(ict.swingLowCount / 10, 1));
    features.push(ict.trendStrength);
    features.push(ict.lastStructureBreakType === 'bos' ? 1 : ict.lastStructureBreakType === 'choch' ? -1 : 0);
    features.push(Math.min(ict.barsFromLastBreak / 100, 1));

    // NEW: BOS/CHoCH specific features (8 features)
    features.push(ict.lastBOSDirection); // -1, 0, or 1
    features.push(ict.lastBOSConfidence); // 0-1
    features.push(Math.min(ict.barsFromLastBOS / 100, 1)); // Normalized recency
    features.push(ict.lastCHoCHDirection); // -1, 0, or 1
    features.push(ict.lastCHoCHConfidence); // 0-1
    features.push(Math.min(ict.barsFromLastCHoCH / 100, 1)); // Normalized recency
    features.push(Math.min(ict.structureBreakCount / 20, 1)); // Normalized count
    features.push(ict.bosChochRatio); // 0-1

    // Order blocks (6 features)
    features.push(ict.nearestBullishOB ? ict.nearestBullishOB.distance : 1);
    features.push(ict.nearestBullishOB ? ict.nearestBullishOB.strength : 0);
    features.push(ict.nearestBearishOB ? ict.nearestBearishOB.distance : 1);
    features.push(ict.nearestBearishOB ? ict.nearestBearishOB.strength : 0);
    features.push(ict.priceInBullishOB ? 1 : 0);
    features.push(ict.priceInBearishOB ? 1 : 0);

    // FVGs (6 features)
    features.push(ict.nearestBullishFVG ? ict.nearestBullishFVG.distance : 1);
    features.push(ict.nearestBullishFVG ? ict.nearestBullishFVG.size : 0);
    features.push(ict.nearestBearishFVG ? ict.nearestBearishFVG.distance : 1);
    features.push(ict.nearestBearishFVG ? ict.nearestBearishFVG.size : 0);
    features.push(ict.priceInBullishFVG ? 1 : 0);
    features.push(ict.priceInBearishFVG ? 1 : 0);

    // Liquidity (3 features)
    features.push(ict.nearestBSL ? ict.nearestBSL.distance : 1);
    features.push(ict.nearestSSL ? ict.nearestSSL.distance : 1);
    features.push(ict.recentSweep === 'bsl' ? 1 : ict.recentSweep === 'ssl' ? -1 : 0);

    // Session (5 features)
    features.push(ict.inKillZone ? 1 : 0);
    features.push(...ict.sessionEncoding); // 4 features

    // Position features (4 features)
    features.push(position.isLong);
    features.push(position.isShort);
    features.push(position.unrealizedPnLNorm);
    features.push(position.holdingPeriod);

    return features;
  }

  /**
   * Get feature vector size
   */
  getFeatureSize(includeOrderFlow: boolean = false): number {
    // Price: 60 returns + 6 indicators = 66
    // ICT: 6 structure + 8 BOS/CHoCH + 6 OB + 6 FVG + 3 liquidity + 5 session = 34
    // Position: 4
    // Base: 104
    const base = this.config.lookbackPeriod + 6 + 34 + 4;
    // Order flow: 10 (optional)
    return includeOrderFlow ? base + ORDER_FLOW_FEATURE_COUNT : base;
  }

  // ============================================
  // Helper methods
  // ============================================

  private clipAndNormalize(value: number, min: number, max: number): number {
    const clipped = Math.max(min, Math.min(max, value));
    const range = max - min;
    return range > 0 ? (clipped - min) / range * 2 - 1 : 0; // Normalize to -1 to 1
  }

  private calculateRSI(prices: number[], period: number): number {
    if (prices.length < period + 1) return 50;

    let gains = 0;
    let losses = 0;

    for (let i = prices.length - period; i < prices.length; i++) {
      const change = prices[i]! - prices[i - 1]!;
      if (change > 0) gains += change;
      else losses -= change;
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  private calculateEMA(prices: number[], period: number): number {
    if (prices.length === 0) return 0;
    const k = 2 / (period + 1);
    let ema = prices[0]!;

    for (let i = 1; i < prices.length; i++) {
      ema = prices[i]! * k + ema * (1 - k);
    }

    return ema;
  }

  private calculateTrendStrength(_bias: Bias, highs: SwingPoint[], lows: SwingPoint[]): number {
    if (highs.length < 2 || lows.length < 2) return 0;

    const recentHighs = highs.slice(-3);
    const recentLows = lows.slice(-3);

    let hhCount = 0;
    let lhCount = 0;
    let hlCount = 0;
    let llCount = 0;

    for (let i = 1; i < recentHighs.length; i++) {
      if (recentHighs[i]!.price > recentHighs[i - 1]!.price) hhCount++;
      else lhCount++;
    }

    for (let i = 1; i < recentLows.length; i++) {
      if (recentLows[i]!.price > recentLows[i - 1]!.price) hlCount++;
      else llCount++;
    }

    // Bullish: HH + HL, Bearish: LH + LL
    const bullishScore = (hhCount + hlCount) / Math.max(1, recentHighs.length + recentLows.length - 2);
    const bearishScore = (lhCount + llCount) / Math.max(1, recentHighs.length + recentLows.length - 2);

    return bullishScore - bearishScore; // -1 to 1
  }

  private findNearestOB(
    orderBlocks: OrderBlock[],
    currentPrice: number,
    type: 'bullish' | 'bearish'
  ): { distance: number; strength: number } | null {
    const filtered = orderBlocks.filter((ob) => ob.type === type && ob.status === 'unmitigated');
    if (filtered.length === 0) return null;

    let nearest = filtered[0]!;
    let minDistance = Infinity;

    for (const ob of filtered) {
      // Calculate distance to nearest edge, not midpoint
      // This is more relevant for trading decisions
      let distance: number;
      if (currentPrice > ob.high) {
        // Price above OB - distance to top edge
        distance = (currentPrice - ob.high) / currentPrice;
      } else if (currentPrice < ob.low) {
        // Price below OB - distance to bottom edge
        distance = (ob.low - currentPrice) / currentPrice;
      } else {
        // Price inside OB - distance is 0
        distance = 0;
      }

      if (distance < minDistance) {
        minDistance = distance;
        nearest = ob;
      }
    }

    return {
      distance: Math.min(minDistance * 10, 1), // Normalize, cap at 1
      strength: Math.min(nearest.strength / 100, 1), // Normalize
    };
  }

  private findNearestFVG(
    fvgs: FairValueGap[],
    currentPrice: number,
    type: 'bullish' | 'bearish'
  ): { distance: number; size: number } | null {
    const filtered = fvgs.filter((fvg) => fvg.type === type && fvg.status !== 'filled');
    if (filtered.length === 0) return null;

    let nearest = filtered[0]!;
    let minDistance = Infinity;

    for (const fvg of filtered) {
      // Calculate distance to nearest edge, not midpoint
      let distance: number;
      if (currentPrice > fvg.high) {
        // Price above FVG - distance to top edge
        distance = (currentPrice - fvg.high) / currentPrice;
      } else if (currentPrice < fvg.low) {
        // Price below FVG - distance to bottom edge
        distance = (fvg.low - currentPrice) / currentPrice;
      } else {
        // Price inside FVG - distance is 0
        distance = 0;
      }

      if (distance < minDistance) {
        minDistance = distance;
        nearest = fvg;
      }
    }

    return {
      distance: Math.min(minDistance * 10, 1),
      size: Math.min(nearest.sizePercent / 2, 1), // Normalize
    };
  }

  private findNearestLiquidity(
    swings: SwingPoint[],
    currentPrice: number,
    type: 'bsl' | 'ssl'
  ): { distance: number; strength: number } | null {
    // Find clusters of equal highs/lows (liquidity)
    if (swings.length < 2) return null;

    // Simple implementation: find recent swing levels close to current price
    const threshold = 0.001; // 0.1% tolerance for equal levels
    const clusters: { price: number; count: number }[] = [];

    for (const swing of swings) {
      const existing = clusters.find((c) => Math.abs(c.price - swing.price) / swing.price < threshold);
      if (existing) {
        existing.count++;
      } else {
        clusters.push({ price: swing.price, count: 1 });
      }
    }

    // Filter for meaningful clusters (2+ touches)
    const liquidityLevels = clusters.filter((c) => c.count >= 2);
    if (liquidityLevels.length === 0) return null;

    // Find nearest based on direction
    let nearest: { price: number; count: number } | null = null;
    let minDistance = Infinity;

    for (const level of liquidityLevels) {
      const isRelevant = type === 'bsl' ? level.price > currentPrice : level.price < currentPrice;
      if (!isRelevant) continue;

      const distance = Math.abs(level.price - currentPrice) / currentPrice;
      if (distance < minDistance) {
        minDistance = distance;
        nearest = level;
      }
    }

    if (!nearest) return null;

    return {
      distance: Math.min(minDistance * 20, 1),
      strength: Math.min(nearest.count / 5, 1),
    };
  }

  private getSessionEncoding(timestamp: number): number[] {
    // Determine session from UTC hour
    // Asian: 0-8 UTC, London: 7-16 UTC, NYC: 13-22 UTC, London Close: 15-17 UTC
    const date = new Date(timestamp);
    const hour = date.getUTCHours();

    const asian = hour >= 0 && hour < 8 ? 1 : 0;
    const london = hour >= 7 && hour < 16 ? 1 : 0;
    const nyc = hour >= 13 && hour < 22 ? 1 : 0;
    const londonClose = hour >= 15 && hour < 17 ? 1 : 0;

    return [asian, london, nyc, londonClose];
  }
}
