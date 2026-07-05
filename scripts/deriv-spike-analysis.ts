#!/usr/bin/env tsx
/**
 * Deriv Boom/Crash — Spike Structure & "Real Trader" Test
 *
 * Reframes the question from PREDICTION to TRADING. A profitable Boom/Crash
 * trader does not predict the next tick — they manage a known structural
 * asymmetry (Boom only spikes UP; Crash only spikes DOWN) with risk and
 * position sizing. This script asks the empirical questions that decide whether
 * any of that has a real edge vs is variance/survivorship:
 *
 *   1. SPIKE DETECTION — find the rare one-directional spike bars.
 *   2. HAZARD FUNCTION — is inter-spike timing memoryless (flat hazard →
 *      geometric/Poisson, no "overdue" edge) or does the hazard RISE with
 *      ticks-since-last-spike (→ a real timing edge for overdue entries)?
 *   3. DRIFT SIGN STABILITY — is the small between-spike drift persistent
 *      (a directional bias to harvest) or just single-path noise?
 *   4. SPIKE-RIDER SIM — long-only-on-Boom / short-only-on-Crash, ride toward
 *      a spike with a stop. Report win rate, EV/trade (net of spread), skew,
 *      and max drawdown. Then test whether entering only when the spike is
 *      "overdue" improves EV (the hazard edge, if real).
 *
 * Usage:
 *   npx tsx scripts/deriv-spike-analysis.ts --symbols BOOM500,BOOM1000,CRASH500,CRASH1000
 *   npx tsx scripts/deriv-spike-analysis.ts --symbol BOOM1000 --spike-k 8 --spread-bp 2
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types/candle';

function getArg(name: string): string | undefined {
  const a = process.argv.slice(2);
  const i = a.indexOf(`--${name}`);
  return i !== -1 && a[i + 1] ? a[i + 1] : undefined;
}

function median(x: number[]): number {
  if (x.length === 0) return 0;
  const s = [...x].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Spike direction per family: Boom spikes up (+1), Crash spikes down (-1). */
function spikeDir(symbol: string): 1 | -1 {
  return symbol.toUpperCase().startsWith('BOOM') ? 1 : -1;
}

interface Analysis {
  symbol: string;
  bars: number;
  spikeCount: number;
  meanIntervalBars: number;
  hazard: { k: number; h: number; n: number }[];
  hazardSlope: string;
  driftSignStable: string;
  rider: { winRate: number; evPerTrade: number; totalPnl: number; skew: number; maxDD: number; trades: number };
  overdueEv: { q: number; ev: number; trades: number }[];
}

