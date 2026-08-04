/**
 * Every trade needs a CHART, not just numbers.
 *
 * The detail drawer could say what a trade did and why it opened, but not what
 * the market looked like when it happened. Seeing the candles around an entry —
 * with the entry, exit, stop and target drawn on them — is how you judge whether
 * the bot is trading sensibly, which numbers alone cannot show.
 *
 * Crypto has stored OHLCV (`bot_candles`), so those trades get a real chart.
 * Session legs and gold do not persist candles, so they return an explicit
 * `unavailable` reason rather than an empty chart that looks broken.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readTradeChart } from '../../src/lib/bot/sleeve-readers';

let dir: string;
const H = 3_600_000;
const T0 = Date.UTC(2026, 6, 1);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-'));
  const db = new Database(path.join(dir, 'ict-trading.db'));
  db.exec(`
    CREATE TABLE bot_trades (id TEXT PRIMARY KEY, symbol TEXT, direction TEXT,
      entry_price REAL, exit_price REAL, entry_timestamp INTEGER, exit_timestamp INTEGER,
      stop_loss REAL, take_profit REAL, pnl_percent REAL, exit_reason TEXT);
    CREATE TABLE bot_candles (id TEXT, symbol TEXT, timestamp INTEGER, open REAL, high REAL, low REAL, close REAL, volume REAL);
  `);
  // 200 hourly bars; the trade sits from bar 100 to bar 110.
  const ins = db.prepare('INSERT INTO bot_candles VALUES (?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 200; i++) {
    const px = 60000 + i * 10;
    ins.run(`c${i}`, 'BTCUSDT', T0 + i * H, px, px + 50, px - 50, px + 5, 1);
  }
  db.prepare('INSERT INTO bot_trades VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
    't1', 'BTCUSDT', 'long', 61000, 61100, T0 + 100 * H, T0 + 110 * H, 60500, 62000, 0.16, 'take_profit',
  );
  db.close();
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('readTradeChart', () => {
  it('returns candles covering the trade with context on both sides', () => {
    const c = readTradeChart('t1', dir);
    expect(c.available).toBe(true);
    expect(c.candles.length).toBeGreaterThan(10);
    // The window must contain both the entry and the exit bar.
    const first = c.candles[0]!.timestamp;
    const last = c.candles[c.candles.length - 1]!.timestamp;
    expect(first).toBeLessThanOrEqual(T0 + 100 * H);
    expect(last).toBeGreaterThanOrEqual(T0 + 110 * H);
    // …and padding beyond the trade so the move is visible in context.
    expect(first).toBeLessThan(T0 + 100 * H);
    expect(last).toBeGreaterThan(T0 + 110 * H);
  });

  it('carries the markers needed to draw the trade on the chart', () => {
    const c = readTradeChart('t1', dir);
    expect(c.entryTimestamp).toBe(T0 + 100 * H);
    expect(c.exitTimestamp).toBe(T0 + 110 * H);
    expect(c.entryPrice).toBe(61000);
    expect(c.exitPrice).toBe(61100);
    expect(c.stopLoss).toBe(60500);
    expect(c.takeProfit).toBe(62000);
    expect(c.direction).toBe('long');
    expect(c.symbol).toBe('BTCUSDT');
  });

  it('returns OHLC, not just closes — it is a candle chart', () => {
    const k = readTradeChart('t1', dir).candles[0]!;
    expect(k.open).toBeGreaterThan(0);
    expect(k.high).toBeGreaterThanOrEqual(k.open);
    expect(k.low).toBeLessThanOrEqual(k.open);
    expect(k.close).toBeGreaterThan(0);
  });

  it('explains itself when a sleeve stores no candles', () => {
    fs.writeFileSync(path.join(dir, 'metals-bot-state.json'), JSON.stringify({
      positions: [],
      trades: [{ leg: 'overnight', metal: 'gold', side: 'long', entryPrice: 4000, exitPrice: 4040,
        entryTime: '2026-07-01T22:00:00Z', exitTime: '2026-07-02T07:00:00Z', pnlPct: 1 }],
    }));
    const id = `metals:overnight:gold:${Date.parse('2026-07-02T07:00:00Z')}`;
    const c = readTradeChart(id, dir);
    expect(c.available).toBe(false);
    expect(c.reason).toMatch(/does not store/i);
    expect(c.candles).toEqual([]);
    // Markers still come through so the panel can show levels without a chart.
    expect(c.entryPrice).toBe(4000);
  });

  it('returns unavailable rather than throwing for an unknown id', () => {
    const c = readTradeChart('nope', dir);
    expect(c.available).toBe(false);
    expect(c.candles).toEqual([]);
  });
});
