import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readCryptoSleeve, readMetalsSleeve, readGoldSleeve, readAllSleeves } from '../../src/lib/bot/sleeve-readers';

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
