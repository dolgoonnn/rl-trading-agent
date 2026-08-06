/**
 * Reconstructing an external M5 gold bot, then testing it on a regime it never saw.
 *
 * THE TARGET (from the author's own charts)
 *   ~18 trades/day from ~10 signals, ~50% win rate, ~+$45/day at 0.01 lot,
 *   TP ~ +$22.9 / SL ~ -$23.8, and VISIBLY OVERLAPPING positions.
 *   Labels: `inside-red8`, `Cn.DN/UP.opp8`, `RV race reverse`, `RV guard reflip`,
 *   `C0 oc=-1 reverse`  ("oc" = open-close direction of the bar).
 *
 * A first attempt read `opp8` as a failed-box-breakout fade and produced 2.3
 * trades/day and $1.9/day — 4% of his result. Being 20x off means the
 * RECONSTRUCTION is wrong, not that the idea is dead. So this version does the
 * actual work: four trigger families, concurrency, and a wide grid, all scored
 * against how closely they REPRODUCE his live behaviour before any verdict.
 *
 * TRIGGER FAMILIES
 *   run-exhaust  — fade after N consecutive same-direction bars (`oc=-1`, `opp8`
 *                  = take the OPPOSITE of an 8-bar run). Counter-trend.
 *   fade-break   — box forms, price breaks out, closes back inside => fade it.
 *   break-cont   — box forms, price breaks out => go WITH the break.
 *   inside-break — mother bar + inside bar, enter on the mother-bar break.
 *
 * METHOD (pre-registered)
 *   1. CALIBRATE on 2025-03 -> 2026-06 (his window) and rank by how close each
 *      config lands to 18 trades/day AND positive $/day. Reproduction first.
 *   2. Only then run the winner on 2020-2024 — a true holdout his parameters
 *      have never seen.
 *   3. Report the zero-cost result too, so "no edge" and "eaten by friction"
 *      stay distinguishable.
 *   KILL: must be positive net of costs on the holdout with t > 2.
 *
 * EXECUTION REALISM
 *   Entry fills at the NEXT bar's open. TP/SL checked on intrabar high/low.
 *   A bar spanning both is scored as the STOP (pessimistic). Round-trip cost on
 *   every fill including reflips.
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

export type Trigger = 'run-exhaust' | 'fade-break' | 'break-cont' | 'inside-break';

export interface Params {
  trigger: Trigger;
  n: number;              // run length / box bars / lookback
  compression: number;    // box range <= this * ATR (box triggers only)
  tp: number;             // dollars, or ATR multiples in 'atr' mode
  slMult: number;         // SL = tp * slMult
  maxReflips: number;
  maxConcurrent: number;  // his chart shows overlapping positions
  mode: 'fixed' | 'atr';
  costPerSide: number;
}

export interface Result {
  trades: number; net: number; winRate: number; meanPerTrade: number;
  t: number; grossNet: number; costPaid: number; maxDD: number;
  perDay: number; tradesPerDay: number; days: number;
}

interface Pos { dir: 1 | -1; entry: number; tp: number; sl: number; flips: number }

export function run(bars: Bar[], a: number[], p: Params, from: number, to: number): Result {
  const rets: number[] = [];
  let cost = 0;
  const dayset = new Set<string>();
  let open: Pos[] = [];
  const pending: Array<{ dir: 1 | -1; flips: number }> = [];

  // Box state for the box-based triggers.
  let boxHi = 0, boxLo = 0, boxOk = false, brokeUp = false, brokeDn = false;

  const bracket = (dir: 1 | -1, px: number, atrNow: number, flips: number): Pos => {
    const tpD = p.mode === 'fixed' ? p.tp : p.tp * atrNow;
    const slD = tpD * p.slMult;
    cost += p.costPerSide * 2;
    return {
      dir, entry: px, flips,
      tp: dir === 1 ? px + tpD : px - tpD,
      sl: dir === 1 ? px - slD : px + slD,
    };
  };

  for (let i = Math.max(p.n, 20) + 2; i < bars.length - 1; i++) {
    const b = bars[i]!;
    if (b.t < from) continue;
    if (b.t > to) break;
    const atrNow = a[i]!;
    if (!Number.isFinite(atrNow) || atrNow <= 0) continue;
    dayset.add(new Date(b.t).toISOString().slice(0, 10));

    // ---- fill anything queued on the previous bar, at THIS bar's open ----
    while (pending.length > 0) {
      const q = pending.shift()!;
      if (open.length < p.maxConcurrent) open.push(bracket(q.dir, b.o, atrNow, q.flips));
    }

    // ---- manage open positions ----
    const still: Pos[] = [];
    for (const pos of open) {
      const hitSL = pos.dir === 1 ? b.l <= pos.sl : b.h >= pos.sl;
      const hitTP = pos.dir === 1 ? b.h >= pos.tp : b.l <= pos.tp;
      if (hitSL) {
        rets.push(-Math.abs(pos.entry - pos.sl) - p.costPerSide * 2);
        // `RV guard reflip` — reverse into the move that stopped us.
        if (pos.flips < p.maxReflips) {
          pending.push({ dir: (pos.dir === 1 ? -1 : 1) as 1 | -1, flips: pos.flips + 1 });
        }
        continue;
      }
      if (hitTP) {
        rets.push(Math.abs(pos.tp - pos.entry) - p.costPerSide * 2);
        continue;
      }
      still.push(pos);
    }
    open = still;
    if (open.length >= p.maxConcurrent) continue;

    // ---- signal generation ----
    let sig: 1 | -1 | 0 = 0;

    if (p.trigger === 'run-exhaust') {
      // `opp8` / `oc=-1`: N consecutive same-direction bars => take the opposite.
      let up = 0, dn = 0;
      for (let k = i - p.n + 1; k <= i; k++) {
        const x = bars[k]!;
        if (x.c > x.o) up++; else if (x.c < x.o) dn++;
      }
      if (up === p.n) sig = -1;
      else if (dn === p.n) sig = 1;
    } else if (p.trigger === 'inside-break') {
      const mother = bars[i - 1]!;
      const inside = b;
      if (inside.h < mother.h && inside.l > mother.l) {
        // Enter on whichever side of the mother bar breaks first — approximate
        // with the direction the inside bar is leaning.
        sig = inside.c > inside.o ? 1 : -1;
      }
    } else {
      // Box-based triggers: detect compression, then act on the break.
      let hi = -Infinity, lo = Infinity;
      for (let k = i - p.n + 1; k <= i; k++) {
        if (bars[k]!.h > hi) hi = bars[k]!.h;
        if (bars[k]!.l < lo) lo = bars[k]!.l;
      }
      if (hi - lo <= p.compression * atrNow) {
        boxHi = hi; boxLo = lo; boxOk = true; brokeUp = false; brokeDn = false;
      } else if (boxOk) {
        if (b.h > boxHi) brokeUp = true;
        if (b.l < boxLo) brokeDn = true;
        const backInside = b.c <= boxHi && b.c >= boxLo;
        if (p.trigger === 'fade-break') {
          if (brokeUp && backInside) { sig = -1; boxOk = false; }
          else if (brokeDn && backInside) { sig = 1; boxOk = false; }
        } else {
          if (brokeUp && b.c > boxHi) { sig = 1; boxOk = false; }
          else if (brokeDn && b.c < boxLo) { sig = -1; boxOk = false; }
        }
        if (boxOk && (b.c > boxHi + 2 * atrNow || b.c < boxLo - 2 * atrNow)) boxOk = false;
      }
    }

    if (sig !== 0) pending.push({ dir: sig, flips: 0 });
  }

  const n = rets.length;
  const days = Math.max(1, dayset.size);
  if (n === 0) {
    return { trades: 0, net: 0, winRate: 0, meanPerTrade: 0, t: 0, grossNet: 0, costPaid: 0, maxDD: 0, perDay: 0, tradesPerDay: 0, days };
  }
  const net = rets.reduce((x, y) => x + y, 0);
  const mean = net / n;
  const sd = Math.sqrt(rets.reduce((x, r) => x + (r - mean) ** 2, 0) / Math.max(1, n - 1));
  let eq = 0, peak = 0, maxDD = 0;
  for (const r of rets) { eq += r; if (eq > peak) peak = eq; if (peak - eq > maxDD) maxDD = peak - eq; }
  return {
    trades: n, net, winRate: rets.filter((r) => r > 0).length / n, meanPerTrade: mean,
    t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
    grossNet: net + cost, costPaid: cost, maxDD,
    perDay: net / days, tradesPerDay: n / days, days,
  };
}

const FIT = [Date.parse('2025-03-01'), Date.parse('2026-06-09')] as const;
const HOLDOUT = [Date.parse('2020-01-01'), Date.parse('2024-12-31')] as const;
const COST = 0.175; // $/side per oz ≈ $0.35 round trip, typical retail XAUUSD

// His live behaviour — the reproduction target.
const TARGET_TPD = 18;
const TARGET_PERDAY = 45;

function main(): void {
  console.log('loading 1m -> 5m …');
  const bars = loadM5();
  const a = atr(bars, 14);
  console.log(`  ${bars.length} M5 bars  ${new Date(bars[0]!.t).toISOString().slice(0, 10)} -> ${new Date(bars[bars.length - 1]!.t).toISOString().slice(0, 10)}`);
  console.log(`  reproduction target: ${TARGET_TPD} trades/day, ~$${TARGET_PERDAY}/day\n`);

  const grid: Params[] = [];
  const triggers: Trigger[] = ['run-exhaust', 'fade-break', 'break-cont', 'inside-break'];
  for (const trigger of triggers) {
    const ns = trigger === 'run-exhaust' ? [3, 4, 5, 6, 8] : trigger === 'inside-break' ? [1] : [5, 8, 12];
    for (const n of ns) {
      for (const compression of trigger === 'fade-break' || trigger === 'break-cont' ? [0.8, 1.2, 1.8, 2.5] : [0]) {
        for (const maxConcurrent of [1, 3, 6]) {
          for (const maxReflips of [0, 1, 2]) {
            for (const slMult of [0.7, 1.04, 1.5]) {
              grid.push({ trigger, n, compression, tp: 22.9, slMult, maxReflips, maxConcurrent, mode: 'fixed', costPerSide: COST });
              for (const tp of [1, 2, 3.5]) {
                grid.push({ trigger, n, compression, tp, slMult, maxReflips, maxConcurrent, mode: 'atr', costPerSide: COST });
              }
            }
          }
        }
      }
    }
  }
  console.log(`grid: ${grid.length} configs\n`);

  const fit = grid.map((p) => ({ p, r: run(bars, a, p, FIT[0], FIT[1]) })).filter((x) => x.r.trades >= 50);

  // Rank by REPRODUCTION: how close to his trade rate, among profitable configs.
  const closeness = (r: Result): number => Math.abs(Math.log(r.tradesPerDay / TARGET_TPD));
  const reproducers = fit.filter((x) => x.r.perDay > 0).sort((x, y) => closeness(x.r) - closeness(y.r));

  console.log('════ CALIBRATION on his window (2025-03 → 2026-06) ════');
  console.log('closest reproductions of his 18 trades/day that are also profitable:');
  console.log('trigger      n comp conc flip mode  tp    sl×   trades/day   $/day    WR      t');
  for (const { p, r } of reproducers.slice(0, 10)) {
    console.log(
      `${p.trigger.padEnd(12)} ${p.n} ${String(p.compression).padEnd(4)} ${p.maxConcurrent}    ${p.maxReflips}    ${p.mode.padEnd(5)} ${String(p.tp).padEnd(5)} ${String(p.slMult).padEnd(5)} ` +
      `${r.tradesPerDay.toFixed(1).padStart(8)} ${r.perDay.toFixed(2).padStart(9)} ${(r.winRate * 100).toFixed(1).padStart(6)}% ${r.t.toFixed(2).padStart(6)}`);
  }

  console.log('\nbest by profit per day (any trade rate):');
  const byProfit = fit.slice().sort((x, y) => y.r.perDay - x.r.perDay);
  console.log('trigger      n comp conc flip mode  tp    sl×   trades/day   $/day    WR      t');
  for (const { p, r } of byProfit.slice(0, 10)) {
    console.log(
      `${p.trigger.padEnd(12)} ${p.n} ${String(p.compression).padEnd(4)} ${p.maxConcurrent}    ${p.maxReflips}    ${p.mode.padEnd(5)} ${String(p.tp).padEnd(5)} ${String(p.slMult).padEnd(5)} ` +
      `${r.tradesPerDay.toFixed(1).padStart(8)} ${r.perDay.toFixed(2).padStart(9)} ${(r.winRate * 100).toFixed(1).padStart(6)}% ${r.t.toFixed(2).padStart(6)}`);
  }

  // Per-trigger best, so no family is dismissed because another dominated the grid.
  console.log('\nbest config per trigger family (by $/day on his window):');
  const winners: Array<{ label: string; p: Params; r: Result }> = [];
  for (const trigger of triggers) {
    const b = byProfit.find((x) => x.p.trigger === trigger);
    if (!b) { console.log(`  ${trigger}: nothing reached 50 trades`); continue; }
    winners.push({ label: trigger, p: b.p, r: b.r });
    console.log(`  ${trigger.padEnd(12)} $${b.r.perDay.toFixed(2)}/day  ${b.r.tradesPerDay.toFixed(1)} tr/day  t=${b.r.t.toFixed(2)}  net $${b.r.net.toFixed(0)}`);
  }
  // Also carry the single closest reproducer, whatever family it came from.
  if (reproducers[0]) winners.push({ label: `closest-repro(${reproducers[0].p.trigger})`, p: reproducers[0].p, r: reproducers[0].r });

  console.log('\n════ HOLDOUT 2020-2024 — never seen. THE VERDICT ════');
  console.log('config                        trades/day   $/day     net      t      maxDD   verdict');
  for (const { label, p } of winners) {
    const r = run(bars, a, p, HOLDOUT[0], HOLDOUT[1]);
    const pass = r.net > 0 && r.t > 2;
    console.log(
      `${label.padEnd(28)} ${r.tradesPerDay.toFixed(1).padStart(8)} ${r.perDay.toFixed(2).padStart(9)} ${('$' + r.net.toFixed(0)).padStart(9)} ${r.t.toFixed(2).padStart(6)} ${('$' + r.maxDD.toFixed(0)).padStart(9)}   ${pass ? 'PASS' : 'FAIL'}`);
  }

  console.log('\n════ ZERO-COST — is there a mechanism at all, before friction? ════');
  console.log('config                          fit $/day (t)        holdout $/day (t)');
  for (const { label, p } of winners) {
    const free = { ...p, costPerSide: 0 };
    const rf = run(bars, a, free, FIT[0], FIT[1]);
    const rh = run(bars, a, free, HOLDOUT[0], HOLDOUT[1]);
    console.log(`${label.padEnd(30)} ${rf.perDay.toFixed(2).padStart(8)} (${rf.t.toFixed(2).padStart(5)})   ${rh.perDay.toFixed(2).padStart(10)} (${rh.t.toFixed(2).padStart(5)})`);
  }

  // ── EXHAUSTIVE: does ANYTHING in the grid survive the holdout? ──────────────
  // Reporting only the configs I chose would answer the weaker question ("did my
  // picks fail?"). The question that matters is whether the grid contains a
  // survivor at all — and how many pass by chance, which is what a 3,240-config
  // search buys you for free.
  console.log('\n════ EXHAUSTIVE HOLDOUT SWEEP — all configs ════');
  const all = grid.map((p) => ({ p, fit: run(bars, a, p, FIT[0], FIT[1]), hold: run(bars, a, p, HOLDOUT[0], HOLDOUT[1]) }))
    .filter((x) => x.fit.trades >= 50 && x.hold.trades >= 50);
  const holdPass = all.filter((x) => x.hold.net > 0 && x.hold.t > 2);
  const bothPass = holdPass.filter((x) => x.fit.net > 0 && x.fit.t > 2);
  console.log(`  configs evaluated: ${all.length}`);
  console.log(`  positive on holdout at all: ${all.filter((x) => x.hold.net > 0).length}`);
  console.log(`  holdout PASS (net>0, t>2):  ${holdPass.length}`);
  console.log(`  pass BOTH fit and holdout:  ${bothPass.length}   <-- the only ones that would matter`);
  for (const x of bothPass.slice(0, 10)) {
    console.log(`    ${x.p.trigger} n=${x.p.n} comp=${x.p.compression} conc=${x.p.maxConcurrent} flip=${x.p.maxReflips} ${x.p.mode} tp=${x.p.tp} sl×${x.p.slMult}`);
    console.log(`      fit $${x.fit.perDay.toFixed(2)}/day t=${x.fit.t.toFixed(2)} | holdout $${x.hold.perDay.toFixed(2)}/day t=${x.hold.t.toFixed(2)}`);
  }

  // Best fit-window t against what a search this wide yields from pure noise.
  const maxFitT = Math.max(...all.map((x) => x.fit.t));
  const expectedMaxT = Math.sqrt(2 * Math.log(all.length));
  console.log(`\n  best fit-window t across the search: ${maxFitT.toFixed(2)}`);
  console.log(`  expected max |t| from ${all.length} PURE NOISE trials: ${expectedMaxT.toFixed(2)}`);
  console.log(`  => ${maxFitT < expectedMaxT ? 'BELOW the noise expectation — the fit-window result is what a search this wide produces from nothing' : 'above the noise expectation'}`);
}

main();
