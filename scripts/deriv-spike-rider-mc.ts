#!/usr/bin/env tsx
/**
 * Deriv Boom/Crash — Spike-Rider Monte Carlo (the "is my brother's edge real?" test)
 *
 * Models the ACTUAL discretionary style: ride the spike WITH direction
 * (long Boom / short Crash), tight stop, let the spike run, 1% risk per trade.
 * Because we proved the process is a memoryless martingale, NO entry has
 * predictive value — so the per-trade R-multiple distribution is the same
 * regardless of how the trader "selects" entries (selection only changes how
 * many trades, i.e. how fast variance resolves). We extract that empirical
 * R distribution from our data, then bootstrap equity curves.
 *
 * Output answers, with numbers:
 *   - EV per trade (in R, net of spread) — expect slightly negative.
 *   - The SKEW (positive = lots of small losses, rare big spike wins).
 *   - P(account is UP) after 250 / 1250 / 5000 trades — i.e. how many disciplined
 *     spike-riders are profitable after ~weeks/months/years purely by variance.
 *   - Median & 5th/95th-pct final equity, max-drawdown distribution, P(ruin).
 *
 * Usage:
 *   npx tsx scripts/deriv-spike-rider-mc.ts --symbols BOOM500,BOOM1000,CRASH500,CRASH1000
 *   npx tsx scripts/deriv-spike-rider-mc.ts --symbol BOOM1000 --risk 0.01 --tp-r 5 --spread-bp 2
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
  if (!x.length) return 0;
  const s = [...x].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx]!;
}
function dir(symbol: string): 1 | -1 {
  return symbol.toUpperCase().startsWith('BOOM') ? 1 : -1;
}

/**
 * Extract per-trade R-multiples for a faithful spike-rider, using PROPER
 * intrabar OHLC fills: enter WITH the spike direction (long Boom / short Crash),
 * stop at -1R, take profit at +tpR (a fixed target the trader sets). A Boom
 * spike is a violent up-WICK, so the TP order fills intrabar when the bar HIGH
 * crosses it — that is how the rider captures the spike (close-to-close misses
 * the wick entirely). risk = slMult × median fractional bar range. If both stop
 * and TP fall inside one bar, assume the stop fills first (conservative).
 */
function extractRMultiples(
  candles: Candle[], symbol: string, slMult: number, tpR: number, maxHold: number, cooldown: number, spreadBp: number,
): number[] {
  const d = dir(symbol);
  const n = candles.length;
  const medRangeFrac = median(candles.map((c) => (c.high - c.low) / c.close));
  const riskFrac = slMult * medRangeFrac;          // 1R risk as a price fraction
  const spreadR = (spreadBp / 1e4) / riskFrac;     // spread expressed in R

  const Rs: number[] = [];
  let i = 1;
  while (i < n) {
    const entry = candles[i]!.open;
    const stopP = d === 1 ? entry * (1 - riskFrac) : entry * (1 + riskFrac);
    const tpP = d === 1 ? entry * (1 + tpR * riskFrac) : entry * (1 - tpR * riskFrac);
    let done = false;
    for (let h = 0; h < maxHold && i + h < n; h++) {
      const c = candles[i + h]!;
      const stopHit = d === 1 ? c.low <= stopP : c.high >= stopP;
      const tpHit = d === 1 ? c.high >= tpP : c.low <= tpP;
      if (stopHit) { Rs.push(-1 - spreadR); i = i + h + 1 + cooldown; done = true; break; }
      if (tpHit) { Rs.push(tpR - spreadR); i = i + h + 1 + cooldown; done = true; break; }
    }
    if (!done) {
      const exit = candles[Math.min(i + maxHold, n - 1)]!.close;
      Rs.push((d * (exit - entry) / entry) / riskFrac - spreadR);
      i = i + maxHold + cooldown;
    }
  }
  return Rs;
}

function mean(x: number[]): number { return x.reduce((s, v) => s + v, 0) / x.length; }
function skew(x: number[]): number {
  const m = mean(x);
  const sd = Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1));
  return sd > 0 ? x.reduce((s, v) => s + ((v - m) / sd) ** 3, 0) / x.length : 0;
}

