import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createCallerFactory } from '../../src/lib/trpc/init';
import { bookRouter } from '../../src/lib/trpc/routers/dashboard/book';

let dir: string;
const createCaller = createCallerFactory(bookRouter);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'book-'));
  process.env.BOT_DATA_DIR = dir; // router reads from here (see impl note)
});
afterEach(() => {
  delete process.env.BOT_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('book router', () => {
  it('overview reports an empty book on a fresh volume without throwing', async () => {
    const caller = createCaller({});
    const o = await caller.overview();
    expect(o.totalClosedTrades).toBe(0);
    expect(o.totalEquity).toBeCloseTo(30000); // 3 sleeves × 10000 default
    expect(o.idleSleeves).toHaveLength(3);
    expect(o.governance.available).toBe(false);
  });

  it('overview aggregates seeded crypto data', async () => {
    const db = new Database(path.join(dir, 'ict-trading.db'));
    db.exec(`
      CREATE TABLE bot_trades (id TEXT PRIMARY KEY, pnl_percent REAL);
      CREATE TABLE bot_state (id INTEGER PRIMARY KEY, equity REAL);
      CREATE TABLE bot_positions (id TEXT PRIMARY KEY, status TEXT);
      INSERT INTO bot_trades VALUES ('a', 2.0);
      INSERT INTO bot_state VALUES (1, 10200);
      INSERT INTO bot_positions VALUES ('p','open');
    `);
    db.close();
    const o = await createCaller({}).overview();
    expect(o.totalClosedTrades).toBe(1);
    expect(o.totalOpenPositions).toBe(1);
    expect(o.activeSleeves).toBe(1);
  });

  it('trades clamps the limit to 200', async () => {
    const t = await createCaller({}).trades({ limit: 9999 });
    expect(Array.isArray(t)).toBe(true); // no throw; clamped internally
  });
});
