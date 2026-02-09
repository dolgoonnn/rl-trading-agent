/**
 * Order Flow Feature Builder
 *
 * Extracts 10 features orthogonal to OHLCV candle data.
 * These break the circular dependency where all RL features
 * come from the same data that generates the trading signals.
 *
 * Features:
 *   1. fundingRate          — raw funding rate (sentiment)
 *   2. fundingRateTrend     — 3-period funding rate delta
 *   3. openInterestChange1h — hourly OI change
 *   4. openInterestChange24h — 24h OI change
 *   5. longShortRatio       — normalized account positioning
 *   6. takerBuyRatio        — taker buy vol / total vol
 *   7. liquidationPressure  — (long liqs - short liqs) / total liqs
 *   8. liquidationVolume    — total liqs / avg volume
 *   9. fundingOIDivergence  — funding direction ≠ OI direction
 *  10. crowdingSignal       — extreme funding + extreme positioning
 */

import type { Candle } from '@/types';
import type { FuturesSnapshot } from '@/lib/data/binance-futures-api';

// ============================================
// Types
// ============================================

export interface OrderFlowFeatures {
  fundingRate: number;
  fundingRateTrend: number;
  openInterestChange1h: number;
  openInterestChange24h: number;
  longShortRatio: number;
  takerBuyRatio: number;
  liquidationPressure: number;
  liquidationVolume: number;
  fundingOIDivergence: number;
  crowdingSignal: number;
}

export const ORDER_FLOW_FEATURE_COUNT = 10;

export const ORDER_FLOW_FEATURE_NAMES: (keyof OrderFlowFeatures)[] = [
  'fundingRate',
  'fundingRateTrend',
  'openInterestChange1h',
  'openInterestChange24h',
  'longShortRatio',
  'takerBuyRatio',
  'liquidationPressure',
  'liquidationVolume',
  'fundingOIDivergence',
  'crowdingSignal',
];

// ============================================
// Feature Extraction
// ============================================

/**
 * Build order flow features for the current bar.
 *
 * @param snapshots  Array of FuturesSnapshot aligned to candle timestamps
 * @param candles    Candle array (for takerBuyVolume and volume)
 * @param currentIndex  Current bar index in both arrays
 * @returns 10 normalized features, all in roughly [-1, 1] or [0, 1]
 */
