/**
 * ICT Breaker Blocks Detection
 *
 * A breaker block is a failed order block that becomes support/resistance.
 * When price breaks through an order block and closes beyond it, that OB
 * "flips" into a breaker that can be traded from the opposite direction.
 *
 * - Bullish OB broken (price closes below) → Bearish Breaker (resistance)
 * - Bearish OB broken (price closes above) → Bullish Breaker (support)
 *
 * Breakers are high-probability levels because:
 * 1. They were institutional levels (order blocks)
 * 2. The break shows change of institutional interest
 * 3. Retests of breakers often provide excellent entries
 */

import type { Candle, OrderBlock, BreakerBlock, BreakerType, BreakerStatus } from '@/types';
import { detectOrderBlocks } from './order-blocks';

// Re-export types for convenience
export type { BreakerBlock, BreakerType, BreakerStatus };

export interface BreakerConfig {
  /** Minimum break exceedance (as % of price) */
  minBreakExceedance: number;
  /** Require body close beyond OB (not just wick) */
  requireBodyClose: boolean;
  /** Maximum age of breaker in bars */
  maxBreakerAge: number;
  /** Lookback for detecting OBs */
  obLookback: number;
}

const DEFAULT_CONFIG: BreakerConfig = {
  minBreakExceedance: 0.001, // 0.1% minimum break
  requireBodyClose: true,    // Require body close for valid break
  maxBreakerAge: 100,        // Breakers valid for 100 bars
  obLookback: 50,            // Look back 50 bars for OBs
};

/**
 * Detect breaker blocks from candle data
 */
export function detectBreakerBlocks(
  candles: Candle[],
  config: Partial<BreakerConfig> = {}
): BreakerBlock[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const breakers: BreakerBlock[] = [];

  if (candles.length < 10) return breakers;

  // First detect order blocks
  const orderBlocks = detectOrderBlocks(candles);

  // Track which OBs have been broken
  const brokenOBs = new Set<number>();

  // Iterate through candles to find OB breaks
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;

    // Check each unmitigated OB for potential break
    for (const ob of orderBlocks) {
      // Skip if already processed as broken
      if (brokenOBs.has(ob.index)) continue;

      // Skip if OB hasn't formed yet
      if (ob.index >= i) continue;

      // Skip if OB is too old
      if (i - ob.index > cfg.maxBreakerAge) continue;

      const breaker = checkOBBreak(ob, candle, i, cfg);
      if (breaker) {
        breakers.push(breaker);
        brokenOBs.add(ob.index);
      }
    }
  }

  // Update breaker statuses (check for tests)
  updateBreakerStatuses(breakers, candles);

  return breakers;
}

/**
 * Check if a candle breaks an order block
 */
function checkOBBreak(
  ob: OrderBlock,
  candle: Candle,
  candleIndex: number,
  config: BreakerConfig
): BreakerBlock | null {
  if (ob.type === 'bullish') {
    // Bullish OB broken when price closes below it
    const priceToCheck = config.requireBodyClose
      ? Math.min(candle.open, candle.close)
      : candle.low;

    if (priceToCheck < ob.low) {
      const exceedance = (ob.low - priceToCheck) / ob.low;

      if (exceedance >= config.minBreakExceedance) {
        // Bullish OB broken → Bearish Breaker (will act as resistance)
        return {
          type: 'bearish',
          status: 'active',
          originalOB: ob,
          high: ob.high,
          low: ob.low,
          breakIndex: candleIndex,
          breakTimestamp: candle.timestamp,
          breakExceedance: exceedance,
          testCount: 0,
          strength: calculateBreakerStrength(ob, exceedance),
        };
      }
    }
  } else {
    // Bearish OB broken when price closes above it
    const priceToCheck = config.requireBodyClose
      ? Math.max(candle.open, candle.close)
      : candle.high;

    if (priceToCheck > ob.high) {
      const exceedance = (priceToCheck - ob.high) / ob.high;

      if (exceedance >= config.minBreakExceedance) {
        // Bearish OB broken → Bullish Breaker (will act as support)
        return {
          type: 'bullish',
          status: 'active',
          originalOB: ob,
          high: ob.high,
          low: ob.low,
          breakIndex: candleIndex,
          breakTimestamp: candle.timestamp,
          breakExceedance: exceedance,
          testCount: 0,
          strength: calculateBreakerStrength(ob, exceedance),
        };
      }
    }
  }

  return null;
}

/**
 * Calculate breaker strength based on original OB and break characteristics
 */
