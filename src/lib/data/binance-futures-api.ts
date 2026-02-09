/**
 * Binance Futures API Client
 *
 * Fetches order flow data orthogonal to OHLCV candles:
 * - Funding rates (every 8h)
 * - Open interest (hourly snapshots)
 * - Long/Short account ratio (hourly)
 * - Liquidation data (event stream, aggregated hourly)
 *
 * All endpoints are public (no API key required).
 */

const FAPI_BASE = 'https://fapi.binance.com';

// ============================================
// Types
// ============================================

export interface FundingRateEntry {
  symbol: string;
  fundingTime: number;
  fundingRate: number; // e.g. 0.0001 = 0.01%
}

export interface OpenInterestEntry {
  symbol: string;
  timestamp: number;
  sumOpenInterest: number; // In contracts
  sumOpenInterestValue: number; // In USD
}

export interface LongShortRatioEntry {
  symbol: string;
  timestamp: number;
  longShortRatio: number;
  longAccount: number; // fraction, e.g. 0.55
  shortAccount: number; // fraction, e.g. 0.45
}

/** Aggregated hourly futures snapshot aligned to candle timestamps */
export interface FuturesSnapshot {
  timestamp: number;
  fundingRate: number; // Latest funding rate at this hour (-0.01 to 0.01)
  openInterest: number; // USD value
  openInterestContracts: number; // Contract count
  longShortRatio: number; // >1 = more longs
  longAccount: number; // Fraction of long accounts
  shortAccount: number; // Fraction of short accounts
}

// ============================================
// API Fetchers
// ============================================

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch funding rate history.
 * Binance returns funding every 8h. Max 1000 per request.
 */
export async function fetchFundingRates(
  symbol: string,
  startTime: number,
  endTime: number,
): Promise<FundingRateEntry[]> {
  const results: FundingRateEntry[] = [];
  let cursor = startTime;

  while (cursor < endTime) {
    const params = new URLSearchParams({
      symbol,
      startTime: cursor.toString(),
      endTime: endTime.toString(),
      limit: '1000',
    });

    const url = `${FAPI_BASE}/fapi/v1/fundingRate?${params}`;
    const response = await fetch(url);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Funding rate API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as Array<{
      symbol: string;
      fundingTime: number;
      fundingRate: string;
      markPrice: string;
    }>;

    if (data.length === 0) break;

    for (const entry of data) {
      results.push({
        symbol: entry.symbol,
        fundingTime: entry.fundingTime,
        fundingRate: parseFloat(entry.fundingRate),
      });
    }

    cursor = data[data.length - 1]!.fundingTime + 1;
    await sleep(200);
  }

  return results;
}

/**
 * Fetch open interest statistics.
 * Available periods: "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"
 */
export async function fetchOpenInterestHistory(
  symbol: string,
  period: string,
  startTime: number,
  endTime: number,
): Promise<OpenInterestEntry[]> {
  const results: OpenInterestEntry[] = [];
  let cursor = startTime;

  while (cursor < endTime) {
    const params = new URLSearchParams({
      symbol,
      period,
      startTime: cursor.toString(),
      endTime: endTime.toString(),
      limit: '500',
    });

    const url = `${FAPI_BASE}/futures/data/openInterestHist?${params}`;
    const response = await fetch(url);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Open interest API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as Array<{
      symbol: string;
      sumOpenInterest: string;
      sumOpenInterestValue: string;
      timestamp: number;
    }>;

    if (data.length === 0) break;

    const prevCursor = cursor;
    for (const entry of data) {
      results.push({
        symbol: entry.symbol,
        timestamp: entry.timestamp,
        sumOpenInterest: parseFloat(entry.sumOpenInterest),
        sumOpenInterestValue: parseFloat(entry.sumOpenInterestValue),
      });
    }

    cursor = data[data.length - 1]!.timestamp + 1;
    // Break if no progress (API returned same data) or got partial page
    if (cursor <= prevCursor || data.length < 500) break;
    await sleep(150);
  }

  return results;
}

