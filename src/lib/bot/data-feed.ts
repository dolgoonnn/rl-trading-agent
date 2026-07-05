/**
 * Data Feed — REST Candle Fetcher from Bybit
 *
 * Polls 1H candles via Bybit REST API at :00:05 past each hour.
 * Maintains a local candle cache in SQLite for ICT analysis.
 * Handles backfill on startup and new candle detection.
 */

import { RestClientV5 } from 'bybit-api';
import { eq, and } from 'drizzle-orm';
import type { Candle } from '@/types/candle';
import type { BotSymbol, OrderbookSnapshot } from '@/types/bot';
import { db } from '@/lib/data/db';
import { botCandles } from '@/lib/data/schema';
import { BYBIT_CATEGORY, BYBIT_INTERVAL } from './config';
import { withRetry, BybitApiError } from './retry';

/**
 * Minimum candles needed for ICT analysis (structure, regime, etc.).
 * Regime detector uses atrRollingWindow=500 for ATR percentile.
 * We need 2500+ bars so the ATR percentile distribution matches the
 * backtest's deep history (26K candles), giving stable volatility
 * classification instead of recent-only data skew.
 */
const MIN_CANDLES_FOR_ANALYSIS = 2500;

/** Max candles per Bybit API request */
const BYBIT_MAX_LIMIT = 200;

/** Mark-price cache TTL (ms) — avoid hammering the tickers endpoint on each tick */
const MARK_PRICE_CACHE_MS = 5_000;

/** Orderbook cache TTL (ms) — same 5s pattern as the mark-price cache. */
const ORDERBOOK_CACHE_MS = 5_000;

/** Top-N order-book levels summed for the tradeability depth check. */
const ORDERBOOK_DEPTH_LEVELS = 10;

/** Max rows per Bybit funding-history request (API hard cap is 200). */
const BYBIT_FUNDING_MAX_LIMIT = 200;

/** Funding-history cache TTL (ms) — short, since realized settlements are stable once published. */
const FUNDING_HISTORY_CACHE_MS = 30_000;

/**
 * One realized funding settlement: the UTC instant it settled and the rate
 * (fraction, e.g. 0.0001 = 1bp) that applied. `settlementMs` is the canonical
 * 00:00 / 08:00 / 16:00 UTC instant the funding-ledger keys on.
 */
export interface FundingSettlement {
  settlementMs: number;
  fundingRate: number;
}

export class DataFeed {
  private client: RestClientV5;
  private lastTimestamps: Map<string, number> = new Map();
  private markPriceCache: Map<string, { price: number; fetchedAt: number }> = new Map();
  private orderbookCache: Map<string, { snapshot: OrderbookSnapshot; fetchedAt: number }> =
    new Map();
  /**
   * Funding-history cache keyed by `symbol|startMs|endMs`. Realized funding is
   * immutable once published, so a short TTL is plenty to avoid re-paging the
   * same window on consecutive closes within a tick.
   */
  private fundingHistoryCache: Map<
    string,
    { settlements: FundingSettlement[]; fetchedAt: number }
  > = new Map();

  /**
   * Wall-clock timestamp (ms) of the last successful feed update from the
   * exchange. Used by the future heartbeat (Task 5) to detect a wedged feed:
   * if `now - lastFeedUpdate` exceeds the heartbeat timeout the bot is no
   * longer receiving fresh data and should escalate. Null until the first
   * successful fetch.
   */
  private lastFeedUpdateMs: number | null = null;

  constructor(
    apiKey?: string,
    apiSecret?: string,
    testnet = false,
  ) {
    this.client = new RestClientV5({
      key: apiKey,
      secret: apiSecret,
      testnet,
    });
  }

  /**
   * Run one Bybit REST call with transient-failure retry (backoff + jitter)
   * and uniform retCode validation. A DNS blip or rate-limit is ridden out
   * in-process instead of crashing the bot (the 2026-06-27 outage killed the
   * fleet via PM2 restart exhaustion during startup backfill).
   *
   * `maxAttempts: Number.POSITIVE_INFINITY` is reserved for startup paths
   * (backfill) where the right behavior during an outage is to wait, capped
   * at 60s between tries, until the network returns.
   */
  private async bybitCall<T extends { retCode: number; retMsg: string }>(
    label: string,
    fn: () => Promise<T>,
    opts: { maxAttempts?: number } = {},
  ): Promise<T> {
    return withRetry(
      async () => {
        const response = await fn();
        if (response.retCode !== 0) {
          throw new BybitApiError(`${label}: ${response.retMsg}`, response.retCode);
        }
        return response;
      },
      {
        maxAttempts: opts.maxAttempts ?? 5,
        onRetry: (err, attempt, delayMs) => {
          const detail = err instanceof Error ? err.message : String(err);
          console.warn(
            `[data-feed] ${label} attempt ${attempt} failed (${detail}); retrying in ${Math.round(delayMs)}ms`,
          );
        },
      },
    );
  }

