/**
 * Funding Data Feed — Poll Bybit for Funding Rates
 *
 * Fetches current funding rates via getTickers and
 * historical rates via getFundingRateHistory.
 */

import { RestClientV5 } from 'bybit-api';
import type {
  FundingRateSnapshot,
  FundingRateRecord,
} from '@/types/funding-arb';
import { BYBIT_CATEGORY } from './config';

export class FundingDataFeed {
  private client: RestClientV5;

  constructor(apiKey?: string, apiSecret?: string, testnet = false) {
    this.client = new RestClientV5({
      key: apiKey,
      secret: apiSecret,
      testnet,
    });
  }

  /**
   * Fetch current funding rate snapshot for a symbol.
   * Uses getTickers endpoint which includes fundingRate and bid/ask.
   */
  async fetchCurrentRate(symbol: string): Promise<FundingRateSnapshot> {
    const response = await this.client.getTickers({
      category: BYBIT_CATEGORY,
      symbol,
    });

    if (response.retCode !== 0) {
      throw new Error(
        `Bybit getTickers error: ${response.retMsg} (code: ${response.retCode})`,
      );
    }

    const tickers = response.result.list;
    if (!tickers || tickers.length === 0) {
      throw new Error(`No ticker data for ${symbol}`);
    }

    const ticker = tickers[0]!;
    const bid1 = parseFloat(ticker.bid1Price);
    const ask1 = parseFloat(ticker.ask1Price);

    return {
      symbol,
      fundingRate: parseFloat(ticker.fundingRate),
      nextFundingTime: parseInt(ticker.nextFundingTime, 10),
      markPrice: parseFloat(ticker.markPrice),
      indexPrice: parseFloat(ticker.indexPrice),
      bid1,
      ask1,
      spread: ask1 > 0 ? (ask1 - bid1) / ask1 : 0,
      polledAt: Date.now(),
    };
  }

  /**
   * Fetch current funding rates for multiple symbols in parallel.
   */
  async fetchCurrentRates(
    symbols: string[],
  ): Promise<Map<string, FundingRateSnapshot>> {
    const results = new Map<string, FundingRateSnapshot>();

    const fetches = symbols.map(async (symbol) => {
      try {
        const snapshot = await this.fetchCurrentRate(symbol);
        results.set(symbol, snapshot);
      } catch (err) {
        console.error(`Failed to fetch funding rate for ${symbol}:`, err);
      }
    });

    await Promise.all(fetches);
    return results;
  }

  /**
   * Fetch historical funding rate records from Bybit.
   * Returns records in chronological order (oldest first).
   *
   * @param symbol Symbol to fetch
   * @param startTime Start timestamp in ms (optional)
   * @param endTime End timestamp in ms (optional)
   * @param limit Max records per request (default 200, max 200)
   */
  async fetchFundingHistory(
    symbol: string,
    startTime?: number,
    endTime?: number,
    limit = 200,
  ): Promise<FundingRateRecord[]> {
    const response = await this.client.getFundingRateHistory({
      category: BYBIT_CATEGORY,
      symbol,
      startTime,
      endTime,
      limit,
    });

    if (response.retCode !== 0) {
      throw new Error(
        `Bybit getFundingRateHistory error: ${response.retMsg} (code: ${response.retCode})`,
      );
    }

    const records = response.result.list;
    if (!records || records.length === 0) {
      return [];
    }

    // Bybit returns newest first, reverse to chronological
    return records
      .map((r) => ({
        symbol,
        fundingRate: parseFloat(r.fundingRate),
        fundingRateTimestamp: parseInt(r.fundingRateTimestamp, 10),
      }))
      .reverse();
  }

  /**
   * Fetch all funding history for a symbol by paginating backwards.
   * Stops when no more records or startTime is reached.
   */
  async fetchFullFundingHistory(
    symbol: string,
    startTime: number,
    endTime?: number,
  ): Promise<FundingRateRecord[]> {
    const allRecords: FundingRateRecord[] = [];
    let cursor = endTime ?? Date.now();
    const batchSize = 200;

    while (cursor > startTime) {
      const batch = await this.fetchFundingHistory(
        symbol,
        startTime,
        cursor,
        batchSize,
      );

      if (batch.length === 0) break;

      allRecords.unshift(...batch);

      // Move cursor before the oldest record in this batch
      cursor = batch[0]!.fundingRateTimestamp - 1;

      // Rate limit: small delay between requests
      await sleep(200);
    }

    // Deduplicate by timestamp
    const seen = new Set<number>();
    return allRecords.filter((r) => {
      if (seen.has(r.fundingRateTimestamp)) return false;
      seen.add(r.fundingRateTimestamp);
      return true;
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