export function buildOrderFlowFeatures(
  snapshots: FuturesSnapshot[],
  candles: Candle[],
  currentIndex: number,
): OrderFlowFeatures {
  const snap = snapshots[currentIndex];
  const candle = candles[currentIndex];

  // Guard: no data available yet
  if (!snap || !candle) {
    return zeroFeatures();
  }

  // 1. Funding rate — scale to roughly [-1, 1]
  // Typical range: -0.001 to 0.003 (extreme). Divide by 0.001 to normalize.
  const fundingRate = clamp(snap.fundingRate / 0.001, -3, 3) / 3;

  // 2. Funding rate trend — 3-period delta
  let fundingRateTrend = 0;
  if (currentIndex >= 3) {
    // Funding updates every 8h, but we track the latest known at each hour.
    // Use 24h lookback (3 funding periods) to capture trend.
    const prev24hIdx = Math.max(0, currentIndex - 24);
    const prevSnap = snapshots[prev24hIdx];
    if (prevSnap) {
      const delta = snap.fundingRate - prevSnap.fundingRate;
      fundingRateTrend = clamp(delta / 0.0005, -1, 1);
    }
  }

  // 3. Open interest change 1h
  let openInterestChange1h = 0;
  if (currentIndex >= 1) {
    const prevSnap = snapshots[currentIndex - 1];
    if (prevSnap && prevSnap.openInterest > 0) {
      openInterestChange1h = clamp(
        (snap.openInterest - prevSnap.openInterest) / prevSnap.openInterest,
        -0.1,
        0.1,
      );
      // Normalize to [-1, 1]
      openInterestChange1h = openInterestChange1h / 0.1;
    }
  }

  // 4. Open interest change 24h
  let openInterestChange24h = 0;
  if (currentIndex >= 24) {
    const prevSnap = snapshots[currentIndex - 24];
    if (prevSnap && prevSnap.openInterest > 0) {
      openInterestChange24h = clamp(
        (snap.openInterest - prevSnap.openInterest) / prevSnap.openInterest,
        -0.5,
        0.5,
      );
      openInterestChange24h = openInterestChange24h / 0.5;
    }
  }

  // 5. Long/Short ratio — normalize to [-1, 1] where 0 = neutral (ratio=1.0)
  // Typical range: 0.5 to 2.0. Map: 1.0 → 0, 2.0 → 1, 0.5 → -1
  const longShortRatio = clamp((snap.longShortRatio - 1.0) / 0.5, -1, 1);

  // 6. Taker buy ratio — from candle data
  let takerBuyRatio = 0.5; // neutral default
  if (candle.volume > 0 && candle.takerBuyVolume !== undefined) {
    takerBuyRatio = candle.takerBuyVolume / candle.volume;
  }
  // Normalize to [-1, 1] where 0.5 → 0
  const takerBuyRatioNorm = clamp((takerBuyRatio - 0.5) * 4, -1, 1);

  // 7. Liquidation pressure — placeholder (requires liquidation data)
  // When liquidation data is available, this would be:
  // (longLiqVol - shortLiqVol) / (longLiqVol + shortLiqVol)
  // For now, derive from extreme funding + extreme ratio as proxy
  const liquidationPressure = deriveLiquidationProxy(snap.fundingRate, snap.longShortRatio);

  // 8. Liquidation volume — placeholder (requires liquidation data)
  // Proxy: when funding is extreme, liquidations are likely
  const liquidationVolume = clamp(Math.abs(snap.fundingRate) / 0.001, 0, 1);

  // 9. Funding-OI divergence
  // High funding + falling OI = bearish divergence (crowded longs exiting)
  // Low funding + rising OI = bullish divergence (new shorts building)
  const fundingDirection = snap.fundingRate > 0 ? 1 : snap.fundingRate < 0 ? -1 : 0;
  const oiDirection = openInterestChange1h > 0 ? 1 : openInterestChange1h < 0 ? -1 : 0;
  const fundingOIDivergence = fundingDirection !== oiDirection && fundingDirection !== 0
    ? -fundingDirection * 0.7 // Divergence signal
    : 0;

  // 10. Crowding signal — extreme positioning
  // When funding is extremely positive AND long/short ratio is extremely high → crowded longs
  // When funding is extremely negative AND ratio is extremely low → crowded shorts
  const absF = Math.abs(snap.fundingRate);
  const ratioExtreme = Math.abs(snap.longShortRatio - 1.0);
  const crowdingSignal = clamp(
    (absF / 0.001) * (ratioExtreme / 0.3),
    0,
    1,
  );

  return {
    fundingRate,
    fundingRateTrend,
    openInterestChange1h,
    openInterestChange24h,
    longShortRatio,
    takerBuyRatio: takerBuyRatioNorm,
    liquidationPressure,
    liquidationVolume,
    fundingOIDivergence,
    crowdingSignal,
  };
}

/**
 * Flatten OrderFlowFeatures into a number array for state builder.
 */
export function flattenOrderFlowFeatures(features: OrderFlowFeatures): number[] {
  return ORDER_FLOW_FEATURE_NAMES.map((name) => features[name]);
}

// ============================================
// Helpers
// ============================================

function clamp(value: number, min: number, max: number): number {
  if (!isFinite(value)) return 0;
  return Math.max(min, Math.min(max, value));
}

function zeroFeatures(): OrderFlowFeatures {
  return {
    fundingRate: 0,
    fundingRateTrend: 0,
    openInterestChange1h: 0,
    openInterestChange24h: 0,
    longShortRatio: 0,
    takerBuyRatio: 0,
    liquidationPressure: 0,
    liquidationVolume: 0,
    fundingOIDivergence: 0,
    crowdingSignal: 0,
  };
}

/**
 * Derive liquidation pressure proxy from funding + positioning.
 * When extreme longs: funding high + ratio high → long liquidation pressure.
 */
function deriveLiquidationProxy(fundingRate: number, longShortRatio: number): number {
  const fundingBias = fundingRate / 0.001; // >1 means extreme long funding
  const positionBias = (longShortRatio - 1.0) / 0.3; // >1 means extreme long positioning

  // Positive = long liquidation pressure (bearish), Negative = short liquidation pressure (bullish)
  const rawPressure = (fundingBias + positionBias) / 2;
  return clamp(rawPressure, -1, 1);
}
