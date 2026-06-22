#!/usr/bin/env tsx
/**
 * Execution-timing robustness for the metals overnight hold.
 *
 * The backtest enters at the open of the first bar ≥22:00 UTC and exits at the
 * first bar ≥07:00. Real execution slips: late entries, late exits, missed
 * minutes at the reopen. If the edge dies with a few minutes of jitter, it is
 * microstructure noise, not a tradeable seasonal.
 *
 * Tests entry delay k ∈ {0,1,2,5,10,15,30,60} minutes (exit delayed equally),
 * gold + silver, 2015–2026, base window (no weekend leg), 0.5bp/side.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';

const DELAYS = [0, 1, 2, 5, 10, 15, 30, 60];

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function sharpe(xs: number[]): number { const s = std(xs); return s > 0 ? (mean(xs) / s) * Math.sqrt(252) : 0; }
function fmt(x: number, dp = 2): number { const f = 10 ** dp; return Math.round(x * f) / f; }

/** Minute-resolution session extraction: enter ≥(22:00+k), exit ≥(07:00+k), ≥5h hold. */
function trades(candles: Candle[], delayMin: number): number[] {
  const entryMark = 22 * 60 + delayMin;
  const exitMark = 7 * 60 + delayMin;
  const out: number[] = [];
  let entryOpen = -1;
  let entryTs = -1;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    const d = new Date(c.timestamp);
    const lm = d.getUTCHours() * 60 + d.getUTCMinutes();

    if (entryOpen > 0) {
      const inExit = lm >= exitMark && lm < 20 * 60;
      if (c.timestamp - prev.timestamp > 12 * 3_600_000) {
        out.push(Math.log(prev.open / entryOpen) - 2 * 0.00005);
        entryOpen = -1;
      } else if (inExit && c.timestamp - entryTs >= 5 * 3_600_000) {
        out.push(Math.log(c.open / entryOpen) - 2 * 0.00005);
        entryOpen = -1;
      } else if (c.timestamp - entryTs > 4 * 24 * 3_600_000) {
        out.push(Math.log(c.open / entryOpen) - 2 * 0.00005);
        entryOpen = -1;
      }
    }

    if (entryOpen < 0 && lm >= entryMark) {
      entryOpen = c.open;
      entryTs = c.timestamp;
    }
  }
  return out;
}

async function main(): Promise<void> {
  for (const metal of ['XAUUSD', 'XAGUSD']) {
    let candles: Candle[] = [];
    for (const suffix of ['_1m_holdout.json', '_1m.json']) {
      const p = path.resolve(__dirname, '..', 'data', `${metal}${suffix}`);
      candles = candles.concat(JSON.parse(fs.readFileSync(p, 'utf-8')) as Candle[]);
    }
    candles.sort((a, b) => a.timestamp - b.timestamp);

    console.log(`\n=== ${metal} entry/exit jitter (0.5bp/side, 2015–2026) ===`);
    console.log('  delay | n | total% | sharpe');
    for (const k of DELAYS) {
      const rets = trades(candles, k);
      console.log(
        `  ${String(k).padStart(4)}m | ${rets.length} | ${String(fmt(rets.reduce((s, x) => s + x, 0) * 100, 1)).padStart(7)} | ${fmt(sharpe(rets))}`,
      );
    }
  }
}

main().catch((err) => { console.error('Jitter test failed:', err); process.exit(1); });
