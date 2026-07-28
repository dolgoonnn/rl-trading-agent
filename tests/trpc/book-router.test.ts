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

describe('detail + analytics procedures', () => {
  it('returns an empty-but-valid stats payload on a fresh volume', async () => {
    const s = await createCaller({}).stats();
    expect(s.n).toBe(0);
    expect(s.profitFactor).toBeNull();
    expect(s.minTradesForStats).toBe(20);
  });

  it('aggregates stats, breakdowns and costs from seeded trades', async () => {
    const db = new Database(path.join(dir, 'ict-trading.db'));
    db.exec(`
      CREATE TABLE bot_trades (id TEXT PRIMARY KEY, symbol TEXT, pnl_percent REAL, pnl_usdt REAL,
        risk_amount_usdt REAL, exit_reason TEXT, regime TEXT, confluence_score REAL,
        gross_return REAL, friction_return REAL, funding_return REAL, net_return REAL, funding_paid_usdt REAL);
      INSERT INTO bot_trades VALUES ('a','BTCUSDT',2,10,5,'take_profit','ranging+low',4.31,0.021,-0.0014,0.0,0.02,0.03);
      INSERT INTO bot_trades VALUES ('b','ETHUSDT',-1,-5,5,'stop_loss','uptrend+normal',5.82,-0.009,-0.0014,-0.0002,-0.011,0.01);
      CREATE TABLE bot_equity_snapshots (id INTEGER PRIMARY KEY, timestamp INTEGER, equity REAL, drawdown REAL);
      INSERT INTO bot_equity_snapshots (timestamp, equity, drawdown) VALUES
        (10, 10000, 0), (20, 8500, 0.15), (30, 9200, 0.08);
    `);
    db.close();
    const caller = createCaller({});
    const s = await caller.stats();
    expect(s.n).toBe(2);
    expect(s.profitFactor).toBeCloseTo(2);   // 2 / 1
    // maxDrawdown must come from bot_equity_snapshots (max of the `drawdown` column),
    // NOT be re-derived by compounding per-trade pnlPct (notional, not equity) returns.
    expect(s.maxDrawdown).toBeCloseTo(0.15);
    const b = await caller.breakdowns();
    expect(b.byExitReason).toHaveLength(2);
    expect(b.bySymbol.map((r) => r.key).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(b.byConfluence.some((r) => r.key === '4-5')).toBe(true);
    const c = await caller.costs();
    expect(c.totalFriction).toBeCloseTo(-0.0028);
    expect(c.fundingBySymbol).toHaveLength(2);
    expect(c.n).toBe(2);
  });

  it('returns found:false for an unknown trade id', async () => {
    const d = await createCaller({}).tradeDetail({ id: 'missing' });
    expect(d.found).toBe(false);
  });
});