  /**
   * Fetch latest candles from Bybit for a symbol.
   * Returns new candles since the last fetch.
   */
  async fetchCandles(
    symbol: BotSymbol,
    limit = MIN_CANDLES_FOR_ANALYSIS,
  ): Promise<{ candles: Candle[]; newCandles: Candle[] }> {
    const response = await this.bybitCall(`getKline ${symbol}`, () =>
      this.client.getKline({
        category: BYBIT_CATEGORY,
        symbol,
        interval: BYBIT_INTERVAL,
        limit,
      }),
    );

    // Successful exchange round-trip — record the heartbeat timestamp.
    this.lastFeedUpdateMs = Date.now();

    const rawCandles = response.result.list;
    if (!rawCandles || rawCandles.length === 0) {
      return { candles: [], newCandles: [] };
    }

    // Bybit returns newest first, reverse to chronological order
    const candles: Candle[] = rawCandles
      .map((row) => ({
        timestamp: parseInt(row[0], 10),
        open: parseFloat(row[1]),
        high: parseFloat(row[2]),
        low: parseFloat(row[3]),
        close: parseFloat(row[4]),
        volume: parseFloat(row[5]),
      }))
      .reverse();

    // Detect new candles since last fetch
    const lastTs = this.lastTimestamps.get(symbol) ?? 0;
    const newCandles = candles.filter((c) => c.timestamp > lastTs);

    if (candles.length > 0) {
      this.lastTimestamps.set(symbol, candles[candles.length - 1]!.timestamp);
    }

    return { candles, newCandles };
  }

  /**
   * Backfill candles for a symbol into the bot candle cache.
   * Fetches enough history for ICT analysis on first start.
   * Makes multiple API requests if needed (Bybit max 200 per request).
   */
  async backfill(symbol: BotSymbol, targetCandles = MIN_CANDLES_FOR_ANALYSIS): Promise<number> {
    // Check existing candles in DB
    const existing = await this.getCachedCandles(symbol);
    if (existing.length >= targetCandles) {
      const latest = existing[existing.length - 1]!;
      this.lastTimestamps.set(symbol, latest.timestamp);
      return existing.length;
    }

    // Fetch from Bybit in pages (max 200 per request)
    const allFetched: Candle[] = [];
    let endTime: number | undefined;

    while (allFetched.length < targetCandles) {
      const remaining = targetCandles - allFetched.length;
      const limit = Math.min(remaining, BYBIT_MAX_LIMIT);

      // Startup path: ride out a network outage in-process (capped 60s between
      // tries) instead of crashing into PM2's max_restarts budget.
      const response = await this.bybitCall(
        `backfill getKline ${symbol}`,
        () =>
          this.client.getKline({
            category: BYBIT_CATEGORY,
            symbol,
            interval: BYBIT_INTERVAL,
            limit,
            ...(endTime ? { end: endTime } : {}),
          }),
        { maxAttempts: Number.POSITIVE_INFINITY },
      );

      const rawCandles = response.result.list;
      if (!rawCandles || rawCandles.length === 0) break;

      // Bybit returns newest first
      const batch: Candle[] = rawCandles.map((row) => ({
        timestamp: parseInt(row[0], 10),
        open: parseFloat(row[1]),
        high: parseFloat(row[2]),
        low: parseFloat(row[3]),
        close: parseFloat(row[4]),
        volume: parseFloat(row[5]),
      }));

      allFetched.push(...batch);

      // Set endTime to the oldest candle's timestamp for next page
      const oldest = batch[batch.length - 1]!;
      endTime = oldest.timestamp - 1;

      if (batch.length < limit) break; // No more data available
    }

    // Reverse to chronological order and deduplicate
    const candles = allFetched.reverse();
    const seen = new Set<number>();
    const uniqueCandles = candles.filter((c) => {
      if (seen.has(c.timestamp)) return false;
      seen.add(c.timestamp);
      return true;
    });

    // Upsert into cache
    for (const candle of uniqueCandles) {
      const existingRow = db.select()
        .from(botCandles)
        .where(
          and(
            eq(botCandles.symbol, symbol),
            eq(botCandles.timestamp, candle.timestamp),
          ),
        )
        .get();

      if (!existingRow) {
        db.insert(botCandles).values({
          symbol,
          timestamp: candle.timestamp,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
        }).run();
      }
    }

    if (uniqueCandles.length > 0) {
      this.lastTimestamps.set(symbol, uniqueCandles[uniqueCandles.length - 1]!.timestamp);
    }

    return uniqueCandles.length;
  }