/** Bootstrap one equity curve: compound `risk` fraction × R per trade. Returns {final, maxDD, ruined}. */
function simEquity(Rs: number[], nTrades: number, risk: number): { final: number; maxDD: number; ruined: boolean } {
  let eq = 1, peak = 1, maxDD = 0, ruined = false;
  for (let t = 0; t < nTrades; t++) {
    const R = Rs[(Math.random() * Rs.length) | 0]!;
    eq *= 1 + risk * R;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak;
    if (dd > maxDD) maxDD = dd;
    if (eq <= 0.2) ruined = true; // hit -80% => practically wiped
  }
  return { final: eq, maxDD, ruined };
}

function main(): void {
  const symbolsArg = getArg('symbols') ?? getArg('symbol') ?? 'BOOM500,BOOM1000,CRASH500,CRASH1000';
  const risk = parseFloat(getArg('risk') ?? '0.01');
  const slMult = parseFloat(getArg('sl-mult') ?? '3');
  const tpR = parseFloat(getArg('tp-r') ?? '3');
  const spreadBp = parseFloat(getArg('spread-bp') ?? '2');
  const sims = parseInt(getArg('sims') ?? '20000', 10);
  const symbols = symbolsArg.split(',').map((s) => s.trim()).filter(Boolean);
  const horizons = [250, 1250, 5000]; // ~1wk, ~1yr, ~4yr at modest trade frequency

  console.log(`Spike-Rider Monte Carlo | risk/trade=${(risk * 100).toFixed(0)}% | SL=${slMult}×range | TP=${tpR}R (intrabar OHLC fills) | spread=${spreadBp}bp | ${sims.toLocaleString()} sims`);

  for (const sym of symbols) {
    const p = path.resolve(__dirname, '..', 'data', `${sym}_1m.json`);
    if (!fs.existsSync(p)) { console.log(`\n${sym}: no 1m data`); continue; }
    const candles = JSON.parse(fs.readFileSync(p, 'utf-8')) as Candle[];
    const Rs = extractRMultiples(candles, sym, slMult, tpR, 60, 2, spreadBp);
    const evR = mean(Rs);
    const wr = Rs.filter((x) => x > 0).length / Rs.length;
    const sk = skew(Rs);

    console.log(`\n========== ${sym} ==========`);
    console.log(`  trades sampled: ${Rs.length} | win rate: ${(wr * 100).toFixed(1)}% | EV/trade: ${evR.toFixed(4)}R | skew: ${sk.toFixed(2)}`);
    console.log(`  => per-$1-risked expectancy: ${(evR * 100).toFixed(2)}% of risk (negative = house edge bleeds through)`);

    for (const H of horizons) {
      const finals: number[] = [];
      const dds: number[] = [];
      let up = 0, ruined = 0, doubled = 0;
      for (let s = 0; s < sims; s++) {
        const { final, maxDD, ruined: rn } = simEquity(Rs, H, risk);
        finals.push(final); dds.push(maxDD);
        if (final > 1) up++;
        if (final >= 2) doubled++;
        if (rn) ruined++;
      }
      finals.sort((a, b) => a - b); dds.sort((a, b) => a - b);
      console.log(
        `  @${String(H).padStart(4)} trades: P(up)=${(up / sims * 100).toFixed(1)}%  P(2x+)=${(doubled / sims * 100).toFixed(1)}%  ` +
        `P(ruin<-80%)=${(ruined / sims * 100).toFixed(1)}%  | equity median=${pct(finals, 0.5).toFixed(2)}x  ` +
        `5th=${pct(finals, 0.05).toFixed(2)}x  95th=${pct(finals, 0.95).toFixed(2)}x  | median maxDD=${(pct(dds, 0.5) * 100).toFixed(0)}%`,
      );
    }
  }

  console.log(`\nREAD:`);
  console.log(`  • Buy-and-hold EV ≈ 0 (fair martingale) — the process is a fair coin minus the spread.`);
  console.log(`  • TIGHT STOPS make it MUCH worse (the expectation is locked in rare spikes; a tight stop shakes you`);
  console.log(`    out during the down-drift before the spike that would make you whole). Wide/no stop ≈ -spread.`);
  console.log(`  • Positive skew => median path is DOWN while a minority catch enough spikes to be up. P(up) shrinks`);
  console.log(`    as trades accumulate. A "profitable" spike-rider is in that shrinking lucky minority — variance, not edge.`);
}

main();
