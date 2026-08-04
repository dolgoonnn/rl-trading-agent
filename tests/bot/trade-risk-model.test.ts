/**
 * A trade must say HOW it was risk-managed, not leave stop/target blank.
 *
 * "Most trade details don't show SL and TP" is not missing data — the session
 * legs (metals, EUR, US500) and the LETF leg place NO stop and NO target at
 * all. They enter on a clock and exit on a clock; grep the bots and there is no
 * stop field to store. Only the crypto sleeve trades bracketed levels.
 *
 * Rendering "—" made a deliberate design read as broken plumbing, which is the
 * more dangerous of the two: a naked position is a risk fact the operator must
 * see stated, not infer from an empty cell.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readTradeDetail } from '../../src/lib/bot/sleeve-readers';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('riskModel on a trade detail', () => {
  it('marks crypto trades as bracketed by levels', () => {
    const db = new Database(path.join(dir, 'ict-trading.db'));
    db.exec(`CREATE TABLE bot_trades (id TEXT PRIMARY KEY, symbol TEXT, direction TEXT,
      entry_price REAL, exit_price REAL, entry_timestamp INTEGER, exit_timestamp INTEGER,
      stop_loss REAL, take_profit REAL, pnl_percent REAL, exit_reason TEXT)`);
    db.prepare('INSERT INTO bot_trades VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      't1', 'BTCUSDT', 'long', 61000, 61100, 1, 2, 60500, 62000, 0.0016, 'take_profit',
    );
    db.close();
    const d = readTradeDetail('t1', dir);
    expect(d.riskModel).toBe('levels');
    expect(d.stopLoss).toBe(60500);
    // Instrument travels with the detail so the drawer can show the move in pips.
    expect(d.instrument).toBe('btcusdt');
  });

  it('marks session legs as time-exit, so a blank stop is explained not implied', () => {
    fs.writeFileSync(path.join(dir, 'metals-bot-state.json'), JSON.stringify({
      positions: [],
      trades: [{ leg: 'overnight', metal: 'gold', side: 'long', entryPrice: 4000, exitPrice: 4004,
        entryTime: '2026-08-03T22:00:00Z', exitTime: '2026-08-04T07:00:00Z', pnlPct: 0.1 }],
    }));
    const id = `metals:overnight:gold:${Date.parse('2026-08-04T07:00:00Z')}`;
    const d = readTradeDetail(id, dir);
    expect(d.found).toBe(true);
    expect(d.riskModel).toBe('time');
    expect(d.stopLoss).toBeNull();
    expect(d.takeProfit).toBeNull();
    expect(d.instrument).toBe('gold');
  });

  it('marks the LETF close-flow leg as time-exit too', () => {
    fs.writeFileSync(path.join(dir, 'letf-bot-state.json'), JSON.stringify({
      positions: [],
      trades: [{ instrument: 'silver', side: 'long', entryPrice: 58, exitPrice: 58.2,
        entryTime: '2026-08-03T19:00:00Z', exitTime: '2026-08-03T20:00:00Z', pnlPct: 0.34 }],
    }));
    const id = `letf:silver:${Date.parse('2026-08-03T20:00:00Z')}`;
    const d = readTradeDetail(id, dir);
    expect(d.riskModel).toBe('time');
    expect(d.instrument).toBe('silver');
  });
});
