/**
 * Every sleeve percentage must mean the same thing: % of SLEEVE EQUITY.
 *
 * The dashboard reported the crypto sleeve at -5.77% and named `order_block`
 * the book's top detractor against "rest +3.37%". The real numbers:
 *
 *     crypto  equity impact  -$10.48
 *     metals  equity impact +$336.99
 *
 * Crypto contributed -$10 to a book that was +$309. The panel was pointing at
 * the wrong sleeve entirely.
 *
 * CAUSE: `bot_trades.pnl_percent` is return on POSITION NOTIONAL. Crypto sizes
 * by risk, so positions are $55-$389 on a $10,000 sleeve — a -1.34% move on a
 * $389 position is -$5.22, i.e. -0.05% of equity. Summing notional-relative
 * percentages produces a number that is not a percentage of anything.
 *
 * The metals legs run at full sleeve notional, so THEIR sum happens to equal
 * the equity return, and `readMetalsSleeve` even derives equity from it. The
 * two sleeves therefore looked comparable while being measured differently —
 * the same family as the percent-vs-fraction bugs already on record, on a new
 * axis: notional-relative vs equity-relative.
 *
 * Crypto carries `pnl_usdt`, so the equity-relative figure is recoverable
 * exactly; there is no need to estimate it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readCryptoSleeve, readLegAttribution, SLEEVE_STARTING_EQUITY } from '../../src/lib/bot/sleeve-readers';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eqrel-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** Reproduces the live shape: big notional-relative losses, tiny dollar losses. */
function seedCrypto(): void {
  const db = new Database(path.join(dir, 'ict-trading.db'));
  db.exec(`
    CREATE TABLE bot_trades (id TEXT PRIMARY KEY, symbol TEXT, strategy TEXT,
      pnl_percent REAL, pnl_usdt REAL, position_size_usdt REAL);
    CREATE TABLE bot_state (id INTEGER PRIMARY KEY, equity REAL);
    CREATE TABLE bot_positions (id TEXT PRIMARY KEY, status TEXT);
  `);
  const ins = db.prepare('INSERT INTO bot_trades VALUES (?,?,?,?,?,?)');
  ins.run('a', 'ETHUSDT', 'order_block', -0.0134, -5.22, 389);
  ins.run('b', 'ETHUSDT', 'order_block', -0.0199, -1.09, 55);
  ins.run('c', 'SOLUSDT', 'order_block', -0.0244, -4.17, 171);
  db.prepare('INSERT INTO bot_state VALUES (1, ?)').run(10000 - 10.48);
  db.close();
}

describe('crypto sleeve reports % of equity, not % of notional', () => {
  it('agrees with its own equity figure', () => {
    seedCrypto();
    const s = readCryptoSleeve(dir);
    // -$10.48 on a $10,000 sleeve.
    expect(s.cumPnlPct).toBeCloseTo(-10.48 / SLEEVE_STARTING_EQUITY, 6);
    // The old behaviour summed notional returns to -5.77% — 55x the real impact.
    expect(s.cumPnlPct).toBeGreaterThan(-0.01);
    // Whatever the percentage says, equity must corroborate it.
    expect(s.equity).toBeCloseTo(SLEEVE_STARTING_EQUITY * (1 + s.cumPnlPct), 2);
  });

  it('still counts wins from the sign of the trade', () => {
    seedCrypto();
    expect(readCryptoSleeve(dir).closedTrades).toBe(3);
    expect(readCryptoSleeve(dir).winRate).toBe(0);
  });
});

describe('leg attribution compares like with like', () => {
  it('scales crypto legs to equity so they rank against session legs fairly', () => {
    seedCrypto();
    // A session leg that genuinely moved the book by +3%.
    fs.writeFileSync(path.join(dir, 'metals-bot-state.json'), JSON.stringify({
      positions: [],
      trades: [{ leg: 'agfix-short', metal: 'silver', side: 'short', pnlPct: 3.0,
        entryTime: '2026-08-01T11:00:00Z', exitTime: '2026-08-01T12:00:00Z' }],
    }));
    const legs = readLegAttribution(dir);
    const ob = legs.find((l) => l.leg === 'order_block')!;
    const ag = legs.find((l) => l.leg === 'agfix-short')!;

    expect(ob.netPnlPct).toBeCloseTo(-10.48 / SLEEVE_STARTING_EQUITY, 6);
    expect(ag.netPnlPct).toBeCloseTo(0.03, 6);
    // The whole point: the session leg must outrank the crypto leg, because it
    // actually moved 30x the money. Ranked on notional returns it did not.
    expect(Math.abs(ag.netPnlPct)).toBeGreaterThan(Math.abs(ob.netPnlPct));
  });

  it('falls back to the notional return when no dollar figure was stored', () => {
    // Older rows predate pnl_usdt. Degrade to the old number rather than
    // silently reporting zero, which would hide a real leg.
    const db = new Database(path.join(dir, 'ict-trading.db'));
    db.exec(`CREATE TABLE bot_trades (id TEXT PRIMARY KEY, strategy TEXT, pnl_percent REAL, pnl_usdt REAL)`);
    db.prepare('INSERT INTO bot_trades VALUES (?,?,?,?)').run('x', 'order_block', -0.02, null);
    db.close();
    const ob = readLegAttribution(dir).find((l) => l.leg === 'order_block')!;
    expect(ob.netPnlPct).toBeCloseTo(-0.02, 6);
  });
});
