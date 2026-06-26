/**
 * Cross-sectional short-term reversal — PULSE CHECK (research loop, iteration 1)
 *
 * Question: across a ~20-coin crypto panel (1h), is there a short-term REVERSAL
 * premium — long recent losers / short recent winners — and does it survive cost?
 * This is a relative-value edge family the project has never tested (all prior
 * work was single-asset OHLC). Decisive cheap first look BEFORE building anything.
 *
 * Method: at each rebalance (every h bars), rank coins by trailing k-bar return,
 * go long the bottom tercile / short the top tercile (equal-weight, dollar-neutral),
 * hold h bars, record the spread return. Report GROSS + NET (approx cost) Sharpe.
 *
 * GROSS positive & sizable => a real reversal premium exists -> worth building.
 * GROSS flat/negative => family is dead here too -> move to next candidate.
 */
import { readFileSync } from 'node:fs';

interface Candle { timestamp: number; close: number }

const COINS = [
  'AAVEUSDT', 'ADAUSDT', 'APTUSDT', 'ARBUSDT', 'ATOMUSDT', 'AVAXUSDT', 'BNBUSDT',
  'BTCUSDT', 'DOGEUSDT', 'DOTUSDT', 'ETHUSDT', 'FILUSDT', 'ICPUSDT', 'LINKUSDT',
  'LTCUSDT', 'MATICUSDT', 'NEARUSDT', 'SOLUSDT', 'UNIUSDT', 'XRPUSDT',
];

// per-coin timestamp -> close
const closeByCoin = new Map<string, Map<number, number>>();
for (const c of COINS) {
  try {
    const raw = JSON.parse(readFileSync(`data/${c}_1h.json`, 'utf8')) as Candle[];
    const m = new Map<number, number>();
    for (const k of raw) m.set(k.timestamp, k.close);
    closeByCoin.set(c, m);
  } catch {
    // skip missing coin
  }
}

// reference timeline = BTC's hourly grid (most complete history)
const btc = JSON.parse(readFileSync('data/BTCUSDT_1h.json', 'utf8')) as Candle[];
const timeline = btc.map((c) => c.timestamp).sort((a, b) => a - b);
const HOUR = 3_600_000;

function mean(xs: number[]): number { return xs.reduce((s, x) => s + x, 0) / xs.length; }
function std(xs: number[]): number {
  const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

/** trailing k-bar return for coin at timeline index i (needs i and i-k present) */
function pastRet(coin: string, i: number, k: number): number | null {
  const m = closeByCoin.get(coin)!;
  const cNow = m.get(timeline[i]!);
  const cPast = m.get(timeline[i - k]!);
  if (cNow === undefined || cPast === undefined) return null;
  return cNow / cPast - 1;
}
function fwdRet(coin: string, i: number, h: number): number | null {
  const m = closeByCoin.get(coin)!;
  const cNow = m.get(timeline[i]!);
  const cFut = m.get(timeline[i + h]!);
  if (cNow === undefined || cFut === undefined) return null;
  return cFut / cNow - 1;
}

const FRICTION_PER_SIDE = 0.0005; // 5 bps (maker-ish)
// full reconstitution of a 1-long + 1-short book each rebalance ≈ 4 legs traded
const COST_PER_REBALANCE = 4 * FRICTION_PER_SIDE;

function run(k: number, h: number): { n: number; grossMean: number; grossSharpe: number; netSharpe: number; netAnnPct: number } {
  const rets: number[] = [];
  for (let i = k; i + h < timeline.length; i += h) {
    // gap guard: require roughly contiguous hourly bars around the window
    if (timeline[i]! - timeline[i - k]! !== k * HOUR) continue;
    if (timeline[i + h]! - timeline[i]! !== h * HOUR) continue;
    const scored: { coin: string; r: number }[] = [];
    for (const c of COINS) {
      const r = pastRet(c, i, k);
      if (r !== null) scored.push({ coin: c, r });
    }
    if (scored.length < 6) continue; // need enough names for terciles
    scored.sort((a, b) => a.r - b.r);
    const t = Math.floor(scored.length / 3);
    const losers = scored.slice(0, t);          // long these (reversal)
    const winners = scored.slice(scored.length - t); // short these
    const longF: number[] = [];
    const shortF: number[] = [];
    for (const x of losers) { const f = fwdRet(x.coin, i, h); if (f !== null) longF.push(f); }
    for (const x of winners) { const f = fwdRet(x.coin, i, h); if (f !== null) shortF.push(f); }
    if (longF.length === 0 || shortF.length === 0) continue;
    rets.push(mean(longF) - mean(shortF)); // dollar-neutral spread return
  }
  if (rets.length < 30) return { n: rets.length, grossMean: 0, grossSharpe: 0, netSharpe: 0, netAnnPct: 0 };
  const periodsPerYear = (24 * 365) / h;
  const gM = mean(rets); const sd = std(rets);
  const grossSharpe = (gM / sd) * Math.sqrt(periodsPerYear);
  const netRets = rets.map((r) => r - COST_PER_REBALANCE);
  const nM = mean(netRets);
  const netSharpe = (nM / sd) * Math.sqrt(periodsPerYear);
  const netAnnPct = nM * periodsPerYear * 100;
  return { n: rets.length, grossMean: gM, grossSharpe, netSharpe, netAnnPct };
}

console.log(`Cross-sectional short-term REVERSAL pulse — ${closeByCoin.size} coins, ${timeline.length} hourly bars`);
console.log(`cost/rebalance = ${(COST_PER_REBALANCE * 100).toFixed(2)}% (4 legs × ${FRICTION_PER_SIDE * 10000}bps)\n`);
console.log('  k(lkbk) | h(hold) |    n | grossMean/reb | grossSharpe | netSharpe | netAnn%');
console.log('----------|---------|------|---------------|-------------|-----------|--------');
for (const k of [1, 4, 12, 24]) {
  for (const h of [1, 4, 12, 24]) {
    const r = run(k, h);
    console.log(
      `${String(k).padStart(9)} | ${String(h).padStart(7)} | ${String(r.n).padStart(4)} | ${(r.grossMean * 100).toFixed(4).padStart(12)}% | ${r.grossSharpe.toFixed(2).padStart(11)} | ${r.netSharpe.toFixed(2).padStart(9)} | ${r.netAnnPct.toFixed(1).padStart(6)}%`,
    );
  }
}
console.log('\nRead: grossSharpe>0 => reversal premium exists; netSharpe>1 at some (k,h) => survives cost.');
