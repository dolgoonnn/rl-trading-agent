/**
 * Data Feed — REST Candle Fetcher from Bybit
 *
 * Polls 1H candles via Bybit REST API at :00:05 past each hour.
 * Maintains a local candle cache in SQLite for ICT analysis.
 * Handles backfill on startup and new candle detection.
 */

import { RestClientV5 } from 'bybit-api';
import { eq, and, desc } from 'drizzle-orm';
import type { Candle } from '@/types/candle';
import type { BotSymbol } from '@/types/bot';
import { db } from '@/lib/data/db';
import { botCandles } from '@/lib/data/schema';
import { BYBIT_CATEGORY, BYBIT_INTERVAL } from './config';

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

export class DataFeed {
  private client: RestClientV5;
  private lastTimestamps: Map<string, number> = new Map();
  private markPriceCache: Map<string, { price: number; fetchedAt: number }> = new Map();

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
   * Fetch latest candles from Bybit for a symbol.
   * Returns new candles since the last fetch.
   */
  async fetchCandles(
    symbol: BotSymbol,
    limit = MIN_CANDLES_FOR_ANALYSIS,
  ): Promise<{ candles: Candle[]; newCandles: Candle[] }> {
    const response = await this.client.getKline({
      category: BYBIT_CATEGORY,
      symbol,
      interval: BYBIT_INTERVAL,
      limit,
    });

    if (response.retCode !== 0) {
      throw new Error(`Bybit API error: ${response.retMsg} (code: ${response.retCode})`);
    }

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

      const response = await this.client.getKline({
        category: BYBIT_CATEGORY,
        symbol,
        interval: BYBIT_INTERVAL,
        limit,
        ...(endTime ? { end: endTime } : {}),
      });

      if (response.retCode !== 0) {
        throw new Error(`Bybit API error: ${response.retMsg} (code: ${response.retCode})`);
      }

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
    const response = await this.client.getKline({
      category: BYBIT_CATEGORY,
      symbol,
      interval: interval as '1' | '3' | '5' | '15' | '30' | '60',
      limit,
    });

    if (response.retCode !== 0) {
      throw new Error(`Bybit API error (LTF): ${response.retMsg} (code: ${response.retCode})`);
    }

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

    const response = await this.client.getTickers({
      category: BYBIT_CATEGORY,
      symbol,
    });

    if (response.retCode !== 0) {
      throw new Error(`Bybit API error (tickers): ${response.retMsg} (code: ${response.retCode})`);
    }

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
}