  /**
   * Process a new candle: fetch latest, cache it, return full DB history for analysis.
   *
   * Returns the FULL cached candle history (not just the 200-candle API response),
   * so regime detection has enough bars for ATR percentile (needs ~500 bars).
   */
  async processNewCandle(symbol: BotSymbol): Promise<{
    allCandles: Candle[];
    latestCandle: Candle | null;
    isNew: boolean;
  }> {
    const { newCandles } = await this.fetchCandles(symbol);

    // Cache new candles
    for (const candle of newCandles) {
      const existingRow = db.select()
        .from(botCandles)
        .where(
          and(
            eq(botCandles.symbol, symbol),
            eq(botCandles.timestamp, candle.timestamp),
          ),
        )
        .get();

      if (!existingRow) {
        db.insert(botCandles).values({
          symbol,
          timestamp: candle.timestamp,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
        }).run();
      }
    }

    const isNew = newCandles.length > 0;

    // Return full DB cache for regime detection (needs ~500 bars for ATR percentile).
    // The Bybit API only returns 200 candles per request, but the DB accumulates over time.
    const allCandles = await this.getCachedCandles(symbol);
    const latestCandle = allCandles.length > 0 ? allCandles[allCandles.length - 1]! : null;

    return { allCandles, latestCandle, isNew };
  }

  /**
   * Get cached candles from DB for a symbol, in chronological order.
   */
  async getCachedCandles(symbol: BotSymbol): Promise<Candle[]> {
    const rows = db.select()
      .from(botCandles)
      .where(eq(botCandles.symbol, symbol))
      .orderBy(botCandles.timestamp)
      .all();

    return rows.map((row) => ({
      timestamp: row.timestamp,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    }));
  }

  /**
   * Get the last cached candle timestamp for a symbol.
   */
  getLastTimestamp(symbol: BotSymbol): number {
    return this.lastTimestamps.get(symbol) ?? 0;
  }

  /**
   * Wall-clock ms of the last successful feed update from the exchange,
   * or null if no successful fetch has happened yet. Consumed by the
   * heartbeat (Task 5) to detect a stale/wedged feed.
   */
  get lastFeedUpdate(): number | null {
    return this.lastFeedUpdateMs;
  }

  /**
   * Check if a new hourly candle should be available.
   * Returns true if current time is past :00:05 and we haven't processed this hour yet.
   */
  isNewCandleExpected(symbol: BotSymbol): boolean {
    const now = Date.now();
    const hourMs = 3600_000;
    const currentHourStart = Math.floor(now / hourMs) * hourMs;
    const lastTs = this.lastTimestamps.get(symbol) ?? 0;

    // The candle timestamp is the START of the hour
    // A candle for hour H closes at H+1:00:00
    // We check 5 seconds after the close
    return lastTs < currentHourStart;
  }

  /**
   * Fetch LTF candles (e.g., 5m) from Bybit for LTF entry timing.
   * Returns candles in chronological order.
   *
   * @param symbol Symbol to fetch
   * @param interval Bybit interval (e.g., '5' for 5min, '15' for 15min)
   * @param limit Number of candles to fetch (max 200)
   */
  async fetchLTFCandles(
    symbol: BotSymbol,
    interval: string,
    limit = 100,
  ): Promise<Candle[]> {
    const response = await this.bybitCall(`getKline LTF ${symbol}/${interval}m`, () =>
      this.client.getKline({
        category: BYBIT_CATEGORY,
        symbol,
        interval: interval as '1' | '3' | '5' | '15' | '30' | '60',
        limit,
      }),
    );

    const rawCandles = response.result.list;
    if (!rawCandles || rawCandles.length === 0) {
      return [];
    }

    // Bybit returns newest first, reverse to chronological order
    return rawCandles
      .map((row) => ({
        timestamp: parseInt(row[0], 10),
        open: parseFloat(row[1]),
        high: parseFloat(row[2]),
        low: parseFloat(row[3]),
        close: parseFloat(row[4]),
        volume: parseFloat(row[5]),
      }))
      .reverse();
  }

