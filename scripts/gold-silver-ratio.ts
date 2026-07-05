#!/usr/bin/env tsx
/**
 * Gold–silver intraday ratio mean-reversion (gold loop — relative-value).
 *
 * Genuinely different family: not directional. The XAU/XAG ratio mean-reverts
 * (real macro prior). Trade the log-spread ln(XAU)-ln(XAG) when it deviates,
 * bet on convergence. Multi-hour hold ⇒ low-ish turnover. Both legs ⇒ ~2x cost.
 *
 * Hourly bars, z vs trailing window, enter |z|>2 / exit |z|<0.5, no look-ahead
 * (signal from prior bar). Cost charged on each position change (both legs).
 * IS 2020-26 + OOS 2015-19 (both assets have aligned holdouts). Judge on OOS.
 */
import { readFileSync } from 'node:fs';

interface C { timestamp: number; open: number; high: number; low: number; close: number }
const Z_ENTER = Number(process.env.Z_ENTER ?? 2);
const Z_EXIT = Number(process.env.Z_EXIT ?? 0.5);
const WIN = Number(process.env.WIN ?? 48);            // trailing hours for z
const COMBINED_BP = Number(process.env.COMBINED_BP ?? 6); // both legs, one-way (gold~2+silver~4 bp/side)

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); }

function hourlyClose(file: string): Map<number, number> {
  const m1 = JSON.parse(readFileSync(file, 'utf8')) as C[];
  const out = new Map<number, number>();
  for (const c of m1) { const h = Math.floor(c.timestamp / 3_600_000) * 3_600_000; if (c.close > 0) out.set(h, c.close); }
  return out;
}

function run(label: string, xauFile: string, xagFile: string): void {
  const xau = hourlyClose(xauFile), xag = hourlyClose(xagFile);
  const ts = [...xau.keys()].filter((t) => xag.has(t)).sort((a, b) => a - b);
  const spread = ts.map((t) => Math.log(xau.get(t)!) - Math.log(xag.get(t)!));
  const net: number[] = []; const gross: number[] = [];
  let pos = 0, nTrades = 0;
  for (let i = WIN; i < ts.length; i++) {
    if (ts[i]! - ts[i - 1]! !== 3_600_000) { pos = 0; continue; } // gap → flat
    const wnd = spread.slice(i - WIN, i);
    const mu = mean(wnd), sd = std(wnd);
    if (sd === 0) continue;
    const z = (spread[i - 1]! - mu) / sd; // prior-bar signal
    let np = pos;
    if (pos === 0) { if (z > Z_ENTER) np = -1; else if (z < -Z_ENTER) np = 1; }
    else if (pos === 1 && z > -Z_EXIT) np = 0;
    else if (pos === -1 && z < Z_EXIT) np = 0;
    let cost = 0; if (np !== pos) { nTrades++; cost = COMBINED_BP / 1e4; }
    const dS = spread[i]! - spread[i - 1]!;
    gross.push(np * dS); net.push(np * dS - cost);
    pos = np;
  }
  const annH = Math.sqrt(24 * 252);
  const sg = std(gross), sn = std(net);
  const grossSharpe = sg ? (mean(gross) / sg) * annH : 0;
  const netSharpe = sn ? (mean(net) / sn) * annH : 0;
  const netAnn = mean(net) * 24 * 252 * 100;
  console.log(`  ${label.padEnd(10)} | bars ${String(net.length).padStart(6)} | trades ${String(nTrades).padStart(4)} | grossSharpe ${grossSharpe.toFixed(2).padStart(6)} | netSharpe ${netSharpe.toFixed(2).padStart(6)} | netAnn ${netAnn.toFixed(1).padStart(6)}%`);
}

console.log(`Gold–silver ratio mean-reversion — z window ${WIN}h, enter |z|>${Z_ENTER} exit |z|<${Z_EXIT}, cost ${COMBINED_BP}bp/change\n`);
console.log('  set        |  bars   | trades | grossSharpe | netSharpe | netAnn');
console.log('  -----------|---------|--------|-------------|-----------|-------');
run('IS 20-26', 'data/XAUUSD_1m.json', 'data/XAGUSD_1m.json');
run('OOS 15-19', 'data/XAUUSD_1m_holdout.json', 'data/XAGUSD_1m_holdout.json');
console.log('\nSURVIVE = OOS netSharpe>0.5 net of cost. grossSharpe>>netSharpe ⇒ cost wall again.');
