#!/usr/bin/env tsx
/**
 * Session book — PAPER trading bot (PM2-compatible).
 *
 * Deployable legs (experiments/execution-audit.md, venue-realistic costs):
 *   - Au+Ag overnight long: enter 18:05–19:30 ET (CME reopen anchor), exit 07:01+ UTC.
 *   - Friday weekend leg: enter 20:00 UTC Friday, exit Monday morning.
 *   - Gold fix-short: short 14:30 London (refined window), cover 15:00 London (DST-aware).
 *   - Silver own-fix short: 11:00→12:00 London.
 *   - EUR morning short: 09:00→12:00 UTC (Breedon-Ranaldo).
 *   - US500 overnight: 16:00 ET close → 09:31 ET open (leg J).
 *   - Gold NFP momentum: sign(08:30→09:00 ET) held 09:00→12:00 ET, NFP Fridays (leg F).
 *   Cut by audit: AM-fix bounce (marginal), EUR-h22 (dead at rollover costs).
 *
 * Paper friction is VENUE-REALISTIC per leg (execution audit), not the
 * backtest's futures-tier assumption — paper PnL should track deployable PnL.
 *
 * Feed: Yahoo v8 chart (keyless), 1m bars; quotes older than 15 minutes are
 * treated as market-closed and no action is taken.
 *
 * State: data/metals-bot-state.json (positions, trade log, running PnL).
 *
 * Usage:
 *   npx tsx scripts/run-metals-bot.ts             # run forever (PM2)
 *   npx tsx scripts/run-metals-bot.ts --once      # single tick (testing)
 *   npx tsx scripts/run-metals-bot.ts --verbose
 */

import * as fs from 'fs';
import * as path from 'path';
import { readBookGovernanceSignal, BOOK_GOVERNANCE_CONFIG } from '../src/lib/bot/book-governance';
import { isStrandedHold } from '../src/lib/bot/metals-stale';

const STATE_PATH = path.resolve(__dirname, '..', 'data', 'metals-bot-state.json');
const TICK_MS = 30_000;
// Yahoo futures feed is ~10min delayed; jitter test showed minutes 1-60 are a
// flat plateau, so delayed fills are unbiased for paper purposes.
const QUOTE_STALE_MS = 15 * 60_000;

// Venue-realistic per-side friction (experiments/execution-audit.md):
// MGC 0.55bp overnight / 0.45bp RTH windows; SIL 2bp overnight / 1bp fix
// window; MES 0.5bp; EURUSD raw-spread 0.35bp London hours.
function frictionFor(leg: string, metal: string): number {
  if (leg === 'overnight' || leg === 'weekend') return metal === 'gold' ? 0.000055 : 0.0002;
  if (leg === 'fix-short' || leg === 'nfp-mom' || leg === 'amfix-long') return 0.000045;
  if (leg === 'agfix-short') return 0.0001;
  if (leg === 'eur-morning-short' || leg === 'eur-h22-long') return 0.000035;
  if (leg === 'us500-overnight') return 0.00005;
  return 0.0001;
}
// COMEX front-month futures + FX spot + CME e-mini — the actual deployment instruments
const YAHOO: Record<string, string> = { gold: 'GC=F', silver: 'SI=F', eurusd: 'EURUSD=X', us500: 'ES=F' };

type Instrument = 'gold' | 'silver' | 'eurusd' | 'us500';

interface Position {
  leg: 'overnight' | 'weekend' | 'fix-short' | 'amfix-long' | 'agfix-short' | 'nfp-mom' | 'eur-morning-short' | 'eur-h22-long' | 'us500-overnight';
  metal: Instrument;
  side: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  /**
   * Last observed market price for this instrument, refreshed every tick.
   * The bot already fetches these quotes to decide exits; persisting the latest
   * one is what lets the dashboard show unrealised P&L on an open session leg
   * instead of "no live mark for this sleeve". Read-only for the strategy —
   * nothing here influences entries or exits.
   */
  lastPrice?: number;
  lastPriceTime?: number;
}

