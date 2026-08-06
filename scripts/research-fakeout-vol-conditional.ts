/**
 * Is the M5 gold bot's edge CONDITIONAL on volatility, or just fitted to a
 * high-volatility window?
 *
 * The two look identical in a plain backtest. The family is significantly
 * positive in 2025-03→2026-06 (gold ranging 31-166 pt/day) and dead flat in
 * 2020-2024 (~22 pt/day). That is either:
 *
 *   (a) a REAL conditional edge — the mechanism needs volatility to work, in
 *       which case a vol-GATED version is a genuine strategy, or
 *   (b) parameter selection — 2025-26 is simply where the parameters were fit,
 *       and the vol story is a coincidence of when that happened to be.
 *
 * These are distinguished by ONE test: take the parameters fit on 2025-26 and
 * ask whether they work on the HIGH-VOL DAYS INSIDE 2020-2024. Those days exist
 * (COVID March 2020, the Aug-2020 spike, 2022) and the parameters have never
 * seen them. If (a), high-vol holdout days are profitable and there is a
 * tradeable gate. If (b), they are not, and the vol story dies with the rest.
 *
 * The vol percentile is computed CAUSALLY — rank of today's ATR within a
 * trailing window only — so any gate derived from it is actually tradeable.
 */
import { loadM5, atr, run, type Params, type TradeRec } from './research-fakeout-fade';

const FIT = [Date.parse('2025-03-01'), Date.parse('2026-06-09')] as const;
const HOLDOUT = [Date.parse('2020-01-01'), Date.parse('2024-12-31')] as const;
const COST = 0.175;

/** The config that best reproduced his live behaviour: 18.0 trades/day. */
const REPRO: Params = {
  trigger: 'run-exhaust', n: 5, compression: 0, tp: 2, slMult: 1.5,
  maxReflips: 2, maxConcurrent: 6, mode: 'atr', costPerSide: COST,
};
/** The most profitable config on his window. */
const BEST: Params = {
  trigger: 'break-cont', n: 5, compression: 2.5, tp: 3.5, slMult: 1.5,
  maxReflips: 1, maxConcurrent: 6, mode: 'atr', costPerSide: COST,
};

const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
function tstat(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  const sd = Math.sqrt(a.reduce((x, v) => x + (v - m) ** 2, 0) / (a.length - 1));
  return sd > 0 ? m / (sd / Math.sqrt(a.length)) : 0;
}

/**
 * Causal percentile of each trade's entry ATR: rank within the trailing
 * `windowDays` of daily ATR observations available BEFORE that day.
 */
function causalVolPercentile(recs: TradeRec[], windowDays = 250): number[] {
  // One representative ATR per day, in order.
  const byDay = new Map<string, number>();
  for (const r of recs) {
    const k = new Date(r.t).toISOString().slice(0, 10);
    if (!byDay.has(k)) byDay.set(k, r.atr);
  }
  const days = [...byDay.keys()].sort();
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  const series = days.map((d) => byDay.get(d)!);
  return recs.map((r) => {
    const k = new Date(r.t).toISOString().slice(0, 10);
    const i = dayIdx.get(k)!;
    const start = Math.max(0, i - windowDays);
    const hist = series.slice(start, i); // strictly BEFORE today
    if (hist.length < 30) return NaN;
    const below = hist.filter((v) => v < r.atr).length;
    return below / hist.length;
  });
}

function bucketReport(label: string, recs: TradeRec[]): void {
  const pct = causalVolPercentile(recs);
  const buckets: Array<{ lo: number; hi: number; name: string }> = [
    { lo: 0.0, hi: 0.2, name: 'Q1 quietest' },
    { lo: 0.2, hi: 0.4, name: 'Q2' },
    { lo: 0.4, hi: 0.6, name: 'Q3' },
    { lo: 0.6, hi: 0.8, name: 'Q4' },
    { lo: 0.8, hi: 1.01, name: 'Q5 wildest' },
  ];
  console.log(`\n  ${label}`);
  console.log('    vol bucket      trades    $/trade      total       t');
  for (const b of buckets) {
    const sel = recs.filter((_, i) => pct[i]! >= b.lo && pct[i]! < b.hi);
    if (sel.length < 20) { console.log(`    ${b.name.padEnd(14)} ${String(sel.length).padStart(6)}   (too few)`); continue; }
    const p = sel.map((r) => r.pnl);
    console.log(
      `    ${b.name.padEnd(14)} ${String(sel.length).padStart(6)} ${mean(p).toFixed(3).padStart(10)} ` +
      `${('$' + p.reduce((x, y) => x + y, 0).toFixed(0)).padStart(11)} ${tstat(p).toFixed(2).padStart(7)}`);
  }
}