function calculateBreakerStrength(ob: OrderBlock, exceedance: number): number {
  let strength = 0;

  // Base strength from original OB
  strength += ob.strength / 200; // Normalize OB strength

  // Stronger break = higher strength (up to 0.3)
  strength += Math.min(0.3, exceedance * 10);

  // Cap at 1.0
  return Math.min(1, strength);
}

/**
 * Update breaker statuses by checking for tests
 */
function updateBreakerStatuses(breakers: BreakerBlock[], candles: Candle[]): void {
  for (const breaker of breakers) {
    // Check candles after the break for tests
    for (let i = breaker.breakIndex + 1; i < candles.length; i++) {
      const candle = candles[i];
      if (!candle) continue;

      if (breaker.type === 'bullish') {
        // Bullish breaker - check if price tested from above (support)
        if (candle.low <= breaker.high && candle.low >= breaker.low) {
          breaker.testCount++;
          if (!breaker.firstTestIndex) {
            breaker.firstTestIndex = i;
            breaker.status = 'tested';
          }
        }
        // Check if breaker is broken
        if (candle.close < breaker.low) {
          breaker.status = 'broken';
          break;
        }
      } else {
        // Bearish breaker - check if price tested from below (resistance)
        if (candle.high >= breaker.low && candle.high <= breaker.high) {
          breaker.testCount++;
          if (!breaker.firstTestIndex) {
            breaker.firstTestIndex = i;
            breaker.status = 'tested';
          }
        }
        // Check if breaker is broken
        if (candle.close > breaker.high) {
          breaker.status = 'broken';
          break;
        }
      }
    }
  }
}

/**
 * Get active breakers (not broken)
 */
export function getActiveBreakers(
  candles: Candle[],
  config: Partial<BreakerConfig> = {}
): BreakerBlock[] {
  const breakers = detectBreakerBlocks(candles, config);
  return breakers.filter((b) => b.status !== 'broken');
}

/**
 * Check if price is at a breaker level
 */
export function isPriceAtBreaker(
  price: number,
  breakers: BreakerBlock[],
  tolerance: number = 0.002
): { atBreaker: boolean; breaker?: BreakerBlock; direction: 'long' | 'short' | null } {
  for (const breaker of breakers) {
    if (breaker.status === 'broken') continue;

    const zoneHigh = breaker.high * (1 + tolerance);
    const zoneLow = breaker.low * (1 - tolerance);

    if (price >= zoneLow && price <= zoneHigh) {
      return {
        atBreaker: true,
        breaker,
        direction: breaker.type === 'bullish' ? 'long' : 'short',
      };
    }
  }

  return { atBreaker: false, direction: null };
}

/**
 * Get breaker-based entry signal
 */
export function getBreakerSignal(
  candle: Candle,
  breakers: BreakerBlock[],
  _atr: number, // Reserved for future SL/TP calculations
  tolerance: number = 0.002
): {
  hasSignal: boolean;
  direction?: 'long' | 'short';
  breaker?: BreakerBlock;
  confidence?: number;
  reasoning?: string[];
} {
  const { atBreaker, breaker, direction } = isPriceAtBreaker(candle.close, breakers, tolerance);

  if (!atBreaker || !breaker || !direction) {
    return { hasSignal: false };
  }

  const reasoning: string[] = [];
  reasoning.push(`Price at ${breaker.type} breaker (former ${breaker.originalOB.type} OB)`);

  // Check for proper reaction
  let properReaction = false;

  if (direction === 'long') {
    // For bullish breaker (support), look for bullish candle
    const isBullish = candle.close > candle.open;
    const hasLowerWick = (candle.open - candle.low) > (candle.high - candle.close);
    properReaction = isBullish || hasLowerWick;

    if (properReaction) {
      reasoning.push('Bullish reaction at support breaker');
    }
  } else {
    // For bearish breaker (resistance), look for bearish candle
    const isBearish = candle.close < candle.open;
    const hasUpperWick = (candle.high - candle.open) > (candle.close - candle.low);
    properReaction = isBearish || hasUpperWick;

    if (properReaction) {
      reasoning.push('Bearish reaction at resistance breaker');
    }
  }

  if (!properReaction) {
    return { hasSignal: false };
  }

  // Calculate confidence
  let confidence = 0.4 + breaker.strength;

  // Bonus for tested breakers
  if (breaker.testCount > 0) {
    confidence += 0.1;
    reasoning.push(`Breaker tested ${breaker.testCount}x`);
  }

  // Bonus for recent break
  // (freshness would need current index, omitting for simplicity)

  return {
    hasSignal: true,
    direction,
    breaker,
    confidence: Math.min(0.9, confidence),
    reasoning,
  };
}
