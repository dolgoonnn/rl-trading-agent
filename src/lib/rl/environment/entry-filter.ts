/**
 * Entry Filter
 * Rule-based entry filter for hybrid RL system
 * Uses ICT concepts to pre-filter high-confluence entry opportunities
 */

import type { Candle, OrderBlock, FairValueGap, Bias, StructureBreak } from '@/types';
import type {
  EntrySignal,
  EntryFilterConfig,
  ConfluenceLevel,
} from '../types';
import {
  analyzeMarketStructure,
  detectOrderBlocks,
  detectFairValueGaps,
} from '@/lib/ict';

const DEFAULT_CONFIG: EntryFilterConfig = {
  minConfluence: 3,           // A-level minimum
  requireOBTouch: true,       // Must touch OB
  requireTrendAlignment: true, // Must align with market structure bias
  allowedSessionsUTC: [
    [7, 11],   // London Kill Zone (07:00-11:00 UTC)
    [13, 17],  // NYC Kill Zone (13:00-17:00 UTC)
  ],
  maxBarsFromOB: 50,          // OB must be recent
  obProximityPercent: 0.003,  // 0.3% proximity to OB edge
};

export class EntryFilter {
  private config: EntryFilterConfig;

  // Cached detections (updated on each check)
  private cachedIndex: number = -1;
  private orderBlocks: OrderBlock[] = [];
  private fvgs: FairValueGap[] = [];
  private bias: Bias = 'neutral';
  private structureBreaks: StructureBreak[] = [];
  private trendStrength: number = 0;

