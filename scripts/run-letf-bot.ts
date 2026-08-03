#!/usr/bin/env tsx
/**
 * LETF close-flow — PAPER trading bot (PM2/Railway-compatible, standalone).
 *
 * EXPERIMENTAL SLEEVE — separate state, separate attribution, NOT part of the
 * session book. Mechanism: leveraged metal ETFs (AGQ/ZSL) rebalance
 * AUM x (L^2-L) x r_day into the 16:00 ET NAV strike; on large-move days the
 * final hour shows signed continuation (Todorov RoF 2024; BIS QR Mar-2026;
 * experiments/letf-close-flow.md). Effect is REGIME-DEPENDENT (2020, 2021,
 * 2026 — leveraged-retail episodes), hence the trailing kill-switch below.
 *
 * Rule (mirrors research-letf-close-strategy.ts, p95 config):
 *   sig = log(P15:00ET / prev-day P16:00ET) on silver.
 *   If |sig| >= p95 of trailing 250 |sig| values -> enter sign(sig) in the
 *   15:00-15:30 ET window, exit at the 16:00 ET mark. Max 1 trade/day.
 *   Paper friction 2bp/side (4bp RT, Bybit XAG maker+taker tier).
 *
 * Delay handling: the Yahoo feed lags ~10min (see run-metals-bot.ts NFP leg).
 * Marks are taken from the LAST BAR AT/BEFORE the mark minute using bar
 * timestamps, not wall clock, so the delayed feed yields the correct mark a
 * few minutes late. Entries therefore occur ~15:05-15:15 wall time.
 *
 * Kill-switch: after >=20 closed trades, if the trailing-20 mean net <= 0,
 * entries stop (REGIME-HALT logged); exits always run. Manual restart
 * decision only — this sleeve is a forward-record experiment, not a
 * validated edge.
 *
 * State: data/letf-bot-state.json. Threshold seed: data/letf-seed.json
 * (build with scripts/build-letf-seed.ts).
 *
 * Usage:
 *   npx tsx scripts/run-letf-bot.ts           # run forever (PM2)
 *   npx tsx scripts/run-letf-bot.ts --once    # single tick (testing)
 *   npx tsx scripts/run-letf-bot.ts --verbose
 */

import * as fs from 'fs';
import * as path from 'path';

const STATE_PATH = path.resolve(__dirname, '..', 'data', 'letf-bot-state.json');
// Seed ships with the image under scripts/ (Railway volume shadows /app/data).
const SEED_PATH = path.resolve(__dirname, 'letf-seed.json');
const TICK_MS = 30_000;
const QUOTE_STALE_MS = 15 * 60_000;
const FRICTION_SIDE = 0.0002; // 2bp/side paper (Bybit XAG perp maker+taker tier)
const LOOKBACK = 250;
const PCTILE = 0.95;
const KILL_TRAILING_N = 20;

const verbose = process.argv.includes('--verbose');
const once = process.argv.includes('--once');

function log(msg: string): void { console.log(`[${new Date().toISOString()}] ${msg}`); }
function vlog(msg: string): void { if (verbose) log(msg); }

interface TradeLog {
  side: 'long' | 'short';
  sig: number;
  threshold: number;
  entryPrice: number;
  exitPrice: number;
  entryTime: string;
  exitTime: string;
  pnlPct: number; // net of paper friction, PERCENT (metals convention)
}

interface Position { side: 'long' | 'short'; sig: number; threshold: number; entryPrice: number; entryTime: number }

interface BotState {
  createdAt: string;
  position: Position | null;
  trades: TradeLog[];
  totalPnlPct: number;
  absSigHistory: { day: string; absSig: number }[]; // rolling threshold input
  marks: { day: string; m1500?: number; m1600?: number; prev1600?: number; tradedToday?: boolean };
  regimeHalted?: boolean;
}

function loadState(): BotState {
  if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')) as BotState;
  const seed = fs.existsSync(SEED_PATH)
    ? (JSON.parse(fs.readFileSync(SEED_PATH, 'utf-8')) as { absSigHistory: { day: string; absSig: number }[] })
    : { absSigHistory: [] };
  if (!seed.absSigHistory.length) {
    log('WARNING: no seed history (data/letf-seed.json missing) — bot will not trade until 250 days accumulate. Run scripts/build-letf-seed.ts.');
  }
  return {
    createdAt: new Date().toISOString(),
    position: null,
    trades: [],
    totalPnlPct: 0,
    absSigHistory: seed.absSigHistory,
    marks: { day: '' },
  };
}
function saveState(s: BotState): void { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }

