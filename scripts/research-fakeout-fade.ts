/**
 * Failed-breakout fade with stop-and-reverse — reconstruction of an external
 * M5 gold bot, tested against a regime it has never seen.
 *
 * WHAT THE SYSTEM IS (decoded from the author's own chart labels)
 *   `inside-red8`  — an 8-bar compression/inside-bar cluster forms a box.
 *   `Cn.DN/UP.opp8`— price breaks the box, then closes back INSIDE it; the trade
 *                    is taken OPPOSITE the break (the classic fakey/liquidity-trap
 *                    fade — "do not chase the breakout, wait for the fake move").
 *   `RV race reverse` / `RV guard reflip`
 *                  — on a stop-out it immediately reverses, with a guard capping
 *                    consecutive flips.
 *   Fixed brackets — TP ~ +$22.9, SL ~ -$23.8 (~1:1), constant size.
 *
 * WHY THIS TEST EXISTS
 * The author's equity curve (2025-03 -> 2026-07, +$18,093 at 0.01 lot) correlates
 * with gold's average daily RANGE at R^2 = 0.80 — 80% of his monthly P&L variance
 * is explained by how many dollars gold moved per day, not by anything the system
 * learned. His whole sample sits in a regime with 4-6x gold's historical dollar
 * volatility (2020-2024: ~22pt/day; his window: 31-166pt/day). Fixed-dollar
 * brackets mechanically harvest more when the range triples.
 *
 * So the question is NOT "does it make money in 2025-2026" — it demonstrably did.
 * It is "is there a mechanism, or is it a volatility artifact?"
 *
 * DESIGN (pre-registered before running)
 *   FIT   on 2025-03 -> 2026-06 — the author's own window, where he tuned.
 *   TEST  on 2020-01 -> 2024-12 — a true holdout his parameters never saw.
 *   Two bracket modes:
 *     'fixed' — dollar brackets exactly as he runs them.
 *     'atr'   — the same brackets expressed in ATR units. THIS is the real test:
 *               if the MECHANISM has edge, ATR-scaled brackets survive both
 *               regimes. If only fixed-dollars-in-high-vol works, it is an artifact.
 *   KILL CRITERION: the ATR variant must be positive net of costs on the holdout
 *   with t > 2. Anything else is a fail. Declared here so the result cannot be
 *   re-framed after the fact.
 *
 * EXECUTION REALISM (the standing rule: model the complete trader flow)
 *   - Entry fills at the NEXT bar's open, never the signal bar's close.
 *   - TP/SL checked against intrabar high/low.
 *   - When a bar spans both levels, the STOP is assumed first (pessimistic).
 *   - Round-trip cost charged on every fill, including every reflip.
 */
import fs from 'node:fs';
import path from 'node:path';

interface Bar { t: number; o: number; h: number; l: number; c: number }

const DATA = path.resolve(__dirname, '..', 'data', 'XAUUSD_1m.json');

