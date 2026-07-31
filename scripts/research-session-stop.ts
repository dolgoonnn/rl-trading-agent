#!/usr/bin/env npx tsx
/**
 * Does a disaster STOP help the gold overnight session-hold?
 *
 * MOTIVATION: the live paper book's realized payoff is ~1:2.5 (avg win +0.30%,
 * avg loss −0.77%), which needs a 71.8% win rate just to break even — it is
 * running 73.3%, a 1.6pp cushion. An in-sample sweep over the first 15 live
 * trades suggested a 0.75–1.5% stop would have added +0.5 to +1.3pp. That is
 * 15 trades of evidence; this script asks the same question on YEARS of data,
 * and specifically on the 2015-19 HOLDOUT that validated the base rule.
 *
 * METHOD: reuses `extractTrades` from backtest-gold-session.ts VERBATIM so the
 * entry/exit rule under test is identical to the validated one — the stop is a
 * pure overlay. For each session trade we walk its 1m bars and, if price trades
 * at or below the stop level, exit there instead of at 07:00.
 *
 * FILL REALISM: a bar whose LOW breaches the stop fills AT the stop; a bar that
 * OPENS below it (gap-through) fills at the OPEN — strictly worse, which is what
 * actually happens. Friction is charged per side on both the base and stopped
 * variants, so the comparison is apples-to-apples.
 *
 * Usage:
 *   npx tsx scripts/research-session-stop.ts                       # holdout 2015-19
 *   npx tsx scripts/research-session-stop.ts --data data/XAUUSD_1m.json
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from '../src/types/candle';
import { extractTrades } from './backtest-gold-session';

/** Stop levels to test, as a fraction of entry price. */
const STOPS = [0.005, 0.0075, 0.01, 0.015, 0.02];
/** Deployable friction tier (futures MGC/GC ~0.3-0.5bp per side). */
const FRICTION_PER_SIDE = 0.00005;

interface Result {
  label: string;
  n: number;
  triggered: number;
  totalPct: number;
  sharpe: number;
  maxDDPct: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  worstPct: number;
  perYear: Record<string, number>;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Per-trade returns -> annualised Sharpe on a ~252-session year. */
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
    const dd = (peak - eq) / peak;
    if (dd > worst) worst = dd;
  }
  return worst;
}

/**
 * Net return of one session trade under an optional stop.
 * Returns the simple (not log) net return and whether the stop fired.
 */
function tradeReturn(
  candles: Candle[],
  idxByTs: Map<number, number>,
  entryTs: number,
  exitTs: number,
  stopFrac: number | null,
): { ret: number; stopped: boolean } {
  const ei = idxByTs.get(entryTs);
  const xi = idxByTs.get(exitTs);
  const entry = candles[ei ?? -1];
  const exit = candles[xi ?? -1];
  if (ei === undefined || xi === undefined || !entry || !exit) return { ret: 0, stopped: false };

  const entryPx = entry.open;
  let exitPx = exit.open;
  let stopped = false;

  if (stopFrac !== null) {
    const stopPx = entryPx * (1 - stopFrac);
    for (let i = ei + 1; i <= xi; i++) {
      const c = candles[i]!;
      if (c.open <= stopPx) {
        // Gap-through: the stop is already breached at the open — fill there.
        exitPx = c.open;
        stopped = true;
        break;
      }
      if (c.low <= stopPx) {
        exitPx = stopPx;
        stopped = true;
        break;
      }
    }
  }

  const gross = (exitPx - entryPx) / entryPx;
  return { ret: gross - 2 * FRICTION_PER_SIDE, stopped };
}

function evaluate(
  label: string,
  candles: Candle[],
  idxByTs: Map<number, number>,
  trades: Array<{ entryTs: number; exitTs: number }>,
  stopFrac: number | null,
): Result {
  const rets: number[] = [];
  const perYear: Record<string, number> = {};
  let triggered = 0;

  for (const t of trades) {
    const { ret, stopped } = tradeReturn(candles, idxByTs, t.entryTs, t.exitTs, stopFrac);
    rets.push(ret);
    if (stopped) triggered++;
    const y = String(new Date(t.entryTs).getUTCFullYear());
    perYear[y] = (perYear[y] ?? 0) + ret * 100;
  }

  const wins = rets.filter((r) => r > 0);
  const losses = rets.filter((r) => r <= 0);
  // Compound the per-trade returns for a total.
  const total = rets.reduce((eq, r) => eq * (1 + r), 1) - 1;

  return {
    label,
    n: rets.length,
    triggered,
    totalPct: total * 100,
    sharpe: sharpeAnnual(rets),
    maxDDPct: maxDrawdown(rets) * 100,
    winRate: rets.length ? (wins.length / rets.length) * 100 : 0,
    avgWinPct: mean(wins) * 100,
    avgLossPct: mean(losses) * 100,
    worstPct: rets.length ? Math.min(...rets) * 100 : 0,
    perYear,
  };
}