interface TradeLog {
  leg: string;
  metal: string;
  side: string;
  entryPrice: number;
  exitPrice: number;
  entryTime: string;
  exitTime: string;
  pnlPct: number; // net of paper friction AND risk weight (see legWeight)
  weight?: number; // risk weight applied; absent on pre-weighting trades (treat as 1)
  stale?: boolean; // held beyond leg cap (downtime-stranded) → exclude from strategy attribution
}

interface BotState {
  createdAt: string;
  positions: Position[];
  trades: TradeLog[];
  totalPnlPct: number;
  /** scratch: NFP-Friday 08:30 ET gold mark for the momentum signal */
  nfpSignal?: { date: string; price0830: number } | null;
}

const verbose = process.argv.includes('--verbose');
const once = process.argv.includes('--once');

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
function vlog(msg: string): void {
  if (verbose) log(msg);
}

function loadState(): BotState {
  if (fs.existsSync(STATE_PATH)) {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  }
  return { createdAt: new Date().toISOString(), positions: [], trades: [], totalPnlPct: 0 };
}
function saveState(s: BotState): void {
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

// --- London DST (last Sun Mar → last Sun Oct) ---
function lastSundayUTC(year: number, month: number): number {
  const last = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay());
}
function nyHour(ts: number): { h: number; m: number } {
  const y = new Date(ts).getUTCFullYear();
  const nth = (mo: number, n: number): number => { const dow = new Date(Date.UTC(y, mo, 1)).getUTCDay(); return Date.UTC(y, mo, 1 + ((7 - dow) % 7) + (n - 1) * 7); };
  const summer = ts >= nth(2, 2) + 7 * 3_600_000 && ts < nth(10, 1) + 6 * 3_600_000;
  const d = new Date(ts + (summer ? -4 : -5) * 3_600_000);
  return { h: d.getUTCHours(), m: d.getUTCMinutes() };
}
function londonHour(ts: number): number {
  const y = new Date(ts).getUTCFullYear();
  const summer = ts >= lastSundayUTC(y, 2) + 3_600_000 && ts < lastSundayUTC(y, 9) + 3_600_000;
  return new Date(ts + (summer ? 1 : 0) * 3_600_000).getUTCHours();
}
function isFirstFriday(d: Date): boolean {
  return d.getUTCDay() === 5 && d.getUTCDate() <= 7;
}

