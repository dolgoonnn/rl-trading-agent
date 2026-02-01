/**
 * Order Block Detection
 * Identifies institutional order blocks (supply/demand zones)
 */

import type { Candle, OrderBlock, OrderBlockType } from '@/types';
import { isBullish, isBearish, bodySize, range } from '@/types/candle';

export interface OrderBlockConfig {
  minMovePercent: number; // Minimum % move after OB to consider valid
  maxAgeCandles: number; // Maximum age before OB expires
  bodyToRangeRatio: number; // Minimum body/range ratio for OB candle
}

const DEFAULT_CONFIG: OrderBlockConfig = {
  minMovePercent: 0.5,
  maxAgeCandles: 100,
  bodyToRangeRatio: 0.5,
};

/**
 * Detect bullish order blocks
 * Bullish OB = Last bearish candle before a significant bullish move
 */
export function detectBullishOrderBlocks(
  candles: Candle[],
  config: OrderBlockConfig = DEFAULT_CONFIG
): OrderBlock[] {
  const orderBlocks: OrderBlock[] = [];

  for (let i = 1; i < candles.length - 3; i++) {
    const current = candles[i];
    if (!current) continue;

    // Must be a bearish candle
    if (!isBearish(current)) continue;

    // Check for significant bullish move after
    let totalMove = 0;
    let validMove = false;

    for (let j = i + 1; j < Math.min(i + 5, candles.length); j++) {
      const nextCandle = candles[j];
      if (!nextCandle) continue;

      if (isBullish(nextCandle)) {
        totalMove += bodySize(nextCandle);
      }

      const movePercent = (totalMove / current.close) * 100;
      if (movePercent >= config.minMovePercent) {
        validMove = true;
        break;
      }
    }

    if (validMove) {
      orderBlocks.push({
        type: 'bullish',
        status: 'unmitigated',
        high: current.high,
        low: current.low,
        openPrice: current.open,
        closePrice: current.close,
        index: i,
        timestamp: current.timestamp,
        strength: calculateStrength(candles, i, 'bullish'),
      });
    }
  }

  return orderBlocks;
}

/**
 * Detect bearish order blocks
 * Bearish OB = Last bullish candle before a significant bearish move
 */
export function detectBearishOrderBlocks(
  candles: Candle[],
  config: OrderBlockConfig = DEFAULT_CONFIG
): OrderBlock[] {
  const orderBlocks: OrderBlock[] = [];

  for (let i = 1; i < candles.length - 3; i++) {
    const current = candles[i];
    if (!current) continue;

    // Must be a bullish candle
    if (!isBullish(current)) continue;

    // Check for significant bearish move after
    let totalMove = 0;
    let validMove = false;

    for (let j = i + 1; j < Math.min(i + 5, candles.length); j++) {
      const nextCandle = candles[j];
      if (!nextCandle) continue;

      if (isBearish(nextCandle)) {
        totalMove += bodySize(nextCandle);
      }

      const movePercent = (totalMove / current.close) * 100;
      if (movePercent >= config.minMovePercent) {
        validMove = true;
        break;
      }
    }

    if (validMove) {
      orderBlocks.push({
        type: 'bearish',
        status: 'unmitigated',
        high: current.high,
        low: current.low,
        openPrice: current.open,
        closePrice: current.close,
        index: i,
        timestamp: current.timestamp,
        strength: calculateStrength(candles, i, 'bearish'),
      });
    }
  }

  return orderBlocks;
}

/**
 * Calculate order block strength based on move after
 */
function calculateStrength(
  candles: Candle[],
  obIndex: number,
  _type: OrderBlockType
): number {
  let strength = 0;

  for (let i = obIndex + 1; i < Math.min(obIndex + 10, candles.length); i++) {
    const candle = candles[i];
    if (!candle) continue;

    const r = range(candle);
    if (r > 0) {
      strength += r;
    }
  }

  return strength;
}

/**
 * Check if order block has been mitigated (price returned to it)
 */
export function checkMitigation(
  ob: OrderBlock,
  candles: Candle[],
  fromIndex: number
): OrderBlock {
  for (let i = fromIndex; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;

    if (ob.type === 'bullish') {
      // Price returned to bullish OB (price dipped into the zone)
      if (candle.low <= ob.high) {
        return {
          ...ob,
          status: candle.low < ob.low ? 'broken' : 'mitigated',
          mitigationIndex: i,
        };
      }
    } else {
      // Price returned to bearish OB (price rose into the zone)
      if (candle.high >= ob.low) {
        return {
          ...ob,
          status: candle.high > ob.high ? 'broken' : 'mitigated',
          mitigationIndex: i,
        };
      }
    }
  }

  return ob;
}

/**
 * Detect all order blocks in candle data
 */
export function detectOrderBlocks(
  candles: Candle[],
  config: OrderBlockConfig = DEFAULT_CONFIG
): OrderBlock[] {
  const bullishOBs = detectBullishOrderBlocks(candles, config);
  const bearishOBs = detectBearishOrderBlocks(candles, config);

  return [...bullishOBs, ...bearishOBs].sort((a, b) => a.index - b.index);
}
