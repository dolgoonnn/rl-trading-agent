/**
 * Bybit 1m Candle Bulk Downloader
 *
 * Downloads historical 1-minute candles from Bybit REST API
 * with automatic pagination backwards in time.
 * Bybit returns max 1000 candles per request for kline endpoint.
 */

import { RestClientV5 } from 'bybit-api';
import type { Candle } from '@/types/candle';

/** Bybit max candles per kline request */
const MAX_PER_REQUEST = 1000;

/** Rate limit delay between requests (ms) */
const RATE_LIMIT_DELAY = 200;

/** 1 minute in milliseconds */
const ONE_MINUTE_MS = 60_000;

export interface DownloadProgress {
  totalCandles: number;
  oldestTimestamp: number;
  newestTimestamp: number;
  requestCount: number;
}

export type ProgressCallback = (progress: DownloadProgress) => void;

/**
 * Download historical 1m candles from Bybit, paginating backwards.
 *
 * @param symbol - Trading pair (e.g., 'BTCUSDT')
 * @param targetMonths - How many months of history to download
 * @param onProgress - Optional progress callback
 * @param endTime - End timestamp (defaults to now)
 * @returns Array of candles in chronological order
 */
export async function downloadCandles1m(
  symbol: string,
  targetMonths: number,
  onProgress?: ProgressCallback,
  endTime?: number,
): Promise<Candle[]> {
  const client = new RestClientV5({});
  const allCandles: Map<number, Candle> = new Map();

  const now = endTime ?? Date.now();
  const targetStartMs = now - targetMonths * 30 * 24 * 60 * 60 * 1000;

  let cursor = now;
  let requestCount = 0;

  while (cursor > targetStartMs) {
    const response = await client.getKline({
      category: 'linear',
      symbol,
      interval: '1',
      limit: MAX_PER_REQUEST,
      end: cursor,
    });

    if (response.retCode !== 0) {
      throw new Error(`Bybit API error: ${response.retMsg} (code: ${response.retCode})`);
    }

    const rawCandles = response.result.list;
    if (!rawCandles || rawCandles.length === 0) {
      break; // No more data
    }

    requestCount++;

    // Bybit returns newest first
    for (const row of rawCandles) {
      const ts = parseInt(row[0], 10);
      if (!allCandles.has(ts)) {
        allCandles.set(ts, {
          timestamp: ts,
          open: parseFloat(row[1]),
          high: parseFloat(row[2]),
          low: parseFloat(row[3]),
          close: parseFloat(row[4]),
          volume: parseFloat(row[5]),
        });
      }
    }

    // Move cursor to oldest candle in this batch - 1 minute
    const oldestInBatch = parseInt(rawCandles[rawCandles.length - 1]![0], 10);
    cursor = oldestInBatch - ONE_MINUTE_MS;

    if (onProgress) {
      const sorted = [...allCandles.keys()].sort((a, b) => a - b);
      onProgress({
        totalCandles: allCandles.size,
        oldestTimestamp: sorted[0]!,
        newestTimestamp: sorted[sorted.length - 1]!,
        requestCount,
      });
    }

    // Rate limit
    await sleep(RATE_LIMIT_DELAY);
  }

  // Sort chronologically
  const candles = [...allCandles.values()].sort((a, b) => a.timestamp - b.timestamp);
  return candles;
}

/**
 * Validate downloaded candle data quality.
 * Reports gaps, OHLC inconsistencies, and coverage.
 */
export function validateCandles(candles: Candle[], intervalMs: number): {
  totalCandles: number;
  startDate: string;
  endDate: string;
  gaps: Array<{ after: number; missing: number }>;
  ohlcErrors: number;
  valid: boolean;
} {
  const gaps: Array<{ after: number; missing: number }> = [];
  let ohlcErrors = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;

    // OHLC consistency
    if (c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close)) {
      ohlcErrors++;
    }
    if (c.high < c.low) {
      ohlcErrors++;
    }

    // Gap detection (skip first candle)
    if (i > 0) {
      const prev = candles[i - 1]!;
      const expectedTs = prev.timestamp + intervalMs;
      if (c.timestamp !== expectedTs) {
        const missingBars = Math.round((c.timestamp - prev.timestamp) / intervalMs) - 1;
        if (missingBars > 0) {
          gaps.push({ after: prev.timestamp, missing: missingBars });
        }
      }
    }
  }

  const totalGapBars = gaps.reduce((sum, g) => sum + g.missing, 0);
  const startDate = candles.length > 0
    ? new Date(candles[0]!.timestamp).toISOString()
    : 'N/A';
  const endDate = candles.length > 0
    ? new Date(candles[candles.length - 1]!.timestamp).toISOString()
    : 'N/A';

  return {
    totalCandles: candles.length,
    startDate,
    endDate,
    gaps,
    ohlcErrors,
    valid: ohlcErrors === 0 && totalGapBars < candles.length * 0.01, // <1% missing
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
