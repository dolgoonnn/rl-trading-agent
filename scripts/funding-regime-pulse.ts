#!/usr/bin/env tsx
/**
 * Aggregate-funding REGIME pulse (systems-loop step 4 — funding as market-timing overlay).
 *
 * Distinct from the per-coin directional null: the PANEL-MEAN funding is a leverage/positioning
 * sentiment gauge. Thesis: extreme aggregate positive funding = crowded leveraged longs =
 * elevated crash risk → lower forward market return (de-risk signal); deeply negative = capitulation
 * → risk-on. If panel-mean funding predicts forward BTC return at multi-day horizon, it's a cheap
 * regime overlay for the deployed crypto book (Run-20). PULSE only — corr + decile spread, IS/OOS.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const UNIVERSE = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT',
  'LINKUSDT', 'DOTUSDT', 'LTCUSDT', 'ATOMUSDT', 'UNIUSDT', 'AAVEUSDT', 'NEARUSDT', 'APTUSDT', 'ARBUSDT', 'FILUSDT', 'ICPUSDT'];
const HORIZONS = [3, 9, 21]; // settlements: 1d / 3d / 7d
const ALPHA = 0.1;

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length), ma = mean(a), mb = mean(b); let c = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { c += (a[i]! - ma) * (b[i]! - mb); va += (a[i]! - ma) ** 2; vb += (b[i]! - mb) ** 2; }
  return va > 0 && vb > 0 ? c / Math.sqrt(va * vb) : 0;
}

// panel-mean funding per settlement
const fundMaps = UNIVERSE.filter((s) => existsSync(resolve('data', `${s}_funding.json`)))
  .map((s) => new Map((JSON.parse(readFileSync(resolve('data', `${s}_funding.json`), 'utf8')) as { timestamp: number; fundingRate: number }[]).map((r) => [r.timestamp, r.fundingRate])));
const settle = [...new Set(fundMaps.flatMap((m) => [...m.keys()]))].sort((a, b) => a - b);
const panel: { ts: number; f: number }[] = [];
for (const ts of settle) { const vals = fundMaps.map((m) => m.get(ts)).filter((x): x is number => x !== undefined); if (vals.length >= 10) panel.push({ ts, f: mean(vals) }); }

// BTC perp price at settlements (forward returns)
const btc = new Map((JSON.parse(readFileSync(resolve('data', 'BTCUSDT_basis_1h.json'), 'utf8')) as { timestamp: number; perp: number }[]).map((r) => [r.timestamp, r.perp]));

interface Pt { ts: number; sig: number; fwd: Record<number, number> }
const pts: Pt[] = [];
let ema = 0; let init = false;
for (let i = 0; i < panel.length - Math.max(...HORIZONS); i++) {
  const { ts, f } = panel[i]!;
  ema = init ? ALPHA * f + (1 - ALPHA) * ema : f; init = true;
  if (!btc.has(ts)) continue;
  const p0 = btc.get(ts)!;
  const fwd: Record<number, number> = {};
  let ok = true;
  for (const H of HORIZONS) { const t2 = panel[i + H]?.ts; if (t2 === undefined || !btc.has(t2)) { ok = false; break; } fwd[H] = Math.log(btc.get(t2)! / p0); }
  if (ok) pts.push({ ts, sig: ema, fwd });
}

console.log(`Aggregate-funding regime pulse — panel-mean funding (EMA α=${ALPHA}) vs forward BTC return\n`);
console.log(`panel n=${panel.length} settlements, usable pts=${pts.length}, funding EMA range [${(Math.min(...pts.map((p) => p.sig)) * 100).toFixed(3)}%, ${(Math.max(...pts.map((p) => p.sig)) * 100).toFixed(3)}%]/8h\n`);
const isP = pts.filter((p) => p.ts < Date.UTC(2025, 0, 1)), oosP = pts.filter((p) => p.ts >= Date.UTC(2025, 0, 1));
for (const H of HORIZONS) {
  const cIS = corr(isP.map((p) => p.sig), isP.map((p) => p.fwd[H]!));
  const cOOS = corr(oosP.map((p) => p.sig), oosP.map((p) => p.fwd[H]!));
  const dec = (arr: Pt[]) => { const s = [...arr].sort((a, b) => a.sig - b.sig); const k = Math.floor(s.length / 5); return (mean(s.slice(0, k).map((p) => p.fwd[H]!)) - mean(s.slice(-k).map((p) => p.fwd[H]!))) * 100; };
  console.log(`  H=${String(H).padStart(2)} settl (${H / 3}d) | corr sig→fwdBTC  IS ${cIS.toFixed(3).padStart(6)}  OOS ${cOOS.toFixed(3).padStart(6)} | low-minus-high funding quintile fwd BTC%  IS ${dec(isP).toFixed(1).padStart(6)}  OOS ${dec(oosP).toFixed(1).padStart(6)}`);
}
console.log(`\nSIGNAL if: corr consistently NEGATIVE (high funding → low fwd return) AND quintile spread positive & material in BOTH IS & OOS.`);
console.log(`Use case would be a de-risk overlay on the crypto book, not a standalone. Else: confirms funding has no timing edge either.`);