function nyParts(ts: number): { day: string; min: number; dow: number } {
  const y = new Date(ts).getUTCFullYear();
  const nth = (mo: number, n: number): number => {
    const dow = new Date(Date.UTC(y, mo, 1)).getUTCDay();
    return Date.UTC(y, mo, 1 + ((7 - dow) % 7) + (n - 1) * 7);
  };
  const summer = ts >= nth(2, 2) + 7 * 3_600_000 && ts < nth(10, 1) + 6 * 3_600_000;
  const d = new Date(ts + (summer ? -4 : -5) * 3_600_000);
  return { day: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() };
}

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
}

/** Latest silver bar at/before the given NY minute-of-day for today, from Yahoo 1m bars. */
async function fetchMarkAndLatest(): Promise<{ bars: { ts: number; close: number }[] } | null> {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/SI=F?interval=1m&range=1d';
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) return null;
    const json = await resp.json() as {
      chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
    };
    const r = json.chart?.result?.[0];
    const stamps = r?.timestamp ?? [];
    const closes = r?.indicators?.quote?.[0]?.close ?? [];
    const bars: { ts: number; close: number }[] = [];
    for (let i = 0; i < stamps.length; i++) {
      const c = closes[i];
      if (c !== null && c !== undefined && c > 0) bars.push({ ts: stamps[i]! * 1000, close: c });
    }
    return { bars };
  } catch {
    return null;
  }
}

function lastAtOrBefore(bars: { ts: number; close: number }[], nyMinMark: number, day: string): number | undefined {
  let best: number | undefined;
  for (const b of bars) {
    const p = nyParts(b.ts);
    if (p.day === day && p.min <= nyMinMark && p.min > nyMinMark - 30) best = b.close;
  }
  return best;
}

