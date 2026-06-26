#!/usr/bin/env tsx
/**
 * CROSS-SECTIONAL funding carry (systems-loop step 4 — new-data mechanism variant).
 *
 * Each 8h settlement: rank the 19-coin panel by trailing (EMA) funding. LONG-carry the top
 * quantile (long spot / short perp → collect high funding) and SHORT-carry the bottom (short
 * spot / long perp → pay low/negative funding). Dollar-neutral L/S. Each leg is delta-neutral
 * (spot/perp), and the cross-section cancels the COMMON basis factor → captures the funding
 * DIFFERENTIAL, cleaner than the absolute carry. Honest: every coin marked-to-market on basis.
 *   per-coin period return  r_i = sgn_i · (funding_i − Δbasis_i)   (sgn +1 long-carry / −1 short-carry)
 *   portfolio = mean_top(funding−Δbasis) − mean_bot(funding−Δbasis) − turnover·cost
 * Benchmark: absolute carry on same 19 coins (all long-carry, EW). IS 2023-24 / OOS 2025-26.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const UNIVERSE = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT',
  'LINKUSDT', 'DOTUSDT', 'LTCUSDT', 'ATOMUSDT', 'UNIUSDT', 'AAVEUSDT', 'NEARUSDT', 'APTUSDT', 'ARBUSDT', 'FILUSDT', 'ICPUSDT'];
const NQ = Number(process.env.NQ ?? 5);         // top/bottom quantile size
const ALPHA = Number(process.env.ALPHA ?? 0.1); // EMA decay for trailing-funding signal (smaller = stickier)
const HOLD = Number(process.env.HOLD ?? 1);     // rebalance every HOLD settlements (turnover reducer)
const LONG_ONLY = process.env.LONG_ONLY === '1'; // borrow-free: long-carry top quantile only (no short-spot legs)
const RT_BP = Number(process.env.RT_BP ?? 6) / 1e4; // round-trip cost per unit turnover (spot+perp)
const BORROW = Number(process.env.BORROW ?? 0) / 100; // annual alt-spot borrow on SHORT legs (L/S only); 0=ignore
const ANN = Math.sqrt(3 * 365);

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); }
function sharpe(xs: number[]): number { const s = std(xs); return s === 0 ? 0 : (mean(xs) / s) * ANN; }
function maxDD(xs: number[]): number { let eq = 0, pk = 0, dd = 0; for (const r of xs) { eq += r; if (eq > pk) pk = eq; if (pk - eq > dd) dd = pk - eq; } return dd; }
function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length), ma = mean(a), mb = mean(b); let c = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { c += (a[i]! - ma) * (b[i]! - mb); va += (a[i]! - ma) ** 2; vb += (b[i]! - mb) ** 2; }
  return va > 0 && vb > 0 ? c / Math.sqrt(va * vb) : 0;
}

interface Coin { fund: Map<number, number>; basis: Map<number, number> }
const coins = new Map<string, Coin>();
for (const sym of UNIVERSE) {
  if (!existsSync(resolve('data', `${sym}_funding.json`)) || !existsSync(resolve('data', `${sym}_basis_1h.json`))) continue;
  const fund = new Map<number, number>();
  for (const r of JSON.parse(readFileSync(resolve('data', `${sym}_funding.json`), 'utf8')) as { timestamp: number; fundingRate: number }[]) fund.set(r.timestamp, r.fundingRate);
  const basis = new Map<number, number>();
  for (const r of JSON.parse(readFileSync(resolve('data', `${sym}_basis_1h.json`), 'utf8')) as { timestamp: number; basis: number }[]) basis.set(r.timestamp, r.basis);
  coins.set(sym, { fund, basis });
}

// settlement grid = sorted union of all funding timestamps
const settle = [...new Set([...coins.values()].flatMap((c) => [...c.fund.keys()]))].sort((a, b) => a - b);

const ema = new Map<string, number>();          // trailing-funding signal
let prevPos = new Map<string, number>();        // coin → signed weight (last formed)
const xsRet: number[] = [], xsTs: number[] = [], absRet: number[] = [];

for (let k = 1; k < settle.length; k++) {
  const ts = settle[k]!, prev = settle[k - 1]!;
  // coins with full data this period (funding now + basis at both ends)
  const avail: string[] = [];
  for (const [sym, c] of coins) if (c.fund.has(ts) && c.basis.has(ts) && c.basis.has(prev)) avail.push(sym);
  if (avail.length < 2 * NQ) { continue; }
  const carry = (sym: string): number => { const c = coins.get(sym)!; return c.fund.get(ts)! - (c.basis.get(ts)! - c.basis.get(prev)!); };

  // realize prevPos over [prev, ts]
  let pr = 0, shortExp = 0;
  for (const [sym, w] of prevPos) {
    if (w < 0) shortExp += -w; // short-spot notional needs borrow
    if (coins.get(sym)!.fund.has(ts) && coins.get(sym)!.basis.has(ts) && coins.get(sym)!.basis.has(prev)) pr += w * carry(sym);
  }
  pr -= shortExp * BORROW / (3 * 365); // alt-spot borrow drag on short legs
  // absolute-carry benchmark: EW long-carry all available
  const absR = mean(avail.map((s) => carry(s)));

  // form new positions only on rebalance cadence (HOLD); else carry prevPos forward (no turnover)
  const rebal = (k - 1) % HOLD === 0;
  let newPos = prevPos;
  if (rebal) {
    const ranked = avail.filter((s) => ema.has(s)).sort((a, b) => ema.get(b)! - ema.get(a)!);
    if (ranked.length >= 2 * NQ) {
      newPos = new Map<string, number>();
      for (const s of ranked.slice(0, NQ)) newPos.set(s, 1 / NQ);   // long-carry top funding (borrow-free)
      // short-carry bottom needs SHORT SPOT (alt borrow) — skip in LONG_ONLY (deployable) mode
      if (!LONG_ONLY) for (const s of ranked.slice(-NQ)) newPos.set(s, -1 / NQ);
    }
  }
  // turnover cost (charged at formation)
  let turnover = 0;
  const allSyms = new Set([...prevPos.keys(), ...newPos.keys()]);
  for (const s of allSyms) turnover += Math.abs((newPos.get(s) ?? 0) - (prevPos.get(s) ?? 0));
  const cost = turnover * RT_BP;

  if (prevPos.size > 0) { xsRet.push(pr - cost); xsTs.push(ts); absRet.push(absR); }
  prevPos = newPos;

  // update EMA with realized funding this settlement
  for (const s of avail) { const fr = coins.get(s)!.fund.get(ts)!; ema.set(s, ema.has(s) ? ALPHA * fr + (1 - ALPHA) * ema.get(s)! : fr); }
}

function rep(label: string, xs: number[]): string {
  return `${label.padEnd(22)} ann.ret ${(mean(xs) * 3 * 365 * 100).toFixed(1).padStart(6)}%  Sharpe ${sharpe(xs).toFixed(2).padStart(6)}  maxDD ${(maxDD(xs) * 100).toFixed(1).padStart(5)}%`;
}
const isIdx = (t: number): boolean => t < Date.UTC(2025, 0, 1);
const xsIS = xsRet.filter((_, i) => isIdx(xsTs[i]!)), xsOOS = xsRet.filter((_, i) => !isIdx(xsTs[i]!));
const absIS = absRet.filter((_, i) => isIdx(xsTs[i]!)), absOOS = absRet.filter((_, i) => !isIdx(xsTs[i]!));

console.log(`Cross-sectional funding carry — ${coins.size} coins, top/bot ${NQ}, EMA α=${ALPHA}, rebal every ${HOLD} settlement(s), cost ${(RT_BP * 1e4).toFixed(0)}bp/turnover\n`);
console.log(`periods=${xsRet.length} (${new Date(xsTs[0]!).toISOString().slice(0, 10)} → ${new Date(xsTs[xsTs.length - 1]!).toISOString().slice(0, 10)})\n`);
console.log('  XS L/S carry (net):');
console.log('    ' + rep('full', xsRet));
console.log('    ' + rep('IS 2023-24', xsIS));
console.log('    ' + rep('OOS 2025-26', xsOOS));
console.log('  Absolute carry benchmark (EW long-carry, same coins):');
console.log('    ' + rep('full', absRet));
console.log('    ' + rep('IS 2023-24', absIS));
console.log('    ' + rep('OOS 2025-26', absOOS));
console.log(`\n  corr(XS, absolute carry) = ${corr(xsRet, absRet).toFixed(3)}`);
console.log(`\nDeployable XS = OOS Sharpe survives AND beats absolute carry on risk-adjusted (cleaner neutrality).`);
console.log(`Caveat (same as absolute): price-Sharpe hides counterparty/operational/borrow risk; do NOT lever.`);
