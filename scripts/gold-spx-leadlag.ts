#!/usr/bin/env tsx
/**
 * Gold–SPX intraday lead-lag (gold loop — cross-asset, last untested stone).
 * Does S&P 500's last-hour return predict gold's next-hour return (risk-on/off
 * spillover)? Sign learned on IS, traded OOS. GROSS (does SPX lead gold?) + NET
 * (survives gold's cost + the hourly turnover?). IS 2020-26 / OOS 2015-19.
 */
import { readFileSync } from 'node:fs';

interface C { timestamp: number; close: number }
const SPREAD_BP = Number(process.env.SPREAD_BP ?? 4);
const CAP = 3;

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); }
function clip(x: number, c: number): number { return Math.max(-c, Math.min(c, x)); }
function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length), ma = mean(a), mb = mean(b);
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { cov += (a[i]! - ma) * (b[i]! - mb); va += (a[i]! - ma) ** 2; vb += (b[i]! - mb) ** 2; }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}
function hourlyClose(file: string): Map<number, number> {
  const m1 = JSON.parse(readFileSync(file, 'utf8')) as C[];
  const out = new Map<number, number>();
  for (const c of m1) { const h = Math.floor(c.timestamp / 3_600_000) * 3_600_000; if (c.close > 0) out.set(h, c.close); }
  return out;
}

const spx = hourlyClose('data/US500_1m.json');

interface Aligned { goldRet: number[]; spxRet: number[] }
function align(goldFile: string): Aligned {
  const gold = hourlyClose(goldFile);
  const ts = [...gold.keys()].filter((t) => spx.has(t) && gold.has(t - 3_600_000) && spx.has(t - 3_600_000)).sort((a, b) => a - b);
  const goldRet: number[] = [], spxRetLag: number[] = [];
  for (const t of ts) {
    goldRet.push(gold.get(t)! / gold.get(t - 3_600_000)! - 1);
    spxRetLag.push(spx.get(t - 3_600_000)! / spx.get(t - 2 * 3_600_000)! - 1); // SPX return over PRIOR hour
  }
  return { goldRet, spxRet: spxRetLag };
}

const is = align('data/XAUUSD_1m.json');
const oos = align('data/XAUUSD_1m_holdout.json');

// learn sign + spx vol on IS
const signIS = Math.sign(corr(is.goldRet, is.spxRet)) || 1;
const spxVolIS = std(is.spxRet) || 1;

function trade(a: Aligned): { gross: number[]; net: number[] } {
  const gross: number[] = [], net: number[] = [];
  let prev = 0;
  for (let i = 0; i < a.goldRet.length; i++) {
    const pos = signIS * clip(a.spxRet[i]! / spxVolIS, CAP);
    gross.push(pos * a.goldRet[i]!);
    net.push(pos * a.goldRet[i]! - (SPREAD_BP / 1e4) * Math.abs(pos - prev));
    prev = pos;
  }
  return { gross, net };
}
const annH = Math.sqrt(24 * 252);
function sh(xs: number[]): number { const s = std(xs); return s ? (mean(xs) / s) * annH : 0; }

console.log(`Gold–SPX intraday lead-lag — does SPX[t-1] predict gold[t]? cost ${SPREAD_BP}bp/Δpos\n`);
console.log(`IS cross-corr(gold[t], spx[t-1]) = ${corr(is.goldRet, is.spxRet).toFixed(4)}  (sign learned: ${signIS > 0 ? '+' : '-'})`);
console.log(`OOS cross-corr(gold[t], spx[t-1]) = ${corr(oos.goldRet, oos.spxRet).toFixed(4)}\n`);
console.log('  set        |  bars  | grossSharpe | netSharpe');
console.log('  -----------|--------|-------------|----------');
for (const [label, a] of [['IS 20-26', is], ['OOS 15-19', oos]] as [string, Aligned][]) {
  const r = trade(a);
  console.log(`  ${label.padEnd(10)} | ${String(r.net.length).padStart(6)} | ${sh(r.gross).toFixed(2).padStart(11)} | ${sh(r.net).toFixed(2).padStart(9)}`);
}
console.log('\nGROSS>0 both ⇒ SPX leads gold (real). NET>0.5 OOS ⇒ tradeable. GROSS>0 NET<0 ⇒ cost wall (execution edge).');
