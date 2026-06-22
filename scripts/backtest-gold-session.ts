#!/usr/bin/env tsx
/**
 * Gold overnight session-hold backtest — "long 22:00 → 07:00 UTC".
 *
 * Tests the time-of-day seasonal found in experiments/gold-1m-research.md:
 * the 22-07 UTC window carried ~all of gold's intraday return 2020-2026 while
 * the US session was a net drag. Parameter-free by design (no optimizer).
 *
 * Variants:
 *   base      — long first bar >=22:00 UTC, exit first bar >=07:00 UTC (Sun-Thu nights)
 *   weekend   — base + hold Friday close → Monday 07:00 (captures weekend gap)
 *   bias      — base, but only when daily EMA(lambda=0.95) slope is up (no look-ahead)
 *   bias-wknd — bias + weekend hold
 *
 * For each variant × friction {0, 0.5, 1, 2 bps/side}:
 *   total return (sum of per-trade log returns), Sharpe (per-day, sqrt(252)),
 *   MaxDD, WR, per-year table, split-half check, rolling 3-month pass rate,
 *   MC bootstrap (1000x) 5th pct Sharpe/PnL — vs buy-and-hold benchmark.
 *
 * Entries/exits use bar OPEN prices (executable: the time rule is known in advance).
 *
 * Usage: npx tsx scripts/backtest-gold-session.ts [--json]
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';

const DATA_PATH = path.resolve(__dirname, '..', 'data', 'XAUUSD_1m.json');
const OUT_PATH = path.resolve(__dirname, '..', 'experiments', 'runs', 'gold-session-results.json');

function nthSundayUTCBGS(year: number, month: number, n: number): number {
  if (n > 0) {
    const dow = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return Date.UTC(year, month, 1 + ((7 - dow) % 7) + (n - 1) * 7);
  }
  const last = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay());
}
/** NY UTC-offset hours (DST-aware) — for CME-session-anchored entries */
function nyOffsetHoursBGS(ts: number): number {
  const y = new Date(ts).getUTCFullYear();
  const start = nthSundayUTCBGS(y, 2, 2) + 7 * 3_600_000;
  const end = nthSundayUTCBGS(y, 10, 1) + 6 * 3_600_000;
  return ts >= start && ts < end ? -4 : -5;
}

const ENTRY_HOUR = 22;
const EXIT_HOUR = 7;
const FRICTIONS = [0, 0.00005, 0.0001, 0.0002];
// 'bias' (daily EMA gate) was tested and dropped: it hurt in both the selection
// period and the 2015-19 holdout. 'wknd-gap' adds a Friday 20:00 → Monday 07:00
// leg to capture the weekend-gap drift.
const VARIANTS = ['base', 'wknd-gap'] as const;
type Variant = typeof VARIANTS[number];