function analyze(symbol: string, candles: Candle[], spikeK: number, spreadBp: number): Analysis {
  const dir = spikeDir(symbol);
  const n = candles.length;

  // Signed log returns in the spike direction
  const r: number[] = [];
  for (let i = 1; i < n; i++) {
    const a = candles[i - 1]!.close, b = candles[i]!.close;
    r.push(dir * Math.log(b / a)); // positive = in the spike direction
  }

  // Robust spike threshold: median + k * MAD of the directional return
  const med = median(r);
  const mad = median(r.map((v) => Math.abs(v - med)));
  const thresh = med + spikeK * mad * 1.4826; // 1.4826 → ~sigma for normal bulk
  const isSpike: boolean[] = r.map((v) => v > thresh);
  const spikeBars: number[] = [];
  isSpike.forEach((s, i) => { if (s) spikeBars.push(i); });

  // Inter-spike intervals (bars)
  const intervals: number[] = [];
  for (let i = 1; i < spikeBars.length; i++) intervals.push(spikeBars[i]! - spikeBars[i - 1]!);
  const meanInterval = intervals.length ? intervals.reduce((s, v) => s + v, 0) / intervals.length : 0;

  // Empirical hazard h(k) = P(spike at gap k | survived to k)
  const maxK = Math.min(Math.ceil(meanInterval * 2.5), 200);
  const atK = new Array(maxK + 1).fill(0);
  const geK = new Array(maxK + 1).fill(0);
  for (const iv of intervals) {
    for (let k = 1; k <= Math.min(iv, maxK); k++) geK[k]++;
    if (iv <= maxK) atK[iv]++;
  }
  const hazard: { k: number; h: number; n: number }[] = [];
  // sample a handful of buckets across the range
  const ks = [1, Math.round(meanInterval * 0.25), Math.round(meanInterval * 0.5), Math.round(meanInterval * 0.75),
    Math.round(meanInterval), Math.round(meanInterval * 1.5), Math.round(meanInterval * 2)]
    .filter((k, idx, arr) => k >= 1 && k <= maxK && arr.indexOf(k) === idx);
  for (const k of ks) hazard.push({ k, h: geK[k] ? atK[k] / geK[k] : 0, n: geK[k] });

  // Hazard slope: compare early-half vs late-half hazard
  const earlyH = hazard.length >= 2 ? hazard[0]!.h : 0;
  const lateH = hazard.length >= 2 ? hazard[hazard.length - 1]!.h : 0;
  const flat = 1 / meanInterval;
  const hazardSlope = lateH > earlyH * 1.3 ? `RISING (overdue edge?) early=${(earlyH).toFixed(4)} late=${(lateH).toFixed(4)} flat=${flat.toFixed(4)}`
    : lateH < earlyH * 0.7 ? `FALLING early=${(earlyH).toFixed(4)} late=${(lateH).toFixed(4)}`
    : `~FLAT (memoryless) early=${(earlyH).toFixed(4)} late=${(lateH).toFixed(4)} flat=${flat.toFixed(4)}`;

  // Drift sign stability: split into 6 chunks, drift = mean of NON-spike returns, check sign consistency
  const nonSpike = r.filter((_, i) => !isSpike[i]);
  const chunk = Math.floor(r.length / 6);
  const chunkDrifts: number[] = [];
  for (let c = 0; c < 6; c++) {
    const seg = r.slice(c * chunk, (c + 1) * chunk);
    chunkDrifts.push(seg.reduce((s, v) => s + v, 0) / Math.max(seg.length, 1));
  }
  const posChunks = chunkDrifts.filter((d) => d > 0).length;
  const driftSignStable = `non-spike drift/bar=${(nonSpike.reduce((s, v) => s + v, 0) / nonSpike.length * 1e4).toFixed(2)}bp, full-dir-drift/bar=${(r.reduce((s, v) => s + v, 0) / r.length * 1e4).toFixed(2)}bp, ${posChunks}/6 chunks same-sign-as-spike`;

  // SPIKE-RIDER SIM: trade WITH the spike direction, TP/SL in units of median bar range
  const barRange = median(candles.slice(1).map((c) => Math.abs(Math.log(c.high / c.low) || 0)));
  const spread = spreadBp / 1e4;
  const TP = barRange * 12;   // wide TP to catch a spike
  const SL = barRange * 3;    // tight stop on the drift
  const maxHold = Math.round(meanInterval * 1.5);

  function simulate(minBarsSinceSpike: number): { trades: number; wins: number; pnls: number[] } {
    const pnls: number[] = [];
    let wins = 0;
    let lastSpike = -1;
    let i = 1;
    while (i < r.length) {
      // track spikes as we walk
      if (isSpike[i - 1]) lastSpike = i - 1;
      const sinceSpike = lastSpike >= 0 ? (i - lastSpike) : i;
      if (sinceSpike < minBarsSinceSpike) { i++; continue; }
      // enter long(Boom)/short(Crash) at bar i, exit on TP/SL/maxHold in directional return space
      let cum = 0, exited = false;
      for (let h = 0; h < maxHold && i + h < r.length; h++) {
        if (isSpike[i + h]) lastSpike = i + h;
        cum += r[i + h]!; // directional cumulative return
        if (cum >= TP) { pnls.push(TP - spread); wins++; exited = true; i = i + h + 1; break; }
        if (cum <= -SL) { pnls.push(-SL - spread); exited = true; i = i + h + 1; break; }
      }
      if (!exited) { pnls.push(cum - spread); if (cum > 0) wins++; i = i + maxHold; }
    }
    return { trades: pnls.length, wins, pnls };
  }

  const base = simulate(0);
  const evBase = base.pnls.reduce((s, v) => s + v, 0) / Math.max(base.trades, 1);
  const totalPnl = base.pnls.reduce((s, v) => s + v, 0);
  const meanP = evBase;
  const sd = Math.sqrt(base.pnls.reduce((s, v) => s + (v - meanP) ** 2, 0) / Math.max(base.trades - 1, 1));
  const skew = sd > 0 ? base.pnls.reduce((s, v) => s + ((v - meanP) / sd) ** 3, 0) / base.trades : 0;
  // equity-curve max drawdown
  let peak = 0, eq = 0, maxDD = 0;
  for (const p of base.pnls) { eq += p; if (eq > peak) peak = eq; if (peak - eq > maxDD) maxDD = peak - eq; }

  // Overdue test: EV as a function of "only enter when spike is overdue"
  const overdueEv: { q: number; ev: number; trades: number }[] = [];
  for (const mult of [0, 0.5, 1.0, 1.5, 2.0]) {
    const q = Math.round(meanInterval * mult);
    const s = simulate(q);
    overdueEv.push({ q, ev: s.pnls.reduce((a, v) => a + v, 0) / Math.max(s.trades, 1), trades: s.trades });
  }

  return {
    symbol, bars: n, spikeCount: spikeBars.length, meanIntervalBars: meanInterval,
    hazard, hazardSlope, driftSignStable,
    rider: { winRate: base.wins / Math.max(base.trades, 1), evPerTrade: evBase, totalPnl, skew, maxDD, trades: base.trades },
    overdueEv,
  };
}

