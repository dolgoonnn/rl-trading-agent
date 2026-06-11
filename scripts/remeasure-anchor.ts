#!/usr/bin/env tsx
/**
 * DST anchor-bug re-measure (execution-audit gating item):
 * old anchor = 22:01 UTC (sits on CME maintenance break in winter) vs
 * new anchor = 18:05 ET DST-aware (CME reopen +5min, always tradeable).
 * Gold + silver, wknd-gap variant, 0.5bp/1bp per side, halves + per-year.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';
import { extractTrades, type Trade } from './backtest-gold-session';

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function sharpe(xs: number[]): number { const s = std(xs); return s > 0 ? (mean(xs) / s) * Math.sqrt(252) : 0; }
function fmt(x: number, dp = 2): number { const f = 10 ** dp; return Math.round(x * f) / f; }

function report(label: string, trades: Trade[], friction: number): void {
  const rets = trades.map((t) => t.rawLogRet - 2 * friction);
  const split = Date.UTC(2020, 0, 1);
  const h1 = trades.filter((t) => t.entryTs < split).reduce((s, t) => s + t.rawLogRet - 2 * friction, 0);
  const h2 = trades.filter((t) => t.entryTs >= split).reduce((s, t) => s + t.rawLogRet - 2 * friction, 0);
  const perYear = new Map<string, number>();
  for (const t of trades) {
    const y = new Date(t.entryTs).toISOString().slice(0, 4);
    perYear.set(y, (perYear.get(y) ?? 0) + t.rawLogRet - 2 * friction);
  }
  const yearsPos = [...perYear.values()].filter((v) => v > 0).length;
  console.log(
    `  ${label} | n=${rets.length} total=${fmt(rets.reduce((s, x) => s + x, 0) * 100, 1)}% ` +
    `sharpe=${fmt(sharpe(rets))} halves=${fmt(h1 * 100, 1)}/${fmt(h2 * 100, 1)} years+=${yearsPos}/${perYear.size}`,
  );
}

async function main(): Promise<void> {
  for (const metal of ['XAUUSD', 'XAGUSD']) {
    let candles: Candle[] = [];
    for (const sfx of ['_1m_holdout.json', '_1m.json']) {
      candles = candles.concat(JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', `${metal}${sfx}`), 'utf-8')) as Candle[]);
    }
    candles.sort((a, b) => a.timestamp - b.timestamp);
    const friction = metal === 'XAUUSD' ? 0.00005 : 0.0001;

    console.log(`\n=== ${metal} (wknd-gap, ${(friction * 10000).toFixed(1)}bp/side) ===`);
    report('OLD 22:01 UTC   ', extractTrades(candles, true, 22, 7, 1), friction);
    report('NEW 18:05 ET DST', extractTrades(candles, true, 18, 7, 5, 'ny'), friction);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
