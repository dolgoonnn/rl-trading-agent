#!/usr/bin/env npx tsx
/**
 * Does a 12-MONTH time-series-momentum gate improve the gold session-hold?
 *
 * WHY THIS TEST, AND WHY IT IS NOT A REPEAT:
 * A daily-EMA trend gate was already tested on this strategy and HURT in both
 * periods. But that is a ~days horizon. Moskowitz, Ooi & Pedersen (2012, JFE,
 * "Time Series Momentum") document trend predictability across 58 futures
 * markets specifically at the PAST 12-MONTH horizon — "the past 12-month excess
 * return is a positive predictor of future return". Gating a 9-hour session hold
 * on a 12-month signal is horizon-appropriate in a way a daily EMA is not.
 *
 * HYPOTHESIS: the overnight session drift is a risk-premium-like effect that is
 * stronger when gold's 12-month trend is positive, so skipping nights when the
 * 12-month return is negative should raise Sharpe.
 *
 * NULL RESULT IS THE EXPECTED OUTCOME and is equally valuable: it would say the
 * session edge is independent of the macro trend, which is what the flat-basin
 * hour-grid and the failed daily-EMA gate already hint at.
 *
 * Lookbacks are swept so the finding is a plateau or nothing — a single winning
 * lookback among many is overfitting, not a signal.
 *
 * Usage:
 *   npx tsx scripts/research-session-tsmom-gate.ts                       # holdout 2015-19
 *   npx tsx scripts/research-session-tsmom-gate.ts --data data/XAUUSD_1m.json
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from '../src/types/candle';
import { extractTrades } from './backtest-gold-session';

const FRICTION_PER_SIDE = 0.00005;
const DAY = 86_400_000;
/** Trend lookbacks in calendar days — 12m is the MOP horizon; others bracket it. */
const LOOKBACKS = [63, 126, 252, 378];

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function sharpeAnnual(xs: number[]): number {
  const s = std(xs);
  return s === 0 ? 0 : (mean(xs) / s) * Math.sqrt(252);
}
function maxDD(xs: number[]): number {
  let eq = 1, pk = 1, w = 0;
  for (const r of xs) { eq *= 1 + r; pk = Math.max(pk, eq); w = Math.max(w, (pk - eq) / pk); }
  return w;
}

function main(): void {
  const ai = process.argv.indexOf('--data');
  const dataPath = ai !== -1 && process.argv[ai + 1]
    ? path.resolve(process.argv[ai + 1]!)
    : path.resolve('data/XAUUSD_1m_holdout.json');

  console.log(`Loading ${path.basename(dataPath)} ...`);
  const candles: Candle[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  const idxByTs = new Map<number, number>();
  candles.forEach((c, i) => idxByTs.set(c.timestamp, i));

  // Daily close series for the trend signal (last print of each UTC day).
  const dayClose = new Map<number, number>();
  for (const c of candles) dayClose.set(Math.floor(c.timestamp / DAY), c.close);
  const days = [...dayClose.keys()].sort((a, b) => a - b);
  const dayIdx = new Map<number, number>();
  days.forEach((d, i) => dayIdx.set(d, i));

  /** Trend at time t over `lb` days: sign of the trailing return. Null if insufficient history. */
  function trendUp(t: number, lb: number): boolean | null {
    const d = Math.floor(t / DAY);
    const i = dayIdx.get(d);
    if (i === undefined || i < lb) return null;
    const now = dayClose.get(days[i]!)!;
    const then = dayClose.get(days[i - lb]!)!;
    return now > then;
  }

  const raw = extractTrades(candles, false, 22, 7, 1, 'utc');
  const trades = raw.map((t) => {
    const ei = idxByTs.get(t.entryTs);
    const xi = idxByTs.get(t.exitTs);
    if (ei === undefined || xi === undefined) return null;
    const e = candles[ei]!.open;
    const x = candles[xi]!.open;
    return { ts: t.entryTs, ret: (x - e) / e - 2 * FRICTION_PER_SIDE };
  }).filter((t): t is { ts: number; ret: number } => t !== null);

  console.log(`  ${candles.length.toLocaleString()} bars, ${trades.length} session trades\n`);

  const allRets = trades.map((t) => t.ret);
  const baseTot = (allRets.reduce((eq, r) => eq * (1 + r), 1) - 1) * 100;
  const baseSh = sharpeAnnual(allRets);

  console.log('gate'.padEnd(22) + 'n'.padStart(6) + 'total%'.padStart(9) + 'Sharpe'.padStart(8)
    + 'maxDD%'.padStart(8) + 'win%'.padStart(7) + '   vs base');
  console.log('-'.repeat(78));
  console.log('none (base)'.padEnd(22) + String(allRets.length).padStart(6)
    + baseTot.toFixed(1).padStart(9) + baseSh.toFixed(2).padStart(8)
    + (maxDD(allRets) * 100).toFixed(1).padStart(8)
    + ((allRets.filter((r) => r > 0).length / allRets.length) * 100).toFixed(1).padStart(7));

  for (const lb of LOOKBACKS) {
    for (const mode of ['long-only-uptrend', 'skip-downtrend'] as const) {
      const kept = trades.filter((t) => {
        const up = trendUp(t.ts, lb);
        if (up === null) return mode === 'skip-downtrend'; // no history: base behaviour
        return up;
      });
      const rets = kept.map((t) => t.ret);
      if (rets.length < 30) { console.log(`${lb}d ${mode}`.padEnd(22) + 'insufficient history'.padStart(20)); continue; }
      const tot = (rets.reduce((eq, r) => eq * (1 + r), 1) - 1) * 100;
      const sh = sharpeAnnual(rets);
      console.log(
        `${lb}d ${mode === 'long-only-uptrend' ? 'up-only' : 'skip-dn'}`.padEnd(22)
        + String(rets.length).padStart(6)
        + tot.toFixed(1).padStart(9)
        + sh.toFixed(2).padStart(8)
        + (maxDD(rets) * 100).toFixed(1).padStart(8)
        + ((rets.filter((r) => r > 0).length / rets.length) * 100).toFixed(1).padStart(7)
        + `   ${tot - baseTot >= 0 ? '+' : ''}${(tot - baseTot).toFixed(1)}pp, ${sh - baseSh >= 0 ? '+' : ''}${(sh - baseSh).toFixed(2)} Sh`,
      );
    }
  }
  console.log('\nA gate that only helps at ONE lookback is overfitting. Look for a plateau across lookbacks,');
  console.log('and require it to hold in BOTH the holdout and the selection period.');
}

main();
