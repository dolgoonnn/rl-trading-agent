#!/usr/bin/env tsx
/**
 * GMMA Ribbon Trend-Follower — reverse-engineered from a discretionary trader's
 * MT5/Deriv charts (multi-EMA "ribbon" + trigger line + trend-strength filter,
 * traded WITH the trend on M1 across synthetics AND gold).
 *
 * The whole point of trend-following is the EXIT: cut losers at an ATR stop,
 * let winners RUN via a chandelier trailing stop / ribbon-flip exit. That is
 * what produces the positive-skew "a few huge winners carry it" profile seen
 * in his real gold history (+3000-type trades dominating).
 *
 * Indicators (all O(n) vectorized):
 *   - GMMA fast group EMAs [3,5,8,10,12,15], slow group [30,35,40,45,50,60]
 *   - Trigger = fast EMA (the thin "red" line)
 *   - ADX(14) trend-strength filter
 *   - ATR(14) for stops
 *
 * Entry: trend flips aligned (fast ribbon fully above/below slow) AND ADX>=min.
 * Exit:  initial ATR stop, chandelier ATR trailing stop, or ribbon-flip.
 *
 * Reports R-multiples, profit factor, skew, max DD, and the TOP-3-trade share
 * of gross profit (to compare to his ~85% gold concentration), plus a per-quartile
 * regime breakdown (durable edge vs single-regime luck).
 *
 * Usage:
 *   npx tsx scripts/backtest-ribbon.ts --symbol frxXAUUSD --tf 1m --spread-bp 1
 *   npx tsx scripts/backtest-ribbon.ts --symbols BOOM1000,CRASH1000,R_75,R_100 --tf 1m
 *   npx tsx scripts/backtest-ribbon.ts --symbol GC_F --tf 1h --adx-min 20 --trail-atr 3
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types/candle';

function getArg(name: string): string | undefined {
  const a = process.argv.slice(2);
  const i = a.indexOf(`--${name}`);
  return i !== -1 && a[i + 1] ? a[i + 1] : undefined;
}
function hasFlag(name: string): boolean { return process.argv.slice(2).includes(`--${name}`); }

// ---------- O(n) indicator series ----------
function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out = new Array<number>(values.length);
  out[0] = values[0]!;
  for (let i = 1; i < values.length; i++) out[i] = values[i]! * k + out[i - 1]! * (1 - k);
  return out;
}

function trueRange(candles: Candle[]): number[] {
  const tr = new Array<number>(candles.length);
  tr[0] = candles[0]!.high - candles[0]!.low;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!, pc = candles[i - 1]!.close;
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  }
  return tr;
}

/** Wilder-smoothed ATR. */
function atrSeries(candles: Candle[], period: number): number[] {
  const tr = trueRange(candles);
  const out = new Array<number>(candles.length).fill(0);
  let seed = 0;
  for (let i = 0; i < period && i < candles.length; i++) seed += tr[i]!;
  let atr = seed / period;
  for (let i = 0; i < candles.length; i++) {
    if (i < period) { out[i] = atr; continue; }
    atr = (atr * (period - 1) + tr[i]!) / period;
    out[i] = atr;
  }
  return out;
}

/** Wilder ADX. */
function adxSeries(candles: Candle[], period: number): number[] {
  const n = candles.length;
  const tr = trueRange(candles);
  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i]!.high - candles[i - 1]!.high;
    const dn = candles[i - 1]!.low - candles[i]!.low;
    plusDM[i] = up > dn && up > 0 ? up : 0;
    minusDM[i] = dn > up && dn > 0 ? dn : 0;
  }
  // Wilder smoothing
  const smooth = (arr: number[]): number[] => {
    const out = new Array<number>(n).fill(0);
    let s = 0;
    for (let i = 1; i <= period && i < n; i++) s += arr[i]!;
    out[period] = s;
    for (let i = period + 1; i < n; i++) out[i] = out[i - 1]! - out[i - 1]! / period + arr[i]!;
    return out;
  };
  const strTR = smooth(tr), strP = smooth(plusDM), strM = smooth(minusDM);
  const adx = new Array<number>(n).fill(0);
  const dx = new Array<number>(n).fill(0);
  for (let i = period; i < n; i++) {
    const pdi = strTR[i] ? 100 * strP[i]! / strTR[i]! : 0;
    const mdi = strTR[i] ? 100 * strM[i]! / strTR[i]! : 0;
    dx[i] = (pdi + mdi) ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
  }
  // ADX = Wilder average of DX
  let seed = 0;
  const start = period * 2;
  for (let i = period; i < start && i < n; i++) seed += dx[i]!;
  let a = seed / period;
  for (let i = period; i < n; i++) {
    if (i < start) { adx[i] = a; continue; }
    a = (a * (period - 1) + dx[i]!) / period;
    adx[i] = a;
  }
  return adx;
}