function main(): void {
  console.log('loading …');
  const bars = loadM5();
  const a = atr(bars, 14);

  for (const [name, cfg] of [['REPRO (18 trades/day)', REPRO], ['BEST on his window', BEST]] as const) {
    console.log(`\n════════ ${name} ════════`);
    const fitLog: TradeRec[] = [];
    const holdLog: TradeRec[] = [];
    const rf = run(bars, a, cfg, FIT[0], FIT[1], fitLog);
    const rh = run(bars, a, cfg, HOLDOUT[0], HOLDOUT[1], holdLog);
    console.log(`  fit     $${rf.perDay.toFixed(2)}/day  t=${rf.t.toFixed(2)}  (${rf.trades} trades)`);
    console.log(`  holdout $${rh.perDay.toFixed(2)}/day  t=${rh.t.toFixed(2)}  (${rh.trades} trades)`);

    bucketReport('FIT WINDOW 2025-03→2026-06 (where it was tuned)', fitLog);
    bucketReport('HOLDOUT 2020-2024 — DOES VOL RESCUE IT HERE?', holdLog);

    // The decisive number: top-quintile vol days inside the holdout only.
    const pct = causalVolPercentile(holdLog);
    const hi = holdLog.filter((_, i) => pct[i]! >= 0.8).map((r) => r.pnl);
    const hiZero = holdLog.filter((_, i) => pct[i]! >= 0.8).map((r) => r.pnl + 2 * COST);
    if (hi.length >= 20) {
      console.log(`\n  >>> HOLDOUT high-vol days only: ${hi.length} trades, ` +
        `$${hi.reduce((x, y) => x + y, 0).toFixed(0)} net, $${mean(hi).toFixed(3)}/trade, t=${tstat(hi).toFixed(2)}`);
      console.log(`      same, at ZERO cost: $${hiZero.reduce((x, y) => x + y, 0).toFixed(0)} net, t=${tstat(hiZero).toFixed(2)}`);
      const verdict = mean(hi) > 0 && tstat(hi) > 2
        ? 'CONDITIONAL EDGE — the gate is real and tradeable'
        : mean(hiZero) > 0 && tstat(hiZero) > 2
          ? 'mechanism exists but does not clear costs'
          : 'NO conditional edge — volatility does not rescue it';
      console.log(`      => ${verdict}`);
    }

    // Last place an edge could hide: a session effect. Tested at ZERO cost —
    // the most generous possible framing — and out of sample. If nothing shows
    // here, there is nowhere left for it to be.
    console.log('\n  BY HOUR (UTC), holdout, ZERO cost — the most generous test available');
    const rows: string[] = [];
    for (let h = 0; h < 24; h++) {
      const sel = holdLog.filter((r) => r.hour === h).map((r) => r.pnl + 2 * COST);
      if (sel.length < 100) continue;
      const t = tstat(sel);
      rows.push(`    ${String(h).padStart(2)}:00  n=${String(sel.length).padStart(5)}  $/trade ${mean(sel).toFixed(3).padStart(7)}  t=${t.toFixed(2).padStart(6)}${t > 2 ? '  <-- positive' : ''}`);
    }
    console.log(rows.join('\n'));
    const anyHour = rows.filter((r) => r.includes('<--')).length;
    console.log(`    => ${anyHour} of ${rows.length} hours positive at t>2 (expect ~${(rows.length * 0.025).toFixed(1)} by chance alone)`);
  }
}

main();
