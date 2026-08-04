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

describe('priceMove — native units per instrument', () => {
  it('reads FX in pips', () => {
    // EUR/USD 1.1400 -> 1.1361 short = +39 pips in the trade's favour
    const m = priceMove('eurusd', 'short', 1.14, 1.1361);
    expect(m?.unit).toBe('pips');
    expect(m?.value).toBeCloseTo(39, 0);
  });

  it('reads gold and silver futures in points', () => {
    const gold = priceMove('gold', 'short', 4040, 4026.7);
    expect(gold?.unit).toBe('pts');
    expect(gold?.value).toBeCloseTo(13.3, 1);

    const silver = priceMove('silver', 'long', 58, 58.348);
    expect(silver?.unit).toBe('pts');
    expect(silver?.value).toBeCloseTo(0.348, 3);
  });

  it('reads the index in points', () => {
    const m = priceMove('us500', 'long', 7449.5, 7460.25);
    expect(m?.unit).toBe('pts');
    expect(m?.value).toBeCloseTo(10.75, 2);
  });

  it('signs the move by direction — a short profits when price falls', () => {
    expect(priceMove('gold', 'short', 4040, 4050)?.value).toBeCloseTo(-10, 1);
    expect(priceMove('gold', 'long', 4040, 4050)?.value).toBeCloseTo(10, 1);
  });

  it('returns null when the instrument or prices are unknown', () => {
    expect(priceMove(null, 'long', 100, 101)).toBeNull();
    expect(priceMove('gold', 'long', null, 101)).toBeNull();
    expect(priceMove('dogecoin', 'long', 1, 2)).toBeNull();
  });
});
