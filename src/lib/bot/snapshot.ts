/**
 * Forward-loop snapshot helpers — pure, clock-injected logic.
 *
 * Extracted from run-bot.ts so the hourly snapshot cadence and the
 * mark-to-market equity computation are unit-testable without standing up
 * the whole bot (no Date.now() inside; the caller injects nowMs and prices).
 *
 * Cadence rule: record ONE equity snapshot per UTC hour, deduped by
 * floor(nowMs / 3_600_000). The bot keeps the last recorded hour bucket in
 * state and only snapshots when the bucket advances.
 */

import type { BotPosition } from '@/types/bot';

const HOUR_MS = 3_600_000;

/** UTC hour bucket index for a timestamp (floor to the hour). */
export function hourBucket(nowMs: number): number {
  return Math.floor(nowMs / HOUR_MS);
}

/**
 * Decide whether to record an hourly equity snapshot.
 *
 * @param prevHourBucket The last recorded hour bucket, or null if none yet.
 * @param nowMs Current time in ms (injected — no internal clock).
 * @returns `snapshot=true` when the bucket advances (or on the first call),
 *          plus the `bucket` the caller should store as the new last bucket.
 */
export function shouldSnapshot(
  prevHourBucket: number | null,
  nowMs: number,
): { snapshot: boolean; bucket: number } {
  const bucket = hourBucket(nowMs);
  if (prevHourBucket === null || bucket > prevHourBucket) {
    return { snapshot: true, bucket };
  }
  return { snapshot: false, bucket: prevHourBucket };
}

/**
 * Unrealized PnL (USDT) of an open position marked at `markPrice`.
 *
 * Mirrors OrderManager.closePosition: PnL fraction × positionSizeUSDT, where
 * the fraction is computed against the friction-adjusted entryPrice.
 */
export function unrealizedPnlUsdt(position: BotPosition, markPrice: number): number {
  const entry = position.entryPrice;
  if (entry <= 0) return 0;
  const fraction =
    position.direction === 'long'
      ? (markPrice - entry) / entry
      : (entry - markPrice) / entry;
  return fraction * position.positionSizeUSDT;
}

/**
 * Mark-to-market equity = realized equity + Σ unrealized PnL of open positions
 * at the latest candle close for each symbol.
 *
 * Positions whose symbol has no price in `latestPrices` are skipped (their
 * unrealized PnL is treated as 0) so a missing tick can never produce NaN.
 *
 * @param realizedEquity Cash equity (realized PnL booked).
 * @param openPositions Currently open positions.
 * @param latestPrices Latest close price per symbol.
 */
export function markToMarketEquity(
  realizedEquity: number,
  openPositions: BotPosition[],
  latestPrices: Partial<Record<string, number>>,
): number {
  let equity = realizedEquity;
  for (const position of openPositions) {
    const price = latestPrices[position.symbol];
    if (price === undefined || !Number.isFinite(price) || price <= 0) continue;
    equity += unrealizedPnlUsdt(position, price);
  }
  return equity;
}
