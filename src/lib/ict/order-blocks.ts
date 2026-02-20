/**
 * Order Block Detection
 * Identifies institutional order blocks (supply/demand zones)
 */

import type { Candle, OrderBlock, OrderBlockType } from '@/types';
import { isBullish, isBearish, bodySize, range } from '@/types/candle';

export interface OrderBlockConfig {
  minMovePercent: number; // Minimum % move after OB (legacy fallback)
  minMoveATR?: number; // Minimum move as ATR-14 multiple (overrides minMovePercent). Auto-scales across assets.
  maxAgeCandles: number; // Maximum age before OB expires
  bodyToRangeRatio: number; // Minimum body/range ratio for OB candle
}

export const DEFAULT_OB_CONFIG: OrderBlockConfig = {
  minMovePercent: 1.2,   // Default: fixed 1.2% (tuned for crypto). Set minMoveATR to override.
  maxAgeCandles: 75,
  bodyToRangeRatio: 0.5, // Enforced below: reject doji/indecision candles as OBs
};

const DEFAULT_CONFIG = DEFAULT_OB_CONFIG;

/**
 * Calculate ATR (Average True Range) for move validation.
 * Used to make OB detection volatility-adaptive across asset classes.
 */
function calculateATR(candles: Candle[], endIndex: number, period: number = 14): number {
  const start = Math.max(1, endIndex - period + 1);
  let sum = 0;
  let count = 0;

  for (let i = start; i <= endIndex; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    if (!curr || !prev) continue;

    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    sum += tr;
    count++;
  }

  return count > 0 ? sum / count : 0;
}

/**
 * Compute the minimum move threshold (in absolute price units) for OB validation.
 * ATR-based if configured, otherwise falls back to percentage-based.
 */
function getMoveThreshold(candles: Candle[], index: number, price: number, config: OrderBlockConfig): number {
  if (config.minMoveATR !== undefined) {
    const atr = calculateATR(candles, index);
    return atr * config.minMoveATR;
  }
  return price * config.minMovePercent / 100;
}

/**
 * Detect bullish order blocks
 * Bullish OB = Last bearish candle immediately before a significant bullish move
 *
 * Quality filters:
 * - Must be the LAST bearish candle before the impulse (not any candle in a range)
 * - Body-to-range ratio must exceed threshold (reject doji/indecision candles)
 * - Impulse move must exceed minMovePercent
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

    // Body-to-range filter: reject doji/indecision candles
    const candleRange = range(current);
    if (candleRange <= 0) continue;
    if (bodySize(current) / candleRange < config.bodyToRangeRatio) continue;

    // "Last candle" requirement: one of the next 2 candles must be bullish (start of impulse)
    // This ensures this is the last bearish candle before the move, not one in the middle of a range
    const next1 = candles[i + 1];
    const next2 = candles[i + 2];
    const impulseStarts = (next1 && isBullish(next1)) || (next2 && isBullish(next2));
    if (!impulseStarts) continue;

    // Also reject if next candle is another bearish candle with bigger body (not the "last" bearish)
    if (next1 && isBearish(next1) && bodySize(next1) > bodySize(current)) continue;

    // Check for significant bullish move after
    const moveThreshold = getMoveThreshold(candles, i, current.close, config);
    let totalMove = 0;
    let validMove = false;

    for (let j = i + 1; j < Math.min(i + 5, candles.length); j++) {
      const moveCandle = candles[j];
      if (!moveCandle) continue;

      if (isBullish(moveCandle)) {
        totalMove += bodySize(moveCandle);
      }

      if (totalMove >= moveThreshold) {
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
        volume: current.volume,
      });
    }
  }

  return orderBlocks;
}

/**
 * Detect bearish order blocks
 * Bearish OB = Last bullish candle immediately before a significant bearish move
 *
 * Quality filters:
 * - Must be the LAST bullish candle before the impulse (not any candle in a range)
 * - Body-to-range ratio must exceed threshold (reject doji/indecision candles)
 * - Impulse move must exceed threshold (ATR-based or percentage-based)
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

    // Body-to-range filter: reject doji/indecision candles
    const candleRange = range(current);
    if (candleRange <= 0) continue;
    if (bodySize(current) / candleRange < config.bodyToRangeRatio) continue;

    // "Last candle" requirement: one of the next 2 candles must be bearish (start of impulse)
    const next1 = candles[i + 1];
    const next2 = candles[i + 2];
    const impulseStarts = (next1 && isBearish(next1)) || (next2 && isBearish(next2));
    if (!impulseStarts) continue;

    // Also reject if next candle is another bullish candle with bigger body (not the "last" bullish)
    if (next1 && isBullish(next1) && bodySize(next1) > bodySize(current)) continue;

    // Check for significant bearish move after
    const moveThreshold = getMoveThreshold(candles, i, current.close, config);
    let totalMove = 0;
    let validMove = false;

    for (let j = i + 1; j < Math.min(i + 5, candles.length); j++) {
      const moveCandle = candles[j];
      if (!moveCandle) continue;

      if (isBearish(moveCandle)) {
        totalMove += bodySize(moveCandle);
      }

      if (totalMove >= moveThreshold) {
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
        volume: current.volume,
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
 * Detect all order blocks in candle data.
 *
 * Note: Mitigation is NOT checked here because detection runs on a lookback window
 * where most OBs will already have been mitigated. Mitigation should be checked
 * at the strategy level relative to the current bar (or not at all — the strategy
 * already filters for price touching the OB zone).
 */
export function detectOrderBlocks(
  candles: Candle[],
  config: OrderBlockConfig = DEFAULT_CONFIG
): OrderBlock[] {
  const bullishOBs = detectBullishOrderBlocks(candles, config);
  const bearishOBs = detectBearishOrderBlocks(candles, config);

  return [...bullishOBs, ...bearishOBs].sort((a, b) => a.index - b.index);
}
