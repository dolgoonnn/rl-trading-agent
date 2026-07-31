#!/usr/bin/env npx tsx
/**
 * Can the gold overnight session-hold "let winners run"?
 *
 * THE QUESTION: uniformly extending the 07:00 exit hurt (Sharpe 1.12 -> 0.78 on
 * the 2015-19 holdout) because losses grew faster than wins. But that tested a
 * SYMMETRIC change. "Letting winners run" is ASYMMETRIC — keep the runners, cut
 * the reversals. Whether that can work depends entirely on one property of the
 * data, and the literature is explicit about it:
 *
 *   Kaminski & Lo (2014, J. Financial Markets) — "When Do Stop-Loss Rules Stop
 *   Losses?": under a random walk, stop rules ALWAYS reduce expected return; they
 *   add value only under MOMENTUM, and destroy value under MEAN REVERSION.
 *
 *   Liu, Liu, Wang, Zhou & Zhu — "Overnight-Intraday Reversal Everywhere":
 *   documents a cross-period REVERSAL — high overnight returns are followed by
 *   LOW intraday returns, robust across asset classes including commodities.
 *
 * So: if a big overnight gain CONTINUES into the morning, asymmetric exits
 * (trailing stops, runners) are worth building. If it REVERSES, then every
 * "let winners run" variant is structurally doomed here and 07:00 is right.
 *
 * METHOD: reuse `extractTrades` verbatim (same rule as validated), bucket the
 * completed overnight trades by their own return quintile, then measure the
 * FORWARD return over the following 1h / 2h / 4h. A monotone negative gradient
 * across quintiles = reversal. Positive = momentum.
 *
 * Usage:
 *   npx tsx scripts/research-session-continuation.ts                      # holdout 2015-19
 *   npx tsx scripts/research-session-continuation.ts --data data/XAUUSD_1m.json
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from '../src/types/candle';
import { extractTrades } from './backtest-gold-session';

const H = 3_600_000;
const FORWARD_HOURS = [1, 2, 4];

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Pearson correlation. */
function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

/** Two-sided t-stat for a mean being different from zero. */
function tStat(xs: number[]): number {
  const s = std(xs);
  return s === 0 || xs.length < 2 ? 0 : mean(xs) / (s / Math.sqrt(xs.length));
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

  // Index by timestamp, and keep a sorted array for forward lookups.
  const idxByTs = new Map<number, number>();
  candles.forEach((c, i) => idxByTs.set(c.timestamp, i));

  /** Last close at or before t (no look-ahead past t). */
  function priceAt(fromIdx: number, t: number): number | null {
    let best: number | null = null;
    for (let i = fromIdx; i < candles.length; i++) {
      const c = candles[i]!;
      if (c.timestamp > t) break;
      best = c.open;
    }
    return best;
  }

  const trades = extractTrades(candles, false, 22, 7, 1, 'utc');
  console.log(`  ${trades.length} session trades\n`);

  interface Row { overnight: number; fwd: Record<number, number> }
  const rows: Row[] = [];

  for (const t of trades) {
    const ei = idxByTs.get(t.entryTs);
    const xi = idxByTs.get(t.exitTs);
    if (ei === undefined || xi === undefined) continue;
    const entryPx = candles[ei]!.open;
    const exitPx = candles[xi]!.open;
    const overnight = (exitPx - entryPx) / entryPx * 100;

    const fwd: Record<number, number> = {};
    let ok = true;
    for (const h of FORWARD_HOURS) {
      const p = priceAt(xi, t.exitTs + h * H);
      if (p === null) { ok = false; break; }
      fwd[h] = (p - exitPx) / exitPx * 100;
    }
    if (ok) rows.push({ overnight, fwd });
  }

  console.log(`usable trades with forward data: ${rows.length}\n`);

  // Quintiles of the overnight return.
  const sorted = [...rows].sort((a, b) => a.overnight - b.overnight);
  const q = 5;
  const size = Math.floor(sorted.length / q);

  console.log('Forward return AFTER the 07:00 exit, by overnight-return quintile');
  console.log('(if winners CONTINUE, Q5 forward should be positive; if they REVERSE, negative)\n');
  console.log(
    'quintile'.padEnd(10) + 'n'.padStart(5) + 'overnight%'.padStart(12)
    + FORWARD_HOURS.map((h) => `+${h}h%`.padStart(9)).join(''),
  );
  console.log('-'.repeat(10 + 5 + 12 + FORWARD_HOURS.length * 9));

  for (let k = 0; k < q; k++) {
    const slice = k === q - 1 ? sorted.slice(k * size) : sorted.slice(k * size, (k + 1) * size);
    const label = `Q${k + 1}${k === 0 ? ' (worst)' : k === q - 1 ? ' (best)' : ''}`;
    console.log(
      label.padEnd(10)
      + String(slice.length).padStart(5)
      + mean(slice.map((r) => r.overnight)).toFixed(3).padStart(12)
      + FORWARD_HOURS.map((h) => mean(slice.map((r) => r.fwd[h] ?? 0)).toFixed(3).padStart(9)).join(''),
    );
  }

  console.log('\nCorrelation(overnight return, forward return) — negative = reversal:');
  for (const h of FORWARD_HOURS) {
    const a = rows.map((r) => r.overnight);
    const b = rows.map((r) => r.fwd[h] ?? 0);
    const c = corr(a, b);
    console.log(`  +${h}h : rho = ${c >= 0 ? '+' : ''}${c.toFixed(4)}   ${c < -0.02 ? '<- REVERSAL' : c > 0.02 ? '<- momentum' : '(no signal)'}`);
  }

  // Winners only: does a profitable overnight keep going?
  const winners = rows.filter((r) => r.overnight > 0);
  console.log(`\nWINNERS ONLY (overnight > 0, n=${winners.length}) — the "let it run" case:`);
  for (const h of FORWARD_HOURS) {
    const f = winners.map((r) => r.fwd[h] ?? 0);
    console.log(
      `  +${h}h : mean ${mean(f) >= 0 ? '+' : ''}${mean(f).toFixed(4)}%   t=${tStat(f).toFixed(2)}   `
      + `${mean(f) < 0 ? 'gives back' : 'continues'}`,
    );
  }

  const outPath = path.resolve('experiments/runs', `session-continuation-${path.basename(dataPath, '.json')}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    dataPath,
    n: rows.length,
    corr: Object.fromEntries(FORWARD_HOURS.map((h) => [h, corr(rows.map((r) => r.overnight), rows.map((r) => r.fwd[h] ?? 0))])),
    winnersForward: Object.fromEntries(FORWARD_HOURS.map((h) => [h, mean(winners.map((r) => r.fwd[h] ?? 0))])),
  }, null, 2));
  console.log(`\nwrote ${path.relative(process.cwd(), outPath)}`);
}

main();
