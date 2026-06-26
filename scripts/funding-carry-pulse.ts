/**
 * Funding-carry delta-neutral — PULSE CHECK (research loop, iteration 2)
 *
 * Strategy (not a chart edge): hold long spot + short perp (delta-neutral) and
 * collect perp funding. When fundingRate>0 (longs pay shorts) the short-perp leg
 * RECEIVES funding; price moves net to ~0. Carry P&L ≈ cumulative funding − fees.
 * Barely trades (always-on) → no turnover cost wall (the thing that kills scalp).
 *
 * Tests: (a) always-on short-perp carry, (b) funding-timed (only hold when last
 * settlement funding >0; flat otherwise — avoid paying in bear regimes).
 * Reports ann%, Sharpe, maxDD, %settlements positive, and correlation to BTC
 * spot returns (should be ≈0 — the diversification is the point).
 */
import { readFileSync } from 'node:fs';

interface Row { timestamp: number; fundingRate: number; openInterest: number }
const COINS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const HOUR = 3_600_000;
const SETTLE = 8 * HOUR;                 // Bybit funding settles every 8h (00/08/16 UTC)
const SETTLES_PER_YEAR = 3 * 365;        // 1095
const REHEDGE_COST = 0.00002;            // 2 bps per settlement: delta rehedge + slippage (conservative)

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); }
function maxDD(curve: number[]): number {
  let peak = curve[0] ?? 1, dd = 0;
  for (const v of curve) { if (v > peak) peak = v; if (peak > 0) dd = Math.max(dd, (peak - v) / peak); }
  return dd;
}
function summarize(label: string, rates: number[]): void {
  if (rates.length < 30) { console.log(`${label}: insufficient (${rates.length})`); return; }
  const net = rates.map((r) => r - REHEDGE_COST);
  let eq = 1; const curve: number[] = [1];
  for (const r of net) { eq *= (1 + r); curve.push(eq); }
  const annGross = mean(rates) * SETTLES_PER_YEAR * 100;
  const annNet = mean(net) * SETTLES_PER_YEAR * 100;
  const sharpe = (mean(net) / std(net)) * Math.sqrt(SETTLES_PER_YEAR);
  const pctPos = 100 * rates.filter((r) => r > 0).length / rates.length;
  const totalNet = (eq - 1) * 100;
  console.log(`${label.padEnd(28)} | n=${String(rates.length).padStart(5)} | annGross ${annGross.toFixed(1).padStart(6)}% | annNet ${annNet.toFixed(1).padStart(6)}% | Sharpe ${sharpe.toFixed(2).padStart(5)} | maxDD ${(maxDD(curve) * 100).toFixed(1).padStart(5)}% | %pos ${pctPos.toFixed(0)} | totalNet ${totalNet.toFixed(0)}%`);
}

// load settlement-grid funding per coin (only live rows: openInterest>0)
const fundingByCoin = new Map<string, Map<number, number>>();
for (const c of COINS) {
  const rows = JSON.parse(readFileSync(`data/${c}_futures_1h.json`, 'utf8')) as Row[];
  const m = new Map<number, number>();
  // settlements every 8h; openInterest is placeholder-zero in this file, so gate on
  // real funding instead: drop the leading block of zero-funding placeholder rows.
  const setts = rows.filter((r) => r.timestamp % SETTLE === 0).sort((a, b) => a.timestamp - b.timestamp);
  const firstReal = setts.findIndex((r) => r.fundingRate !== 0);
  const live = firstReal >= 0 ? setts.slice(firstReal) : [];
  for (const r of live) m.set(r.timestamp, r.fundingRate);
  fundingByCoin.set(c, m);
}

console.log(`Funding-carry pulse — settle every 8h, rehedge cost ${REHEDGE_COST * 10000}bps/settle\n`);
console.log('book                         |     n  | annGross | annNet | Sharpe | maxDD | %pos | totalNet');
console.log('-----------------------------|--------|----------|--------|--------|-------|------|---------');

// per-coin always-on
for (const c of COINS) {
  const rates = [...fundingByCoin.get(c)!.values()];
  summarize(`${c} always-on`, rates);
}

// per-coin funding-timed (hold only if PREVIOUS settlement funding > 0)
for (const c of COINS) {
  const entries = [...fundingByCoin.get(c)!.entries()].sort((a, b) => a[0] - b[0]);
  const timed: number[] = [];
  for (let i = 1; i < entries.length; i++) {
    timed.push(entries[i - 1]![1] > 0 ? entries[i]![1] : 0); // flat (0) when prev funding ≤ 0
  }
  summarize(`${c} funding-timed`, timed);
}

// combined equal-weight always-on across the 3 coins (common settlements)
const common = [...fundingByCoin.get('BTCUSDT')!.keys()]
  .filter((t) => COINS.every((c) => fundingByCoin.get(c)!.has(t)))
  .sort((a, b) => a - b);
const combo = common.map((t) => mean(COINS.map((c) => fundingByCoin.get(c)!.get(t)!)));
summarize('COMBINED ew always-on', combo);

// correlation of combined carry to BTC spot returns over the same settlements (delta-neutral check)
const btc = JSON.parse(readFileSync('data/BTCUSDT_1h.json', 'utf8')) as { timestamp: number; close: number }[];
const btcClose = new Map<number, number>(btc.map((c) => [c.timestamp, c.close]));
const pairs: { carry: number; spot: number }[] = [];
for (let i = 1; i < common.length; i++) {
  const t0 = common[i - 1]!, t1 = common[i]!;
  const c0 = btcClose.get(t0), c1 = btcClose.get(t1);
  if (c0 !== undefined && c1 !== undefined) pairs.push({ carry: combo[i]!, spot: c1 / c0 - 1 });
}
if (pairs.length > 30) {
  const cs = pairs.map((p) => p.carry), ss = pairs.map((p) => p.spot);
  const mc = mean(cs), msp = mean(ss);
  const cov = mean(pairs.map((p) => (p.carry - mc) * (p.spot - msp)));
  const corr = cov / (std(cs) * std(ss));
  console.log(`\nCombined-carry vs BTC-spot return correlation: ${corr.toFixed(3)} (≈0 ⇒ genuinely market-neutral, diversifies the directional book)`);
}
console.log('\nRead: annNet>0 with low maxDD & Sharpe>1 & corr≈0 ⇒ a real, combinable market-neutral sleeve.');
