/**
 * Candle Manager
 * Manages OHLCV candle buffer with historical initialization and real-time updates
 */

import type { Candle } from '@/types';
import type { LiveCandle, CandleBufferConfig } from './types';

const DEFAULT_CONFIG: Required<CandleBufferConfig> = {
  symbol: 'BTCUSDT',
  timeframe: '1h',
  maxCandles: 2000,
  historyDays: 30,
  binanceApiUrl: 'https://api.binance.com/api/v3',
};

// Timeframe to milliseconds
const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60 * 1000,
  '3m': 3 * 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
};

export class CandleManager {
  private config: Required<CandleBufferConfig>;
  private candles: Candle[] = [];
  private lastClosedTimestamp: number = 0;
  private initialized: boolean = false;

  constructor(config: CandleBufferConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (!TIMEFRAME_MS[this.config.timeframe]) {
      throw new Error(`Invalid timeframe: ${this.config.timeframe}`);
    }
  }

  /**
   * Initialize with historical data from Binance REST API
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    console.log(`[CandleManager] Fetching ${this.config.historyDays} days of ${this.config.symbol} ${this.config.timeframe} history...`);

    const endTime = Date.now();
    const startTime = endTime - this.config.historyDays * 24 * 60 * 60 * 1000;
    const intervalMs = TIMEFRAME_MS[this.config.timeframe]!;

    const allCandles: Candle[] = [];
    let currentStart = startTime;

    while (currentStart < endTime) {
      const batchEnd = Math.min(currentStart + 1000 * intervalMs, endTime);

      try {
        const candles = await this.fetchKlines(currentStart, batchEnd);
        allCandles.push(...candles);
        currentStart = batchEnd;

        // Rate limiting
        await this.sleep(100);
      } catch (error) {
        console.error(`[CandleManager] Failed to fetch batch: ${error}`);
        throw error;
      }
    }

    // Deduplicate and sort
    this.candles = this.deduplicateAndSort(allCandles);

    // Trim to max size
    if (this.candles.length > this.config.maxCandles) {
      this.candles = this.candles.slice(-this.config.maxCandles);
    }

    // Set last closed timestamp
    const lastCandle = this.candles[this.candles.length - 1];
    if (lastCandle) {
      this.lastClosedTimestamp = lastCandle.timestamp;
    }

    this.initialized = true;
    console.log(`[CandleManager] Initialized with ${this.candles.length} candles`);

    const first = this.candles[0];
    const last = this.candles[this.candles.length - 1];
    if (first && last) {
      console.log(`[CandleManager] Period: ${new Date(first.timestamp).toISOString()} to ${new Date(last.timestamp).toISOString()}`);
    }
  }

  /**
   * Fetch klines from Binance REST API
   */
  private async fetchKlines(startTime: number, endTime: number): Promise<Candle[]> {
    const params = new URLSearchParams({
      symbol: this.config.symbol,
      interval: this.config.timeframe,
      startTime: startTime.toString(),
      endTime: endTime.toString(),
      limit: '1000',
    });

    const url = `${this.config.binanceApiUrl}/klines?${params}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Binance API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as (string | number)[][];

    return data.map((k) => ({
      timestamp: k[0] as number,
      open: parseFloat(k[1] as string),
      high: parseFloat(k[2] as string),
      low: parseFloat(k[3] as string),
      close: parseFloat(k[4] as string),
      volume: parseFloat(k[5] as string),
    }));
  }

  /**
   * Handle live candle update from WebSocket
   */
  handleLiveCandle(liveCandle: LiveCandle): { isNew: boolean; candle: Candle } {
    const candle: Candle = {
      timestamp: liveCandle.timestamp,
      open: liveCandle.open,
      high: liveCandle.high,
      low: liveCandle.low,
      close: liveCandle.close,
      volume: liveCandle.volume,
    };

    // Check if this is a new closed candle
    if (liveCandle.closed && liveCandle.timestamp > this.lastClosedTimestamp) {
      this.appendCandle(candle);
      this.lastClosedTimestamp = liveCandle.timestamp;
      return { isNew: true, candle };
    }

    // Update the current incomplete candle (not stored yet)
    return { isNew: false, candle };
  }

  /**
   * Append a new candle to the buffer
   */
  private appendCandle(candle: Candle): void {
    // Check for duplicates
    const lastCandle = this.candles[this.candles.length - 1];
    if (lastCandle && lastCandle.timestamp === candle.timestamp) {
      // Update existing candle
      this.candles[this.candles.length - 1] = candle;
      return;
    }

    // Check for gaps
    if (lastCandle) {
      const expectedTimestamp = lastCandle.timestamp + TIMEFRAME_MS[this.config.timeframe]!;
      if (candle.timestamp !== expectedTimestamp) {
        console.warn(`[CandleManager] Gap detected: expected ${expectedTimestamp}, got ${candle.timestamp}`);
        // TODO: Fetch missing candles if significant gap
      }
    }

    this.candles.push(candle);

    // Trim buffer if needed
    if (this.candles.length > this.config.maxCandles) {
      this.candles.shift();
    }
  }

  /**
   * Get all candles
   */
  getCandles(): Candle[] {
    return [...this.candles];
  }

  /**
   * Get the latest N candles
   */
  getLatestCandles(n: number): Candle[] {
    return this.candles.slice(-n);
  }

  /**
   * Get the current index (last candle index)
   */
  getCurrentIndex(): number {
    return this.candles.length - 1;
  }

  /**
   * Get candle at specific index
   */
  getCandleAt(index: number): Candle | undefined {
    return this.candles[index];
  }

  /**
   * Get the latest closed candle
   */
  getLatestCandle(): Candle | undefined {
    return this.candles[this.candles.length - 1];
  }

  /**
   * Get the number of candles in buffer
   */
  size(): number {
    return this.candles.length;
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Validate buffer continuity (no gaps)
   */
  validateContinuity(): { valid: boolean; gaps: number[] } {
    const gaps: number[] = [];
    const intervalMs = TIMEFRAME_MS[this.config.timeframe]!;

    for (let i = 1; i < this.candles.length; i++) {
      const prev = this.candles[i - 1]!;
      const curr = this.candles[i]!;
      const expectedTimestamp = prev.timestamp + intervalMs;

      if (curr.timestamp !== expectedTimestamp) {
        gaps.push(i);
      }
    }

    return {
      valid: gaps.length === 0,
      gaps,
    };
  }

  /**
   * Get buffer statistics
   */
  getStats(): {
    size: number;
    oldestTimestamp: number | null;
    newestTimestamp: number | null;
    timeSpanDays: number;
    gaps: number;
  } {
    const first = this.candles[0];
    const last = this.candles[this.candles.length - 1];
    const { gaps } = this.validateContinuity();

    return {
      size: this.candles.length,
      oldestTimestamp: first?.timestamp ?? null,
      newestTimestamp: last?.timestamp ?? null,
      timeSpanDays: first && last
        ? (last.timestamp - first.timestamp) / (24 * 60 * 60 * 1000)
        : 0,
      gaps: gaps.length,
    };
  }

  /**
   * Clear the buffer
   */
  clear(): void {
    this.candles = [];
    this.lastClosedTimestamp = 0;
    this.initialized = false;
  }

  /**
   * Deduplicate and sort candles by timestamp
   */
  private deduplicateAndSort(candles: Candle[]): Candle[] {
    return Array.from(
      new Map(candles.map((c) => [c.timestamp, c])).values()
    ).sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
