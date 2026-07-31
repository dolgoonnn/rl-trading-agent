#!/usr/bin/env npx tsx
/**
 * Does a TRAILING stop improve the gold overnight session-hold?
 *
 * WHY THIS IS A SEPARATE QUESTION from the fixed-stop and exit-hour tests:
 *   - a FIXED stop measures distance from ENTRY (pure risk cap);
 *   - extending the EXIT HOUR changes every trade symmetrically;
 *   - a TRAILING stop measures distance from the running HIGH-WATER MARK, so it
 *     is the canonical "let winners run, cut the reversal" mechanism, and it acts
 *     INSIDE the 22:00-07:00 window rather than after it.
 * The earlier continuation test measured post-exit reversal; it says nothing about
 * whether the intra-window path trends or chops. This does.
 *
 * TWO VARIANTS:
 *   trail-X      — trail X% below the high-water mark for the whole hold.
 *   armed-A/X    — hold normally until the trade is +A% in profit, THEN start
 *                  trailing X% below the HWM. This is the actual "protect the
 *                  runner, don't touch the loser" configuration traders mean.
 *
 * FILL REALISM: a bar whose LOW breaches the trail level fills AT the level; a bar
 * that OPENS below it (gap-through) fills at the OPEN — strictly worse. Friction is
 * charged per side on every variant so the comparison is apples-to-apples.
 *
 * Usage:
 *   npx tsx scripts/research-session-trailing.ts                       # holdout 2015-19
 *   npx tsx scripts/research-session-trailing.ts --data data/XAUUSD_1m.json
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from '../src/types/candle';
import { extractTrades } from './backtest-gold-session';

const FRICTION_PER_SIDE = 0.00005;

/** Pure trailing distances (fraction of the high-water mark). */
const TRAILS = [0.0025, 0.005, 0.0075, 0.01, 0.015];
/** [armAtProfit, trailDistance] — trail only engages once the trade is up armAt. */
const ARMED: Array<[number, number]> = [
  [0.0025, 0.0025],
  [0.005, 0.0025],
  [0.005, 0.005],
  [0.0075, 0.005],
  [0.01, 0.005],
  [0.01, 0.0075],
];

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

function sharpeAnnual(rets: number[]): number {
  const s = std(rets);
  return s === 0 ? 0 : (mean(rets) / s) * Math.sqrt(252);
}

function maxDrawdown(rets: number[]): number {
  let eq = 1;
  let peak = 1;
  let worst = 0;
  for (const r of rets) {
    eq *= 1 + r;
    if (eq > peak) peak = eq;
    worst = Math.max(worst, (peak - eq) / peak);
  }
  return worst;
}

interface Cfg { label: string; trail: number | null; armAt: number | null }

/** Net return of one long session trade under an optional (possibly armed) trail. */
function tradeReturn(
  candles: Candle[],
  ei: number,
  xi: number,
  cfg: Cfg,
): { ret: number; fired: boolean } {
  const entryPx = candles[ei]!.open;
  let exitPx = candles[xi]!.open;
  let fired = false;

  if (cfg.trail !== null) {
    let hwm = entryPx;
    let armed = cfg.armAt === null; // no arm threshold => armed from the start
    for (let i = ei + 1; i <= xi; i++) {
      const c = candles[i]!;
      if (c.high > hwm) hwm = c.high;
      if (!armed && cfg.armAt !== null && (hwm - entryPx) / entryPx >= cfg.armAt) armed = true;
      if (!armed) continue;
      const level = hwm * (1 - cfg.trail);
      if (c.open <= level) { exitPx = c.open; fired = true; break; }   // gap-through
      if (c.low <= level) { exitPx = level; fired = true; break; }
    }
  }

  return { ret: (exitPx - entryPx) / entryPx - 2 * FRICTION_PER_SIDE, fired };
}

function main(): void {
  const argIdx = process.argv.indexOf('--data');
  const dataPath = argIdx !== -1 && process.argv[argIdx + 1]
    ? path.resolve(process.argv[argIdx + 1]!)
    : path.resolve('data/XAUUSD_1m_holdout.json');

  console.log(`Loading ${path.basename(dataPath)} ...`);
  const candles: Candle[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  const idxByTs = new Map<number, number>();
  candles.forEach((c, i) => idxByTs.set(c.timestamp, i));

  const trades = extractTrades(candles, false, 22, 7, 1, 'utc')
    .map((t) => ({ ei: idxByTs.get(t.entryTs), xi: idxByTs.get(t.exitTs) }))
    .filter((t): t is { ei: number; xi: number } => t.ei !== undefined && t.xi !== undefined);
  console.log(`  ${candles.length.toLocaleString()} bars, ${trades.length} session trades\n`);

  const cfgs: Cfg[] = [
    { label: 'base (07:00 only)', trail: null, armAt: null },
    ...TRAILS.map((t) => ({ label: `trail ${(t * 100).toFixed(2)}%`, trail: t, armAt: null })),
    ...ARMED.map(([a, t]) => ({
      label: `armed +${(a * 100).toFixed(2)}/tr${(t * 100).toFixed(2)}`,
      trail: t,
      armAt: a,
    })),
  ];

  console.log(`Friction ${(FRICTION_PER_SIDE * 10000).toFixed(1)}bp/side (futures tier)\n`);
  console.log(
    'variant'.padEnd(22) + 'total%'.padStart(9) + 'Sharpe'.padStart(8) + 'maxDD%'.padStart(8)
    + 'win%'.padStart(7) + 'avgWin'.padStart(8) + 'avgLoss'.padStart(9) + 'fired'.padStart(7)
    + '   vs base',
  );
  console.log('-'.repeat(100));

  let baseTot = 0;
  let baseSh = 0;
  for (const cfg of cfgs) {
    const rets: number[] = [];
    let fired = 0;
    for (const t of trades) {
      const r = tradeReturn(candles, t.ei, t.xi, cfg);
      rets.push(r.ret);
      if (r.fired) fired++;
    }
    const tot = (rets.reduce((eq, r) => eq * (1 + r), 1) - 1) * 100;
    const sh = sharpeAnnual(rets);
    const w = rets.filter((r) => r > 0);
    const l = rets.filter((r) => r <= 0);
    if (cfg.trail === null) { baseTot = tot; baseSh = sh; }
    const delta = cfg.trail === null
      ? ''
      : `${tot - baseTot >= 0 ? '+' : ''}${(tot - baseTot).toFixed(1)}pp, ${sh - baseSh >= 0 ? '+' : ''}${(sh - baseSh).toFixed(2)} Sh`;
    console.log(
      cfg.label.padEnd(22)
      + tot.toFixed(1).padStart(9)
      + sh.toFixed(2).padStart(8)
      + (maxDrawdown(rets) * 100).toFixed(1).padStart(8)
      + ((w.length / rets.length) * 100).toFixed(1).padStart(7)
      + (mean(w) * 100).toFixed(3).padStart(8)
      + (mean(l) * 100).toFixed(3).padStart(9)
      + String(fired).padStart(7)
      + '   ' + delta,
    );
  }
  console.log('\nNOTE: avgWin RISING while total/Sharpe FALL means the trail is cutting winners short,');
  console.log('      not letting them run — the surviving winners are just the ones it did not touch.');
}

main();
