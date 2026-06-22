#!/usr/bin/env tsx
/**
 * NFP bot-logic replay — confirm run-metals-bot.ts's NFP leg BEFORE its first
 * live firing (Jul 3), by replaying its exact decision path over every
 * historical first-Friday 2015–2026.
 *
 * Bot path (run-metals-bot.ts): first tick in [08:30,08:35] ET records the
 * pre-print mark from the FEED (Yahoo, ~10min delayed); first tick in
 * [09:00,09:10] enters in sign(feed − mark) at the feed price; first tick
 * ≥12:00 exits. Feed delay means the bot sees bar (t − delay) at tick t.
 *
 * Backtest reference (leg F, analyze-combo-portfolio): sign(08:30→09:00 ET
 * exact marks), hold 09:00→12:00 exact marks.
 *
 * We replay at delay=0 and delay=10min and report: events traded/missed,
 * direction agreement with the reference, fill slippage vs reference, and
 * whether the leg's aggregate edge survives the bot's timing (friction
 * 0.45bp/side both).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function tstat(xs: number[]): number { const s = std(xs); return s > 0 ? mean(xs) / (s / Math.sqrt(xs.length)) : 0; }
function fmt(x: number, dp = 2): string { return x.toFixed(dp); }

function nthSundayUTC(year: number, month: number, n: number): number {
  const dow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return Date.UTC(year, month, 1 + ((7 - dow) % 7) + (n - 1) * 7);
}
function nyOffsetHours(ts: number): number {
  const y = new Date(ts).getUTCFullYear();
  const start = nthSundayUTC(y, 2, 2) + 7 * 3_600_000;
  const end = nthSundayUTC(y, 10, 1) + 6 * 3_600_000;
  return ts >= start && ts < end ? -4 : -5;
}
function firstFriday(year: number, month: number): string {
  const dow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return new Date(Date.UTC(year, month, 1 + ((5 - dow + 7) % 7))).toISOString().slice(0, 10);
}

const FRICTION = 0.000045;

interface EventResult { date: string; dir: 1 | -1; entry: number; exit: number; pnl: number }

function main(): void {
  console.log('Loading gold 1m...');
  const load = (names: string[]): Candle[] => {
    let out: Candle[] = [];
    for (const n of names) out = out.concat(JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', n), 'utf-8')) as Candle[]);
    return out.sort((a, b) => a.timestamp - b.timestamp);
  };
  const gold = load(['XAUUSD_1m_holdout.json', 'XAUUSD_1m.json']);

  // NY-minute marks for NFP days only
  const nfpDates = new Set<string>();
  for (let y = 2015; y <= 2026; y++) for (let m = 0; m < 12; m++) nfpDates.add(firstFriday(y, m));
  const marks = new Map<string, Map<number, number>>(); // nyDate → nyMin → close
  for (const c of gold) {
    const local = c.timestamp + nyOffsetHours(c.timestamp) * 3_600_000;
    const d = new Date(local);
    const day = d.toISOString().slice(0, 10);
    if (!nfpDates.has(day)) continue;
    let m = marks.get(day);
    if (!m) { m = new Map(); marks.set(day, m); }
    m.set(d.getUTCHours() * 60 + d.getUTCMinutes(), c.close);
  }

  /** feed price visible at NY-minute t with the given delay: latest bar ≤ t−delay (≤15m stale window like the bot) */
  const feedAt = (m: Map<number, number>, t: number, delay: number): number | null => {
    for (let k = t - delay; k >= t - delay - 15; k--) {
      const p = m.get(k);
      if (p !== undefined) return p;
    }
    return null;
  };

  /** replay the bot's tick loop (1-min ticks) for one day */
  const replayBot = (m: Map<number, number>, delay: number): EventResult | { miss: string } => {
    let mark: number | null = null;
    let entry: number | null = null;
    let dir: 1 | -1 = 1;
    let exit: number | null = null;
    for (let t = 8 * 60 + 30; t <= 12 * 60 + 15; t++) {
      const p = feedAt(m, t, delay);
      if (p === null) continue;
      if (mark === null && t >= 8 * 60 + 30 && t <= 8 * 60 + 35) mark = p;
      if (mark !== null && entry === null && t >= 9 * 60 && t <= 9 * 60 + 10 && p !== mark) {
        dir = p > mark ? 1 : -1;
        entry = p;
      }
      if (entry !== null && t >= 12 * 60) { exit = p; break; }
    }
    if (mark === null) return { miss: 'no mark in 08:30-08:35' };
    if (entry === null) return { miss: 'no entry in 09:00-09:10' };
    if (exit === null) return { miss: 'no exit tick' };
    return { date: '', dir, entry, exit, pnl: dir * Math.log(exit / entry) - 2 * FRICTION };
  };

  /** backtest reference: exact marks */
  const reference = (m: Map<number, number>): EventResult | { miss: string } => {
    const p0830 = feedAt(m, 8 * 60 + 30, 0);
    const p0900 = feedAt(m, 9 * 60, 0);
    const p1200 = feedAt(m, 12 * 60, 0);
    if (!p0830 || !p0900 || !p1200 || p0900 === p0830) return { miss: 'marks' };
    const dir: 1 | -1 = p0900 > p0830 ? 1 : -1;
    return { date: '', dir, entry: p0900, exit: p1200, pnl: dir * Math.log(p1200 / p0900) - 2 * FRICTION };
  };

  for (const delay of [0, 10]) {
    const botRes: EventResult[] = [];
    const refRes: EventResult[] = [];
    let missed = 0;
    let dirMatch = 0;
    let compared = 0;
    const slippage: number[] = [];
    for (const [day, m] of [...marks.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const b = replayBot(m, delay);
      const r = reference(m);
      if ('miss' in b) { missed++; continue; }
      b.date = day;
      botRes.push(b);
      if (!('miss' in r)) {
        r.date = day;
        refRes.push(r);
        compared++;
        if (b.dir === r.dir) dirMatch++;
        slippage.push(b.dir * Math.log(r.entry / b.entry)); // + = bot entered better
      }
    }
    const pnls = botRes.map((x) => x.pnl);
    const refPnls = refRes.map((x) => x.pnl);
    console.log(`\n=== feed delay ${delay} min ===`);
    console.log(`events: ${botRes.length} traded, ${missed} missed | direction match vs reference: ${dirMatch}/${compared} (${fmt((dirMatch / Math.max(1, compared)) * 100, 0)}%)`);
    console.log(`bot:       mean=${fmt(mean(pnls) * 1e4, 1)}bp t=${fmt(tstat(pnls))} total=${fmt(pnls.reduce((s, x) => s + x, 0) * 100, 2)}% WR=${fmt((pnls.filter((x) => x > 0).length / pnls.length) * 100, 0)}%`);
    console.log(`reference: mean=${fmt(mean(refPnls) * 1e4, 1)}bp t=${fmt(tstat(refPnls))} total=${fmt(refPnls.reduce((s, x) => s + x, 0) * 100, 2)}%`);
    console.log(`entry slippage bot vs ref: mean=${fmt(mean(slippage) * 1e4, 2)}bp (+ = bot better)`);
  }
}

main();
