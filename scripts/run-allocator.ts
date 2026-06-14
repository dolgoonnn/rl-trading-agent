#!/usr/bin/env tsx
/**
 * Portfolio allocator + sleeve monitor for the combined book
 * (experiments/strategy-combination.md, execution-audit.md).
 *
 * SIZING (from backtest series — stable estimates, no live cold-start):
 *   1. Sleeve vols/correlations from experiments/runs/strategy-daily-returns.json
 *      (union calendar, zeros when flat, trailing 252 obs).
 *   2. Fixed cluster weights (pre-registered, gold-tail mitigation):
 *      crypto 0.50 / sessionBookRetail 0.30 / f2f 0.20.
 *   3. Sleeve scale to 10% ann vol (cap 4×), Carver DM (ρ floored 0, cap 2.5),
 *      book scaled to the portfolio vol target (default 12% ann, cap 3×).
 *   Output: target notional per sleeve for a given --capital.
 *
 * MONITORING (from live paper-bot states, best-effort):
 *   - session book: data/metals-bot-state.json (trade log)
 *   - f2f gold:     data/gold-bot-state.json (trade log / equity)
 *   - crypto:       data/ict-trading.db bot_equity_snapshots (if readable)
 *   Pre-registered rules (from validate-combination worst-window analysis —
 *   a flat half-year is NORMAL):
 *     WATCH  = rolling 30d realized Sharpe < 0
 *     BREACH = rolling 60d realized Sharpe < −1.0  (≈ below the bootstrap
 *              5th-percentile band; manual review before any kill decision)
 *
 * Usage:
 *   npx tsx scripts/run-allocator.ts --capital 100000 [--vol-target 0.12]
 */

import * as fs from 'fs';
import * as path from 'path';
import { getCppiExposureMultiplier } from '../src/lib/bot/risk-engine';
import { expectedMaxDD, hardKillDD } from '../src/lib/bot/retirement';
import { RETIREMENT_CONFIG } from '../src/lib/bot/config';

// ============================================
// Config
// ============================================

const SLEEVES = ['crypto', 'sessionBookRetail', 'f2f'] as const;
type Sleeve = (typeof SLEEVES)[number];
const CLUSTER_WEIGHTS: Record<Sleeve, number> = { crypto: 0.5, sessionBookRetail: 0.3, f2f: 0.2 };
const SLEEVE_VOL_TARGET = 0.10;
const SLEEVE_LEVERAGE_CAP = 4;
const BOOK_LEVERAGE_CAP = 3;
const DM_CAP = 2.5;

// ============================================
// Helpers
// ============================================

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function annSharpe(xs: number[]): number { const s = std(xs); return s > 0 ? (mean(xs) / s) * Math.sqrt(252) : 0; }
function corrOf(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; db += (b[i]! - mb) ** 2; }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : 0;
}
function fmt(x: number, dp = 2): string { return x.toFixed(dp); }

// ============================================
// Live book drawdown (PURE — unit-testable without a DB)
// ============================================

/** A single live equity snapshot from `bot_equity_snapshots`. */
export interface EquitySnapshot {
  timestamp: number;
  equity: number;
}

/**
 * Trailing-peak drawdown of the LIVE book equity series.
 *
 *   drawdown = 1 - latestEquity / max(historicalPeak, latestEquity)
 *
 * Snapshots are sorted by `timestamp` so the latest is the chronological last
 * (the DB read is already ordered, but we re-sort defensively). Returns 0 when
 * there are no snapshots — the graceful fallback that maps to a CPPI multiplier
 * of 1.0 (no cut) when there is no live history to size off yet. This is PURE
 * (no DB / clock) so the CPPI cut is unit-testable in isolation.
 */
export function liveBookDrawdown(snapshots: EquitySnapshot[]): number {
  if (snapshots.length === 0) return 0;
  const sorted = [...snapshots].sort((a, b) => a.timestamp - b.timestamp);
  const latest = sorted[sorted.length - 1]!.equity;
  let peak = latest;
  for (const s of sorted) peak = Math.max(peak, s.equity);
  if (peak <= 0) return 0;
  return Math.max(0, 1 - latest / peak);
}

/**
 * Best-effort read of the LIVE crypto book equity series from
 * `bot_equity_snapshots` (the same source the live monitor reads). Returns an
 * empty array if the DB is missing/locked/empty so CPPI falls back to mult 1.0
 * with a logged note — NEVER to the backtest curve's drawdown.
 */
