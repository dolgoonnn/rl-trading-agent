import { describe, it, expect } from 'vitest';
import { DataFeed } from '@/lib/bot/data-feed';
import type { Candle } from '@/types/candle';
import type { BotSymbol } from '@/types/bot';

/**
 * Test subclass that stubs the network-bound fetchCandles so getLatestPrice's
 * freshness logic can be exercised deterministically (no Bybit calls).
 */
class StubDataFeed extends DataFeed {
  private stubCandle: Candle;

  constructor(stubCandle: Candle) {
    super();
    this.stubCandle = stubCandle;
  }

  override async fetchCandles(): Promise<{ candles: Candle[]; newCandles: Candle[] }> {
    return { candles: [this.stubCandle], newCandles: [this.stubCandle] };
  }
}

const SYMBOL: BotSymbol = 'BTCUSDT';
const CANDLE_TS = 1_700_000_000_000;
const MAX_AGE_MS = 5_400_000; // 90 min

function makeCandle(ts: number, close: number): Candle {
  return { timestamp: ts, open: close, high: close + 1, low: close - 1, close, volume: 1 };
}

describe('DataFeed.getLatestPrice freshness', () => {
  it('returns null when the candle is stale (nowMs - timestamp > maxAgeMs)', async () => {
    const feed = new StubDataFeed(makeCandle(CANDLE_TS, 42_000));
    const nowMs = CANDLE_TS + MAX_AGE_MS + 1; // 1ms past the limit
    const price = await feed.getLatestPrice(SYMBOL, nowMs, MAX_AGE_MS);
    expect(price).toBeNull();
  });

  it('returns the close when the candle is fresh (age <= maxAgeMs)', async () => {
    const feed = new StubDataFeed(makeCandle(CANDLE_TS, 42_000));
    const nowMs = CANDLE_TS + MAX_AGE_MS; // exactly at the limit → fresh
    const price = await feed.getLatestPrice(SYMBOL, nowMs, MAX_AGE_MS);
    expect(price).toBe(42_000);
  });

  it('returns the close when called with no freshness args (legacy behavior)', async () => {
    const feed = new StubDataFeed(makeCandle(CANDLE_TS, 42_000));
    const price = await feed.getLatestPrice(SYMBOL);
    expect(price).toBe(42_000);
  });
});
