#!/usr/bin/env tsx
/**
 * HONEST funding/basis carry (systems-loop, crypto mechanism — un-parking the funding carry).
 *
 * Delta-neutral: LONG spot + SHORT perp. We receive funding (89% positive) but the position
 * is marked-to-market on the BASIS (perp/spot − 1). The parked "pulse" only summed the smooth
 * funding stream → Sharpe-16 artifact. Here the daily P&L includes −Δbasis (the real risk):
 *     r_dn[t] = fundingCredit[t]  −  Δbasis[t]
 *   fundingCredit = +fundingRate at 0/8/16 UTC settlements (short perp receives + funding).
 *
 * Two systems: (a) always-on; (b) funding-gated (hold only when trailing funding > 0).
 * Per symbol + EW portfolio, IS 2023-24 / OOS 2025-26, with the funding-only artifact for contrast.
 * Data: {SYM}_basis_1h.json (download-basis-data.ts) + {SYM}_futures_1h.json (funding).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface BasisRow { timestamp: number; spot: number; perp: number; basis: number }
interface FutRow { timestamp: number; fundingRate: number }
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const TOGGLE_COST = Number(process.env.TOGGLE_BP ?? 4) / 1e4; // round-trip spot+perp on a gate toggle (maker ~2-4bp)
const ANN = Math.sqrt(24 * 365);

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); }
function sharpe(xs: number[]): number { const s = std(xs); return s === 0 ? 0 : (mean(xs) / s) * ANN; }
function maxDD(xs: number[]): number { let eq = 0, pk = 0, dd = 0; for (const r of xs) { eq += r; if (eq > pk) pk = eq; if (pk - eq > dd) dd = pk - eq; } return dd; }
function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length), ma = mean(a), mb = mean(b); let c = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { c += (a[i]! - ma) * (b[i]! - mb); va += (a[i]! - ma) ** 2; vb += (b[i]! - mb) ** 2; }
  return va > 0 && vb > 0 ? c / Math.sqrt(va * vb) : 0;
}

interface Hour { ts: number; dn: number; dnGated: number; fundOnly: number; perpRet: number; toggles: number }
function build(symbol: string): Hour[] {
  const basis = JSON.parse(readFileSync(resolve('data', `${symbol}_basis_1h.json`), 'utf8')) as BasisRow[];
  const fut = JSON.parse(readFileSync(resolve('data', `${symbol}_futures_1h.json`), 'utf8')) as FutRow[];
  const fund = new Map<number, number>();
  for (const r of fut) fund.set(r.timestamp, r.fundingRate);
  basis.sort((a, b) => a.timestamp - b.timestamp);
  const out: Hour[] = [];
  let held = false; // gated state
  let trailFund = 0; // EMA of realized funding (sign gate)
  for (let i = 1; i < basis.length; i++) {
    const prev = basis[i - 1]!, cur = basis[i]!;
    if (!fund.has(cur.timestamp)) continue; // need funding coverage (ends 2026-02)
    const h = new Date(cur.timestamp).getUTCHours();
    const settle = h === 0 || h === 8 || h === 16;
    const fr = settle ? (fund.get(cur.timestamp) ?? 0) : 0; // 8h rate at settlement
    const dBasis = cur.basis - prev.basis;                  // Δ(perp/spot−1)
    const dn = fr - dBasis;                                  // long spot/short perp, MtM
    const perpRet = Math.log(cur.perp / prev.perp);
    if (settle) trailFund = 0.94 * trailFund + 0.06 * fr;   // EMA over settlements
    const wantHold = trailFund > 0;
    let toggles = 0;
    if (wantHold !== held) { toggles = 1; held = wantHold; }
    const dnGated = held ? dn - (toggles ? TOGGLE_COST : 0) : (toggles ? -TOGGLE_COST : 0);
    out.push({ ts: cur.timestamp, dn, dnGated, fundOnly: fr, perpRet, toggles });
  }
  return out;
}

function rep(label: string, xs: number[]): string {
  return `${label.padEnd(26)} ann.ret ${(mean(xs) * 24 * 365 * 100).toFixed(1).padStart(6)}%  Sharpe ${sharpe(xs).toFixed(2).padStart(6)}  maxDD ${(maxDD(xs) * 100).toFixed(1).padStart(5)}%`;
}

const all = SYMBOLS.map((s) => ({ s, h: build(s) }));
console.log(`Honest funding/basis carry (delta-neutral long spot/short perp, MtM on basis) — toggle cost ${(TOGGLE_COST * 1e4).toFixed(0)}bp\n`);
for (const { s, h } of all) {
  const range = `${new Date(h[0]!.ts).toISOString().slice(0, 10)}→${new Date(h[h.length - 1]!.ts).toISOString().slice(0, 10)}`;
  console.log(`${s} (n=${h.length}h ${range}, toggles=${h.reduce((a, x) => a + x.toggles, 0)}):`);
  console.log('  ' + rep('funding-only (ARTIFACT)', h.map((x) => x.fundOnly)));
  console.log('  ' + rep('delta-neutral always-on', h.map((x) => x.dn)));
  console.log('  ' + rep('delta-neutral funding-gated', h.map((x) => x.dnGated)));
  console.log(`  corr(dn, perp) = ${corr(h.map((x) => x.dn), h.map((x) => x.perpRet)).toFixed(3)} (market-neutrality check)`);
}

// EW portfolio on common timestamps, IS/OOS
const idx = new Map<number, number[]>();
for (const { h } of all) for (const x of h) { const a = idx.get(x.ts) ?? []; a.push(x.dn); idx.set(x.ts, a); }
const tsSorted = [...idx.keys()].filter((t) => idx.get(t)!.length === SYMBOLS.length).sort((a, b) => a - b);
const ew = tsSorted.map((t) => mean(idx.get(t)!));
const isEW = tsSorted.map((t, i) => (t < Date.UTC(2025, 0, 1) ? ew[i]! : null)).filter((x): x is number => x !== null);
const oosEW = tsSorted.map((t, i) => (t >= Date.UTC(2025, 0, 1) ? ew[i]! : null)).filter((x): x is number => x !== null);
console.log(`\nEW delta-neutral portfolio (3 symbols, always-on, n=${ew.length}h):`);
console.log('  ' + rep('EW full', ew));
console.log('  ' + rep('EW IS 2023-24', isEW));
console.log('  ' + rep('EW OOS 2025-26', oosEW));
console.log(`\nHONEST READ: funding-only Sharpe = the artifact. delta-neutral Sharpe = real (includes basis MtM).`);
console.log(`Deployable = OOS Sharpe survives + corr~0 to perp (diversifier). Caveats not modeled: hedge-rebalance`);
console.log(`cost, borrow/withdrawal limits, exchange/counterparty risk, funding-regime shift, negative-funding tails.`);
