#!/usr/bin/env tsx
/**
 * Deriv Scalp Bot — "the brother's setup", paper runner + backtest.
 *
 * Mimics the reverse-engineered fade-to-mean ribbon scalp (src/lib/deriv/scalp-strategy.ts)
 * on Deriv synthetic indices. ONE strategy module drives both modes, so the paper bot trades
 * exactly what the backtest measures (no sim/live drift).
 *
 *   BACKTEST:  npx tsx scripts/run-deriv-scalp.ts --backtest --symbols stpRNG,frxXAUUSD
 *   PAPER (live, no real orders):
 *              npx tsx scripts/run-deriv-scalp.ts --symbols stpRNG --risk 0.005 --daily-loss 0.05
 *              (Ctrl-C for a session summary. Add --max-polls N to auto-stop.)
 *
 * SAFETY: paper only — it NEVER sends real orders, it simulates fills at the instrument spread.
 * HONEST EV: on these random-walk synthetics the entry is ~0 EV before cost and net-negative by
 * the spread (experiments/brother-trades.md §3c). Run it to study the behaviour, feed alerts to a
 * human (who supplies the discretionary edge), and A/B new filters — not as turnkey alpha.
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types/candle';
import { downloadDerivCandles, TF_TO_GRANULARITY } from '@/lib/deriv/downloader';
import {
  DEFAULT_SCALP, INSTRUMENT_PROFILE, computeState, entrySignal, openPosition,
  exitDecision, canScaleIn, type ScalpConfig, type ScalpPosition, type ExitReason,
} from '@/lib/deriv/scalp-strategy';

function getArg(name: string): string | undefined {
  const a = process.argv.slice(2);
  const i = a.indexOf(`--${name}`);
  return i !== -1 && a[i + 1] ? a[i + 1] : undefined;
}
function hasFlag(name: string): boolean { return process.argv.slice(2).includes(`--${name}`); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (n: number, d = 2) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

interface ClosedTrade { symbol: string; dir: 1 | -1; entry: number; exit: number; r: number; usd: number; reason: ExitReason; }

/** Half the spread as a price offset (you cross half on entry, half on exit). */
function halfSpread(price: number, spreadBp: number): number { return (spreadBp / 1e4) * price / 2; }

/** Realise one position closing at `rawExit` on bar i — returns net R and $ after spread. */
function realise(
  pos: ScalpPosition, rawExit: number, atrAtEntry: number, spreadBp: number, dollarRisk: number, slAtr: number,
): { r: number; usd: number } {
  const hs = halfSpread(rawExit, spreadBp);
  const exitFill = rawExit - pos.dir * hs;                 // exit on the worse side
  const riskPrice = slAtr * atrAtEntry;                    // 1R in price
  const grossR = ((exitFill - pos.entryPrice) * pos.dir) / riskPrice;
  return { r: grossR, usd: grossR * dollarRisk };
}

// ============================================================ BACKTEST MODE
function runBacktest(symbols: string[], cfg: ScalpConfig, riskUsd: number): void {
  console.log(`\nDeriv Scalp BACKTEST | ext=${cfg.extAtr}ATR sl=${cfg.slAtr}ATR maxHold=${cfg.maxHoldBars} | EMA(${cfg.fastPeriod}/${cfg.anchorPeriod}/${cfg.slowPeriod})`);
  let allR: number[] = [];
  for (const sym of symbols) {
    const p = path.resolve(__dirname, '..', 'data', `${sym}_1m.json`);
    if (!fs.existsSync(p)) { console.log(`\n${sym}: no data at ${p}`); continue; }
    const candles = JSON.parse(fs.readFileSync(p, 'utf-8')) as Candle[];
    const prof = INSTRUMENT_PROFILE[sym] ?? { bias: cfg.bias, spreadBp: 1 };
    const c: ScalpConfig = { ...cfg, bias: prof.bias };
    const s = computeState(candles, c);
    const open: (ScalpPosition & { atrAtEntry: number })[] = [];
    const trades: ClosedTrade[] = [];
    const warm = c.slowPeriod + c.atrPeriod + 2;
    for (let i = warm; i < candles.length; i++) {
      const bar = candles[i]!;
      // exits first (only positions opened on an earlier bar)
      for (let k = open.length - 1; k >= 0; k--) {
        const pos = open[k]!;
        if (pos.entryIndex >= i) continue;
        const ex = exitDecision(pos, s, bar, i, c);
        if (ex) {
          const { r, usd } = realise(pos, ex.price, pos.atrAtEntry, prof.spreadBp, riskUsd, c.slAtr);
          trades.push({ symbol: sym, dir: pos.dir, entry: pos.entryPrice, exit: ex.price, r, usd, reason: ex.reason });
          open.splice(k, 1);
        }
      }
      // entry
      const dir = entrySignal(s, i, c);
      if (dir !== 0 && i + 1 < candles.length) {
        const sameDir = open.filter((o) => o.dir === dir);
        const allowed = sameDir.length === 0 || (sameDir.length <= c.scaleInMax && canScaleIn(open, dir, s, i, c));
        if (allowed) {
          const fill = candles[i + 1]!.open + dir * halfSpread(candles[i + 1]!.open, prof.spreadBp);
          open.push({ ...openPosition(dir, fill, i + 1, s, c), atrAtEntry: s.atr[i]! });
        }
      }
    }
    summarise(sym, trades);
    allR = allR.concat(trades.map((t) => t.r));
  }
  if (symbols.length > 1) summariseR('ALL SYMBOLS', allR);
}

