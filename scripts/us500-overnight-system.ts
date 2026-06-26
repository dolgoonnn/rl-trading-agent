#!/usr/bin/env tsx
/**
 * US500 overnight-drift SYSTEM (systems-loop — equity index microstructure mechanism).
 *
 * Documented anomaly (Cooper-Cliff-Gulen; Lou-Polk-Skouras "A Tug of War", 2019): US equity
 * index returns accrue almost ENTIRELY overnight (close→open); the intraday session
 * (open→close) drifts flat-to-negative. Mechanism = overnight risk premium + dealer/ETF
 * rebalancing + retail order flow concentrated at the open. A real systems edge, low turnover
 * (1 RT/day), never tested in this project.
 *
 * Decompose US500 daily into overnight vs intraday legs (US cash session 09:30-16:00 ET,
 * DST-aware), test 3 systems net of cost. IS 2015-2020 / OOS 2021-2026 (chronological split).
 */
import { readFileSync } from 'node:fs';

interface C { timestamp: number; close: number }
const SIDE_BP = Number(process.env.SIDE_BP ?? 1); // US500 CFD/futures ~0.5-1bp/side

function nthSundayUTC(year: number, month: number, n: number): number {
  const dow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return Date.UTC(year, month, 1 + ((7 - dow) % 7) + (n - 1) * 7);
}
// US Eastern: EDT (UTC-4) 2nd Sun Mar 07:00 UTC → 1st Sun Nov 06:00 UTC; else EST (UTC-5)
function etOffsetHours(ts: number): number {
  const y = new Date(ts).getUTCFullYear();
  const edt = ts >= nthSundayUTC(y, 2, 2) + 7 * 3_600_000 && ts < nthSundayUTC(y, 10, 1) + 6 * 3_600_000;
  return edt ? -4 : -5;
}
function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); }
function sharpe(xs: number[]): number { const s = std(xs); return s === 0 ? 0 : (mean(xs) / s) * Math.sqrt(252); }
function tstat(xs: number[]): number { const s = std(xs); return s === 0 ? 0 : (mean(xs) / s) * Math.sqrt(xs.length); }

// per ET calendar day: open (first bar ≥ 09:30 ET) and close (last bar ≤ 16:00 ET)
interface Day { day: string; open: number; close: number }
function sessionDays(): Day[] {
  const m1 = JSON.parse(readFileSync('data/US500_1m.json', 'utf8')) as C[];
  const byDay = new Map<string, { open?: number; close?: number }>();
  for (const c of m1) {
    if (c.close <= 0) continue;
    const local = c.timestamp + etOffsetHours(c.timestamp) * 3_600_000;
    const d = new Date(local);
    const et = d.getUTCHours() * 60 + d.getUTCMinutes();
    const day = d.toISOString().slice(0, 10);
    let rec = byDay.get(day); if (!rec) { rec = {}; byDay.set(day, rec); }
    if (et >= 570 && rec.open === undefined) rec.open = c.close; // first bar at/after 09:30 ET
    if (et <= 960) rec.close = c.close;                          // last bar at/before 16:00 ET
  }
  const out: Day[] = [];
  for (const [day, r] of byDay) if (r.open !== undefined && r.close !== undefined && r.open > 0) out.push({ day, open: r.open, close: r.close });
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

const days = sessionDays();
// legs (gross): intraday = open→close; overnight = open[d]→? no — overnight = prevClose→open
interface Row { day: string; overnight: number; intraday: number }
const rows: Row[] = [];
for (let i = 1; i < days.length; i++) {
  const prev = days[i - 1]!, cur = days[i]!;
  rows.push({ day: cur.day, overnight: Math.log(cur.open / prev.close), intraday: Math.log(cur.close / cur.open) });
}
function split(set: 'IS' | 'OOS'): Row[] {
  return rows.filter((r) => (set === 'IS' ? r.day < '2021-01-01' : r.day >= '2021-01-01'));
}

const c1 = SIDE_BP / 1e4;
// systems: net of cost. overnight-only = 1 RT/day (buy close, sell open). intraday-only = 1 RT/day.
// L/S tug-of-war = long overnight + short intraday = 2 RT/day (enter/exit twice).
function evalSet(label: string, rs: Row[]) {
  const onNet = rs.map((r) => r.overnight - 2 * c1);                 // long overnight only
  const idNet = rs.map((r) => r.intraday - 2 * c1);                  // long intraday only
  const lsNet = rs.map((r) => r.overnight - r.intraday - 4 * c1);   // long ON / short ID
  const onGross = rs.map((r) => r.overnight), idGross = rs.map((r) => r.intraday);
  console.log(`  ${label} (n=${rs.length})`);
  console.log(`    overnight-long : gross ${(mean(onGross) * 1e4).toFixed(2)}bp t=${tstat(onGross).toFixed(1)} | NET ${(mean(onNet) * 1e4).toFixed(2)}bp Sharpe ${sharpe(onNet).toFixed(2)}`);
  console.log(`    intraday-long  : gross ${(mean(idGross) * 1e4).toFixed(2)}bp t=${tstat(idGross).toFixed(1)} | NET ${(mean(idNet) * 1e4).toFixed(2)}bp Sharpe ${sharpe(idNet).toFixed(2)}`);
  console.log(`    L/S tug-of-war : NET ${(mean(lsNet) * 1e4).toFixed(2)}bp Sharpe ${sharpe(lsNet).toFixed(2)}`);
}

console.log(`US500 overnight vs intraday SYSTEM — cost ${SIDE_BP}bp/side · cash session 09:30-16:00 ET (DST-aware)`);
console.log(`Hypothesis: returns accrue overnight (close→open); intraday drifts flat/negative.\n`);
evalSet('IS  2015-2020', split('IS'));
evalSet('OOS 2021-2026', split('OOS'));
console.log(`\nDeployable = overnight-long NET Sharpe > 0.5 in BOTH IS & OOS, low turnover (1 RT/day amortizes cost).`);