const FAST = [3, 5, 8, 10, 12, 15];
const SLOW = [30, 35, 40, 45, 50, 60];

interface Trade { dir: 1 | -1; entryIdx: number; exitIdx: number; entry: number; exit: number; r: number; pctMove: number; }

function backtest(candles: Candle[], cfg: {
  adxMin: number; slAtr: number; trailAtr: number; spreadBp: number; ribbonFlipExit: boolean; slipFrac: number;
  mode: 'flip' | 'fade'; ext: number;
  exitMode: 'trail' | 'meanrev'; maxHold: number; bias: 'long' | 'short' | 'both';
}): Trade[] {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const fastEmas = FAST.map((p) => emaSeries(closes, p));
  const slowEmas = SLOW.map((p) => emaSeries(closes, p));
  const atr = atrSeries(candles, 14);
  const adx = adxSeries(candles, 14);
  const spread = cfg.spreadBp / 1e4;

  const fastMin = (i: number) => Math.min(...fastEmas.map((e) => e[i]!));
  const fastMax = (i: number) => Math.max(...fastEmas.map((e) => e[i]!));
  const slowMin = (i: number) => Math.min(...slowEmas.map((e) => e[i]!));
  const slowMax = (i: number) => Math.max(...slowEmas.map((e) => e[i]!));
  const up = (i: number) => fastMin(i) > slowMax(i);
  const down = (i: number) => fastMax(i) < slowMin(i);
  // anchor = centre of the slow ribbon; extension = how many ATR price is from it
  const anchor = (i: number) => (slowMin(i) + slowMax(i)) / 2;
  const extAtr = (i: number) => atr[i]! > 0 ? (closes[i]! - anchor(i)) / atr[i]! : 0;

  const trades: Trade[] = [];
  let pos: { dir: 1 | -1; entry: number; entryIdx: number; initRisk: number; trail: number; extreme: number } | null = null;
  const warm = 70;

  for (let i = warm; i < n; i++) {
    const c = candles[i]!;
    if (pos) {
      let exit: number | null = null;
      if (cfg.exitMode === 'meanrev') {
        // SCALP exit: fixed protective stop (set at entry), take profit when price snaps
        // back to the anchor EMA (the mean), time-stop if it stalls. This is the actual
        // scalper behaviour — take the reversion, do NOT ride.
        const stop = pos.trail;        // fixed at entry ± initRisk (never trailed in this mode)
        const tgt = anchor(i);
        if (pos.dir === 1) {
          if (c.low <= stop) exit = stop - cfg.slipFrac * (stop - c.low);   // stop first (conservative)
          else if (c.high >= tgt) exit = tgt;                               // TP at anchor
        } else {
          if (c.high >= stop) exit = stop + cfg.slipFrac * (c.high - stop);
          else if (c.low <= tgt) exit = tgt;
        }
        if (exit === null && i - pos.entryIdx >= cfg.maxHold) exit = c.close; // time stop
      } else {
        // TREND-RIDE exit: chandelier trail + optional ribbon-flip.
        if (pos.dir === 1) { pos.extreme = Math.max(pos.extreme, c.high); pos.trail = Math.max(pos.trail, pos.extreme - cfg.trailAtr * atr[i]!); }
        else { pos.extreme = Math.min(pos.extreme, c.low); pos.trail = Math.min(pos.trail, pos.extreme + cfg.trailAtr * atr[i]!); }
        if (pos.dir === 1 && c.low <= pos.trail) exit = pos.trail - cfg.slipFrac * (pos.trail - c.low);
        else if (pos.dir === -1 && c.high >= pos.trail) exit = pos.trail + cfg.slipFrac * (c.high - pos.trail);
        else if (cfg.ribbonFlipExit && ((pos.dir === 1 && down(i)) || (pos.dir === -1 && up(i)))) exit = c.close;
      }
      if (exit !== null) {
        const gross = (exit - pos.entry) * pos.dir;
        const net = gross - spread * pos.entry; // round-trip spread approximated as one leg in fraction terms
        trades.push({ dir: pos.dir, entryIdx: pos.entryIdx, exitIdx: i, entry: pos.entry, exit, r: net / pos.initRisk, pctMove: net / pos.entry });
        pos = null;
      }
    }
    if (!pos) {
      let dirSig: 1 | -1 | 0 = 0;
      if (cfg.mode === 'fade') {
        // FADE: enter the REVERSAL when price is overextended from the ribbon AND
        // the fast line rolls back toward it (his apparent style: sell the up-spike
        // exhaustion, buy the down-flush). ADX still gates for a live, moving market.
        const overUp = extAtr(i) >= cfg.ext;      // stretched far ABOVE ribbon → fade short
        const overDn = extAtr(i) <= -cfg.ext;     // stretched far BELOW ribbon → fade long
        const rollDn = closes[i]! < closes[i - 1]!;
        const rollUp = closes[i]! > closes[i - 1]!;
        if (overDn && rollUp && adx[i]! >= cfg.adxMin) dirSig = 1;
        else if (overUp && rollDn && adx[i]! >= cfg.adxMin) dirSig = -1;
      } else {
        const trendUp = up(i) && !up(i - 1) && adx[i]! >= cfg.adxMin;   // trend just turned up
        const trendDn = down(i) && !down(i - 1) && adx[i]! >= cfg.adxMin;
        if (trendUp) dirSig = 1; else if (trendDn) dirSig = -1;
      }
      if (cfg.bias === 'long' && dirSig === -1) dirSig = 0;   // instrument-aligned: e.g. Boom long-only
      if (cfg.bias === 'short' && dirSig === 1) dirSig = 0;   // e.g. Crash short-only
      if (dirSig !== 0) {
        const dir: 1 | -1 = dirSig;
        const next = candles[i + 1];
        if (next) {
          const entry = next.open;
          const initRisk = cfg.slAtr * atr[i]!;
          if (initRisk > 0) {
            pos = { dir, entry, entryIdx: i + 1, initRisk, extreme: dir === 1 ? next.high : next.low, trail: dir === 1 ? entry - initRisk : entry + initRisk };
          }
        }
      }
    }
  }
  return trades;
}

