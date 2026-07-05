#!/usr/bin/env tsx
/**
 * Session-hold ⊕ F2F portfolio analysis + DSR for the session-hold.
 *
 * Question: does combining the overnight session hold (22→07 UTC + weekend gap,
 * experiments/gold-session-hold.md) with the validated F2F daily model produce
 * a better risk-adjusted P&L than either alone? Both are long-gold expressions —
 * if their daily returns are imperfectly correlated, the blend wins.
 *
 * Method:
 *  - Session-hold: wknd-gap trades on 1m data 2015–2026, 0.5bp/side, return
 *    assigned to exit date.
 *  - F2F: deployed params (λ=0.95, θ=0.91, zscore50, long-only) on daily GC_F
 *    data; train stats from 2005–2014, signals 2015→end (no look-ahead);
 *    friction 0.0005 (its validated assumption). NOTE: λ/θ came from F2F's own
 *    walk-forward — this is a fixed-param replay for correlation purposes, not
 *    a fresh OOS claim for F2F.
 *  - Align on calendar dates (missing day = flat 0).
 *  - Report: per-leg Sharpe/PnL/MaxDD, correlation, 50/50 and vol-weighted
 *    blends. DSR for session-hold at an honest trial count.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';
import { extractTrades } from './backtest-gold-session';
import { generateSignals } from '../src/lib/gold/signals';
import { runF2FSimulation } from '../src/lib/gold/strategy';
import { runWalkForwardOptimization } from '../src/lib/gold/optimizer';
import { F2F_DEFAULT_WF_CONFIG } from '../src/lib/gold/types';
import { deflatedSharpePerObs } from '../src/lib/rl/utils/deflated-sharpe';

const SESSION_FRICTION = 0.00005; // 0.5bp/side
const F2F_FRICTION = 0.0005;      // F2F's validated assumption
const DSR_TRIALS = 15;            // base/weekend/bias/bias-wknd/wknd-gap + 9 grid cells + window choice

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

function sharpe(xs: number[]): number {
  const s = std(xs);
  return s > 0 ? (mean(xs) / s) * Math.sqrt(252) : 0;
}

function maxDD(xs: number[]): number {
  let eq = 0; let peak = 0; let dd = 0;
  for (const r of xs) {
    eq += r;
    if (eq > peak) peak = eq;
    if (peak - eq > dd) dd = peak - eq;
  }
  return dd;
}

function corr(a: number[], b: number[]): number {
  const ma = mean(a); const mb = mean(b);
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

function fmt(x: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

function dateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  // --- Session-hold daily returns ---
  console.log('Building session-hold daily returns (wknd-gap, 0.5bp/side)...');
  const sessionDaily = new Map<string, number>();
  for (const file of ['XAUUSD_1m_holdout.json', 'XAUUSD_1m.json']) {
    const candles: Candle[] = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'data', file), 'utf-8'),
    );
    for (const t of extractTrades(candles, true)) {
      const key = dateKey(t.exitTs);
      sessionDaily.set(key, (sessionDaily.get(key) ?? 0) + t.rawLogRet - 2 * SESSION_FRICTION);
    }
  }
  console.log(`  ${sessionDaily.size} session trading days`);

  // --- F2F daily returns ---
  const daily: Candle[] = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'data', 'GC_F_1d.json'), 'utf-8'),
  );

  const f2fDaily = new Map<string, number>();

  if (process.argv.includes('--f2f-wf')) {
    // TRUE walk-forward: re-optimizes (λ,θ) and train stats per window —
    // this is the process behind F2F's validated Sharpe 2.08.
    //
    // IMPORTANT: F2F val windows overlap 6× (126-bar val, 21-bar slide).
    // Using allOOSTrades stacks up to 6 copies of exposure on the same days.
    // For a calendar-honest daily series we keep only NON-OVERLAPPING windows
    // (each OOS day counted exactly once). Trades are cached to avoid
    // recomputing the ~6-minute walk-forward.
    const cachePath = path.resolve(__dirname, '..', 'experiments', 'runs', 'f2f-wf-oos-trades-nonoverlap.json');
    let oosTrades: Array<{ entryIndex: number; exitIndex: number; entryPrice: number; exitPrice: number; weight: number; direction: 'long' | 'short' }>;

    if (fs.existsSync(cachePath)) {
      oosTrades = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      console.log(`Loaded ${oosTrades.length} cached non-overlapping F2F OOS trades`);
    } else {
      console.log('Running F2F TRUE walk-forward (this re-optimizes every window)...');
      const wf = runWalkForwardOptimization(daily, F2F_DEFAULT_WF_CONFIG, F2F_FRICTION, undefined, 'long-only', 'zscore50');
      console.log(`  WF sanity: passRate=${fmt(wf.passRate * 100, 1)}% OOS trades=${wf.allOOSTrades.length} aggregate Sharpe=${fmt(wf.aggregate.sharpe)}`);

      let lastEnd = -1;
      const nonOverlapping = wf.windows.filter((w) => {
        if (w.valStart >= lastEnd) { lastEnd = w.valEnd; return true; }
        return false;
      });
      oosTrades = nonOverlapping.flatMap((w) => w.valTrades);
      console.log(`  Non-overlapping windows: ${nonOverlapping.length}/${wf.windows.length} → ${oosTrades.length} trades`);
      fs.writeFileSync(cachePath, JSON.stringify(oosTrades.map((t) => ({
        entryIndex: t.entryIndex, exitIndex: t.exitIndex, entryPrice: t.entryPrice,
        exitPrice: t.exitPrice, weight: t.weight, direction: t.direction,
      }))));
    }

    // Distribute each OOS trade's exposure across its hold days:
    // daily ret = weight × Δlog(close), entry/exit days use actual fill prices,
    // friction charged half at entry day, half at exit day.
    for (const t of oosTrades) {
      const sign = t.direction === 'long' ? 1 : -1;
      for (let d = t.entryIndex + 1; d <= t.exitIndex; d++) {
        const from = d === t.entryIndex + 1 ? t.entryPrice : daily[d - 1]!.close;
        const to = d === t.exitIndex ? t.exitPrice : daily[d]!.close;
        let r = sign * t.weight * Math.log(to / from);
        if (d === t.entryIndex + 1) r -= t.weight * F2F_FRICTION;
        if (d === t.exitIndex) r -= t.weight * F2F_FRICTION;
        const key = dateKey(daily[d]!.timestamp);
        f2fDaily.set(key, (f2fDaily.get(key) ?? 0) + r);
      }
    }
    console.log(`  ${f2fDaily.size} F2F OOS days from ${oosTrades.length} non-overlapping trades`);
  } else {
    // Fixed-param replay (fast, but understates F2F — see gold-session-hold.md)
    console.log('Building F2F daily returns (fixed λ=0.95 θ=0.91 replay)...');
    const cut = daily.findIndex((c) => c.timestamp >= Date.UTC(2015, 0, 1));
    if (cut < 500) throw new Error('GC_F_1d.json does not cover the 2005-2014 training span');

    const signals = generateSignals(daily, { lambda: 0.95, theta: 0.91 }, 0, cut, cut, undefined, 'zscore50');
    const sim = runF2FSimulation(signals, F2F_FRICTION, 'long-only');
    for (let i = 1; i < sim.equityCurve.length; i++) {
      const prev = sim.equityCurve[i - 1]!;
      const cur = sim.equityCurve[i]!;
      if (prev > 0) {
        f2fDaily.set(dateKey(signals[i]!.timestamp), Math.log(cur / prev));
      }
    }
    console.log(`  ${f2fDaily.size} F2F days, sim trades=${sim.trades.length}`);
  }

  // --- Align ---
  const allDates = [...new Set([...sessionDaily.keys(), ...f2fDaily.keys()])].sort();
  const a: number[] = []; // session
  const b: number[] = []; // f2f
  for (const d of allDates) {
    a.push(sessionDaily.get(d) ?? 0);
    b.push(f2fDaily.get(d) ?? 0);
  }

  const combo5050 = a.map((x, i) => 0.5 * x + 0.5 * b[i]!);
  // Inverse-vol weights (computed on full sample — descriptive, not tradable as-is)
  const va = std(a); const vb = std(b);
  const wa = (1 / va) / (1 / va + 1 / vb);
  const volW = a.map((x, i) => wa * x + (1 - wa) * b[i]!);

  const report = (label: string, xs: number[]): void => {
    console.log(
      `  ${label.padEnd(12)} total=${fmt(xs.reduce((s, x) => s + x, 0) * 100, 1)}% ` +
      `sharpe=${fmt(sharpe(xs))} maxDD=${fmt(maxDD(xs) * 100, 1)}%`,
    );
  };

  console.log(`\n=== Portfolio comparison (${allDates[0]} → ${allDates[allDates.length - 1]}, ${allDates.length} days) ===`);
  report('session', a);
  report('f2f', b);
  report('50/50', combo5050);
  report(`vol-w (${fmt(wa, 2)}/${fmt(1 - wa, 2)})`, volW);
  console.log(`  correlation(session, f2f) = ${fmt(corr(a, b), 3)}`);

  // --- DSR for session-hold ---
  const sessRets = [...sessionDaily.values()];
  const m = mean(sessRets); const s = std(sessRets);
  const skew = s > 0 ? mean(sessRets.map((x) => ((x - m) / s) ** 3)) : 0;
  const kurt = s > 0 ? mean(sessRets.map((x) => ((x - m) / s) ** 4)) : 3;
  // Deflate the PER-OBSERVATION (per-day) Sharpe (m/s), NOT the annualized
  // sharpe() (×√252) — Lo's Var(SR)=(1+0.5SR²)/T is per-observation.
  const dsr = deflatedSharpePerObs({
    perObsSharpe: s > 0 ? m / s : 0,
    numObservations: sessRets.length,
    numTrials: DSR_TRIALS,
    skewness: skew,
    kurtosis: kurt,
  });
  console.log(`\n=== DSR (session-hold, ${DSR_TRIALS} trials, skew=${fmt(skew)}, kurt=${fmt(kurt)}) ===`);
  console.log(`  sharpe=${fmt(dsr.originalSharpe)} haircut=${fmt(dsr.haircut)} DSR=${fmt(dsr.deflatedSharpe)} significant=${dsr.isSignificant}`);

  fs.writeFileSync(
    path.resolve(__dirname, '..', 'experiments', 'runs', 'gold-session-portfolio.json'),
    JSON.stringify({
      days: allDates.length,
      range: [allDates[0], allDates[allDates.length - 1]],
      correlation: fmt(corr(a, b), 4),
      legs: {
        session: { totalPct: fmt(a.reduce((s2, x) => s2 + x, 0) * 100, 2), sharpe: fmt(sharpe(a)), maxDDPct: fmt(maxDD(a) * 100, 2) },
        f2f: { totalPct: fmt(b.reduce((s2, x) => s2 + x, 0) * 100, 2), sharpe: fmt(sharpe(b)), maxDDPct: fmt(maxDD(b) * 100, 2) },
        combo5050: { totalPct: fmt(combo5050.reduce((s2, x) => s2 + x, 0) * 100, 2), sharpe: fmt(sharpe(combo5050)), maxDDPct: fmt(maxDD(combo5050) * 100, 2) },
        volWeighted: { wSession: fmt(wa, 3), totalPct: fmt(volW.reduce((s2, x) => s2 + x, 0) * 100, 2), sharpe: fmt(sharpe(volW)), maxDDPct: fmt(maxDD(volW) * 100, 2) },
      },
      dsr: { sharpe: fmt(dsr.originalSharpe), haircut: fmt(dsr.haircut), deflated: fmt(dsr.deflatedSharpe), trials: DSR_TRIALS },
    }, null, 2),
  );
  console.log('\nSaved → experiments/runs/gold-session-portfolio.json');
}

main().catch((err) => {
  console.error('Portfolio analysis failed:', err);
  process.exit(1);
});
