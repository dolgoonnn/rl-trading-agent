/**
 * A trade row must say WHICH instrument, and how far price actually moved.
 *
 * TWO GAPS THIS CLOSES:
 *  1. The gold and silver `overnight` legs close on the same timestamp with the
 *     same leg name, so the table rendered two indistinguishable rows. You could
 *     not tell which metal produced which result.
 *  2. Percent alone does not describe a move. FX is read in pips, futures in
 *     points — and with `PNL (USDT)` empty for session legs, the row carried no
 *     absolute magnitude at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readRecentTrades } from '../../src/lib/bot/sleeve-readers';
import { priceMove } from '../../src/lib/bot/trade-analytics';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'move-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function seed(trades: Array<Record<string, unknown>>): void {
  fs.writeFileSync(path.join(dir, 'metals-bot-state.json'), JSON.stringify({ positions: [], trades }));
}

describe('instrument on the trade row', () => {
  it('distinguishes the gold and silver legs that close together', () => {
    const exitTime = '2026-08-04T15:01:29Z';
    seed([
      { leg: 'overnight', metal: 'gold', side: 'long', entryPrice: 4000, exitPrice: 4003.6, entryTime: '2026-08-03T22:00:00Z', exitTime, pnlPct: 0.09 },
      { leg: 'overnight', metal: 'silver', side: 'long', entryPrice: 58, exitPrice: 58.348, entryTime: '2026-08-03T22:00:00Z', exitTime, pnlPct: 0.6 },
    ]);
    const rows = readRecentTrades(10, dir);
    const instruments = rows.map((r) => r.instrument).sort();
    expect(instruments).toEqual(['gold', 'silver']);
    // Same leg, same exit — only the instrument tells them apart.
    expect(new Set(rows.map((r) => r.symbol)).size).toBe(1);
  });

  it('carries entry and exit prices so the move can be shown', () => {
    seed([{ leg: 'fix-short', metal: 'gold', side: 'short', entryPrice: 4040, exitPrice: 4026.7, entryTime: '2026-08-04T14:00:00Z', exitTime: '2026-08-04T15:00:00Z', pnlPct: 0.33 }]);
    const r = readRecentTrades(10, dir)[0]!;
    expect(r.entryPrice).toBe(4040);
    expect(r.exitPrice).toBe(4026.7);
  });
});

describe('priceMove — pips, every instrument', () => {
  // These positions are leveraged, so the trader-facing unit is the pip on every
  // market — not points on some and pips on others. Sizes follow the standard
  // retail-broker quote convention per instrument.
  it('reads FX in pips', () => {
    // EUR/USD 1.1400 -> 1.1361 short = +39 pips in the trade's favour
    const m = priceMove('eurusd', 'short', 1.14, 1.1361);
    expect(m?.unit).toBe('pips');
    expect(m?.pipSize).toBe(0.0001);
    expect(m?.value).toBeCloseTo(39, 0);
  });

  // The pip is the second-to-last digit of the quote — the FX rule, applied to
  // every market. A $13 gold move is 133 pips, NOT 1,330: a size that puts a
  // routine day in the thousands is a decimal place too fine.
  it('reads gold in pips of $0.10', () => {
    const gold = priceMove('gold', 'short', 4040, 4026.7);
    expect(gold?.unit).toBe('pips');
    expect(gold?.pipSize).toBe(0.1);
    expect(gold?.value).toBeCloseTo(133, 0);
  });

  it('reads silver in pips of $0.01', () => {
    const silver = priceMove('silver', 'long', 58, 58.348);
    expect(silver?.pipSize).toBe(0.01);
    expect(silver?.value).toBeCloseTo(34.8, 1);
  });

  it('reads the index in pips of one point', () => {
    const m = priceMove('us500', 'long', 7449.5, 7460.25);
    expect(m?.pipSize).toBe(1);
    expect(m?.value).toBeCloseTo(10.75, 2);
  });

  // Guard the scale itself: a 0.1% move must land in the tens of pips on every
  // instrument. This is what catches a pip size that is off by a decimal.
  it('keeps a 0.1% move in the same order of magnitude across the book', () => {
    const cases: Array<[string, number]> = [
      ['eurusd', 1.14], ['gold', 4055], ['silver', 58],
      ['us500', 7443], ['btcusdt', 61000], ['ethusdt', 3000], ['solusdt', 150],
    ];
    for (const [instrument, price] of cases) {
      const m = priceMove(instrument, 'long', price, price * 1.001);
      expect(m, instrument).not.toBeNull();
      expect(m!.value, instrument).toBeGreaterThan(1);
      expect(m!.value, instrument).toBeLessThan(100);
    }
  });

  it('reads crypto perps in pips too', () => {
    expect(priceMove('btcusdt', 'long', 61000, 61350)?.value).toBeCloseTo(350, 0);
    expect(priceMove('ethusdt', 'short', 3000, 2985)?.value).toBeCloseTo(150, 0);
    expect(priceMove('solusdt', 'long', 150, 151.2)?.value).toBeCloseTo(120, 0);
  });

  it('signs the move by direction — a short profits when price falls', () => {
    expect(priceMove('gold', 'short', 4040, 4050)?.value).toBeCloseTo(-100, 0);
    expect(priceMove('gold', 'long', 4040, 4050)?.value).toBeCloseTo(100, 0);
  });

  it('returns null when the instrument or prices are unknown', () => {
    expect(priceMove(null, 'long', 100, 101)).toBeNull();
    expect(priceMove('gold', 'long', null, 101)).toBeNull();
    expect(priceMove('dogeusdt', 'long', 1, 2)).toBeNull();
  });
});

describe('crypto rows carry an instrument too', () => {
  it('derives it from the symbol so the Move column is not blank', () => {
    // The list and the detail view must agree. readTradeDetail derived the
    // instrument while readRecentTrades hardcoded null, so crypto trades were
    // present in the table but rendered with no badge and no Move — they read
    // as broken rows beside session legs that all showed pips.
    const db = new Database(path.join(dir, 'ict-trading.db'));
    db.exec(`CREATE TABLE bot_trades (id TEXT PRIMARY KEY, symbol TEXT, direction TEXT,
      entry_price REAL, exit_price REAL, entry_timestamp INTEGER, exit_timestamp INTEGER,
      pnl_percent REAL, pnl_usdt REAL, exit_reason TEXT)`);
    db.prepare('INSERT INTO bot_trades VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      'c1', 'ETHUSDT', 'short', 1864.81, 1901.88, 1, 2, -0.0199, -1.09, 'max_bars',
    );
    db.close();
    const row = readRecentTrades(10, dir).find((r) => r.sleeve === 'crypto')!;
    expect(row.instrument).toBe('ethusdt');
    const m = priceMove(row.instrument, row.direction, row.entryPrice, row.exitPrice);
    expect(m).not.toBeNull();
    expect(m!.unit).toBe('pips');
    // Short that moved against it: negative.
    expect(m!.value).toBeLessThan(0);
  });
});