// --- Quote feed ---
async function fetchQuote(metal: Instrument): Promise<{ price: number; ts: number } | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO[metal]!)}?interval=1m&range=1d`;
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) return null;
    const json = await resp.json() as {
      chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
    };
    const r = json.chart?.result?.[0];
    const stamps = r?.timestamp ?? [];
    const closes = r?.indicators?.quote?.[0]?.close ?? [];
    for (let i = stamps.length - 1; i >= 0; i--) {
      const c = closes[i];
      if (c !== null && c !== undefined && c > 0) {
        return { price: c, ts: stamps[i]! * 1000 };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function openPosition(state: BotState, p: Position): void {
  state.positions.push(p);
  log(`OPEN ${p.leg} ${p.side} ${p.metal} @ ${p.entryPrice.toFixed(3)}`);
}

/**
 * Each side of a correlated pair carries half a unit of risk, so the PAIR is one
 * bet rather than two.
 *
 * WHY: the gold and silver `overnight` legs enter within seconds of each other
 * and exit on the SAME timestamp every night — they are one directional metals
 * bet booked at double size. Live evidence (2026-07-30, 21 closed trades): the
 * pair alone was -2.454% while every other leg combined was +0.511%, dragging the
 * book to -1.943%. The three pair-nights were -2.782%, +1.792%, -1.464% — gold and
 * silver moved the same way every time, so the second leg adds size, not
 * diversification.
 *
 * This is a SIZING change only: it does not alter which trades are taken or when
 * they exit, so the underlying session edge needs no re-validation.
 */
export const CORRELATED_PAIR_WEIGHT = 0.5;

/** Legs that run gold AND silver simultaneously as a single correlated bet. */
const CORRELATED_PAIR_LEGS = new Set(['overnight', 'weekend']);

/** Risk weight for a leg/instrument. 1 = one full unit of risk. */
export function legWeight(leg: string, metal: string): number {
  if (CORRELATED_PAIR_LEGS.has(leg) && (metal === 'gold' || metal === 'silver')) {
    return CORRELATED_PAIR_WEIGHT;
  }
  return 1;
}

function closePosition(state: BotState, pos: Position, exitPrice: number, stale = false): void {
  const raw = pos.side === 'long'
    ? Math.log(exitPrice / pos.entryPrice)
    : Math.log(pos.entryPrice / exitPrice);
  const weight = legWeight(pos.leg, pos.metal);
  const pnl = (raw - 2 * frictionFor(pos.leg, pos.metal)) * weight;
  state.trades.push({
    leg: pos.leg,
    metal: pos.metal,
    side: pos.side,
    entryPrice: pos.entryPrice,
    exitPrice,
    entryTime: new Date(pos.entryTime).toISOString(),
    exitTime: new Date().toISOString(),
    pnlPct: Math.round(pnl * 1e6) / 1e4,
    // Risk weight applied to this fill. Absent on trades booked before
    // correlated-pair sizing existed — treat a missing value as 1.
    weight,
    ...(stale ? { stale: true } : {}),
  });
  state.totalPnlPct = Math.round((state.totalPnlPct + pnl * 100) * 1e4) / 1e4;
  state.positions = state.positions.filter((x) => x !== pos);
  log(`CLOSE${stale ? ' [STALE]' : ''} ${pos.leg} ${pos.metal} @ ${exitPrice.toFixed(3)} pnl=${(pnl * 100).toFixed(3)}% total=${state.totalPnlPct.toFixed(2)}%`);
}

async function tick(state: BotState): Promise<void> {
  const now = Date.now();
  const d = new Date(now);
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  const dow = d.getUTCDay();
  const ldnHour = londonHour(now);

  // Book-level governance: fail-open (null ⇒ trade as normal).
  // REDUCE-ONLY: bookHalted blocks new-leg OPENS only; exits/closes below always run.
  // De-risk (×0.5 multiplier) is NOT wired here — session legs are fixed-notional,
  // so the sizing multiplier cannot be applied cleanly. Deferred.
  const bookSignal = readBookGovernanceSignal(
    path.resolve(__dirname, '..', 'data'),
    now,
    BOOK_GOVERNANCE_CONFIG.signalMaxAgeMs,
  );
  const bookHalted = bookSignal?.action === 'halt';
  if (bookHalted) {
    log(`[BOOK-HALT] new session legs blocked — book governance halt: ${bookSignal!.reason}`);
  }

  const quotes: Partial<Record<Instrument, { price: number; ts: number }>> = {};
  for (const metal of ['gold', 'silver', 'eurusd', 'us500'] as const) {
    const q = await fetchQuote(metal);
    if (q && now - q.ts <= QUOTE_STALE_MS) quotes[metal] = q;
    else vlog(`${metal}: quote stale/unavailable (market closed?)`);
  }

  // Refresh the live mark on every open position so the dashboard can show
  // unrealised P&L. Purely observational — exits are still decided by the clock.
  for (const pos of state.positions) {
    const q = quotes[pos.metal];
    if (q) {
      pos.lastPrice = q.price;
      pos.lastPriceTime = q.ts;
    }
  }

  const overnightOpen = (metal: 'gold' | 'silver') =>
    state.positions.find((p) => p.metal === metal && (p.leg === 'overnight' || p.leg === 'weekend'));

  // --- Exits first (07:01–19:59 UTC, min 5h hold) ---
  for (const pos of [...state.positions]) {
    const q = quotes[pos.metal];
    if (!q) continue;
    // Downtime guard: any position held far beyond its leg's sane window is
    // stranded (the bot was down through its normal exit). Flatten it NOW at
    // market regardless of window, and flag it stale so its drift is excluded
    // from strategy attribution. Dormant in normal operation.
    if (isStrandedHold(pos.leg, now - pos.entryTime)) {
      closePosition(state, pos, q.price, true);
      continue;
    }
    if ((pos.leg === 'overnight' || pos.leg === 'weekend')
      && utcMin >= 7 * 60 + 1 && utcMin < 20 * 60
      && now - pos.entryTime >= 5 * 3_600_000) {
      closePosition(state, pos, q.price);
    }
    if (pos.leg === 'fix-short' && ldnHour >= 15) {
      closePosition(state, pos, q.price);
    }
    // AM-fix bounce exits 11:30 London; silver own-fix short exits 12:00 London
    if (pos.leg === 'amfix-long' && (ldnHour > 11 || (ldnHour === 11 && d.getUTCMinutes() >= 30))) {
      closePosition(state, pos, q.price);
    }
    if (pos.leg === 'agfix-short' && ldnHour >= 12) {
      closePosition(state, pos, q.price);
    }
    // EUR legs (UTC clock): morning short closes 12:00, h22 long closes 23:00
    if (pos.leg === 'eur-morning-short' && d.getUTCHours() >= 12 && d.getUTCHours() < 20) {
      closePosition(state, pos, q.price);
    }
    if (pos.leg === 'eur-h22-long' && d.getUTCHours() >= 23) {
      closePosition(state, pos, q.price);
    }
    // US500 overnight: exit at cash open 09:31 ET (min 5h hold covers weekends too)
    if (pos.leg === 'us500-overnight') {
      const nyx = nyHour(now);
      const nyxMin = nyx.h * 60 + nyx.m;
      if (nyxMin >= 9 * 60 + 31 && nyxMin < 15 * 60 && now - pos.entryTime >= 5 * 3_600_000) {
        closePosition(state, pos, q.price);
      }
    }
    // NFP momentum: exit ticks ≥12:12 ET (delayed feed then shows ~12:02,
    // matching the backtest's 12:00 exit mark)
    if (pos.leg === 'nfp-mom') {
      const nyx = nyHour(now);
      if (nyx.h * 60 + nyx.m >= 12 * 60 + 12) {
        closePosition(state, pos, q.price);
      }
    }
  }

  // --- Entries (skipped entirely on book-level hard-halt; exits above always run) ---
  const ny = nyHour(now);
  const nyMin = ny.h * 60 + ny.m;
  if (!bookHalted) {
    // Overnight (Sun–Thu): 18:05–19:30 ET (CME reopen anchor — execution-audit fix)
    if (dow >= 0 && dow <= 4 && nyMin >= 18 * 60 + 5 && nyMin <= 19 * 60 + 30) {
      for (const metal of ['gold', 'silver'] as const) {
        const q = quotes[metal];
        if (q && !overnightOpen(metal)) {
          openPosition(state, { leg: 'overnight', metal, side: 'long', entryPrice: q.price, entryTime: now });
        }
      }
    }
    // Weekend leg (Friday 20:00–20:45 UTC)
    if (dow === 5 && utcMin >= 20 * 60 && utcMin <= 20 * 60 + 45) {
      for (const metal of ['gold', 'silver'] as const) {
        const q = quotes[metal];
        if (q && !overnightOpen(metal)) {
          openPosition(state, { leg: 'weekend', metal, side: 'long', entryPrice: q.price, entryTime: now });
        }
      }
    }
    // Fix-short (gold): enter 14:30 London (refined window — gold-fix-refinement-validate.ts:
    // the 14:00→14:30 segment is zero-mean/high-variance, so the tighter 14:30→15:00 short
    // harvests the same drift with 22% less variance, Sharpe 0.48→0.63), cover 15:00. Weekdays.
    if (dow >= 1 && dow <= 5 && ldnHour === 14 && d.getUTCMinutes() >= 30) {
      const q = quotes.gold;
      const open = state.positions.find((p) => p.leg === 'fix-short');
      if (q && !open) {
        openPosition(state, { leg: 'fix-short', metal: 'gold', side: 'short', entryPrice: q.price, entryTime: now });
      }
    }
    // amfix-long leg removed: cut by execution audit (real-cost pricing)
    // Silver own-fix short: 11:00–12:00 London, weekdays (book leg I)
    if (dow >= 1 && dow <= 5 && ldnHour === 11) {
      const q = quotes.silver;
      const open = state.positions.find((p) => p.leg === 'agfix-short');
      if (q && !open) {
        openPosition(state, { leg: 'agfix-short', metal: 'silver', side: 'short', entryPrice: q.price, entryTime: now });
      }
    }
    // EUR morning short 09:00→12:00 UTC, weekdays (book leg K, Breedon-Ranaldo)
    if (dow >= 1 && dow <= 5 && d.getUTCHours() >= 9 && d.getUTCHours() < 11) {
      const q = quotes.eurusd;
      const open = state.positions.find((p) => p.leg === 'eur-morning-short');
      if (q && !open) {
        openPosition(state, { leg: 'eur-morning-short', metal: 'eurusd', side: 'short', entryPrice: q.price, entryTime: now });
      }
    }
    // eur-h22-long leg removed: dead at real rollover costs (execution audit)

    // US500 overnight (book leg J): enter 16:00–16:45 ET Mon–Fri (cash close mark
    // via ES=F), exit next cash open. Friday entry holds the weekend.
    if (dow >= 1 && dow <= 5 && nyMin >= 16 * 60 && nyMin <= 16 * 60 + 45) {
      const q = quotes.us500;
      const open = state.positions.find((p) => p.leg === 'us500-overnight');
      if (q && !open) {
        openPosition(state, { leg: 'us500-overnight', metal: 'us500', side: 'long', entryPrice: q.price, entryTime: now });
      }
    }

    // Gold NFP momentum (book leg F): first Friday of the month.
    // DELAY-AWARE windows (research-nfp-bot-sim.ts): the Yahoo feed lags ~10min,
    // so reading at the backtest's own timestamps destroys the signal (132-event
    // replay: direction match 67%, edge +8.2%→+0.4%). Shifted windows — mark
    // ticks 08:30–08:35 (feed shows ≤08:25, pre-release), signal ticks
    // 09:12–09:22 (feed shows ≥~09:02, the true post-print move) — keep the
    // edge intact with real late fills (replay: t=1.98, +13.7%, 58% WR).
    if (dow === 5 && isFirstFriday(d)) {
      const q = quotes.gold;
      const today = d.toISOString().slice(0, 10);
      if (q && nyMin >= 8 * 60 + 30 && nyMin <= 8 * 60 + 35 && state.nfpSignal?.date !== today) {
        state.nfpSignal = { date: today, price0830: q.price };
        log(`NFP signal mark @ ${q.price.toFixed(2)}`);
      }
      if (q && nyMin >= 9 * 60 + 12 && nyMin <= 9 * 60 + 22
        && state.nfpSignal?.date === today
        && !state.positions.find((p) => p.leg === 'nfp-mom')) {
        const dir = q.price > state.nfpSignal.price0830 ? 'long' : q.price < state.nfpSignal.price0830 ? 'short' : null;
        if (dir) {
          openPosition(state, { leg: 'nfp-mom', metal: 'gold', side: dir, entryPrice: q.price, entryTime: now });
        }
        state.nfpSignal = null;
      }
    }
  } // end !bookHalted entries

  saveState(state);
  vlog(`tick done — positions=${state.positions.length} trades=${state.trades.length} totalPnL=${state.totalPnlPct.toFixed(2)}%`);
}

async function main(): Promise<void> {
  log(`Metals paper bot starting (state: ${STATE_PATH})${once ? ' [single tick]' : ''}`);
  const state = loadState();
  log(`  positions=${state.positions.length} trades=${state.trades.length} totalPnL=${state.totalPnlPct.toFixed(2)}%`);

  if (once) {
    await tick(state);
    return;
  }
  // PM2 long-runner
  for (;;) {
    try {
      await tick(state);
    } catch (err) {
      log(`tick error: ${err}`);
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

main().catch((err) => {
  console.error('Metals bot crashed:', err);
  process.exit(1);
});
