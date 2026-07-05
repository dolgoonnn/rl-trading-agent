#!/usr/bin/env tsx
/**
 * Basis-extreme contrarian PULSE (systems-loop step 4 — new-data directional system).
 *
 * Thesis: an extreme perp basis (perp >> spot) = crowded leveraged longs = squeeze/liquidation
 * risk → negative forward perp return (and vice versa). Uses the freshly-downloaded basis.
 * NOTE: memory flags a prior "funding rate = zero predictive power" null — so PULSE first
 * (cheap corr + decile spread), only build if signal survives IS+OOS.
 *
 * Signal = rolling z-score of basis (168h window). Forward perp log-return over H hours.
 * Contrarian = short when z high, long when z low. IS 2023-24 / OOS 2025-26.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface BasisRow { timestamp: number; spot: number; perp: number; basis: number }
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const WIN = 168; // 1-week rolling z window
const HORIZONS = [8, 24];

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); }
function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length), ma = mean(a), mb = mean(b); let c = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { c += (a[i]! - ma) * (b[i]! - mb); va += (a[i]! - ma) ** 2; vb += (b[i]! - mb) ** 2; }
  return va > 0 && vb > 0 ? c / Math.sqrt(va * vb) : 0;
}

interface Pt { ts: number; z: number; fwd: Record<number, number> }
function points(symbol: string): Pt[] {
  const b = JSON.parse(readFileSync(resolve('data', `${symbol}_basis_1h.json`), 'utf8')) as BasisRow[];
  b.sort((a, c) => a.timestamp - c.timestamp);
  const out: Pt[] = [];
  for (let i = WIN; i < b.length - Math.max(...HORIZONS); i++) {
    const window = b.slice(i - WIN, i).map((r) => r.basis);
    const mu = mean(window), sd = std(window);
    if (sd === 0) continue;
    const z = (b[i]!.basis - mu) / sd;
    const fwd: Record<number, number> = {};
    for (const H of HORIZONS) fwd[H] = Math.log(b[i + H]!.perp / b[i]!.perp);
    out.push({ ts: b[i]!.timestamp, z, fwd });
  }
  return out;
}

console.log(`Basis-extreme contrarian PULSE — z=basis rolling-${WIN}h z-score, forward perp return\n`);
for (const sym of SYMBOLS) {
  const pts = points(sym);
  const isP = pts.filter((p) => p.ts < Date.UTC(2025, 0, 1));
  const oosP = pts.filter((p) => p.ts >= Date.UTC(2025, 0, 1));
  console.log(`${sym} (n=${pts.length}, IS=${isP.length} OOS=${oosP.length}):`);
  for (const H of HORIZONS) {
    // corr(z, fwd): NEGATIVE = contrarian signal (high basis → low forward return)
    const cIS = corr(isP.map((p) => p.z), isP.map((p) => p.fwd[H]!));
    const cOOS = corr(oosP.map((p) => p.z), oosP.map((p) => p.fwd[H]!));
    // decile spread (gross, annualized bp/trade-ish): top-decile fwd vs bottom-decile fwd
    const dec = (arr: Pt[]) => {
      const sorted = [...arr].sort((a, b) => a.z - b.z);
      const k = Math.floor(sorted.length / 10);
      const bot = mean(sorted.slice(0, k).map((p) => p.fwd[H]!)) * 1e4;
      const top = mean(sorted.slice(-k).map((p) => p.fwd[H]!)) * 1e4;
      return { bot, top, spread: bot - top }; // contrarian long-bot/short-top
    };
    const dIS = dec(isP), dOOS = dec(oosP);
    console.log(`  H=${String(H).padStart(2)}h | corr z→fwd  IS ${cIS.toFixed(3).padStart(6)}  OOS ${cOOS.toFixed(3).padStart(6)} | contrarian decile spread (bp)  IS ${dIS.spread.toFixed(1).padStart(7)}  OOS ${dOOS.spread.toFixed(1).padStart(7)}`);
  }
}
console.log(`\nSIGNAL if: corr z→fwd is consistently NEGATIVE (contrarian) AND decile spread > ~2×8h-cost (~8bp) in BOTH IS & OOS.`);
console.log(`Else: confirms the prior funding-no-predictive-power null — kill, don't build.`);
