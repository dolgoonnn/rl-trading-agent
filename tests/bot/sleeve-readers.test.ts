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
  readTradeDetail,
  readAllTradesForStats,
  readDrawdownCurve,
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
    // Sleeves get added over time (letf was the 4th) — assert the contract, not a count.
    expect(all.length).toBeGreaterThanOrEqual(3);
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
    // id carries `metal` to avoid same-ms collisions; this fixture has none → `na`.
    expect(metals?.id).toBe(`metals:overnight_au:na:${Date.parse('2026-07-01T09:00:00Z')}`);
    // Stable across repeated reads.
    expect(readRecentTrades(10, dir).find((t) => t.sleeve === 'metals')?.id).toBe(metals?.id);
  });

  it('distinguishes metals legs that close in the same millisecond', () => {
    // The gold and silver sides of a paired leg (e.g. `overnight`) close at the
    // SAME exit timestamp, so leg+exitTime alone collides — both rows would then
    // open the same detail and one would show the other trade's numbers.
    const exitTime = '2026-07-01T09:00:00Z';
    fs.writeFileSync(
      path.join(dir, 'metals-bot-state.json'),
      JSON.stringify({
        trades: [
          { leg: 'overnight', metal: 'gold', side: 'long', entryTime: '2026-07-01T00:00:00Z', exitTime, pnlPct: 3 },
          { leg: 'overnight', metal: 'silver', side: 'long', entryTime: '2026-07-01T00:00:00Z', exitTime, pnlPct: -2 },
        ],
      }),
    );
    const ids = readRecentTrades(10, dir).map((t) => t.id);
    expect(new Set(ids).size).toBe(2);

    // Each id must resolve back to ITS OWN trade (pnlPct stored as percent → fraction).
    const goldId = ids.find((id) => id.includes('gold'));
    const silverId = ids.find((id) => id.includes('silver'));
    expect(goldId).toBeDefined();
    expect(silverId).toBeDefined();
    expect(readTradeDetail(goldId ?? '', dir).pnlPct).toBeCloseTo(0.03);
    expect(readTradeDetail(silverId ?? '', dir).pnlPct).toBeCloseTo(-0.02);
  });
});