function stats(trades: Trade[]) {
  const n = trades.length;
  if (!n) return null;
  const rs = trades.map((t) => t.r);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
  const totalR = sum(rs);
  const grossWin = sum(wins), grossLoss = -sum(losses);
  const mean = totalR / n;
  const sd = Math.sqrt(sum(rs.map((r) => (r - mean) ** 2)) / Math.max(n - 1, 1));
  const skew = sd > 0 ? sum(rs.map((r) => ((r - mean) / sd) ** 3)) / n : 0;
  // equity max DD in R
  let eq = 0, peak = 0, maxDD = 0;
  for (const r of rs) { eq += r; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq); }
  // top-3 winner concentration
  const sorted = [...rs].sort((a, b) => b - a);
  const top3 = sum(sorted.slice(0, 3));
  const top3Share = grossWin > 0 ? top3 / grossWin : 0;
  return {
    n, winRate: wins.length / n, totalR, avgR: mean, skew,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    maxDDR: maxDD, top3Share,
    avgBars: trades.reduce((s, t) => s + (t.exitIdx - t.entryIdx), 0) / n,
  };
}

function main(): void {
  const symbolsArg = getArg('symbols') ?? getArg('symbol') ?? 'frxXAUUSD';
  const tf = getArg('tf') ?? '1m';
  const cfg = {
    adxMin: parseFloat(getArg('adx-min') ?? '20'),
    slAtr: parseFloat(getArg('sl-atr') ?? '2'),
    trailAtr: parseFloat(getArg('trail-atr') ?? '3'),
    spreadBp: parseFloat(getArg('spread-bp') ?? '1'),
    ribbonFlipExit: !hasFlag('no-flip-exit'),
    slipFrac: parseFloat(getArg('slip') ?? '1'),
    mode: (getArg('mode') === 'fade' ? 'fade' : 'flip') as 'flip' | 'fade',
    ext: parseFloat(getArg('ext') ?? '2.5'),
    exitMode: (getArg('exit') === 'meanrev' ? 'meanrev' : 'trail') as 'trail' | 'meanrev',
    maxHold: parseInt(getArg('max-hold') ?? '30', 10),
    bias: (['long', 'short', 'both'].includes(getArg('bias') ?? '') ? getArg('bias') : 'both') as 'long' | 'short' | 'both',
  };
  const symbols = symbolsArg.split(',').map((s) => s.trim()).filter(Boolean);

  const setup = cfg.mode === 'fade' ? `FADE (ext=${cfg.ext}ATR, bias=${cfg.bias})` : 'trend-FLIP';
  const exitDesc = cfg.exitMode === 'meanrev' ? `SCALP→anchor (maxHold=${cfg.maxHold})` : `RIDE trail=${cfg.trailAtr}ATR`;
  console.log(`GMMA Ribbon ${setup} | exit=${exitDesc} | tf=${tf} | ADXmin=${cfg.adxMin} SL=${cfg.slAtr}ATR spread=${cfg.spreadBp}bp slip=${cfg.slipFrac}`);
  console.log('GMMA fast', JSON.stringify(FAST), 'slow', JSON.stringify(SLOW));

  for (const sym of symbols) {
    const p = path.resolve(__dirname, '..', 'data', `${sym}_${tf}.json`);
    if (!fs.existsSync(p)) { console.log(`\n${sym}: no data at ${p}`); continue; }
    const candles = JSON.parse(fs.readFileSync(p, 'utf-8')) as Candle[];
    const trades = backtest(candles, cfg);
    const s = stats(trades);
    console.log(`\n========== ${sym} (${candles.length.toLocaleString()} ${tf} bars) ==========`);
    if (!s) { console.log('  no trades'); continue; }
    console.log(`  trades=${s.n}  winRate=${(s.winRate * 100).toFixed(1)}%  totalR=${s.totalR.toFixed(1)}  avgR=${s.avgR.toFixed(3)}  PF=${s.profitFactor.toFixed(2)}`);
    console.log(`  skew=${s.skew.toFixed(2)}  maxDD=${s.maxDDR.toFixed(1)}R  top3-winner-share=${(s.top3Share * 100).toFixed(0)}%  avgBarsHeld=${s.avgBars.toFixed(0)}`);
    // regime durability: quartiles by trade order
    const q = Math.ceil(trades.length / 4);
    const parts: string[] = [];
    for (let k = 0; k < 4; k++) {
      const seg = trades.slice(k * q, (k + 1) * q);
      parts.push(`Q${k + 1}:${seg.reduce((a, t) => a + t.r, 0).toFixed(1)}R(n=${seg.length})`);
    }
    console.log(`  durability by quartile: ${parts.join('  ')}`);
  }

  console.log(`\nREAD: trend-following on a fair martingale (synthetics) → totalR ≈ 0 minus spread, PF≈1, no durable edge.`);
  console.log(`On a REAL trending market (gold) → positive totalR is possible IF concentrated in a few big trends`);
  console.log(`(high top3-winner-share, positive skew) AND consistent across quartiles. One good quartile = regime luck.`);
}

main();
