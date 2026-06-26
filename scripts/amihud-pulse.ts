/**
 * Amihud illiquidity factor — PULSE CHECK (research loop, iteration 10, FINAL)
 *
 * Last new factor family before the hard stop. Amihud (2002) illiquidity =
 * mean(|return| / dollar-volume): price impact per dollar traded. Documented
 * premium — illiquid assets compensate holders. Cross-sectional, low turnover
 * (liquidity ranks persist) ⇒ dodges the cost wall.
 *
 * Method: weekly, rank coins by trailing Amihud; long high-illiquidity tercile /
 * short low (and the reverse). dollar-neutral. WF-first: split-half. Report
 * corr→BTC and both directions. Caveat (noted in verdict): illiquid≈small/high-vol
 * alts, so this may overlap the lottery axis that BAB (iter 8) found null.
 *
 * Survives only if net Sharpe>1 with both split-halves>0.
 */
import { readFileSync } from 'node:fs';

interface Candle { timestamp: number; close: number; volume: number }
const COINS = [
  'AAVEUSDT', 'ADAUSDT', 'APTUSDT', 'ARBUSDT', 'ATOMUSDT', 'AVAXUSDT', 'BNBUSDT',
  'BTCUSDT', 'DOGEUSDT', 'DOTUSDT', 'ETHUSDT', 'FILUSDT', 'ICPUSDT', 'LINKUSDT',
  'LTCUSDT', 'NEARUSDT', 'SOLUSDT', 'UNIUSDT', 'XRPUSDT',
];
const FRICTION = Number(process.env.FRICTION ?? 0.0005);
const HOLD = 168;
const PERIODS_YR = (24 * 365) / HOLD;

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); }
function sharpe(xs: number[]): number { const s = std(xs); return s === 0 ? 0 : (mean(xs) / s) * Math.sqrt(PERIODS_YR); }
function half<T>(xs: T[]): [T[], T[]] { const h = Math.floor(xs.length / 2); return [xs.slice(0, h), xs.slice(h)]; }

const closeByCoin = new Map<string, Map<number, number>>();
const volByCoin = new Map<string, Map<number, number>>();
for (const c of COINS) {
  try {
    const raw = JSON.parse(readFileSync(`data/${c}_1h.json`, 'utf8')) as Candle[];
    const cm = new Map<number, number>(), vm = new Map<number, number>();
    for (const k of raw) { if (k.close > 0) cm.set(k.timestamp, k.close); if (k.volume > 0) vm.set(k.timestamp, k.volume); }
    closeByCoin.set(c, cm); volByCoin.set(c, vm);
  } catch { /* skip */ }
}
const live = COINS.filter((c) => closeByCoin.has(c) && volByCoin.get(c)!.size > 0);
const btcTs = [...closeByCoin.get('BTCUSDT')!.keys()].sort((a, b) => a - b);
const timeline = btcTs.filter((t) => live.every((c) => closeByCoin.get(c)!.has(t) && volByCoin.get(c)!.has(t)));

function ret(c: string, i0: number, i1: number): number | null {
  const m = closeByCoin.get(c)!; const a = m.get(timeline[i0]!), b = m.get(timeline[i1]!);
  return a === undefined || b === undefined || a <= 0 ? null : b / a - 1;
}
/** Amihud illiquidity over (i-win, i]: mean |ret_h| / (volume_h·close_h), ×1e9 for readability */
function amihud(c: string, i: number, win: number): number | null {
  const cm = closeByCoin.get(c)!, vm = volByCoin.get(c)!;
  const vals: number[] = [];
  for (let k = i - win + 1; k <= i; k++) {
    const r = ret(c, k - 1, k); const v = vm.get(timeline[k]!); const p = cm.get(timeline[k]!);
    if (r !== null && v !== undefined && p !== undefined && v * p > 0) vals.push(Math.abs(r) / (v * p));
  }
  return vals.length > 10 ? mean(vals) * 1e9 : null;
}