/**
 * Fetch global long/short account ratio.
 * Available periods: "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"
 */
export async function fetchLongShortRatio(
  symbol: string,
  period: string,
  startTime: number,
  endTime: number,
): Promise<LongShortRatioEntry[]> {
  const results: LongShortRatioEntry[] = [];
  let cursor = startTime;

  while (cursor < endTime) {
    const params = new URLSearchParams({
      symbol,
      period,
      startTime: cursor.toString(),
      endTime: endTime.toString(),
      limit: '500',
    });

    const url = `${FAPI_BASE}/futures/data/globalLongShortAccountRatio?${params}`;
    const response = await fetch(url);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Long/Short ratio API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as Array<{
      symbol: string;
      longShortRatio: string;
      longAccount: string;
      shortAccount: string;
      timestamp: number;
    }>;

    if (data.length === 0) break;

    const prevCursor = cursor;
    for (const entry of data) {
      results.push({
        symbol: entry.symbol,
        timestamp: entry.timestamp,
        longShortRatio: parseFloat(entry.longShortRatio),
        longAccount: parseFloat(entry.longAccount),
        shortAccount: parseFloat(entry.shortAccount),
      });
    }

    cursor = data[data.length - 1]!.timestamp + 1;
    // Break if no progress or partial page (end of available data)
    if (cursor <= prevCursor || data.length < 500) break;
    await sleep(150);
  }

  return results;
}

// ============================================
// Snapshot Aggregation
// ============================================

/**
 * Align raw futures data to hourly candle timestamps.
 *
 * Funding rates update every 8h — we forward-fill to each hour.
 * OI and L/S ratio are natively hourly.
 */
export function alignToHourlySnapshots(
  timestamps: number[],
  fundingRates: FundingRateEntry[],
  openInterest: OpenInterestEntry[],
  longShortRatios: LongShortRatioEntry[],
): FuturesSnapshot[] {
  // Sort all arrays by timestamp
  const sortedFunding = [...fundingRates].sort((a, b) => a.fundingTime - b.fundingTime);
  const sortedOI = [...openInterest].sort((a, b) => a.timestamp - b.timestamp);
  const sortedLS = [...longShortRatios].sort((a, b) => a.timestamp - b.timestamp);

  // Index for efficient lookup
  let fundingIdx = 0;
  let oiIdx = 0;
  let lsIdx = 0;

  // Track last known values for forward-fill
  let lastFunding = 0;
  let lastOI = 0;
  let lastOIContracts = 0;
  let lastLSRatio = 1.0;
  let lastLong = 0.5;
  let lastShort = 0.5;

  const snapshots: FuturesSnapshot[] = [];

  for (const ts of timestamps) {
    // Advance funding pointer — use latest funding at or before this timestamp
    while (
      fundingIdx < sortedFunding.length &&
      sortedFunding[fundingIdx]!.fundingTime <= ts
    ) {
      lastFunding = sortedFunding[fundingIdx]!.fundingRate;
      fundingIdx++;
    }

    // Advance OI pointer — use closest hourly bucket
    while (
      oiIdx < sortedOI.length &&
      sortedOI[oiIdx]!.timestamp <= ts
    ) {
      lastOI = sortedOI[oiIdx]!.sumOpenInterestValue;
      lastOIContracts = sortedOI[oiIdx]!.sumOpenInterest;
      oiIdx++;
    }

    // Advance L/S pointer
    while (
      lsIdx < sortedLS.length &&
      sortedLS[lsIdx]!.timestamp <= ts
    ) {
      lastLSRatio = sortedLS[lsIdx]!.longShortRatio;
      lastLong = sortedLS[lsIdx]!.longAccount;
      lastShort = sortedLS[lsIdx]!.shortAccount;
      lsIdx++;
    }

    snapshots.push({
      timestamp: ts,
      fundingRate: lastFunding,
      openInterest: lastOI,
      openInterestContracts: lastOIContracts,
      longShortRatio: lastLSRatio,
      longAccount: lastLong,
      shortAccount: lastShort,
    });
  }

  return snapshots;
}
