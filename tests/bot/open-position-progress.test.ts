/**
 * Open positions must show LIVE progress, not just an entry price.
 *
 * A trader's most urgent question is "how is my open position doing right now?"
 * The table previously answered none of it: no current price, no unrealised P&L,
 * no sense of how close the position is to its stop, target, or scheduled exit.
 *
 * Two kinds of progress, because the sleeves work differently:
 *   - PRICE progress (crypto): entry -> current -> take-profit, with the stop as
 *     the downside rail.
 *   - TIME progress (session legs): these exit on a clock, not a target, so
 *     "how far through the window am I" is the meaningful measure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readOpenPositions, expectedHoldMsFor } from '../../src/lib/bot/sleeve-readers';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openpos-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function seedCrypto(): void {
  const db = new Database(path.join(dir, 'ict-trading.db'));
  db.exec(`
    CREATE TABLE bot_positions (id TEXT PRIMARY KEY, symbol TEXT, direction TEXT, status TEXT,
      entry_price REAL, entry_timestamp INTEGER, position_size_usdt REAL, strategy TEXT,
      stop_loss REAL, take_profit REAL, current_sl REAL);
    CREATE TABLE bot_candles (symbol TEXT, timestamp INTEGER, close REAL);
    -- ETH short: entry 1864.81, SL 1949.32, TP 1699.71
    INSERT INTO bot_positions VALUES ('p1','ETHUSDT','short','open',1864.8137,1785506411843,54.6,'order_block',1949.3243,1699.7114,1949.3243);
    INSERT INTO bot_candles VALUES ('ETHUSDT', 1785733200000, 1858.74);
    INSERT INTO bot_candles VALUES ('ETHUSDT', 1785729600000, 1870.00); -- older, must be ignored
  `);
  db.close();
}

describe('open position live progress', () => {
  it('marks a short to the latest close and computes unrealised P&L', () => {
    seedCrypto();
    const p = readOpenPositions(dir).find((x) => x.symbol === 'ETHUSDT');
    expect(p?.currentPrice).toBeCloseTo(1858.74);
    // short: (entry - current) / entry
    expect(p?.unrealizedPct).toBeCloseTo((1864.8137 - 1858.74) / 1864.8137, 6);
    expect((p?.unrealizedPct ?? 0) > 0).toBe(true);
  });

  it('exposes the stop and target so the rails are visible', () => {
    seedCrypto();
    const p = readOpenPositions(dir).find((x) => x.symbol === 'ETHUSDT');
    expect(p?.stopLoss).toBeCloseTo(1949.3243);
    expect(p?.takeProfit).toBeCloseTo(1699.7114);
  });

  it('reports price progress toward the target as 0..1', () => {
    seedCrypto();
    const p = readOpenPositions(dir).find((x) => x.symbol === 'ETHUSDT');
    expect(p?.progressKind).toBe('price');
    // moved 6.07 of the 165.10 entry->TP range
    expect(p?.progress).toBeCloseTo((1864.8137 - 1858.74) / (1864.8137 - 1699.7114), 3);
  });

  it('uses TIME progress for session legs, which exit on a clock', () => {
    const entry = Date.now() - 4.5 * 3_600_000; // 4.5h into a 9h overnight window
    fs.writeFileSync(path.join(dir, 'metals-bot-state.json'), JSON.stringify({
      trades: [],
      positions: [{ leg: 'overnight', metal: 'gold', side: 'long', entryPrice: 4000, entryTime: entry }],
    }));
    const p = readOpenPositions(dir).find((x) => x.sleeve === 'metals');
    expect(p?.progressKind).toBe('time');
    expect(p?.expectedHoldMs).toBe(9 * 3_600_000);
    expect(p?.progress).toBeGreaterThan(0.45);
    expect(p?.progress).toBeLessThan(0.55);
    // No market price is stored for session legs — do not invent one.
    expect(p?.currentPrice).toBeNull();
    expect(p?.unrealizedPct).toBeNull();
  });

  it('knows each session leg s designed window', () => {
    expect(expectedHoldMsFor('overnight')).toBe(9 * 3_600_000);
    expect(expectedHoldMsFor('fix-short')).toBe(1 * 3_600_000);
    expect(expectedHoldMsFor('eur-morning-short')).toBe(3 * 3_600_000);
    expect(expectedHoldMsFor('weekend')).toBe(59 * 3_600_000);
    expect(expectedHoldMsFor('unknown-leg')).toBeNull();
  });

  it('clamps progress so an overdue position does not exceed 1', () => {
    const entry = Date.now() - 40 * 3_600_000; // way past a 9h window
    fs.writeFileSync(path.join(dir, 'metals-bot-state.json'), JSON.stringify({
      trades: [],
      positions: [{ leg: 'overnight', metal: 'gold', side: 'long', entryPrice: 4000, entryTime: entry }],
    }));
    expect(readOpenPositions(dir).find((x) => x.sleeve === 'metals')?.progress).toBe(1);
  });

  it('returns nulls rather than throwing when there is no price history', () => {
    const db = new Database(path.join(dir, 'ict-trading.db'));
    db.exec(`
      CREATE TABLE bot_positions (id TEXT PRIMARY KEY, symbol TEXT, direction TEXT, status TEXT,
        entry_price REAL, entry_timestamp INTEGER, position_size_usdt REAL, strategy TEXT,
        stop_loss REAL, take_profit REAL, current_sl REAL);
      INSERT INTO bot_positions VALUES ('p1','BTCUSDT','long','open',60000,1,100,'order_block',59000,62000,59000);
    `);
    db.close();
    const p = readOpenPositions(dir)[0];
    expect(p?.currentPrice).toBeNull();
    expect(p?.unrealizedPct).toBeNull();
  });
});

describe('session legs with a live mark', () => {
  it('computes unrealised P&L once the bot persists a quote', () => {
    const entry = Date.now() - 2 * 3_600_000;
    fs.writeFileSync(path.join(dir, 'metals-bot-state.json'), JSON.stringify({
      trades: [],
      positions: [{
        leg: 'overnight', metal: 'gold', side: 'long',
        entryPrice: 4000, entryTime: entry,
        lastPrice: 4040, lastPriceTime: Date.now(),
      }],
    }));
    const p = readOpenPositions(dir).find((x) => x.sleeve === 'metals');
    expect(p?.currentPrice).toBe(4040);
    expect(p?.unrealizedPct).toBeCloseTo(0.01); // long, +1%
    // Progress stays TIME-based — these legs still exit on the clock.
    expect(p?.progressKind).toBe('time');
  });

  it('is direction-aware for a short leg', () => {
    fs.writeFileSync(path.join(dir, 'metals-bot-state.json'), JSON.stringify({
      trades: [],
      positions: [{
        leg: 'fix-short', metal: 'gold', side: 'short',
        entryPrice: 4000, entryTime: Date.now() - 1800_000,
        lastPrice: 3960, lastPriceTime: Date.now(),
      }],
    }));
    const p = readOpenPositions(dir).find((x) => x.sleeve === 'metals');
    expect(p?.unrealizedPct).toBeCloseTo(0.01); // short profits when price falls
  });

  it('still reports null when no quote has been persisted yet', () => {
    fs.writeFileSync(path.join(dir, 'metals-bot-state.json'), JSON.stringify({
      trades: [],
      positions: [{ leg: 'overnight', metal: 'gold', side: 'long', entryPrice: 4000, entryTime: Date.now() }],
    }));
    const p = readOpenPositions(dir).find((x) => x.sleeve === 'metals');
    expect(p?.currentPrice).toBeNull();
    expect(p?.unrealizedPct).toBeNull();
  });
});