function readLiveEquitySnapshots(): EquitySnapshot[] {
  try {
    // best-effort dynamic require so the allocator works even if the DB is locked/full
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const db = new Database(path.resolve(__dirname, '..', 'data', 'ict-trading.db'), { readonly: true });
    const rows = db.prepare(
      'SELECT timestamp, equity FROM bot_equity_snapshots ORDER BY timestamp',
    ).all() as Array<{ timestamp: number; equity: number }>;
    db.close();
    return rows.map((r) => ({ timestamp: r.timestamp, equity: r.equity }));
  } catch {
    return []; // DB unavailable → graceful fallback to no-cut
  }
}

// ============================================
// Sizing from backtest series
// ============================================

interface Sizing {
  vols: Record<Sleeve, number>;
  scales: Record<Sleeve, number>;
  dm: number;
  bookScale: number;
  notional: Record<Sleeve, number>;
  bookVolAnn: number;
  /**
   * Current LIVE book drawdown from the trailing peak of the `bot_equity_snapshots`
   * series (0 when no live history exists yet — CPPI then does not cut).
   */
  liveDrawdown: number;
  /** True when there were no live snapshots ⇒ CPPI defaulted to 1.0 (no cut). */
  liveDataAvailable: boolean;
  /** CPPI continuous-drawdown exposure multiplier applied to all notionals. */
  cppiMult: number;
}