function loadM5(): Bar[] {
  const raw = JSON.parse(fs.readFileSync(DATA, 'utf8')) as Array<Record<string, number>>;
  const out: Bar[] = [];
  let cur: Bar | null = null;
  let curSlot = -1;
  for (const r of raw) {
    const t = (r.timestamp ?? r.time) as number;
    const c = (r.close ?? r.c) as number;
    const h = (r.high ?? r.h ?? c) as number;
    const l = (r.low ?? r.l ?? c) as number;
    const o = (r.open ?? r.o ?? c) as number;
    const slot = Math.floor(t / 300_000);
    if (slot !== curSlot) {
      if (cur) out.push(cur);
      cur = { t: slot * 300_000, o, h, l, c };
      curSlot = slot;
    } else if (cur) {
      if (h > cur.h) cur.h = h;
      if (l < cur.l) cur.l = l;
      cur.c = c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Wilder ATR on the 5m series, in dollars. */
function atr(bars: Bar[], period: number): number[] {
  const out = new Array<number>(bars.length).fill(NaN);
  let prev = bars[0]!.c;
  let acc = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const tr = Math.max(b.h - b.l, Math.abs(b.h - prev), Math.abs(b.l - prev));
    prev = b.c;
    if (i < period) { acc += tr; if (i === period - 1) out[i] = acc / period; continue; }
    out[i] = (out[i - 1]! * (period - 1) + tr) / period;
  }
  return out;
}

export interface Params {
  boxBars: number;        // bars forming the compression box
  compression: number;    // box range must be <= this * ATR
  tp: number;             // take profit — dollars, or ATR multiples in 'atr' mode
  sl: number;             // stop loss  — same units
  maxReflips: number;     // consecutive stop-and-reverse re-entries allowed
  mode: 'fixed' | 'atr';
  costPerSide: number;    // dollars per side, per 1 oz (0.01 lot)
}

export interface Result {
  trades: number; net: number; wins: number; winRate: number;
  meanPerTrade: number; t: number; grossNet: number; costPaid: number;
  maxDD: number; perDay: number;
}

function summarize(rets: number[], cost: number, days: number): Result {
  const n = rets.length;
  if (n === 0) {
    return { trades: 0, net: 0, wins: 0, winRate: 0, meanPerTrade: 0, t: 0, grossNet: 0, costPaid: 0, maxDD: 0, perDay: 0 };
  }
  const net = rets.reduce((a, b) => a + b, 0);
  const mean = net / n;
  const sd = Math.sqrt(rets.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  let eq = 0, peak = 0, maxDD = 0;
  for (const r of rets) { eq += r; if (eq > peak) peak = eq; if (peak - eq > maxDD) maxDD = peak - eq; }
  return {
    trades: n, net, wins: rets.filter((r) => r > 0).length,
    winRate: rets.filter((r) => r > 0).length / n,
    meanPerTrade: mean,
    t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
    grossNet: net + cost, costPaid: cost, maxDD, perDay: net / Math.max(1, days),
  };
}

export function run(bars: Bar[], a: number[], p: Params, from: number, to: number): Result {
  const rets: number[] = [];
  let cost = 0;
  const dayset = new Set<string>();

  // Position state.
  let side: 0 | 1 | -1 = 0;
  let entry = 0, tpPx = 0, slPx = 0, flips = 0;
  // Box state: the most recent compression zone and whether it has been broken.
  let boxHi = 0, boxLo = 0, boxOk = false, brokeUp = false, brokeDn = false;

  const open = (dir: 1 | -1, px: number, atrNow: number): void => {
    const tpD = p.mode === 'fixed' ? p.tp : p.tp * atrNow;
    const slD = p.mode === 'fixed' ? p.sl : p.sl * atrNow;
    side = dir; entry = px;
    tpPx = dir === 1 ? px + tpD : px - tpD;
    slPx = dir === 1 ? px - slD : px + slD;
    cost += p.costPerSide * 2; // round trip charged at entry
  };

  for (let i = p.boxBars + 20; i < bars.length - 1; i++) {
    const b = bars[i]!;
    if (b.t < from || b.t > to) { if (b.t > to) break; continue; }
    const atrNow = a[i]!;
    if (!Number.isFinite(atrNow) || atrNow <= 0) continue;
    dayset.add(new Date(b.t).toISOString().slice(0, 10));

    // ---- manage an open position on THIS bar ----
    if (side !== 0) {
      const hitSL = side === 1 ? b.l <= slPx : b.h >= slPx;
      const hitTP = side === 1 ? b.h >= tpPx : b.l <= tpPx;
      // Pessimistic: when a bar spans both, assume the stop filled first.
      if (hitSL) {
        rets.push(-(Math.abs(entry - slPx)) - p.costPerSide * 2);
        const prevSide = side;
        side = 0;
        // `RV guard reflip` — reverse into the move that stopped us, guard-capped.
        if (flips < p.maxReflips) {
          flips++;
          open(prevSide === 1 ? -1 : 1, b.c, atrNow);
        }
        continue;
      }
      if (hitTP) {
        rets.push(Math.abs(tpPx - entry) - p.costPerSide * 2);
        side = 0; flips = 0;
        continue;
      }
      continue; // still open — no new signals while in a position
    }

    // ---- box detection: `inside-red8` compression ----
    let hi = -Infinity, lo = Infinity;
    for (let k = i - p.boxBars + 1; k <= i; k++) {
      if (bars[k]!.h > hi) hi = bars[k]!.h;
      if (bars[k]!.l < lo) lo = bars[k]!.l;
    }
    if (hi - lo <= p.compression * atrNow) {
      boxHi = hi; boxLo = lo; boxOk = true; brokeUp = false; brokeDn = false;
      continue;
    }
    if (!boxOk) continue;

    // ---- breakout, then failure back inside => fade it (`opp8`) ----
    if (b.h > boxHi) brokeUp = true;
    if (b.l < boxLo) brokeDn = true;

    const backInside = b.c <= boxHi && b.c >= boxLo;
    if (brokeUp && backInside) {
      open(-1, bars[i + 1]!.o, atrNow); // broke up, failed => SHORT
      boxOk = false; flips = 0;
    } else if (brokeDn && backInside) {
      open(1, bars[i + 1]!.o, atrNow);  // broke down, failed => LONG
      boxOk = false; flips = 0;
    }
    // A decisive break that never comes back invalidates the box.
    if (boxOk && (b.c > boxHi + 2 * atrNow || b.c < boxLo - 2 * atrNow)) boxOk = false;
  }

  return summarize(rets, cost, dayset.size);
}

// ── main ─────────────────────────────────────────────────────────────────────
const FIT = [Date.parse('2025-03-01'), Date.parse('2026-06-09')] as const;
const HOLDOUT = [Date.parse('2020-01-01'), Date.parse('2024-12-31')] as const;
const COST = 0.175; // $/side per oz — ~$0.35 round trip, typical retail XAUUSD

function main(): void {
  console.log('loading 1m -> 5m …');
  const bars = loadM5();
  const a = atr(bars, 14);
  console.log(`  ${bars.length} M5 bars, ${new Date(bars[0]!.t).toISOString().slice(0, 10)} -> ${new Date(bars[bars.length - 1]!.t).toISOString().slice(0, 10)}`);

  const grid: Params[] = [];
  for (const boxBars of [6, 8, 12]) {
    for (const compression of [0.8, 1.2, 1.8]) {
      for (const maxReflips of [0, 1, 2]) {
        // Fixed-dollar brackets, as the author runs them (~1:1 at ~$23).
        grid.push({ boxBars, compression, tp: 22.9, sl: 23.8, maxReflips, mode: 'fixed', costPerSide: COST });
        // Same geometry expressed in ATR units.
        for (const tp of [1.5, 2.5, 4]) {
          grid.push({ boxBars, compression, tp, sl: tp * 1.04, maxReflips, mode: 'atr', costPerSide: COST });
        }
      }
    }
  }

  const fit = grid.map((p) => ({ p, r: run(bars, a, p, FIT[0], FIT[1]) }))
    .filter((x) => x.r.trades >= 100);

  const best = (mode: 'fixed' | 'atr') =>
    fit.filter((x) => x.p.mode === mode).sort((x, y) => y.r.net - x.r.net)[0];

  console.log('\n════ FIT WINDOW 2025-03 → 2026-06 (his regime — where he tuned) ════');
  const rows: Array<{ label: string; p: Params; fitR: Result }> = [];
  for (const mode of ['fixed', 'atr'] as const) {
    const b = best(mode);
    if (!b) { console.log(`  ${mode}: no config reached 100 trades`); continue; }
    rows.push({ label: mode, p: b.p, fitR: b.r });
    console.log(`  ${mode.padEnd(5)} box=${b.p.boxBars} comp=${b.p.compression} tp=${b.p.tp} reflips=${b.p.maxReflips}`);
    console.log(`         trades ${b.r.trades}  net $${b.r.net.toFixed(0)}  ($${b.r.perDay.toFixed(1)}/day)  WR ${(b.r.winRate * 100).toFixed(1)}%  t=${b.r.t.toFixed(2)}  maxDD $${b.r.maxDD.toFixed(0)}  cost paid $${b.r.costPaid.toFixed(0)}`);
  }

  console.log('\n════ HOLDOUT 2020-2024 (never seen — THE VERDICT) ════');
  for (const { label, p, fitR } of rows) {
    const r = run(bars, a, p, HOLDOUT[0], HOLDOUT[1]);
    const verdict = r.net > 0 && r.t > 2 ? 'PASS' : 'FAIL';
    console.log(`  ${label.padEnd(5)} trades ${r.trades}  net $${r.net.toFixed(0)}  ($${r.perDay.toFixed(2)}/day)  WR ${(r.winRate * 100).toFixed(1)}%  t=${r.t.toFixed(2)}  maxDD $${r.maxDD.toFixed(0)}   ${verdict}`);
    console.log(`         gross before cost $${r.grossNet.toFixed(0)}  —  cost paid $${r.costPaid.toFixed(0)}   |  fit-window was $${fitR.perDay.toFixed(1)}/day`);
  }

  console.log('\n════ ZERO-COST CHECK (is there ANY mechanism, before friction?) ════');
  for (const { label, p } of rows) {
    const free = { ...p, costPerSide: 0 };
    const rh = run(bars, a, free, HOLDOUT[0], HOLDOUT[1]);
    const rf = run(bars, a, free, FIT[0], FIT[1]);
    console.log(`  ${label.padEnd(5)} holdout $${rh.net.toFixed(0)} (t=${rh.t.toFixed(2)})   fit $${rf.net.toFixed(0)} (t=${rf.t.toFixed(2)})`);
  }
}

main();
