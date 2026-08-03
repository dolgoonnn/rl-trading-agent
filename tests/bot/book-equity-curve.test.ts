/**
 * The equity chart must plot the BOOK, not one sleeve.
 *
 * BUG THIS FIXES: the chart was fed `equityCurve.crypto` — the crypto sleeve's
 * equity snapshots. Crypto had zero closed trades, so the series sat flat at its
 * $10,000 notional while the book was down 3.3% entirely from metals. The
 * headline said "−3.28%" and the chart directly beneath it said "nothing
 * happened". A chart that contradicts the headline is worse than no chart.
 *
 * Snapshots only exist for crypto, so the book curve is reconstructed from the
 * closed trades of ALL sleeves: each sleeve runs its own equal notional, so the
 * book is the sum of the three sleeve equities through time.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readBookEquityCurve, readAllSleeves, SLEEVE_STARTING_EQUITY } from '../../src/lib/bot/sleeve-readers';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookeq-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** Sleeve count is derived, not fixed — sleeves get added over time. */
function bookStart(d: string): number { return SLEEVE_STARTING_EQUITY * readAllSleeves(d).length; }
function sleeves(d: string): number { return readAllSleeves(d).length; }

function seedMetals(trades: Array<{ pnlPct: number; exit: string }>): void {
  fs.writeFileSync(path.join(dir, 'metals-bot-state.json'), JSON.stringify({
    positions: [],
    trades: trades.map((t) => ({
      leg: 'overnight', metal: 'gold', side: 'long',
      entryTime: t.exit, exitTime: t.exit, pnlPct: t.pnlPct,
    })),
  }));
}

describe('readBookEquityCurve', () => {
  it('starts at the combined notional and moves with metals trades', () => {
    // metals state stores PERCENT; -1% then +0.5%
    seedMetals([
      { pnlPct: -1, exit: '2026-07-28T07:00:00Z' },
      { pnlPct: 0.5, exit: '2026-07-29T07:00:00Z' },
    ]);
    const pts = readBookEquityCurve(dir);
    expect(pts).toHaveLength(2);
    expect(pts[0]?.equity).toBeCloseTo(bookStart(dir) * (1 - 0.01 / sleeves(dir)), 2);
    expect(pts[1]?.equity).toBeCloseTo(bookStart(dir) * (1 + (-0.01 + 0.005) / sleeves(dir)), 2);
  });

  it('is chronological even when sleeves are read out of order', () => {
    const db = new Database(path.join(dir, 'ict-trading.db'));
    db.exec(`
      CREATE TABLE bot_trades (id TEXT PRIMARY KEY, exit_timestamp INTEGER, pnl_percent REAL);
      INSERT INTO bot_trades VALUES ('c1', ${Date.parse('2026-07-30T00:00:00Z')}, 0.02);
    `);
    db.close();
    seedMetals([{ pnlPct: -1, exit: '2026-07-28T07:00:00Z' }]);
    const pts = readBookEquityCurve(dir);
    expect(pts).toHaveLength(2);
    expect(pts[0]!.timestamp).toBeLessThan(pts[1]!.timestamp);
  });

  it('tracks drawdown from the running peak', () => {
    seedMetals([
      { pnlPct: 3, exit: '2026-07-28T07:00:00Z' },   // peak
      { pnlPct: -3, exit: '2026-07-29T07:00:00Z' },  // give it back
    ]);
    const pts = readBookEquityCurve(dir);
    expect(pts[0]?.drawdown).toBe(0);
    expect(pts[1]?.drawdown).toBeGreaterThan(0);
  });

  it('excludes downtime-stranded trades — drift is not strategy equity', () => {
    fs.writeFileSync(path.join(dir, 'metals-bot-state.json'), JSON.stringify({
      positions: [],
      trades: [
        { leg: 'overnight', metal: 'gold', entryTime: '2026-07-28T22:00:00Z', exitTime: '2026-07-29T07:00:00Z', pnlPct: -5, stale: true },
        { leg: 'fix-short', metal: 'gold', entryTime: '2026-07-29T13:00:00Z', exitTime: '2026-07-29T14:00:00Z', pnlPct: 1 },
      ],
    }));
    const pts = readBookEquityCurve(dir);
    expect(pts).toHaveLength(1); // the stale one is skipped entirely
    expect(pts[0]?.equity).toBeCloseTo(bookStart(dir) * (1 + 0.01 / sleeves(dir)), 2);
  });

  it('returns an empty series on a fresh volume', () => {
    expect(readBookEquityCurve(dir)).toEqual([]);
  });
});