function main(): void {
  const argIdx = process.argv.indexOf('--data');
  const dataPath = argIdx !== -1 && process.argv[argIdx + 1]
    ? path.resolve(process.argv[argIdx + 1]!)
    : path.resolve('data/XAUUSD_1m_holdout.json');

  console.log(`Loading ${path.basename(dataPath)} ...`);
  const candles: Candle[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  console.log(
    `  ${candles.length.toLocaleString()} bars, `
    + `${new Date(candles[0]!.timestamp).toISOString().slice(0, 10)} -> `
    + `${new Date(candles[candles.length - 1]!.timestamp).toISOString().slice(0, 10)}`,
  );

  const idxByTs = new Map<number, number>();
  candles.forEach((c, i) => idxByTs.set(c.timestamp, i));

  // Same rule as the validated backtest: base variant, UTC clock, delayMin=1
  // (skips the depressed reopen print — the deployable setting).
  const trades = extractTrades(candles, false, 22, 7, 1, 'utc');
  console.log(`  ${trades.length} session trades\n`);

  const results: Result[] = [evaluate('base (no stop)', candles, idxByTs, trades, null)];
  for (const s of STOPS) {
    results.push(evaluate(`stop ${(s * 100).toFixed(2)}%`, candles, idxByTs, trades, s));
  }

  const base = results[0]!;
  console.log(`Friction ${(FRICTION_PER_SIDE * 10000).toFixed(1)}bp/side (futures tier)\n`);
  console.log(
    'variant'.padEnd(16) + 'total%'.padStart(9) + 'Sharpe'.padStart(8) + 'maxDD%'.padStart(8)
    + 'win%'.padStart(7) + 'avgWin'.padStart(8) + 'avgLoss'.padStart(9) + 'worst%'.padStart(8)
    + 'fired'.padStart(7) + '   vs base',
  );
  console.log('-'.repeat(96));
  for (const r of results) {
    const delta = r === base ? '' : `${r.totalPct - base.totalPct >= 0 ? '+' : ''}${(r.totalPct - base.totalPct).toFixed(1)}pp total, ${r.sharpe - base.sharpe >= 0 ? '+' : ''}${(r.sharpe - base.sharpe).toFixed(2)} Sharpe`;
    console.log(
      r.label.padEnd(16)
      + r.totalPct.toFixed(1).padStart(9)
      + r.sharpe.toFixed(2).padStart(8)
      + r.maxDDPct.toFixed(1).padStart(8)
      + r.winRate.toFixed(1).padStart(7)
      + r.avgWinPct.toFixed(3).padStart(8)
      + r.avgLossPct.toFixed(3).padStart(9)
      + r.worstPct.toFixed(2).padStart(8)
      + String(r.triggered).padStart(7)
      + '   ' + delta,
    );
  }

  // Per-year, so a single lucky/unlucky year cannot carry the verdict.
  const years = [...new Set(results.flatMap((r) => Object.keys(r.perYear)))].sort();
  console.log(`\nper-year net % (entry year)\n${'variant'.padEnd(16)}${years.map((y) => y.padStart(9)).join('')}`);
  console.log('-'.repeat(16 + years.length * 9));
  for (const r of results) {
    console.log(r.label.padEnd(16) + years.map((y) => (r.perYear[y] ?? 0).toFixed(1).padStart(9)).join(''));
  }

  const outPath = path.resolve(
    'experiments/runs',
    `session-stop-${path.basename(dataPath, '.json')}.json`,
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ dataPath, frictionPerSide: FRICTION_PER_SIDE, results }, null, 2));
  console.log(`\nwrote ${path.relative(process.cwd(), outPath)}`);
}

main();
