import { describe, it, expect } from 'vitest';
import { DataFeed } from '@/lib/bot/data-feed';
import { db } from '@/lib/data/db';
import { botCandles } from '@/lib/data/schema';
import { and, eq } from 'drizzle-orm';

const H = 3_600_000;

/**
 * Regression: fetchCandles returned Bybit's newest kline — the still-FORMING
 * bar (a partial snapshot seconds old) — and the insert-only cache froze that
 * partial forever (the closed bar's final OHLC never replaced it, because its
 * timestamp was no longer "new"). Verified live: 20/25 cached BTC bars diverged
 * from true OHLC (closes off by $470, ranges truncated 1.4 vs 429.6). All
 * analysis, entries, AND SL/TP intrabar checks ran on corrupted candles.
 */

/** Bybit-shaped kline rows, newest first, built relative to `now`. */
function klineRows(now: number, bars: Array<{ ageHours: number; c: number }>): string[][] {
  return bars.map(({ ageHours, c }) => {
    const start = Math.floor(now / H) * H - ageHours * H;
    return [String(start), String(c - 5), String(c + 10), String(c - 10), String(c), '100', '0'];
  });
}

function stubClient(rows: string[][]): { getKline: () => Promise<{ retCode: number; retMsg: string; result: { list: string[][] } }> } {
  return { getKline: async () => ({ retCode: 0, retMsg: 'OK', result: { list: rows } }) };
}

function feedWith(rows: string[][]): DataFeed {
  const feed = new DataFeed();
  (feed as unknown as { client: ReturnType<typeof stubClient> }).client = stubClient(rows);
  return feed;
}

const TEST_SYMBOL = 'SOLUSDT' as const;

function cleanTestRows(): void {
  db.delete(botCandles).where(eq(botCandles.symbol, 'TESTFEED' as never)).run();
}

describe('fetchCandles — closed bars only', () => {
  it('DROPS the still-forming bar (bar start + interval > now)', async () => {
    const now = Date.now();
    // newest first: forming bar (age 0h), then closed bars 1h, 2h old
    const feed = feedWith(klineRows(now, [{ ageHours: 0, c: 100 }, { ageHours: 1, c: 90 }, { ageHours: 2, c: 80 }]));
    const { candles } = await feed.fetchCandles(TEST_SYMBOL);
    expect(candles.length).toBe(2);
    // chronological, and the newest returned candle is the CLOSED 1h-old bar
    expect(candles[candles.length - 1]!.close).toBe(90);
  });

  it('newCandles are closed bars only (the forming bar never appears as new)', async () => {
    const now = Date.now();
    const feed = feedWith(klineRows(now, [{ ageHours: 0, c: 100 }, { ageHours: 1, c: 90 }]));
    const { newCandles } = await feed.fetchCandles(TEST_SYMBOL);
    expect(newCandles.every((c) => c.timestamp + H <= Date.now())).toBe(true);
  });

  it('getLatestPrice returns the last CLOSED close even though the newest kline is forming', async () => {
    const now = Date.now();
    const feed = feedWith(klineRows(now, [{ ageHours: 0, c: 100 }, { ageHours: 1, c: 90 }]));
    const price = await feed.getLatestPrice(TEST_SYMBOL);
    expect(price).toBe(90);
  });
});

describe('candle cache — self-healing upsert', () => {
  it('processNewCandle UPDATES an existing row whose OHLC differs (heals frozen partials)', async () => {
    const now = Date.now();
    const barStart = Math.floor(now / H) * H - 1 * H; // last closed bar
    const sym = 'TESTFEED' as never;
    cleanTestRows();
    // Seed a frozen partial row for the closed bar (wrong close/high/low).
    db.insert(botCandles).values({ symbol: sym, timestamp: barStart, open: 85, high: 86, low: 84, close: 85.5, volume: 1 }).run();

    const feed = feedWith(klineRows(now, [{ ageHours: 0, c: 100 }, { ageHours: 1, c: 90 }]));
    await feed.processNewCandle('TESTFEED' as never);

    const row = db.select().from(botCandles)
      .where(and(eq(botCandles.symbol, sym), eq(botCandles.timestamp, barStart))).get();
    expect(row?.close).toBe(90); // healed to the true close
    expect(row?.high).toBe(100); // healed range (c+10)
    cleanTestRows();
  });
});