function main(): void {
  const symbolsArg = getArg('symbols') ?? getArg('symbol') ?? 'BOOM500,BOOM1000,CRASH500,CRASH1000';
  const spikeK = parseFloat(getArg('spike-k') ?? '8');
  const spreadBp = parseFloat(getArg('spread-bp') ?? '2');
  const symbols = symbolsArg.split(',').map((s) => s.trim()).filter(Boolean);

  for (const sym of symbols) {
    const p = path.resolve(__dirname, '..', 'data', `${sym}_1m.json`);
    if (!fs.existsSync(p)) { console.log(`${sym}: no 1m data`); continue; }
    const candles = JSON.parse(fs.readFileSync(p, 'utf-8')) as Candle[];
    const a = analyze(sym, candles, spikeK, spreadBp);

    console.log(`\n========== ${a.symbol} (${a.bars.toLocaleString()} 1m bars) ==========`);
    console.log(`Spikes detected: ${a.spikeCount} | mean inter-spike interval: ${a.meanIntervalBars.toFixed(1)} bars`);
    console.log(`HAZARD (P[spike at gap k | survived to k]):`);
    console.log('  ' + a.hazard.map((h) => `k=${h.k}:${h.h.toFixed(4)}`).join('  '));
    console.log(`  => ${a.hazardSlope}`);
    console.log(`DRIFT: ${a.driftSignStable}`);
    console.log(`SPIKE-RIDER (with-spike direction, TP=12×range, SL=3×range, spread=${spreadBp}bp):`);
    console.log(`  trades=${a.rider.trades} winRate=${(a.rider.winRate * 100).toFixed(1)}% EV/trade=${(a.rider.evPerTrade * 1e4).toFixed(2)}bp totalPnl=${(a.rider.totalPnl * 100).toFixed(1)}% skew=${a.rider.skew.toFixed(2)} maxDD=${(a.rider.maxDD * 100).toFixed(1)}%`);
    console.log(`  OVERDUE entry test (EV/trade by min-bars-since-spike):`);
    console.log('  ' + a.overdueEv.map((o) => `q=${o.q}:${(o.ev * 1e4).toFixed(2)}bp(n=${o.trades})`).join('  '));
  }

  console.log(`\nINTERPRETATION:`);
  console.log(`  • Flat hazard => memoryless => "overdue" entries give NO EV improvement => no timing edge.`);
  console.log(`  • Rising hazard + rising overdue-EV => a REAL structural timing edge a trader could exploit.`);
  console.log(`  • Spike-rider EV ≈ -spread with positive skew => high-win-rate "feels profitable" but is variance/ruin, not edge.`);
}

main();