  /**
   * Get latest price for a symbol (from last candle close).
   *
   * Optional freshness guard: when BOTH `nowMs` and `maxAgeMs` are provided,
   * returns `null` if the latest candle is older than `maxAgeMs` (instead of
   * blindly returning a stale close). When omitted, behaves exactly as before
   * and returns the close so existing callers are unaffected.
   */
  async getLatestPrice(
    symbol: BotSymbol,
    nowMs?: number,
    maxAgeMs?: number,
  ): Promise<number | null> {
    const { candles } = await this.fetchCandles(symbol, 1);
    if (candles.length === 0) {
      throw new Error(`No candle data for ${symbol}`);
    }
    const latest = candles[candles.length - 1]!;

    // Freshness guard only when both args are supplied.
    if (nowMs !== undefined && maxAgeMs !== undefined) {
      if (nowMs - latest.timestamp > maxAgeMs) {
        return null;
      }
    }

    return latest.close;
  }

  /**
   * Get the current MARK price for a symbol via Bybit /v5/market/tickers.
   *
   * The mark price (not last-traded) is Bybit's dual-price / liquidation
   * reference and is the correct anchor for a pre-trade mark collar. Cached
   * in-memory for 5s to avoid hammering the tickers endpoint each tick.
   */
  async getMarkPrice(symbol: BotSymbol, nowMs: number = Date.now()): Promise<number> {
    const cached = this.markPriceCache.get(symbol);
    if (cached && nowMs - cached.fetchedAt < MARK_PRICE_CACHE_MS) {
      return cached.price;
    }

    const response = await this.bybitCall(`getTickers ${symbol}`, () =>
      this.client.getTickers({
        category: BYBIT_CATEGORY,
        symbol,
      }),
    );

    const ticker = response.result.list[0];
    if (!ticker) {
      throw new Error(`No ticker data for ${symbol}`);
    }

    const markPrice = parseFloat(ticker.markPrice);
    if (!Number.isFinite(markPrice) || markPrice <= 0) {
      throw new Error(`Invalid mark price for ${symbol}: ${ticker.markPrice}`);
    }

    this.markPriceCache.set(symbol, { price: markPrice, fetchedAt: nowMs });
    return markPrice;
  }

  /**
   * Fetch the current L2 order book for a symbol via Bybit /v5/market/orderbook
   * and summarize it for the tradeability gate.
   *
   * Returns `{ bid, ask, bidDepthUsdt, askDepthUsdt, spreadBps }` where the
   * depth fields sum the top-N levels' (size × price) into USDT notional and
   * `spreadBps = (ask - bid) / mid * 1e4`. Cached in-memory for 5s, mirroring
   * the mark-price cache so a hot order path doesn't hammer the endpoint.
   */
  async getOrderbook(
    symbol: BotSymbol,
    nowMs: number = Date.now(),
  ): Promise<OrderbookSnapshot> {
    const cached = this.orderbookCache.get(symbol);
    if (cached && nowMs - cached.fetchedAt < ORDERBOOK_CACHE_MS) {
      return cached.snapshot;
    }

    const response = await this.bybitCall(`getOrderbook ${symbol}`, () =>
      this.client.getOrderbook({
        category: BYBIT_CATEGORY,
        symbol,
        limit: ORDERBOOK_DEPTH_LEVELS,
      }),
    );

    const book = response.result;
    const bids = book.b ?? [];
    const asks = book.a ?? [];
    const bestBid = bids[0] ? parseFloat(bids[0][0]) : NaN;
    const bestAsk = asks[0] ? parseFloat(asks[0][0]) : NaN;

    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) {
      throw new Error(`Invalid orderbook for ${symbol}: bid=${bestBid} ask=${bestAsk}`);
    }

    const mid = (bestBid + bestAsk) / 2;
    const spreadBps = ((bestAsk - bestBid) / mid) * 1e4;

    // Depth in USDT: sum (size × price) over the top-N levels on each side.
    const sumDepthUsdt = (levels: [string, string][]): number =>
      levels.reduce((acc, [priceStr, sizeStr]) => {
        const price = parseFloat(priceStr);
        const size = parseFloat(sizeStr);
        if (!Number.isFinite(price) || !Number.isFinite(size)) return acc;
        return acc + price * size;
      }, 0);