function trailingMean(trades: TradeLog[], n: number): number {
  const xs = trades.slice(-n).map((t) => t.pnlPct);
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

async function tick(state: BotState): Promise<void> {
  const now = Date.now();
  const ny = nyParts(now);

  const feed = await fetchMarkAndLatest();
  if (!feed || !feed.bars.length) { vlog('feed unavailable'); return; }
  const latest = feed.bars[feed.bars.length - 1]!;
  if (now - latest.ts > QUOTE_STALE_MS + 10 * 60_000) { vlog('quotes stale (market closed?)'); return; }

  // day rollover: archive yesterday's 16:00 mark as prev1600, record |sig| history
  if (state.marks.day !== ny.day) {
    if (state.marks.day && state.marks.m1600) {
      state.marks.prev1600 = state.marks.m1600;
    }
    state.marks = { day: ny.day, prev1600: state.marks.prev1600, tradedToday: false };
  }

  // continuously refresh today's marks from bar timestamps (delay-safe)
  if (ny.min >= 900) {
    const m = lastAtOrBefore(feed.bars, 900, ny.day);
    if (m !== undefined) state.marks.m1500 = m;
  }
  if (ny.min >= 960) {
    const m = lastAtOrBefore(feed.bars, 960, ny.day);
    if (m !== undefined) state.marks.m1600 = m;
  }

  // --- Exit: at/after the 16:00 ET mark (delayed feed shows it ~16:05-16:15) ---
  if (state.position && ny.min >= 962 && state.marks.m1600 !== undefined) {
    const pos = state.position;
    const exitPrice = state.marks.m1600;
    const raw = pos.side === 'long' ? Math.log(exitPrice / pos.entryPrice) : Math.log(pos.entryPrice / exitPrice);
    const pnl = raw - 2 * FRICTION_SIDE;
    state.trades.push({
      side: pos.side,
      sig: pos.sig,
      threshold: pos.threshold,
      entryPrice: pos.entryPrice,
      exitPrice,
      entryTime: new Date(pos.entryTime).toISOString(),
      exitTime: new Date(now).toISOString(),
      pnlPct: Math.round(pnl * 1e6) / 1e4,
    });
    state.totalPnlPct = Math.round((state.totalPnlPct + pnl * 100) * 1e4) / 1e4;
    state.position = null;
    log(`CLOSE ${pos.side} @ ${exitPrice.toFixed(3)} pnl=${(pnl * 100).toFixed(3)}% total=${state.totalPnlPct.toFixed(2)}%`);
    if (state.trades.length >= KILL_TRAILING_N && trailingMean(state.trades, KILL_TRAILING_N) <= 0 && !state.regimeHalted) {
      state.regimeHalted = true;
      log(`REGIME-HALT: trailing-${KILL_TRAILING_N} mean net <= 0 — entries stopped pending manual review (the close-flow effect is regime-dependent by design)`);
    }
  }

  // safety: stranded position (bot was down through the exit) — flatten at latest
  if (state.position && now - state.position.entryTime > 6 * 3_600_000) {
    const pos = state.position;
    const exitPrice = latest.close;
    const raw = pos.side === 'long' ? Math.log(exitPrice / pos.entryPrice) : Math.log(pos.entryPrice / exitPrice);
    const pnl = raw - 2 * FRICTION_SIDE;
    state.trades.push({
      side: pos.side, sig: pos.sig, threshold: pos.threshold, entryPrice: pos.entryPrice, exitPrice,
      entryTime: new Date(pos.entryTime).toISOString(), exitTime: new Date(now).toISOString(),
      pnlPct: Math.round(pnl * 1e6) / 1e4,
    });
    state.totalPnlPct = Math.round((state.totalPnlPct + pnl * 100) * 1e4) / 1e4;
    state.position = null;
    log(`CLOSE [STALE] ${pos.side} @ ${exitPrice.toFixed(3)} pnl=${(pnl * 100).toFixed(3)}%`);
  }

  // --- Signal + entry: 15:00-15:30 ET window (delayed feed => ~15:05-15:30 wall) ---
  if (
    !state.position && !state.marks.tradedToday && !state.regimeHalted
    && ny.dow >= 1 && ny.dow <= 5
    && ny.min >= 902 && ny.min <= 930
    && state.marks.m1500 !== undefined && state.marks.prev1600 !== undefined
    && state.absSigHistory.length >= LOOKBACK
  ) {
    const sig = Math.log(state.marks.m1500 / state.marks.prev1600);
    const threshold = quantile(state.absSigHistory.slice(-LOOKBACK).map((x) => x.absSig), PCTILE);
    // record today's |sig| once (threshold input for future days; no same-day feedback)
    if (!state.absSigHistory.find((x) => x.day === ny.day) && isFinite(sig) && sig !== 0) {
      state.absSigHistory.push({ day: ny.day, absSig: Math.abs(sig) });
      if (state.absSigHistory.length > LOOKBACK + 50) state.absSigHistory = state.absSigHistory.slice(-LOOKBACK);
    }
    if (isFinite(sig) && Math.abs(sig) >= threshold) {
      const side = sig > 0 ? 'long' : 'short';
      state.position = { side, sig, threshold, entryPrice: latest.close, entryTime: now };
      state.marks.tradedToday = true;
      log(`OPEN ${side} @ ${latest.close.toFixed(3)} sig=${(sig * 1e4).toFixed(0)}bp thr=${(threshold * 1e4).toFixed(0)}bp`);
    } else {
      state.marks.tradedToday = true; // decision made once per day
      vlog(`no trade: |sig|=${(Math.abs(sig) * 1e4).toFixed(0)}bp < thr=${(threshold * 1e4).toFixed(0)}bp`);
    }
  }

  saveState(state);
  vlog(`tick done — pos=${state.position ? 1 : 0} trades=${state.trades.length} total=${state.totalPnlPct.toFixed(2)}% halted=${!!state.regimeHalted}`);
}

async function main(): Promise<void> {
  log(`LETF close-flow paper bot starting (state: ${STATE_PATH})${once ? ' [single tick]' : ''}`);
  const state = loadState();
  log(`  trades=${state.trades.length} total=${state.totalPnlPct.toFixed(2)}% seedDays=${state.absSigHistory.length} halted=${!!state.regimeHalted}`);
  if (once) { await tick(state); return; }
  for (;;) {
    try { await tick(state); } catch (err) { log(`tick error: ${err}`); }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

main().catch((err) => { console.error('LETF bot crashed:', err); process.exit(1); });