export interface Trade {
  entryTs: number;
  exitTs: number;
  rawLogRet: number; // friction-free log return long entry→exit
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

function sharpeDaily(rets: number[]): number {
  const s = std(rets);
  return s > 0 ? (mean(rets) / s) * Math.sqrt(252) : 0;
}

function maxDrawdown(rets: number[]): number {
  let equity = 0;
  let peak = 0;
  let maxDD = 0;
  for (const r of rets) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

/** Deterministic LCG so bootstrap is reproducible without Math.random */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function bootstrap(rets: number[], iters = 1000): { sharpe5: number; pnl5: number } {
  const rand = lcg(42);
  const sharpes: number[] = [];
  const pnls: number[] = [];
  for (let it = 0; it < iters; it++) {
    const sample: number[] = [];
    for (let i = 0; i < rets.length; i++) {
      sample.push(rets[Math.floor(rand() * rets.length)]!);
    }
    sharpes.push(sharpeDaily(sample));
    pnls.push(sample.reduce((s, x) => s + x, 0));
  }
  sharpes.sort((a, b) => a - b);
  pnls.sort((a, b) => a - b);
  const idx = Math.floor(iters * 0.05);
  return { sharpe5: sharpes[idx]!, pnl5: pnls[idx]! };
}

/** Skip-20% test: drop each trade with p=0.2; % of iterations still profitable. */
function skip20(rets: number[], iters = 1000): number {
  const rand = lcg(1337);
  let profitable = 0;
  for (let it = 0; it < iters; it++) {
    let total = 0;
    for (const r of rets) {
      if (rand() >= 0.2) total += r;
    }
    if (total > 0) profitable++;
  }
  return Math.round((profitable / iters) * 1000) / 10;
}

/**
 * Extract session trades. Walks bars once; enters at the open of the first bar
 * with UTC hour >= entryHour, exits at the open of the first subsequent bar
 * with hour in [exitHour, entryHour) that is at least 5h after entry.
 *
 * If `weekendGap`, additionally enters on Fridays at the first bar >= 20:00
 * UTC and holds through the weekend close/reopen to the Monday morning exit —
 * capturing the weekend-gap return. Without it, a position facing a >12h gap
 * is force-closed at the last bar before the gap.
 */
export function extractTrades(
  candles: Candle[],
  weekendGap: boolean,
  entryHour = ENTRY_HOUR,
  exitHour = EXIT_HOUR,
  // Minutes past the marks before entries/exits are allowed. delayMin=1 skips
  // the first reopen bar, whose depressed bid print is not a real fill (see
  // research-session-jitter.ts) — use 1 for deployable numbers.
  delayMin = 0,
  // 'ny': entry anchored to the NY/CME clock (DST-aware) — use entryHour=18,
  // delayMin=5 for the deployable 18:05 ET anchor (CME reopens 18:00 ET; the
  // fixed-22:00-UTC anchor sits on the maintenance break half the year).
  entryClock: 'utc' | 'ny' = 'utc',
): Trade[] {
  const trades: Trade[] = [];
  let entryIdx = -1;

  const MIN_HOLD_MS = 5 * 3_600_000;
  const entryMark = entryHour * 60 + delayMin;
  const exitMark = exitHour * 60 + delayMin;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    const d = new Date(c.timestamp);
    const h = d.getUTCHours();
    const lm = h * 60 + d.getUTCMinutes();
    const dEntry = entryClock === 'ny' ? new Date(c.timestamp + nyOffsetHoursBGS(c.timestamp) * 3_600_000) : d;
    const lmEntry = dEntry.getUTCHours() * 60 + dEntry.getUTCMinutes();
    const gapMs = c.timestamp - prev.timestamp;

    if (entryIdx >= 0) {
      const entry = candles[entryIdx]!;
      if (gapMs > 12 * 3_600_000 && !weekendGap) {
        // Force-close at the last bar before the gap
        trades.push({ entryTs: entry.timestamp, exitTs: prev.timestamp, rawLogRet: Math.log(prev.open / entry.open) });
        entryIdx = -1;
      } else if (lm >= exitMark && h < 20 && c.timestamp - entry.timestamp >= MIN_HOLD_MS) {
        trades.push({ entryTs: entry.timestamp, exitTs: c.timestamp, rawLogRet: Math.log(c.open / entry.open) });
        entryIdx = -1;
      } else if (c.timestamp - entry.timestamp > 4 * 24 * 3_600_000) {
        // Safety: never hold >4 days (corrupt data guard)
        trades.push({ entryTs: entry.timestamp, exitTs: c.timestamp, rawLogRet: Math.log(c.open / entry.open) });
        entryIdx = -1;
      }
    }

    if (entryIdx < 0) {
      if (lmEntry >= entryMark) {
        entryIdx = i;
      } else if (weekendGap && d.getUTCDay() === 5 && h >= 20) {
        // Friday pre-close entry: hold the weekend gap to Monday's exit
        entryIdx = i;
      }
    }
  }

  return trades;
}

interface VariantResult {
  variant: Variant;
  frictionPerSide: number;
  trades: number;
  totalRetPct: number;
  winRate: number;
  sharpe: number;
  maxDDPct: number;
  perYearPct: Record<string, number>;
  yearsPositive: string;
  rolling3moPassRate: number;
  bootstrapSharpe5: number;
  bootstrapPnl5Pct: number;
  skip20PctProfitable: number;
  firstHalfPct: number;
  secondHalfPct: number;
}

function evaluate(variant: Variant, trades: Trade[], friction: number): VariantResult {
  // friction: per-side fraction; log-return cost ≈ 2*friction per round trip
  const rets = trades.map((t) => t.rawLogRet - 2 * friction);

  const perYear: Record<string, number> = {};
  for (let k = 0; k < trades.length; k++) {
    const y = String(new Date(trades[k]!.entryTs).getUTCFullYear());
    perYear[y] = (perYear[y] ?? 0) + rets[k]!;
  }
  const years = Object.keys(perYear).sort();
  const positives = years.filter((y) => perYear[y]! > 0).length;

  // Rolling 3-month windows
  const byWindow = new Map<string, number>();
  for (let k = 0; k < trades.length; k++) {
    const d = new Date(trades[k]!.entryTs);
    const q = `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3)}`;
    byWindow.set(q, (byWindow.get(q) ?? 0) + rets[k]!);
  }
  const windows = [...byWindow.values()];
  const passRate = windows.filter((w) => w > 0).length / Math.max(1, windows.length);

  const half = Math.floor(trades.length / 2);
  const boot = bootstrap(rets);

  return {
    variant,
    frictionPerSide: friction,
    trades: trades.length,
    totalRetPct: Math.round(rets.reduce((s, r) => s + r, 0) * 10000) / 100,
    winRate: Math.round((rets.filter((r) => r > 0).length / Math.max(1, rets.length)) * 1000) / 10,
    sharpe: Math.round(sharpeDaily(rets) * 100) / 100,
    maxDDPct: Math.round(maxDrawdown(rets) * 10000) / 100,
    perYearPct: Object.fromEntries(years.map((y) => [y, Math.round(perYear[y]! * 10000) / 100])),
    yearsPositive: `${positives}/${years.length}`,
    rolling3moPassRate: Math.round(passRate * 1000) / 10,
    bootstrapSharpe5: Math.round(boot.sharpe5 * 100) / 100,
    bootstrapPnl5Pct: Math.round(boot.pnl5 * 10000) / 100,
    skip20PctProfitable: skip20(rets),
    firstHalfPct: Math.round(rets.slice(0, half).reduce((s, r) => s + r, 0) * 10000) / 100,
    secondHalfPct: Math.round(rets.slice(half).reduce((s, r) => s + r, 0) * 10000) / 100,
  };
}

/** Buy-and-hold benchmark on the same data, daily close-to-close. */
function buyAndHold(candles: Candle[]): { totalRetPct: number; sharpe: number; maxDDPct: number; perYearPct: Record<string, number> } {
  const dayClose = new Map<string, number>();
  for (const c of candles) {
    dayClose.set(new Date(c.timestamp).toISOString().slice(0, 10), c.close);
  }
  const days = [...dayClose.keys()].sort();
  const rets: number[] = [];
  const perYear: Record<string, number> = {};
  for (let i = 1; i < days.length; i++) {
    const r = Math.log(dayClose.get(days[i]!)! / dayClose.get(days[i - 1]!)!);
    rets.push(r);
    const y = days[i]!.slice(0, 4);
    perYear[y] = (perYear[y] ?? 0) + r;
  }
  return {
    totalRetPct: Math.round(rets.reduce((s, r) => s + r, 0) * 10000) / 100,
    sharpe: Math.round(sharpeDaily(rets) * 100) / 100,
    maxDDPct: Math.round(maxDrawdown(rets) * 10000) / 100,
    perYearPct: Object.fromEntries(Object.entries(perYear).map(([y, v]) => [y, Math.round(v * 10000) / 100])),
  };
}

async function main(): Promise<void> {
  const jsonMode = process.argv.includes('--json');
  const dataArgIdx = process.argv.indexOf('--data');
  const dataPath = dataArgIdx !== -1 && process.argv[dataArgIdx + 1]
    ? path.resolve(process.cwd(), process.argv[dataArgIdx + 1]!)
    : DATA_PATH;

  if (!jsonMode) console.log(`Loading ${path.basename(dataPath)}...`);
  const candles: Candle[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  if (!jsonMode) console.log(`  ${candles.length.toLocaleString()} candles\n`);

  const tradesByVariant: Record<Variant, Trade[]> = {
    base: extractTrades(candles, false),
    'wknd-gap': extractTrades(candles, true),
  };

  const results: VariantResult[] = [];
  for (const variant of VARIANTS) {
    for (const friction of FRICTIONS) {
      results.push(evaluate(variant, tradesByVariant[variant], friction));
    }
  }

  // Hour-grid robustness: a real seasonal should be a flat basin, not one lucky cell
  const grid: Array<{ entry: number; exit: number; trades: number; totalPct: number; sharpe: number }> = [];
  for (const eh of [21, 22, 23]) {
    for (const xh of [6, 7, 8]) {
      const ts = extractTrades(candles, false, eh, xh);
      const rets = ts.map((t) => t.rawLogRet - 2 * 0.00005); // 0.5bp/side
      grid.push({
        entry: eh,
        exit: xh,
        trades: ts.length,
        totalPct: Math.round(rets.reduce((s, r) => s + r, 0) * 10000) / 100,
        sharpe: Math.round(sharpeDaily(rets) * 100) / 100,
      });
    }
  }

  const bh = buyAndHold(candles);

  if (jsonMode) {
    console.log(JSON.stringify({ results, hourGrid: grid, buyAndHold: bh }, null, 2));
  } else {
    console.log('=== Buy-and-hold benchmark (daily close-to-close) ===');
    console.log(`  total=${bh.totalRetPct}% sharpe=${bh.sharpe} maxDD=${bh.maxDDPct}%`);
    console.log(`  per-year: ${JSON.stringify(bh.perYearPct)}\n`);

    console.log('=== Session-hold variants ===');
    console.log('variant | fric(bps) | n | WR% | total% | sharpe | maxDD% | yrs+ | 3mo-pass% | bootSharpe5 | bootPnL5% | skip20% | 1st/2nd half%');
    for (const r of results) {
      console.log(
        `${r.variant.padEnd(9)} | ${String(r.frictionPerSide * 10000).padStart(4)} | ${r.trades} | ${r.winRate} | ${String(r.totalRetPct).padStart(7)} | ${String(r.sharpe).padStart(6)} | ${String(r.maxDDPct).padStart(6)} | ${r.yearsPositive} | ${String(r.rolling3moPassRate).padStart(5)} | ${String(r.bootstrapSharpe5).padStart(6)} | ${String(r.bootstrapPnl5Pct).padStart(7)} | ${String(r.skip20PctProfitable).padStart(5)} | ${r.firstHalfPct}/${r.secondHalfPct}`,
      );
    }
    console.log('\nPer-year (friction=1bp/side):');
    for (const r of results.filter((x) => x.frictionPerSide === 0.0001)) {
      console.log(`  ${r.variant}: ${JSON.stringify(r.perYearPct)}`);
    }
    console.log('\n=== Hour-grid robustness (base, 0.5bp/side) ===');
    console.log('entry→exit | n | total% | sharpe');
    for (const g of grid) {
      console.log(`  ${g.entry}→${String(g.exit).padStart(2, '0')} | ${g.trades} | ${String(g.totalPct).padStart(7)} | ${g.sharpe}`);
    }
  }

  const outPath = dataPath === DATA_PATH
    ? OUT_PATH
    : OUT_PATH.replace('.json', `-${path.basename(dataPath, '.json')}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ results, hourGrid: grid, buyAndHold: bh }, null, 2));
  if (!jsonMode) console.log(`\nSaved → ${outPath}`);
}

// Guard so analysis scripts can import extractTrades without running the backtest
if (require.main === module) {
  main().catch((err) => {
    console.error('Session backtest failed:', err);
    process.exit(1);
  });
}
