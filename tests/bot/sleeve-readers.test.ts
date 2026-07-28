import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  readCryptoSleeve,
  readMetalsSleeve,
  readGoldSleeve,
  readAllSleeves,
  readOpenPositions,
  readRecentTrades,
  readEquityCurve,
  readFreshness,
  readGovernance,
} from '../../src/lib/bot/sleeve-readers';

let dir: string;

function seedCryptoDb(d: string) {
  const db = new Database(path.join(d, 'ict-trading.db'));
  db.exec(`
    CREATE TABLE bot_trades (id TEXT PRIMARY KEY, pnl_percent REAL);
    CREATE TABLE bot_state (id INTEGER PRIMARY KEY, equity REAL);
    CREATE TABLE bot_positions (id TEXT PRIMARY KEY, status TEXT);
    INSERT INTO bot_trades VALUES ('a', 1.5), ('b', -0.5);
    INSERT INTO bot_state VALUES (1, 10123.4);
    INSERT INTO bot_positions VALUES ('p1','open'), ('p2','closed');
  `);
  db.close();
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleeve-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('sleeve-readers', () => {
  it('reads the crypto sleeve from bot_* tables', () => {
    seedCryptoDb(dir);
    const s = readCryptoSleeve(dir);
    expect(s.closedTrades).toBe(2);
    expect(s.cumPnlPct).toBeCloseTo(1.0);
    expect(s.openPositions).toBe(1);
    expect(s.equity).toBeCloseTo(10123.4);
  });

  it('returns an empty crypto summary when the DB is missing (fresh volume)', () => {
    const s = readCryptoSleeve(dir); // no db file
    expect(s.closedTrades).toBe(0);
    expect(s.openPositions).toBe(0);
    expect(s.equity).toBe(10000);
  });

  it('reads gold and metals from JSON state, tolerating absent files', () => {
    fs.writeFileSync(path.join(dir, 'gold-bot-state.json'), JSON.stringify({ trades: [{ pnlPct: 2 }], equity: 10200, position: { dir: 'long' } }));
    fs.writeFileSync(path.join(dir, 'metals-bot-state.json'), JSON.stringify({ trades: [{ pnlPct: -1 }, { pnlPct: 3 }], positions: [] }));
    const gold = readGoldSleeve(dir);
    const metals = readMetalsSleeve(dir);
    expect(gold.closedTrades).toBe(1);
    expect(gold.openPositions).toBe(1);
    expect(gold.equity).toBeCloseTo(10200);
    expect(metals.closedTrades).toBe(2);
    const all = readAllSleeves(dir);
    expect(all).toHaveLength(3);
    expect(all[0]?.label).toContain('crypto');
  });
});

describe('positions & trades readers', () => {
  it('reads open crypto positions with sleeve tag', () => {
    const db = new Database(path.join(dir, 'ict-trading.db'));
    db.exec(`
      CREATE TABLE bot_positions (id TEXT PRIMARY KEY, symbol TEXT, direction TEXT, status TEXT,
        entry_price REAL, entry_timestamp INTEGER, position_size_usdt REAL, strategy TEXT);
      INSERT INTO bot_positions VALUES ('p1','BTCUSDT','long','open',63000,1700000000000,258.2,'order_block');
      INSERT INTO bot_positions VALUES ('p2','ETHUSDT','short','closed',1900,1700000000000,187.0,'order_block');
    `);
    db.close();
    const pos = readOpenPositions(dir);
    expect(pos).toHaveLength(1);
    expect(pos[0]).toMatchObject({ sleeve: 'crypto', symbol: 'BTCUSDT', direction: 'long', strategy: 'order_block' });
  });

  it('reads recent crypto trades newest-first, capped by limit', () => {
    const db = new Database(path.join(dir, 'ict-trading.db'));
    db.exec(`
      CREATE TABLE bot_trades (id TEXT PRIMARY KEY, symbol TEXT, direction TEXT,
        entry_timestamp INTEGER, exit_timestamp INTEGER, pnl_percent REAL, pnl_usdt REAL, exit_reason TEXT);
      INSERT INTO bot_trades VALUES ('t1','BTCUSDT','short',1,100,0.5,1.2,'take_profit');
      INSERT INTO bot_trades VALUES ('t2','ETHUSDT','long',1,200,-1.0,-5.0,'stop_loss');
    `);
    db.close();
    const trades = readRecentTrades(10, dir);
    expect(trades).toHaveLength(2);
    expect(trades[0]?.sleeve).toBe('crypto');
    expect(trades[0]?.exitTimestamp).toBe(200); // newest first
    expect(readRecentTrades(1, dir)).toHaveLength(1);
  });

  it('returns [] for positions/trades on a fresh volume', () => {
    expect(readOpenPositions(dir)).toEqual([]);
    expect(readRecentTrades(10, dir)).toEqual([]);
  });

  it('merges gold/metals JSON state with crypto SQLite, tagged by sleeve', () => {
    const db = new Database(path.join(dir, 'ict-trading.db'));
    db.exec(`
      CREATE TABLE bot_positions (id TEXT PRIMARY KEY, symbol TEXT, direction TEXT, status TEXT,
        entry_price REAL, entry_timestamp INTEGER, position_size_usdt REAL, strategy TEXT);
      CREATE TABLE bot_trades (id TEXT PRIMARY KEY, symbol TEXT, direction TEXT,
        entry_timestamp INTEGER, exit_timestamp INTEGER, pnl_percent REAL, pnl_usdt REAL, exit_reason TEXT);
      INSERT INTO bot_positions VALUES ('p1','BTCUSDT','long','open',63000,1700000000000,258.2,'order_block');
      INSERT INTO bot_trades VALUES ('t1','BTCUSDT','short',1,300000,0.5,1.2,'take_profit');
    `);
    db.close();

    fs.writeFileSync(
      path.join(dir, 'gold-bot-state.json'),
      JSON.stringify({
        position: { direction: 'long', entryPrice: 1900, entryTime: 1700000000000 },
        trades: [
          { direction: 'short', entryTime: '1970-01-01T00:00:00.100Z', exitTime: '1970-01-01T00:00:00.200Z', pnlPct: 1.1 },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'metals-bot-state.json'),
      JSON.stringify({
        positions: [{ leg: 'silver-overnight', direction: 'long', entryPrice: 24, entryTime: 1700000000000 }],
        trades: [
          { leg: 'gold-fix', entryTime: '1970-01-01T00:00:00.050Z', exitTime: '1970-01-01T00:00:00.100Z', pnlPct: -0.4 },
        ],
      }),
    );

    const positions = readOpenPositions(dir);
    const posSleeves = positions.map((p) => p.sleeve);
    expect(posSleeves).toContain('crypto');
    expect(posSleeves).toContain('gold');
    expect(posSleeves).toContain('metals');

    const trades = readRecentTrades(10, dir);
    expect(trades).toHaveLength(3);
    const tradeSleeves = trades.map((t) => t.sleeve);
    // Deterministic exit order: crypto (300000ms) > gold (200ms) > metals (100ms).
    expect(tradeSleeves).toEqual(['crypto', 'gold', 'metals']);
    expect(tradeSleeves).toContain('crypto');
    expect(tradeSleeves).toContain('gold');
    expect(tradeSleeves).toContain('metals');
    expect(trades[0]?.exitTimestamp ?? 0).toBeGreaterThanOrEqual(trades[1]?.exitTimestamp ?? 0);
    expect(trades[1]?.exitTimestamp ?? 0).toBeGreaterThanOrEqual(trades[2]?.exitTimestamp ?? 0);

    // limit clamps the MERGED set, not just the crypto SQL query.
    expect(readRecentTrades(2, dir)).toHaveLength(2);
  });
});

describe('curve/freshness/governance readers', () => {
  it('reads the crypto equity curve and sums current sleeve equity', () => {
    const db = new Database(path.join(dir, 'ict-trading.db'));
    db.exec(`
      CREATE TABLE bot_state (id INTEGER PRIMARY KEY, equity REAL);
      CREATE TABLE bot_equity_snapshots (id INTEGER PRIMARY KEY, timestamp INTEGER, equity REAL, drawdown REAL);
      INSERT INTO bot_state VALUES (1, 10050);
      INSERT INTO bot_equity_snapshots (timestamp, equity, drawdown) VALUES (100, 10000, 0), (200, 10050, 0.01);
    `);
    db.close();
    fs.writeFileSync(path.join(dir, 'gold-bot-state.json'), JSON.stringify({ equity: 10200 }));
    const c = readEquityCurve(dir);
    expect(c.crypto).toHaveLength(2);
    expect(c.crypto[1]?.timestamp).toBe(200);
    expect(c.crypto[1]?.equity).toBeCloseTo(10050);
    expect(c.currentEquity.crypto).toBeCloseTo(10050);
    expect(c.currentEquity.gold).toBeCloseTo(10200);
    expect(c.currentEquity.metals).toBeCloseTo(10000); // default when file absent
    expect(c.currentEquity.total).toBeCloseTo(30250);
  });

  it('reads governance status, available:false when file absent', () => {
    expect(readGovernance(dir)).toEqual({ available: false, action: null, reason: null, multiplier: null });
    fs.writeFileSync(
      path.join(dir, 'book-governance.json'),
      JSON.stringify({ action: 'derisk', reason: 'book BREACH: 60d Sharpe ...', multiplier: 0.5 }),
    );
    expect(readGovernance(dir)).toEqual({
      available: true,
      action: 'derisk',
      reason: 'book BREACH: 60d Sharpe ...',
      multiplier: 0.5,
    });
  });

  it('reads a halted governance signal', () => {
    fs.writeFileSync(
      path.join(dir, 'book-governance.json'),
      JSON.stringify({ action: 'halt', reason: 'book hard drawdown: 25.0% >= hardKillDD 20.0%', multiplier: 0 }),
    );
    expect(readGovernance(dir)).toEqual({
      available: true,
      action: 'halt',
      reason: 'book hard drawdown: 25.0% >= hardKillDD 20.0%',
      multiplier: 0,
    });
  });

  it('reports freshness nulls on a fresh volume', () => {
    const f = readFreshness(dir);
    expect(f.cryptoLatestCandleMs).toBeNull();
  });
});

describe('trade ids', () => {
  it('exposes the crypto DB id and synthesises stable ids for json sleeves', () => {
    const db = new Database(path.join(dir, 'ict-trading.db'));
    db.exec(`
      CREATE TABLE bot_trades (id TEXT PRIMARY KEY, symbol TEXT, direction TEXT,
        entry_timestamp INTEGER, exit_timestamp INTEGER, pnl_percent REAL, pnl_usdt REAL, exit_reason TEXT);
      INSERT INTO bot_trades VALUES ('abc-123','BTCUSDT','short',1,500,0.5,1.2,'take_profit');
    `);
    db.close();
    fs.writeFileSync(path.join(dir, 'metals-bot-state.json'), JSON.stringify({
      trades: [{ leg: 'overnight_au', entryTime: '2026-07-01T00:00:00Z', exitTime: '2026-07-01T09:00:00Z', pnlPct: 1 }],
    }));
    const trades = readRecentTrades(10, dir);
    const crypto = trades.find((t) => t.sleeve === 'crypto');
    const metals = trades.find((t) => t.sleeve === 'metals');
    expect(crypto?.id).toBe('abc-123');
    expect(metals?.id).toBe(`metals:overnight_au:${Date.parse('2026-07-01T09:00:00Z')}`);
    // Stable across repeated reads.
    expect(readRecentTrades(10, dir).find((t) => t.sleeve === 'metals')?.id).toBe(metals?.id);
  });
});