    const snapshot: OrderbookSnapshot = {
      bid: bestBid,
      ask: bestAsk,
      bidDepthUsdt: sumDepthUsdt(bids),
      askDepthUsdt: sumDepthUsdt(asks),
      spreadBps,
    };

    this.orderbookCache.set(symbol, { snapshot, fetchedAt: nowMs });
    return snapshot;
  }

  /**
   * Fetch REALIZED funding settlements for `symbol` over the window
   * `[startMs, endMs]` via Bybit `/v5/market/funding/history` (category=linear).
   *
   * Returns the settlements (UTC settlement instant + realized rate) in
   * ASCENDING order, covering the window. Bybit caps each request at 200 rows
   * and returns newest-first; we page BACKWARDS from `endMs` until we pass
   * `startMs` (or run out of rows), then sort ascending.
   *
   * FAIL-SAFE: on ANY error (network, bad payload, rate limit) this returns `[]`
   * and logs — the caller then books 0 funding rather than crashing a close.
   * Short-cached (30s) per `symbol|startMs|endMs` to avoid re-paging the same
   * window across consecutive closes within a tick.
   *
   * @param symbol Linear-perp symbol (e.g. BTCUSDT).
   * @param startMs Window start (inclusive), UTC ms.
   * @param endMs Window end (inclusive), UTC ms.
   * @param nowMs Injected clock for the cache TTL (defaults to Date.now()).
   */
  async getFundingHistory(
    symbol: BotSymbol,
    startMs: number,
    endMs: number,
    nowMs: number = Date.now(),
  ): Promise<FundingSettlement[]> {
    if (!(endMs >= startMs)) return [];

    const cacheKey = `${symbol}|${startMs}|${endMs}`;
    const cached = this.fundingHistoryCache.get(cacheKey);
    if (cached && nowMs - cached.fetchedAt < FUNDING_HISTORY_CACHE_MS) {
      return cached.settlements;
    }

    try {
      const byInstant = new Map<number, number>();
      // Page backwards from endMs: Bybit returns newest-first, so we walk the
      // `endTime` cursor down to the oldest published settlement >= startMs.
      let endTime = endMs;

      // Guard against an unbounded loop on a misbehaving endpoint.
      for (let page = 0; page < 50; page++) {
        // 3 attempts only: this path already fail-safes to [] and must not
        // stall a position close for long.
        const response = await this.bybitCall(
          `getFundingRateHistory ${symbol}`,
          () =>
            this.client.getFundingRateHistory({
              category: BYBIT_CATEGORY,
              symbol,
              startTime: startMs,
              endTime,
              limit: BYBIT_FUNDING_MAX_LIMIT,
            }),
          { maxAttempts: 3 },
        );

        const rows = response.result.list;
        if (!rows || rows.length === 0) break;

        let oldestTs = Number.POSITIVE_INFINITY;
        for (const row of rows) {
          const ts = parseInt(row.fundingRateTimestamp, 10);
          const rate = parseFloat(row.fundingRate);
          if (!Number.isFinite(ts) || !Number.isFinite(rate)) continue;
          oldestTs = Math.min(oldestTs, ts);
          // Keep only settlements inside the requested window.
          if (ts >= startMs && ts <= endMs) byInstant.set(ts, rate);
        }

        // Done once we've reached rows older than the window or got a short page.
        if (rows.length < BYBIT_FUNDING_MAX_LIMIT) break;
        if (!Number.isFinite(oldestTs) || oldestTs <= startMs) break;
        // Step the cursor just before the oldest row seen so the next page is older.
        endTime = oldestTs - 1;
      }

      const settlements: FundingSettlement[] = [...byInstant.entries()]
        .map(([settlementMs, fundingRate]) => ({ settlementMs, fundingRate }))
        .sort((a, b) => a.settlementMs - b.settlementMs);

      this.fundingHistoryCache.set(cacheKey, { settlements, fetchedAt: nowMs });
      return settlements;
    } catch (err) {
      // Fail-safe: never crash a close on a funding-history fetch error.
      console.warn(
        `[data-feed] getFundingHistory failed for ${symbol} [${startMs}, ${endMs}]; returning []:`,
        err,
      );
      return [];
    }
  }
}