function computeSizing(capital: number, volTargetAnn: number): Sizing {
  const file = path.resolve(__dirname, '..', 'experiments', 'runs', 'strategy-daily-returns.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as { series: Record<string, Record<string, number>> };

  // union calendar over the trailing 252 active dates of the joint window
  const allDates = new Set<string>();
  for (const s of SLEEVES) for (const d of Object.keys(data.series[s]!)) allDates.add(d);
  const dates = [...allDates].sort().slice(-365);
  const series = {} as Record<Sleeve, number[]>;
  for (const s of SLEEVES) series[s] = dates.map((d) => data.series[s]![d] ?? 0);

  const dailyTarget = SLEEVE_VOL_TARGET / Math.sqrt(252);
  const vols = {} as Record<Sleeve, number>;
  const scales = {} as Record<Sleeve, number>;
  const norm = {} as Record<Sleeve, number[]>;
  for (const s of SLEEVES) {
    vols[s] = std(series[s]);
    scales[s] = vols[s] > 0 ? Math.min(SLEEVE_LEVERAGE_CAP, dailyTarget / vols[s]) : 0;
    norm[s] = series[s].map((r) => r * scales[s]);
  }

  // DM on correlations of normalized sleeves, ρ floored at 0
  let q = 0;
  for (const a of SLEEVES) {
    for (const b of SLEEVES) {
      const rho = a === b ? 1 : Math.max(0, corrOf(norm[a], norm[b]));
      q += CLUSTER_WEIGHTS[a] * CLUSTER_WEIGHTS[b] * rho;
    }
  }
  const dm = q > 0 ? Math.min(DM_CAP, 1 / Math.sqrt(q)) : 1;

  // realized book vol at weights×DM → final scale to the portfolio target
  const book = dates.map((_, i) => SLEEVES.reduce((s, k) => s + dm * CLUSTER_WEIGHTS[k] * norm[k][i]!, 0));
  const bookVolAnn = std(book) * Math.sqrt(252);
  const bookScale = bookVolAnn > 0 ? Math.min(BOOK_LEVERAGE_CAP, volTargetAnn / bookVolAnn) : 1;

  // CPPI continuous-drawdown cut, anchored to the FROZEN retirement bounds
  // (reused, not re-derived). CRITICAL (reviewer FIX 1): the drawdown is the
  // LIVE book drawdown from `bot_equity_snapshots`, NOT the backtest equity
  // curve. Sizing CPPI off the historical backtest series produces a FIXED
  // number decoupled from the live account — it could never cut when the LIVE
  // book draws down. We therefore read the live snapshots and take their
  // trailing-peak drawdown; the backtest `book` series above is used for
  // vol/DM ESTIMATION ONLY. With no live history yet we fall back GRACEFULLY to
  // drawdown 0 ⇒ multiplier 1.0 (no cut), never to the backtest drawdown. The
  // cut RECOVERS as live equity recovers — independent of the latched kill.
  const eMaxDD = expectedMaxDD({
    sigmaAnnual: RETIREMENT_CONFIG.sigmaAnnual,
    sharpe: RETIREMENT_CONFIG.sharpe,
    horizonYears: RETIREMENT_CONFIG.horizonYears,
  });
  const hardDD = hardKillDD({ eMaxDD, bootstrapP5DD: RETIREMENT_CONFIG.bootstrapP5DD });
  const liveSnapshots = readLiveEquitySnapshots();
  const liveDataAvailable = liveSnapshots.length > 0;
  const liveDrawdown = liveBookDrawdown(liveSnapshots);
  if (!liveDataAvailable) {
    console.log(
      'CPPI: no live equity snapshots (bot_equity_snapshots) — falling back to exposureMult 1.0 (no cut).',
    );
  }
  const cppiMult = getCppiExposureMultiplier({ drawdown: liveDrawdown, eMaxDD, hardKillDD: hardDD });

  const notional = {} as Record<Sleeve, number>;
  for (const s of SLEEVES) {
    notional[s] = capital * CLUSTER_WEIGHTS[s] * scales[s] * dm * bookScale * cppiMult;
  }
  return { vols, scales, dm, bookScale, notional, bookVolAnn, liveDrawdown, liveDataAvailable, cppiMult };
}

// ============================================
// Live monitoring (best-effort per source)
// ============================================

interface SleeveLive {
  sleeve: string;
  days: number;
  cumPnlPct: number;
  sharpe30: number | null;
  sharpe60: number | null;
  status: 'OK' | 'WATCH' | 'BREACH' | 'NO DATA';
}

function statusOf(sharpe30: number | null, sharpe60: number | null, days: number): SleeveLive['status'] {
  if (days < 10) return 'NO DATA';
  if (sharpe60 !== null && sharpe60 < -1.0) return 'BREACH';
  if (sharpe30 !== null && sharpe30 < 0) return 'WATCH';
  return 'OK';
}

/** daily PnL% series from a {date → pnl} map over the trailing n calendar days */
function rollingFromDaily(byDay: Map<string, number>): SleeveLive {
  const dates = [...byDay.keys()].sort();
  const xs = dates.map((d) => byDay.get(d)!);
  const last30 = xs.slice(-30);
  const last60 = xs.slice(-60);
  return {
    sleeve: '',
    days: xs.length,
    cumPnlPct: Math.round(xs.reduce((s, x) => s + x, 0) * 1e4) / 100,
    sharpe30: last30.length >= 10 ? Math.round(annSharpe(last30) * 100) / 100 : null,
    sharpe60: last60.length >= 20 ? Math.round(annSharpe(last60) * 100) / 100 : null,
    status: 'NO DATA',
  };
}

function liveSessionBook(): SleeveLive {
  const p = path.resolve(__dirname, '..', 'data', 'metals-bot-state.json');
  const out: SleeveLive = { sleeve: 'sessionBookRetail', days: 0, cumPnlPct: 0, sharpe30: null, sharpe60: null, status: 'NO DATA' };
  try {
    const st = JSON.parse(fs.readFileSync(p, 'utf-8')) as { trades: Array<{ exitTime: string; pnlPct: number }> };
    const byDay = new Map<string, number>();
    for (const t of st.trades) {
      const d = t.exitTime.slice(0, 10);
      byDay.set(d, (byDay.get(d) ?? 0) + t.pnlPct / 100);
    }
    Object.assign(out, rollingFromDaily(byDay), { sleeve: 'sessionBookRetail' });
    out.status = statusOf(out.sharpe30, out.sharpe60, out.days);
  } catch { /* no data */ }
  return out;
}

function liveF2F(): SleeveLive {
  const p = path.resolve(__dirname, '..', 'data', 'gold-bot-state.json');
  const out: SleeveLive = { sleeve: 'f2f', days: 0, cumPnlPct: 0, sharpe30: null, sharpe60: null, status: 'NO DATA' };
  try {
    const st = JSON.parse(fs.readFileSync(p, 'utf-8')) as { equity?: number; initialCapital?: number; trades?: Array<{ exitTime?: string; pnlPercent?: number }> };
    const byDay = new Map<string, number>();
    for (const t of st.trades ?? []) {
      if (t.exitTime && typeof t.pnlPercent === 'number') {
        const d = t.exitTime.slice(0, 10);
        byDay.set(d, (byDay.get(d) ?? 0) + t.pnlPercent);
      }
    }
    Object.assign(out, rollingFromDaily(byDay), { sleeve: 'f2f' });
    if (st.equity && st.initialCapital) out.cumPnlPct = Math.round((st.equity / st.initialCapital - 1) * 1e4) / 100;
    out.status = statusOf(out.sharpe30, out.sharpe60, out.days);
  } catch { /* no data */ }
  return out;
}

function liveCrypto(): SleeveLive {
  const out: SleeveLive = { sleeve: 'crypto', days: 0, cumPnlPct: 0, sharpe30: null, sharpe60: null, status: 'NO DATA' };
  try {
    // best-effort dynamic require so the allocator works even if the DB is locked/full
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const db = new Database(path.resolve(__dirname, '..', 'data', 'ict-trading.db'), { readonly: true });
    const rows = db.prepare(
      'SELECT timestamp, equity FROM bot_equity_snapshots ORDER BY timestamp',
    ).all() as Array<{ timestamp: number; equity: number }>;
    db.close();
    // last equity per day → daily returns
    const eqByDay = new Map<string, number>();
    for (const r of rows) {
      eqByDay.set(new Date(r.timestamp).toISOString().slice(0, 10), r.equity);
    }
    const days = [...eqByDay.keys()].sort();
    const byDay = new Map<string, number>();
    for (let i = 1; i < days.length; i++) {
      const prev = eqByDay.get(days[i - 1]!)!;
      const cur = eqByDay.get(days[i]!)!;
      if (prev > 0) byDay.set(days[i]!, cur / prev - 1);
    }
    Object.assign(out, rollingFromDaily(byDay), { sleeve: 'crypto' });
    const first = eqByDay.get(days[0]!);
    const last = eqByDay.get(days[days.length - 1]!);
    if (first && last && first > 0) out.cumPnlPct = Math.round((last / first - 1) * 1e4) / 100;
    out.status = statusOf(out.sharpe30, out.sharpe60, out.days);
  } catch { /* DB unavailable */ }
  return out;
}

// ============================================
// Main
// ============================================

function main(): void {
  const args = process.argv.slice(2);
  const capital = args.includes('--capital') ? parseFloat(args[args.indexOf('--capital') + 1]!) : 100_000;
  const volTarget = args.includes('--vol-target') ? parseFloat(args[args.indexOf('--vol-target') + 1]!) : 0.12;

  console.log(`=== Combined-book allocator — capital $${capital.toLocaleString()}, vol target ${(volTarget * 100).toFixed(0)}% ann ===\n`);

  const s = computeSizing(capital, volTarget);
  console.log('Target allocation (cluster weights crypto .50 / book .30 / f2f .20):');
  console.log('sleeve            | weight | vol(ann) | scale→10% | notional');
  for (const k of SLEEVES) {
    console.log(
      `${k.padEnd(17)} | ${fmt(CLUSTER_WEIGHTS[k])}   | ${fmt(s.vols[k] * Math.sqrt(252) * 100, 1).padStart(6)}% | ${fmt(s.scales[k]).padStart(8)}× | $${Math.round(s.notional[k]).toLocaleString()}`,
    );
  }
  console.log(`DM=${fmt(s.dm)}  bookVol@weights=${fmt(s.bookVolAnn * 100, 1)}%  bookScale=${fmt(s.bookScale)}×`);
  const ddSource = s.liveDataAvailable ? 'live bot_equity_snapshots' : 'no live data → fallback 1.0×';
  console.log(`CPPI: liveDD=${fmt(s.liveDrawdown * 100, 1)}% (${ddSource}) → exposureMult=${fmt(s.cppiMult)}× (recoverable; independent of the latched kill-switch)`);
  console.log(`Total gross notional: $${Math.round(SLEEVES.reduce((t, k) => t + s.notional[k], 0)).toLocaleString()}`);
  console.log('\nExpected (backtest, venue-realistic): ~37%/yr, Sharpe ~2.5, maxDD ~10% at 12% target.');
  console.log('Worst NORMAL stretch: flat 6 months (do not kill sleeves on flat spells).\n');

  console.log('Live sleeve monitor (paper bots):');
  console.log('sleeve            | days | cumPnL% | 30d Sharpe | 60d Sharpe | status');
  const lives = [liveCrypto(), liveSessionBook(), liveF2F()];
  for (const l of lives) {
    console.log(
      `${l.sleeve.padEnd(17)} | ${String(l.days).padStart(4)} | ${String(l.cumPnlPct).padStart(7)} | ${String(l.sharpe30 ?? '—').padStart(10)} | ${String(l.sharpe60 ?? '—').padStart(10)} | ${l.status}`,
    );
  }
  console.log('\nRules: WATCH = 30d Sharpe < 0 (normal, observe). BREACH = 60d Sharpe < −1 (review before kill).');

  const outPath = path.resolve(__dirname, '..', 'experiments', 'runs', 'allocator-report.json');
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    capital, volTarget,
    sizing: {
      weights: CLUSTER_WEIGHTS,
      dm: Math.round(s.dm * 100) / 100,
      bookScale: Math.round(s.bookScale * 100) / 100,
      liveDrawdown: Math.round(s.liveDrawdown * 1e4) / 100,
      liveDataAvailable: s.liveDataAvailable,
      cppiMult: Math.round(s.cppiMult * 100) / 100,
      notional: Object.fromEntries(SLEEVES.map((k) => [k, Math.round(s.notional[k])])),
    },
    live: lives,
  }, null, 2));
  console.log(`Saved → ${outPath}`);
}

// Only run the allocator when executed directly (not when imported by tests).
if (require.main === module) {
  main();
}