describe('detail readers', () => {
  function seedRichTrade(d: string, factorJson: string) {
    const db = new Database(path.join(d, 'ict-trading.db'));
    db.exec(`
      CREATE TABLE bot_trades (id TEXT PRIMARY KEY, symbol TEXT, direction TEXT,
        entry_price REAL, exit_price REAL, entry_timestamp INTEGER, exit_timestamp INTEGER,
        stop_loss REAL, take_profit REAL, position_size_usdt REAL, risk_amount_usdt REAL,
        confluence_score REAL, factor_breakdown TEXT, regime TEXT, exit_reason TEXT,
        bars_held INTEGER, pnl_percent REAL, pnl_usdt REAL,
        gross_return REAL, friction_return REAL, funding_return REAL, net_return REAL, funding_paid_usdt REAL);
    `);
    db.prepare(`INSERT INTO bot_trades VALUES ('t1','BTCUSDT','short',63000,62000,1,500,64000,61000,258.2,6.0,4.31,?, 'ranging+low','take_profit',12,1.5,9.0,0.017,-0.0014,0.00002,0.0156,0.03)`).run(factorJson);
    db.close();
  }

  it('returns a rich crypto trade with parsed factors and R multiple', () => {
    seedRichTrade(dir, JSON.stringify({ obProximity: 1.4, killZoneActive: 1.27, rrRatio: 0.56 }));
    const d = readTradeDetail('t1', dir);
    expect(d.found).toBe(true);
    expect(d.symbol).toBe('BTCUSDT');
    expect(d.confluenceScore).toBeCloseTo(4.31);
    expect(d.factors).toHaveLength(3);
    expect(d.factors?.[0]?.name).toBe('obProximity'); // sorted by value desc
    expect(d.rMultiple).toBeCloseTo(1.5);             // 9.0 / 6.0
    expect(d.netReturn).toBeCloseTo(0.0156);
  });

  it('survives malformed factor_breakdown by returning null factors', () => {
    seedRichTrade(dir, 'not-json{{');
    const d = readTradeDetail('t1', dir);
    expect(d.found).toBe(true);
    expect(d.factors).toBeNull();
  });

  it('returns found:false for an unknown id and on a fresh volume', () => {
    expect(readTradeDetail('nope', dir).found).toBe(false);
    expect(readTradeDetail('gold:123', dir).found).toBe(false);
  });

  it('reads a thin metals trade with null rich fields', () => {
    fs.writeFileSync(path.join(dir, 'metals-bot-state.json'), JSON.stringify({
      trades: [{ leg: 'overnight_au', metal: 'au', side: 'long', entryPrice: 4000, exitPrice: 4040,
        entryTime: '2026-07-01T00:00:00Z', exitTime: '2026-07-01T09:00:00Z', pnlPct: 1 }],
    }));
    const id = `metals:overnight_au:au:${Date.parse('2026-07-01T09:00:00Z')}`;
    const d = readTradeDetail(id, dir);
    expect(d.found).toBe(true);
    expect(d.sleeve).toBe('metals');
    // Metals state stores PERCENT (pnlPct: 1 === 1%) — reader normalizes to FRACTION.
    expect(d.pnlPct).toBeCloseTo(0.01);
    expect(d.direction).toBe('long'); // t.side, matching readRecentTrades
    expect(d.factors).toBeNull();
    expect(d.confluenceScore).toBeNull();
  });

  it('derives metals equity from booked pnl instead of freezing at the starting notional', () => {
    // The metals state has no `equity` field (it tracks totalPnlPct), so equity
    // must be derived — otherwise the sleeve reports a flat $10,000 forever
    // while its PnL says otherwise.
    fs.writeFileSync(path.join(dir, 'metals-bot-state.json'), JSON.stringify({
      trades: [
        { leg: 'overnight', metal: 'gold', side: 'long', entryTime: '2026-07-01T00:00:00Z', exitTime: '2026-07-01T09:00:00Z', pnlPct: -2 },
        { leg: 'fix-short', metal: 'gold', side: 'short', entryTime: '2026-07-02T00:00:00Z', exitTime: '2026-07-02T09:00:00Z', pnlPct: -0.72 },
      ],
      positions: [],
    }));
    const s = readMetalsSleeve(dir);
    expect(s.cumPnlPct).toBeCloseTo(-0.0272); // -2.72% as a fraction
    expect(s.equity).toBeCloseTo(9728); // 10000 * (1 - 0.0272)
  });

  it('reports the starting notional as metals equity when nothing has been booked', () => {
    fs.writeFileSync(path.join(dir, 'metals-bot-state.json'), JSON.stringify({ trades: [], positions: [] }));
    expect(readMetalsSleeve(dir).equity).toBeCloseTo(10000);
    // Absent file → same starting notional, no throw.
    fs.rmSync(path.join(dir, 'metals-bot-state.json'));
    expect(readMetalsSleeve(dir).equity).toBeCloseTo(10000);
  });

  it('normalizes metals PERCENT-scale pnlPct to FRACTION across all three metals readers, leaving gold untouched', () => {
    fs.writeFileSync(path.join(dir, 'metals-bot-state.json'), JSON.stringify({
      trades: [{ leg: 'overnight_au', side: 'long', entryTime: '2026-07-01T00:00:00Z', exitTime: '2026-07-01T09:00:00Z', pnlPct: 2.5 }],
      positions: [],
    }));
    fs.writeFileSync(path.join(dir, 'gold-bot-state.json'), JSON.stringify({
      trades: [{ direction: 'long', entryTime: '2026-07-01T00:00:00Z', exitTime: '2026-07-01T09:00:00Z', pnlPct: 0.02 }],
    }));

    // readMetalsSleeve — cumPnlPct
    const metalsSummary = readMetalsSleeve(dir);
    expect(metalsSummary.cumPnlPct).toBeCloseTo(0.025);

    // readRecentTrades — metals row
    const trades = readRecentTrades(10, dir);
    const metalsRow = trades.find((t) => t.sleeve === 'metals');
    expect(metalsRow?.pnlPct).toBeCloseTo(0.025);
    const goldRow = trades.find((t) => t.sleeve === 'gold');
    expect(goldRow?.pnlPct).toBeCloseTo(0.02); // gold unchanged

    // readTradeDetail — metals trade
    const metalsId = `metals:overnight_au:na:${Date.parse('2026-07-01T09:00:00Z')}`;
    const metalsDetail = readTradeDetail(metalsId, dir);
    expect(metalsDetail.pnlPct).toBeCloseTo(0.025);

    // readTradeDetail — gold trade still unchanged
    const goldId = `gold:${Date.parse('2026-07-01T09:00:00Z')}`;
    const goldDetail = readTradeDetail(goldId, dir);
    expect(goldDetail.pnlPct).toBeCloseTo(0.02);
  });

  it('feeds analytics and the drawdown curve, empty on a fresh volume', () => {
    expect(readAllTradesForStats(dir)).toEqual([]);
    expect(readDrawdownCurve(dir)).toEqual([]);
    const db = new Database(path.join(dir, 'ict-trading.db'));
    db.exec(`
      CREATE TABLE bot_trades (id TEXT PRIMARY KEY, symbol TEXT, pnl_percent REAL, pnl_usdt REAL,
        risk_amount_usdt REAL, exit_reason TEXT, regime TEXT, confluence_score REAL);
      INSERT INTO bot_trades VALUES ('a','BTCUSDT',1.5,9,6,'take_profit','ranging+low',4.31);
      CREATE TABLE bot_equity_snapshots (id INTEGER PRIMARY KEY, timestamp INTEGER, equity REAL, drawdown REAL);
      INSERT INTO bot_equity_snapshots (timestamp, equity, drawdown) VALUES (10, 10000, 0), (20, 9900, 0.01);
    `);
    db.close();
    const rows = readAllTradesForStats(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.confluenceScore).toBeCloseTo(4.31);
    const curve = readDrawdownCurve(dir);
    expect(curve).toHaveLength(2);
    expect(curve[1]?.drawdown).toBeCloseTo(0.01);
  });
});