function summarise(label: string, trades: ClosedTrade[]): void {
  if (!trades.length) { console.log(`\n  ${label}: no trades`); return; }
  const r = trades.map((t) => t.r), usd = trades.map((t) => t.usd);
  const wins = r.filter((x) => x > 0);
  const byReason = (rn: ExitReason) => trades.filter((t) => t.reason === rn).length;
  let eq = 0, peak = 0, dd = 0;
  for (const x of usd) { eq += x; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  console.log(`\n  ${label}: n=${trades.length}  win=${fmt(wins.length / trades.length * 100, 1)}%  ` +
    `netR=${fmt(r.reduce((a, b) => a + b, 0), 1)}  net$=${fmt(usd.reduce((a, b) => a + b, 0))}  ` +
    `avgR=${fmt(r.reduce((a, b) => a + b, 0) / r.length, 3)}  maxDD$=${fmt(dd)}`);
  console.log(`    exits: target=${byReason('target')} stop=${byReason('stop')} timeout=${byReason('timeout')}`);
}
function summariseR(label: string, r: number[]): void {
  if (!r.length) return;
  const wins = r.filter((x) => x > 0).length;
  console.log(`\n  ${label}: n=${r.length}  win=${fmt(wins / r.length * 100, 1)}%  netR=${fmt(r.reduce((a, b) => a + b, 0), 1)}  avgR=${fmt(r.reduce((a, b) => a + b, 0) / r.length, 3)}`);
}

// ============================================================ LIVE PAPER MODE
interface PaperPos extends ScalpPosition { atrAtEntry: number; entryTs: number; }

async function runPaper(symbols: string[], cfg: ScalpConfig, opts: {
  granSec: number; equity0: number; riskFrac: number; dailyLossFrac: number; pollSec: number; window: number; maxPolls: number;
}): Promise<void> {
  const granMs = opts.granSec * 1000;
  const dollarRisk = opts.equity0 * opts.riskFrac;
  console.log(`\n${'='.repeat(74)}\nDeriv Scalp PAPER bot (NO REAL ORDERS) | equity=$${fmt(opts.equity0, 0)} risk=${fmt(opts.riskFrac * 100, 2)}%/trade ($${fmt(dollarRisk)}) | daily-loss-stop=${fmt(opts.dailyLossFrac * 100, 0)}%\n${'='.repeat(74)}`);
  console.log(`symbols=${symbols.join(',')} | ext=${cfg.extAtr}ATR sl=${cfg.slAtr}ATR maxHold=${cfg.maxHoldBars} | poll=${opts.pollSec}s`);

  const state: Record<string, { open: PaperPos[]; lastTs: number }> = {};
  for (const s of symbols) state[s] = { open: [], lastTs: 0 };
  const trades: ClosedTrade[] = [];
  let dayKey = '';
  let dayRealised = 0;
  let halted = false;
  let running = true;

  const summary = () => {
    console.log(`\n${'='.repeat(74)}\nSESSION SUMMARY`);
    summarise('TOTAL', trades);
    const openCount = symbols.reduce((n, s) => n + state[s]!.open.length, 0);
    console.log(`  open paper positions at stop: ${openCount}  | realised net$=${fmt(trades.reduce((a, t) => a + t.usd, 0))}`);
    console.log(`${'='.repeat(74)}`);
  };
  process.on('SIGINT', () => { running = false; summary(); process.exit(0); });

  let polls = 0;
  while (running) {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== dayKey) { dayKey = today; dayRealised = 0; halted = false; }

    const fetched = await Promise.all(symbols.map(async (sym) => {
      try { return { sym, candles: await downloadDerivCandles(sym, opts.granSec, opts.window, { maxRequests: 2, requestDelayMs: 200 }) }; }
      catch (e) { console.log(`  [${sym}] fetch error: ${(e as Error).message}`); return { sym, candles: [] as Candle[] }; }
    }));

    const now = Date.now();
    for (const { sym, candles } of fetched) {
      if (candles.length < cfg.slowPeriod + cfg.atrPeriod + 5) continue;
      const prof = INSTRUMENT_PROFILE[sym] ?? { bias: cfg.bias, spreadBp: 1 };
      const c: ScalpConfig = { ...cfg, bias: prof.bias };
      const s = computeState(candles, c);
      const closed = candles.filter((b) => b.timestamp + granMs <= now);
      const st = state[sym]!;
      const last = closed[closed.length - 1];
      if (st.lastTs === 0) {
        // SEED ONLY on first sight — do NOT replay the historical window as if it were live.
        if (last) {
          const i = candles.indexOf(last);
          const ext = s.atr[i]! > 0 ? (s.close[i]! - s.anchor[i]!) / s.atr[i]! : 0;
          console.log(`  [${sym}] price=${fmt(last.close, 4)} anchor=${fmt(s.anchor[i]!, 4)} extension=${fmt(ext, 2)}ATR signal=${entrySignal(s, i, c) || 'none'} (bias=${c.bias}, spread=${prof.spreadBp}bp) [seeded; waiting for new bars]`);
          st.lastTs = last.timestamp;
        }
        continue;
      }
      for (const bar of closed) {
        if (bar.timestamp <= st.lastTs) continue;
        const i = candles.indexOf(bar);
        if (i < 0) continue;
        // exits
        for (let k = st.open.length - 1; k >= 0; k--) {
          const pos = st.open[k]!; pos.entryIndex = candles.findIndex((b) => b.timestamp === pos.entryTs);
          if (pos.entryIndex < 0 || pos.entryIndex >= i) continue;
          const ex = exitDecision(pos, s, bar, i, c);
          if (ex) {
            const { r, usd } = realise(pos, ex.price, pos.atrAtEntry, prof.spreadBp, dollarRisk, c.slAtr);
            trades.push({ symbol: sym, dir: pos.dir, entry: pos.entryPrice, exit: ex.price, r, usd, reason: ex.reason });
            dayRealised += usd; st.open.splice(k, 1);
            console.log(`  ${new Date(bar.timestamp).toISOString().slice(11, 19)} [${sym}] EXIT ${pos.dir === 1 ? 'LONG' : 'SHORT'} @${fmt(ex.price, 4)} ${ex.reason} R=${fmt(r, 2)} $${fmt(usd)} | day$=${fmt(dayRealised)}`);
          }
        }
        // daily loss stop
        if (!halted && dayRealised <= -opts.dailyLossFrac * opts.equity0) {
          halted = true; console.log(`  ⛔ daily loss limit hit (day$=${fmt(dayRealised)}) — no new entries today`);
        }
        // entry
        if (!halted) {
          const dir = entrySignal(s, i, c);
          if (dir !== 0) {
            const sameDir = st.open.filter((o) => o.dir === dir);
            const allowed = sameDir.length === 0 || (sameDir.length <= c.scaleInMax && canScaleIn(st.open, dir, s, i, c));
            if (allowed) {
              const fill = bar.close + dir * halfSpread(bar.close, prof.spreadBp);
              st.open.push({ ...openPosition(dir, fill, i, s, c), atrAtEntry: s.atr[i]!, entryTs: bar.timestamp });
              console.log(`  ${new Date(bar.timestamp).toISOString().slice(11, 19)} [${sym}] OPEN ${dir === 1 ? 'LONG' : 'SHORT'} @${fmt(fill, 4)} stop=${fmt(st.open[st.open.length - 1]!.stop, 4)} (${sameDir.length ? 'scale-in' : 'new'})`);
            }
          }
        }
        st.lastTs = bar.timestamp;
      }
    }

    polls++;
    if (opts.maxPolls > 0 && polls >= opts.maxPolls) { console.log(`\n(reached --max-polls ${opts.maxPolls})`); summary(); return; }
    await sleep(opts.pollSec * 1000);
  }
}