  constructor(config: Partial<EntryFilterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check for entry signal at current bar
   * Returns EntrySignal if conditions are met, null otherwise
   */
  checkEntry(
    candles: Candle[],
    currentIndex: number
  ): EntrySignal | null {
    if (candles.length < 60) return null;

    const currentCandle = candles[currentIndex];
    if (!currentCandle) return null;

    const currentPrice = currentCandle.close;

    // Update cached detections if needed
    this.updateDetections(candles, currentIndex);

    // Check each unmitigated order block for entry opportunity
    for (const ob of this.orderBlocks) {
      if (ob.status !== 'unmitigated') continue;

      // Check if OB is too old
      if (currentIndex - ob.index > this.config.maxBarsFromOB) continue;

      // Check if price is touching this OB
      const isTouching = this.isPriceTouchingOB(currentCandle, ob);
      if (!isTouching) continue;

      // Determine direction from OB type
      const direction: 'long' | 'short' = ob.type === 'bullish' ? 'long' : 'short';

      // Check trend alignment if required
      if (this.config.requireTrendAlignment) {
        if (!this.isTrendAligned(direction)) continue;
      }

      // Count confluence factors
      const factors = this.countConfluenceFactors(
        currentCandle,
        ob,
        direction
      );

      if (factors.count < this.config.minConfluence) continue;

      // All conditions met - generate entry signal
      const confluenceLevel = this.getConfluenceLevel(factors.count);

      return {
        direction,
        confluenceLevel,
        confluenceCount: factors.count,
        triggerPrice: currentPrice,
        orderBlock: ob,
        additionalFactors: factors.factors,
        timestamp: currentCandle.timestamp,
      };
    }

    return null;
  }

  /**
   * Update cached ICT detections
   */
  private updateDetections(candles: Candle[], currentIndex: number): void {
    // Only recompute if index changed
    if (currentIndex === this.cachedIndex) return;
    this.cachedIndex = currentIndex;

    // Get candles up to current index
    const lookbackCandles = candles.slice(
      Math.max(0, currentIndex - 100),
      currentIndex + 1
    );

    // Run ICT detections
    const structure = analyzeMarketStructure(lookbackCandles);
    this.orderBlocks = detectOrderBlocks(lookbackCandles);
    this.fvgs = detectFairValueGaps(lookbackCandles);

    this.bias = structure.bias;
    this.structureBreaks = structure.structureBreaks;
    this.trendStrength = this.calculateTrendStrength(structure);
  }

  /**
   * Check if price is touching an order block
   */
  private isPriceTouchingOB(candle: Candle, ob: OrderBlock): boolean {
    const proximity = this.config.obProximityPercent;

    // For bullish OB (below price), check if low wicks into or near OB
    if (ob.type === 'bullish') {
      const touchZoneTop = ob.high * (1 + proximity);
      const touchZoneBottom = ob.low * (1 - proximity);

      // Price wick reached into OB zone
      return candle.low <= touchZoneTop && candle.low >= touchZoneBottom;
    }

    // For bearish OB (above price), check if high wicks into or near OB
    if (ob.type === 'bearish') {
      const touchZoneTop = ob.high * (1 + proximity);
      const touchZoneBottom = ob.low * (1 - proximity);

      // Price wick reached into OB zone
      return candle.high >= touchZoneBottom && candle.high <= touchZoneTop;
    }

    return false;
  }

  /**
   * Check if direction aligns with market trend
   */
  private isTrendAligned(direction: 'long' | 'short'): boolean {
    if (direction === 'long') {
      return this.bias === 'bullish' || this.trendStrength > 0.2;
    }
    if (direction === 'short') {
      return this.bias === 'bearish' || this.trendStrength < -0.2;
    }
    return false;
  }

  /**
   * Count confluence factors for entry
   */
  private countConfluenceFactors(
    candle: Candle,
    ob: OrderBlock,
    direction: 'long' | 'short'
  ): { count: number; factors: string[] } {
    const factors: string[] = [];
    let count = 0;

    // 1. OB touch (always present if we got here)
    count++;
    factors.push(`${ob.type}_ob_touch`);

    // 2. Trend alignment
    if (this.isTrendAligned(direction)) {
      count++;
      factors.push('trend_aligned');
    }

    // 3. FVG in same direction nearby
    const nearbyFVG = this.findNearbyFVG(candle.close, direction);
    if (nearbyFVG) {
      count++;
      factors.push('fvg_nearby');
    }

    // 4. Recent BOS/CHoCH confirmation
    const recentBreak = this.findRecentStructureBreak(direction);
    if (recentBreak) {
      count++;
      factors.push(`${recentBreak.type}_confirmation`);
    }

    // 5. Kill Zone active
    if (this.isInKillZone(candle.timestamp)) {
      count++;
      factors.push('kill_zone_active');
    }

    // 6. Strong OB (high strength score)
    if (ob.strength >= 70) {
      count++;
      factors.push('strong_ob');
    }

    // 7. Price in FVG (additional confluence)
    const inFVG = this.isPriceInFVG(candle.close, direction);
    if (inFVG) {
      count++;
      factors.push('in_fvg');
    }

    return { count, factors };
  }

  /**
   * Find nearby FVG in same direction
   */
  private findNearbyFVG(
    price: number,
    direction: 'long' | 'short'
  ): FairValueGap | null {
    const fvgType = direction === 'long' ? 'bullish' : 'bearish';

    for (const fvg of this.fvgs) {
      if (fvg.type !== fvgType) continue;
      if (fvg.status === 'filled') continue;

      // Check if FVG is nearby (within 2% of price)
      const midPoint = (fvg.high + fvg.low) / 2;
      const distance = Math.abs(price - midPoint) / price;

      if (distance < 0.02) {
        return fvg;
      }
    }

    return null;
  }

  /**
   * Check if price is currently inside an FVG
   */
  private isPriceInFVG(price: number, direction: 'long' | 'short'): boolean {
    const fvgType = direction === 'long' ? 'bullish' : 'bearish';

    for (const fvg of this.fvgs) {
      if (fvg.type !== fvgType) continue;
      if (fvg.status === 'filled') continue;

      if (price >= fvg.low && price <= fvg.high) {
        return true;
      }
    }

    return false;
  }

  /**
   * Find recent structure break confirming direction
   */
  private findRecentStructureBreak(
    direction: 'long' | 'short'
  ): StructureBreak | null {
    const breakDirection = direction === 'long' ? 'bullish' : 'bearish';

    // Look for recent breaks (last 20 bars)
    const recentBreaks = this.structureBreaks.filter(
      (b) => b.direction === breakDirection && b.confidence >= 0.5
    );

    if (recentBreaks.length === 0) return null;

    // Return most recent
    return recentBreaks[recentBreaks.length - 1] ?? null;
  }

  /**
   * Check if timestamp is within kill zone hours
   */
  private isInKillZone(timestamp: number): boolean {
    const date = new Date(timestamp);
    const hour = date.getUTCHours();

    for (const [start, end] of this.config.allowedSessionsUTC) {
      if (hour >= start && hour < end) {
        return true;
      }
    }

    return false;
  }

  /**
   * Calculate trend strength from market structure
   */
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

    return bullishScore - bearishScore; // -1 to 1
  }

  /**
   * Convert confluence count to level
   */
  private getConfluenceLevel(count: number): ConfluenceLevel {
    if (count >= 5) return 'A+';
    if (count >= 4) return 'A';
    if (count >= 3) return 'B';
    return 'C';
  }

  /**
   * Get current configuration
   */
  getConfig(): EntryFilterConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<EntryFilterConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get diagnostics for debugging
   */
  getDiagnostics(): {
    orderBlocks: number;
    unmitigated: number;
    bias: Bias;
    trendStrength: number;
    fvgs: number;
  } {
    return {
      orderBlocks: this.orderBlocks.length,
      unmitigated: this.orderBlocks.filter((ob) => ob.status === 'unmitigated').length,
      bias: this.bias,
      trendStrength: this.trendStrength,
      fvgs: this.fvgs.length,
    };
  }
}

export { EntryFilterConfig };
