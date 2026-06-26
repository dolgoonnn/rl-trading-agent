#!/usr/bin/env tsx
/**
 * CROSS-EXCHANGE funding arb (Bybit vs Binance perp, same coin) — systems-loop hunt.
 *
 * Both legs are PERPS → no spot borrow (dodges the XS-carry wall). Capture the funding SPREAD
 * between venues: short the higher-funding venue / long the lower (per coin, per 8h, from trailing
 * spread, no lookahead). Market-neutral; only price risk = the tiny inter-venue perp basis.
 *   r_i = d · ( (f_bybit − f_binance)  +  Δ log(perp_binance/perp_bybit) )      d = sign(trailing spread)
 * Binance funding (4h or 8h) bucketed into Bybit 8h windows. Honest: per-flip fees on BOTH venues
 * + inter-venue basis MtM. EW across coins, IS 2023-24 / OOS 2025-26. FEE_BP per fill (maker ~1-2).
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const UNIVERSE = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT',
  'LINKUSDT', 'DOTUSDT', 'LTCUSDT', 'ATOMUSDT', 'UNIUSDT', 'AAVEUSDT', 'NEARUSDT', 'APTUSDT', 'ARBUSDT', 'FILUSDT', 'ICPUSDT'];
const HOUR = 3_600_000;
const FEE_BP = Number(process.env.FEE_BP ?? 2) / 1e4; // per fill; a flip = 4 fills (close+open, 2 venues)
const ALPHA = Number(process.env.ALPHA ?? 0.1);
const HOLD = Number(process.env.HOLD ?? 1); // min settlements between flips
const ANN = Math.sqrt(3 * 365);

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); }
function sharpe(xs: number[]): number { const s = std(xs); return s === 0 ? 0 : (mean(xs) / s) * ANN; }
function maxDD(xs: number[]): number { let eq = 0, pk = 0, dd = 0; for (const r of xs) { eq += r; if (eq > pk) pk = eq; if (pk - eq > dd) dd = pk - eq; } return dd; }

interface Row { byF: number; bnF: number; byP: number; bnP: number }
interface Coin { settle: number[]; data: Map<number, Row> }
function loadCoin(sym: string): Coin | null {
  const fB = resolve('data', `${sym}_funding.json`), pB = resolve('data', `${sym}_basis_1h.json`);
  const fN = resolve('data', `${sym}_binance_funding.json`), pN = resolve('data', `${sym}_binance_perp_1h.json`);
  if (![fB, pB, fN, pN].every(existsSync)) return null;
  const bybitF = new Map((JSON.parse(readFileSync(fB, 'utf8')) as { timestamp: number; fundingRate: number }[]).map((r) => [r.timestamp, r.fundingRate]));
  const bybitP = new Map((JSON.parse(readFileSync(pB, 'utf8')) as { timestamp: number; perp: number }[]).map((r) => [r.timestamp, r.perp]));
  const binF = (JSON.parse(readFileSync(fN, 'utf8')) as { timestamp: number; fundingRate: number }[]);
  const binP = new Map((JSON.parse(readFileSync(pN, 'utf8')) as { timestamp: number; close: number }[]).map((r) => [r.timestamp, r.close]));
  // bucket Binance funding into Bybit 8h windows ending at each Bybit settlement
  const settle = [...bybitF.keys()].sort((a, b) => a - b);
  const binByWindow = new Map<number, number>();
  let j = 0; const binSorted = binF.sort((a, b) => a.timestamp - b.timestamp);
  for (const t of settle) {
    let s = 0;
    while (j < binSorted.length && binSorted[j]!.timestamp <= t - 8 * HOUR) j++; // skip older
    let k = j; while (k < binSorted.length && binSorted[k]!.timestamp <= t) { s += binSorted[k]!.fundingRate; k++; }
    binByWindow.set(t, s);
  }
  const data = new Map<number, Row>();
  for (const t of settle) {
    if (bybitP.has(t) && binP.has(t) && binByWindow.has(t)) data.set(t, { byF: bybitF.get(t)!, bnF: binByWindow.get(t)!, byP: bybitP.get(t)!, bnP: binP.get(t)! });
  }
  return { settle: [...data.keys()].sort((a, b) => a - b), data };
}

const coins = new Map<string, Coin>();
for (const s of UNIVERSE) { const c = loadCoin(s); if (c && c.settle.length > 200) coins.set(s, c); }

// global settlement grid
const grid = [...new Set([...coins.values()].flatMap((c) => c.settle))].sort((a, b) => a - b);
const ema = new Map<string, number>(); const pos = new Map<string, number>(); const lastFlip = new Map<string, number>();
const ewRet: number[] = [], ewTs: number[] = [];
for (let gi = 1; gi < grid.length; gi++) {
  const t = grid[gi]!, prev = grid[gi - 1]!;
  const legRets: number[] = [];
  for (const [sym, c] of coins) {
    const cur = c.data.get(t), pr = c.data.get(prev);
    if (!cur || !pr) continue;
    const spreadF = cur.byF - cur.bnF;
    const dBasis = Math.log(cur.bnP / cur.byP) - Math.log(pr.bnP / pr.byP);
    const d = pos.get(sym) ?? 0;
    let r = d * (spreadF + dBasis);
    // decide new position from trailing spread EMA (no lookahead), respecting HOLD
    const sig = ema.get(sym);
    if (sig !== undefined) {
      const want = sig > 0 ? 1 : -1;
      if (want !== d && (gi - (lastFlip.get(sym) ?? -1e9)) >= HOLD) {
        r -= (d === 0 ? 2 : 4) * FEE_BP; // initial entry 2 fills, flip 4 fills
        pos.set(sym, want); lastFlip.set(sym, gi);
      }
    }
    if (d !== 0 || pos.get(sym)) legRets.push(r);
    // update EMA with realized spread
    ema.set(sym, ema.has(sym) ? ALPHA * spreadF + (1 - ALPHA) * ema.get(sym)! : spreadF);
  }
  if (legRets.length > 0) { ewRet.push(mean(legRets)); ewTs.push(t); }
}

function rep(label: string, xs: number[]): string {
  return `${label.padEnd(20)} ann.ret ${(mean(xs) * 3 * 365 * 100).toFixed(1).padStart(6)}%  Sharpe ${sharpe(xs).toFixed(2).padStart(6)}  maxDD ${(maxDD(xs) * 100).toFixed(1).padStart(5)}%`;
}
const isR = ewRet.filter((_, i) => ewTs[i]! < Date.UTC(2025, 0, 1)), oosR = ewRet.filter((_, i) => ewTs[i]! >= Date.UTC(2025, 0, 1));
console.log(`Cross-exchange funding arb (Bybit vs Binance) — ${coins.size} coins, fee ${(FEE_BP * 1e4).toFixed(1)}bp/fill, HOLD ${HOLD}, EMA α=${ALPHA}\n`);
console.log(`coins: ${[...coins.keys()].join(', ')}`);
console.log(`periods=${ewRet.length} (${new Date(ewTs[0]!).toISOString().slice(0, 10)} → ${new Date(ewTs[ewTs.length - 1]!).toISOString().slice(0, 10)})\n`);
console.log('  ' + rep('EW full', ewRet));
console.log('  ' + rep('EW IS 2023-24', isR));
console.log('  ' + rep('EW OOS 2025-26', oosR));
// gross funding spread magnitude (diagnostic)
const spreads: number[] = [];
for (const [, c] of coins) for (const t of c.settle) { const r = c.data.get(t)!; spreads.push(Math.abs(r.byF - r.bnF) * 1e4); }
console.log(`\n  mean |Bybit−Binance funding spread| = ${mean(spreads).toFixed(2)}bp/8h (the raw edge to beat ${(8 * FEE_BP * 1e4).toFixed(0)}bp round-trip-ish)`);
console.log(`\nDeployable = OOS Sharpe survives net of 2-venue fees. Caveat: still counterparty risk ×2 venues; basis-divergence/liquidation tail.`);