// ============================================================ MAIN
async function main(): Promise<void> {
  const symbols = (getArg('symbols') ?? 'stpRNG,frxXAUUSD').split(',').map((s) => s.trim()).filter(Boolean);
  const tf = getArg('tf') ?? '1m';
  const granSec = TF_TO_GRANULARITY[tf];
  if (!granSec) { console.error(`Unknown tf ${tf}`); process.exit(1); }

  const cfg: ScalpConfig = {
    ...DEFAULT_SCALP,
    extAtr: parseFloat(getArg('ext') ?? String(DEFAULT_SCALP.extAtr)),
    slAtr: parseFloat(getArg('sl-atr') ?? String(DEFAULT_SCALP.slAtr)),
    maxHoldBars: parseInt(getArg('max-hold') ?? String(DEFAULT_SCALP.maxHoldBars), 10),
    scaleInMax: parseInt(getArg('scale-max') ?? String(DEFAULT_SCALP.scaleInMax), 10),
  };

  if (hasFlag('backtest')) {
    runBacktest(symbols, cfg, parseFloat(getArg('risk-usd') ?? '10'));
    return;
  }
  await runPaper(symbols, cfg, {
    granSec,
    equity0: parseFloat(getArg('equity') ?? '1000'),
    riskFrac: parseFloat(getArg('risk') ?? '0.005'),
    dailyLossFrac: parseFloat(getArg('daily-loss') ?? '0.05'),
    pollSec: parseFloat(getArg('poll-sec') ?? '20'),
    window: parseInt(getArg('window') ?? '400', 10),
    maxPolls: parseInt(getArg('max-polls') ?? '0', 10),
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
