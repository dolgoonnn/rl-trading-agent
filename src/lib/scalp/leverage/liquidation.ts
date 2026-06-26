// src/lib/scalp/leverage/liquidation.ts
import type { Candle } from '@/types/candle';
import type { TradeTapeEntry, LeverageConfig, TradeOutcome } from './types';

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

/**
 * Resolve one trade under leverage by walking its 1m path.
 * Leverage's ONLY effect is liquidation: if the adverse extreme reaches the
 * liquidation trigger within (entryTs, exitTs], the trade is liquidated
 * (lose full margin). Otherwise the 1x outcome is amplified, net of funding.
 */
export function resolveTradeUnderLeverage(
  trade: TradeTapeEntry,
  candles1m: Candle[],
  cfg: LeverageConfig,
): TradeOutcome {
  const trigger = effectiveLiqTrigger(
    trade.entryPrice, trade.direction, cfg.leverage, cfg.mmr, cfg.slippageBps,
  );

  for (const bar of candles1m) {
    if (bar.timestamp <= trade.entryTimestamp) continue;
    if (bar.timestamp > trade.exitTimestamp) break;
    const hit = trade.direction === 'long' ? bar.low <= trigger : bar.high >= trigger;
    if (hit) {
      return { liquidated: true, equityMultiplier: 1 - cfg.marginFraction };
    }
  }

  const funding = fundingCostFraction(trade.entryTimestamp, trade.exitTimestamp, cfg.fundingRate8h);
  const netReturn = trade.pnlPercent1x - funding;
  const multiplier = 1 + cfg.marginFraction * cfg.leverage * netReturn;
  return { liquidated: false, equityMultiplier: multiplier };
}