function run(win: number, dir: number): { net: number[]; gross: number[] } {
  const net: number[] = [], gross: number[] = [];
  let prevSet = new Set<string>();
  for (let i = win; i + HOLD < timeline.length; i += HOLD) {
    const scored: { c: string; a: number }[] = [];
    for (const c of live) { const a = amihud(c, i, win); if (a !== null) scored.push({ c, a }); }
    if (scored.length < 6) continue;
    scored.sort((x, y) => x.a - y.a);
    const t = Math.floor(scored.length / 3);
    const liquid = scored.slice(0, t).map((x) => x.c);        // low Amihud
    const illiquid = scored.slice(scored.length - t).map((x) => x.c); // high Amihud
    const longs = dir > 0 ? illiquid : liquid;  // dir>0 = classic (long illiquid)
    const shorts = dir > 0 ? liquid : illiquid;
    const curSet = new Set<string>(); longs.forEach((c) => curSet.add('L' + c)); shorts.forEach((c) => curSet.add('S' + c));
    let changed = 0; for (const c of new Set([...curSet, ...prevSet])) if (curSet.has(c) !== prevSet.has(c)) changed++;
    const cost = (changed / (2 * t)) * FRICTION; prevSet = curSet;
    const lf: number[] = [], sf: number[] = [];
    for (const c of longs) { const r = ret(c, i, i + HOLD); if (r !== null) lf.push(r); }
    for (const c of shorts) { const r = ret(c, i, i + HOLD); if (r !== null) sf.push(r); }
    if (lf.length === 0 || sf.length === 0) continue;
    const pr = mean(lf) - mean(sf);
    gross.push(pr); net.push(pr - cost);
  }
  return { net, gross };
}

console.log(`Amihud illiquidity pulse — ${live.length} coins, ${timeline.length} 1h bars, weekly, long-illiquid/short-liquid tercile, cost ${FRICTION * 10000}bps\n`);
console.log('  dir            | win(d) |  n  | grossSharpe | netSharpe | netAnn% | splitH (1st/2nd) | corr→BTC');
console.log('  ---------------|--------|-----|-------------|-----------|---------|------------------|--------');
for (const dir of [1, -1]) {
  for (const days of [14, 30]) {
    const win = days * 24;
    const r = run(win, dir);
    if (r.net.length < 10) { console.log(`  ${(dir > 0 ? 'long-illiquid' : 'long-liquid').padEnd(14)} | ${String(days).padStart(6)} | insufficient`); continue; }
    const [h1, h2] = half(r.net);
    const btcWk: number[] = []; for (let i = win, k = 0; i + HOLD < timeline.length && k < r.net.length; i += HOLD, k++) btcWk.push(ret('BTCUSDT', i, i + HOLD) ?? 0);
    const n = Math.min(r.net.length, btcWk.length); const ma = mean(r.net.slice(0, n)), mb = mean(btcWk.slice(0, n));
    let cov = 0, va = 0, vb = 0; for (let k = 0; k < n; k++) { cov += (r.net[k]! - ma) * (btcWk[k]! - mb); va += (r.net[k]! - ma) ** 2; vb += (btcWk[k]! - mb) ** 2; }
    const cBtc = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
    console.log(
      `  ${(dir > 0 ? 'long-illiquid' : 'long-liquid').padEnd(14)} | ${String(days).padStart(6)} | ${String(r.net.length).padStart(3)} | ${sharpe(r.gross).toFixed(2).padStart(11)} | ${sharpe(r.net).toFixed(2).padStart(9)} | ${(mean(r.net) * PERIODS_YR * 100).toFixed(1).padStart(6)}% | ${sharpe(h1).toFixed(2)} / ${sharpe(h2).toFixed(2)} | ${cBtc.toFixed(2)}`,
    );
  }
}
console.log('\nRead: netSharpe>1 + both split-halves>0 ⇒ real illiquidity premium. Else null (likely overlaps the lottery axis BAB found dead).');
