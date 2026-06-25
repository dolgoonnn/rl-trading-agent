// src/lib/scalp/leverage/liquidation.ts
import type { Candle } from '@/types/candle';
import type { TradeTapeEntry, LeverageConfig, TradeOutcome } from './types';

// Re-export for Task 3 resolver to consume from this module.
export type { Candle, TradeTapeEntry, LeverageConfig, TradeOutcome };

const EIGHT_HOURS_MS = 8 * 3_600_000;

/**
 * Isolated-margin liquidation price for a linear perp.
 * Loss at liquidation = initialMargin - maintenanceMargin = notional * (1/L - mmr).
 * => P_liq_long  = entry * (1 - 1/L + mmr)
 *    P_liq_short = entry * (1 + 1/L - mmr)
 */
export function liquidationPrice(
  entry: number,
  direction: 'long' | 'short',
  leverage: number,
  mmr: number,
): number {
  const move = 1 / leverage - mmr;
  return direction === 'long' ? entry * (1 - move) : entry * (1 + move);
}

/** Liquidation trigger after adverse slippage — shifted TOWARD entry (liquidates earlier). */
export function effectiveLiqTrigger(
  entry: number,
  direction: 'long' | 'short',
  leverage: number,
  mmr: number,
  slippageBps: number,
): number {
  const raw = liquidationPrice(entry, direction, leverage, mmr);
  const shift = entry * (slippageBps / 10_000);
  return direction === 'long' ? raw + shift : raw - shift;
}

/**
 * Funding cost as a fraction of NOTIONAL for the trade's holding period.
 * Counts 8h boundaries (00:00 / 08:00 / 16:00 UTC) in (entryTs, exitTs].
 * Epoch (1970-01-01 00:00 UTC) is a multiple of 8h, so multiples of EIGHT_HOURS_MS
 * land exactly on those UTC boundaries.
 */
export function fundingCostFraction(
  entryTs: number,
  exitTs: number,
  fundingRate8h: number,
): number {
  const first = Math.ceil((entryTs + 1) / EIGHT_HOURS_MS) * EIGHT_HOURS_MS;
  let count = 0;
  for (let t = first; t <= exitTs; t += EIGHT_HOURS_MS) count++;
  return count * fundingRate8h;
}
