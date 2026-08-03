#!/usr/bin/env tsx
/**
 * Prop-rule Monte Carlo — Test 1 of the gold-scalp deep dig (2026-08).
 *
 * Extends research-prop-barrier.ts (historical-start resampling, generic
 * Topstep-shaped rules) with everything its writeup listed as un-modeled:
 *   - stationary BLOCK bootstrap (Politis-Romano, seeded LCG) over union-
 *     calendar day-vectors, preserving cross-leg same-day correlation
 *   - firm-specific rulesets verified 2026-08: Topstep 50K Combine vs
 *     MyFundedFutures Rapid 50K (Core is legacy since Jul-2026)
 *   - firm-specific books: Topstep bans weekend holds -> overnight legs
 *     rebuilt with weekendGap=false; MFFU Rapid allows them
 *   - MGC/SIL micro-futures friction (replaces the 0.3/1bp spot-tier bake-in)
 *   - monthly eval fees, activation fee, profit split, payout-denial haircut,
 *     eval consistency rule (Topstep: best day < 50% of profit at pass)
 *   - INTEGER-CONTRACT tier: the granularity vise from prop-barrier-sim.md,
 *     contracts sized at today's prices (the decision is about buying an
 *     eval now, so forward-looking notionals are the right ones)
 *
 * Book = metals sleeve only (legs A,B,C,D,I,F) — the prop-eligible subset per
 * the 2026-08 workflow verdict. US500/EUR legs excluded (separate decision).
 *
 * Decision gate (pre-registered): buy ONE eval (MFFU Rapid first) only if
 * E[net per attempt] > 3x total fees AND P(pass eval) > 50% at the chosen
 * sizing. Otherwise the prop path stays shelved.
 *
 * Usage: NODE_OPTIONS=--max-old-space-size=12288 npx tsx scripts/prop-rule-mc.ts
 *   [--iters 1000] [--stress 0.5] [--pessimistic]
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';
import { extractTrades } from './backtest-gold-session';
import { clockWindowDaily, firstFriday } from './analyze-combo-portfolio';

// ---------------------------------------------------------------- frictions
// Per-side log-fraction friction at micro-futures tier (spread/2 + fees on
// notional). MGC: 1-tick ($1.00) spread on ~$40k notional + ~$1.34 all-in RT
// commission -> ~0.45bp/side RTH; ETH (overnight entries) 2-tick spread
// half the year -> 0.60bp/side. SIL (micro silver, 1000oz): wider book.
const FRICTION = {
  MGC_RTH: 0.000045,
  MGC_ETH: 0.00006,
  SIL_RTH: 0.0001,
  SIL_ETH: 0.00013,
};

interface LegDef {
  name: string;
  weight: number; // legWeight convention: overnight 0.5, windows 1.0
  instrument: 'MGC' | 'SIL';
  series: Map<string, number>; // date -> daily LOG return, friction included
}

interface FirmRules {
  key: string;
  label: string;
  account: number;
  target: number;
  trail: number; // trailing max-loss distance, locks at starting balance
  dailyLoss: number | null; // null = no DLL (TopstepX removed it in 2024)
  evalConsistencyFrac: number | null; // best day <= frac * profit at pass
  weekendHold: boolean;
  fundedIntradayTrail: boolean; // MFFU Rapid funded phase trails intraday
  evalFeeMonthly: number;
  activationFee: number;
  payoutCushion: number; // equity above account+cushion sweeps monthly
  firstPayoutWinDays: { days: number; minWin: number } | null; // Topstep gate
  split: (cumGross: number, sweep: number) => number; // trader's share of sweep
  payoutHaircut: number; // P(paid) discount for denial/counterparty risk
}

const FIRMS: FirmRules[] = [
  {
    key: 'topstep50k',
    label: 'Topstep 50K Combine',
    account: 50_000,
    target: 3_000,
    trail: 2_000,
    dailyLoss: null, // TopstepX default since Aug-2024; sensitivity flag below
    evalConsistencyFrac: 0.5,
    weekendHold: false,
    fundedIntradayTrail: false,
    evalFeeMonthly: 49,
    activationFee: 149,
    payoutCushion: 2_000,
    firstPayoutWinDays: { days: 5, minWin: 200 },
    // 100% of first $10k cumulative, then 90/10
    split: (cumGross, sweep) => {
      const at100 = Math.max(0, Math.min(sweep, 10_000 - cumGross));
      return at100 + (sweep - at100) * 0.9;
    },
    payoutHaircut: 0.95,
  },
  {
    key: 'mffuRapid50k',
    label: 'MFFU Rapid 50K',
    account: 50_000,
    target: 3_000,
    trail: 2_000,
    dailyLoss: null,
    evalConsistencyFrac: null,
    weekendHold: true,
    fundedIntradayTrail: true,
    evalFeeMonthly: 129,
    activationFee: 0,
    payoutCushion: 2_000,
    firstPayoutWinDays: null,
    split: (_cum, sweep) => sweep * 0.9,
    payoutHaircut: 0.85,
  },
];

// ---------------------------------------------------------------- utilities
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
}

// -------------------------------------------------------------- leg builder
function buildBook(gold: Candle[], silver: Candle[], weekendHold: boolean, fricMult: number): LegDef[] {
  const F = {
    MGC_RTH: FRICTION.MGC_RTH * fricMult,
    MGC_ETH: FRICTION.MGC_ETH * fricMult,
    SIL_RTH: FRICTION.SIL_RTH * fricMult,
    SIL_ETH: FRICTION.SIL_ETH * fricMult,
  };
  const overnight = (candles: Candle[], friction: number): Map<string, number> => {
    const out = new Map<string, number>();
    for (const t of extractTrades(candles, weekendHold, 18, 7, 5, 'ny')) {
      const key = new Date(t.exitTs).toISOString().slice(0, 10);
      out.set(key, (out.get(key) ?? 0) + t.rawLogRet - 2 * friction);
    }
    return out;
  };

  const nfpDates = new Set<string>();
  for (let y = 2015; y <= 2026; y++) for (let m = 0; m < 12; m++) nfpDates.add(firstFriday(y, m));
  const sig = clockWindowDaily(gold, 'ny', 510, 540, 1, 0, nfpDates);
  const out0912 = clockWindowDaily(gold, 'ny', 540, 720, 1, 0, nfpDates);
  const fLeg = new Map<string, number>();
  for (const [day, s] of sig) {
    const o = out0912.get(day);
    if (o !== undefined && s !== 0) fLeg.set(day, Math.sign(s) * o - 2 * F.MGC_RTH);
  }

  return [
    { name: 'A:Au-overnight', weight: 0.5, instrument: 'MGC', series: overnight(gold, F.MGC_ETH) },
    { name: 'B:Ag-overnight', weight: 0.5, instrument: 'SIL', series: overnight(silver, F.SIL_ETH) },
    { name: 'C:Au-fix-short', weight: 1.0, instrument: 'MGC', series: clockWindowDaily(gold, 'london', 840, 900, -1, F.MGC_RTH) },
    { name: 'D:Au-AMfix-long', weight: 1.0, instrument: 'MGC', series: clockWindowDaily(gold, 'london', 630, 690, 1, F.MGC_RTH) },
    { name: 'I:Ag-ownfix-short', weight: 1.0, instrument: 'SIL', series: clockWindowDaily(silver, 'london', 660, 720, -1, F.SIL_RTH) },
    { name: 'F:Au-NFP-mom', weight: 1.0, instrument: 'MGC', series: fLeg },
  ];
}

/** Union-calendar day vectors of SIMPLE returns per leg (0 when inactive). */
function toDayVectors(legs: LegDef[], since: string): { dates: string[]; vectors: number[][] } {
  const all = new Set<string>();
  for (const l of legs) for (const d of l.series.keys()) if (d >= since) all.add(d);
  const dates = [...all].sort();
  const vectors = dates.map((d) => legs.map((l) => {
    const r = l.series.get(d);
    return r === undefined ? 0 : Math.exp(r) - 1;
  }));
  return { dates, vectors };
}

// --------------------------------------------------------------- lifecycle
interface Sizing {
  label: string;
  /** dollar PnL for a day vector */
  pnl: (vec: number[]) => number;
  grossNotional: number;
  detail: string;
}

interface AttemptResult {
  passed: boolean;
  evalDays: number;
  feesPaid: number;
  netPayout: number; // after split + haircut
  blownFunded: boolean;
  fundedDays: number;
}

const EVAL_CAP_DAYS = 378; // 18 months of trading days — give slow sizes room
const FUNDED_CAP_DAYS = 252; // report a 12-month funded window

function runAttempt(
  path_: number[][],
  firm: FirmRules,
  sizing: Sizing,
  sigmaDollar: number,
  stressF: number,
): AttemptResult {
  const start = firm.account;
  let equity = start;
  let peak = start;
  let mll = start - firm.trail;
  let evalDays = 0;
  let fees = 0;
  let bestDay = 0;
  let phase: 'eval' | 'funded' = 'eval';
  let fundedDays = 0;
  let grossWithdrawn = 0;
  let netWithdrawn = 0;
  let winDays = 0;
  let firstPayoutUnlocked = firm.firstPayoutWinDays === null;

  for (let i = 0; i < path_.length; i++) {
    const pnl = sizing.pnl(path_[i]!);
    const trough = equity + Math.min(0, pnl) - stressF * sigmaDollar;

    if (firm.dailyLoss !== null && equity - trough >= firm.dailyLoss) {
      return { passed: phase === 'funded', evalDays, feesPaid: fees, netPayout: netWithdrawn, blownFunded: phase === 'funded', fundedDays };
    }
    // Trailing MLL is checked intraday at both firms (level updates EOD in
    // eval; MFFU funded trails intraday, approximated by the same check).
    if (trough <= mll || equity + pnl <= mll) {
      return { passed: phase === 'funded', evalDays, feesPaid: fees, netPayout: netWithdrawn, blownFunded: phase === 'funded', fundedDays };
    }
    equity += pnl;
    if (equity > peak) {
      peak = equity;
      mll = Math.min(start, peak - firm.trail); // trails, locks at start
    }

    if (phase === 'eval') {
      evalDays++;
      if (evalDays % 21 === 1) fees += firm.evalFeeMonthly; // monthly sub
      if (pnl > bestDay) bestDay = pnl;
      const profit = equity - start;
      const consistencyOk = firm.evalConsistencyFrac === null || bestDay <= firm.evalConsistencyFrac * profit;
      if (profit >= firm.target && consistencyOk) {
        phase = 'funded';
        fees += firm.activationFee;
        // funded account starts fresh
        equity = start;
        peak = start;
        mll = start - firm.trail;
      } else if (evalDays >= EVAL_CAP_DAYS) {
        return { passed: false, evalDays, feesPaid: fees, netPayout: 0, blownFunded: false, fundedDays: 0 };
      }
    } else {
      fundedDays++;
      if (pnl >= (firm.firstPayoutWinDays?.minWin ?? 0) && pnl > 0) winDays++;
      if (!firstPayoutUnlocked && firm.firstPayoutWinDays && winDays >= firm.firstPayoutWinDays.days) {
        firstPayoutUnlocked = true;
      }
      const monthEnd = fundedDays % 21 === 0 || fundedDays >= FUNDED_CAP_DAYS;
      if (monthEnd && firstPayoutUnlocked) {
        const sweep = Math.max(0, equity - (start + firm.payoutCushion));
        if (sweep > 0) {
          const kept = firm.split(grossWithdrawn, sweep) * firm.payoutHaircut;
          grossWithdrawn += sweep;
          netWithdrawn += kept;
          equity -= sweep;
          peak = Math.max(equity, start);
        }
      }
      if (fundedDays >= FUNDED_CAP_DAYS) break;
    }
  }
  return { passed: phase === 'funded', evalDays, feesPaid: fees, netPayout: netWithdrawn, blownFunded: false, fundedDays };
}

// -------------------------------------------------------------------- main
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const iters = args.includes('--iters') ? parseInt(args[args.indexOf('--iters') + 1]!, 10) : 1000;

  interface Variant { label: string; stressF: number; fricMult: number; since: string }
  const VARIANTS: Variant[] = [
    { label: 'base            (f=0.5, fric x1.0, 2015+)', stressF: 0.5, fricMult: 1.0, since: '2015-01-01' },
    { label: 'stress-hard     (f=1.0)', stressF: 1.0, fricMult: 1.0, since: '2015-01-01' },
    { label: 'friction-pessim (fric x1.5)', stressF: 0.5, fricMult: 1.5, since: '2015-01-01' },
    { label: 'recent-regime   (2020+)', stressF: 0.5, fricMult: 1.0, since: '2020-01-01' },
    { label: 'worst-case      (f=1.0, x1.5, 2020+)', stressF: 1.0, fricMult: 1.5, since: '2020-01-01' },
  ];

  const load = (names: string[]): Candle[] => {
    let out: Candle[] = [];
    for (const n of names) out = out.concat(JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', n), 'utf-8')) as Candle[]);
    return out.sort((a, b) => a.timestamp - b.timestamp);
  };
  console.log('Loading gold/silver 1m (2015-2026)...');
  const gold = load(['XAUUSD_1m_holdout.json', 'XAUUSD_1m.json']);
  const silver = load(['XAGUSD_1m_holdout.json', 'XAGUSD_1m.json']);
  const goldPx = gold[gold.length - 1]!.close;
  const silverPx = silver[silver.length - 1]!.close;
  const contractNotional = { MGC: 10 * goldPx, SIL: 1000 * silverPx };
  console.log(`Last prices: gold $${goldPx.toFixed(0)} (MGC=$${Math.round(contractNotional.MGC).toLocaleString()}), silver $${silverPx.toFixed(2)} (SIL=$${Math.round(contractNotional.SIL).toLocaleString()})`);
  console.log(`Base frictions/side: MGC ${(FRICTION.MGC_RTH * 1e4).toFixed(2)}/${(FRICTION.MGC_ETH * 1e4).toFixed(2)}bp RTH/ETH, SIL ${(FRICTION.SIL_RTH * 1e4).toFixed(2)}/${(FRICTION.SIL_ETH * 1e4).toFixed(2)}bp`);
  console.log(`MC: ${iters} iters/config, stationary block bootstrap (mean block 10d), eval cap ${EVAL_CAP_DAYS}d + funded ${FUNDED_CAP_DAYS}d\n`);

  interface Row extends Record<string, unknown> {
    variant: string; firm: string; sizing: string; passPct: number; medEvalDays: number;
    fundedBlowPct: number; meanFees: number; meanNet: number; evPerAttempt: number;
    ev5: number; ev95: number; gateEvOk: boolean; gatePassOk: boolean;
  }
  const rows: Row[] = [];

  for (const variant of VARIANTS) {
    console.log(`########## VARIANT: ${variant.label}`);
    for (const firm of FIRMS) {
      const legs = buildBook(gold, silver, firm.weekendHold, variant.fricMult);
      const { dates, vectors } = toDayVectors(legs, variant.since);
      console.log(`=== ${firm.label} (${firm.weekendHold ? 'weekend holds ON' : 'weekend holds OFF'}) — ${dates.length} union days ${dates[0]} → ${dates.at(-1)}`);

      const sizings: Sizing[] = [];
      for (const notional of [25_000, 50_000, 75_000, 100_000]) {
        sizings.push({
          label: `frac $${notional / 1000}k`,
          pnl: (vec) => notional * vec.reduce((s, r, j) => s + legs[j]!.weight * r, 0),
          grossNotional: notional,
          detail: 'fractional (upper bound — ignores contract granularity)',
        });
      }
      for (const notional of [50_000, 100_000]) {
        const contracts = legs.map((l) => Math.round((notional * l.weight) / contractNotional[l.instrument]));
        const detail = legs.map((l, j) => `${l.name.split(':')[0]}=${contracts[j]}`).join(' ');
        sizings.push({
          label: `int  $${notional / 1000}k`,
          pnl: (vec) => vec.reduce((s, r, j) => s + contracts[j]! * contractNotional[legs[j]!.instrument] * r, 0),
          grossNotional: notional,
          detail: `integer contracts: ${detail}`,
        });
      }

      console.log('sizing     | pass% | medEvalD | fundBlow% | fees   | E[net] | EV/attempt | EV p5..p95');
      for (const sizing of sizings) {
        const dollarDaily = vectors.map((v) => sizing.pnl(v));
        const sigmaDollar = Math.sqrt(mean(dollarDaily.map((x) => x * x)));

        const rand = lcg(20260803);
        const T = vectors.length;
        const results: AttemptResult[] = [];
        const L = EVAL_CAP_DAYS + FUNDED_CAP_DAYS;
        for (let it = 0; it < iters; it++) {
          const pathVecs: number[][] = [];
          while (pathVecs.length < L) {
            const startIdx = Math.floor(rand() * T);
            const blockLen = Math.max(1, Math.floor(-10 * Math.log(1 - rand())));
            for (let j = 0; j < blockLen && pathVecs.length < L; j++) {
              pathVecs.push(vectors[(startIdx + j) % T]!);
            }
          }
          results.push(runAttempt(pathVecs, firm, sizing, sigmaDollar, variant.stressF));
        }

        const passed = results.filter((r) => r.passed);
        const passRate = passed.length / results.length;
        const evs = results.map((r) => r.netPayout - r.feesPaid);
        const ev = mean(evs);
        const meanFees = mean(results.map((r) => r.feesPaid));
        const meanNet = mean(results.map((r) => r.netPayout));
        const fundedBlow = passed.length ? passed.filter((r) => r.blownFunded).length / passed.length : 0;
        const gateEvOk = ev > 3 * meanFees;
        const gatePassOk = passRate > 0.5;
        console.log(
          `${sizing.label.padEnd(10)} | ${(passRate * 100).toFixed(0).padStart(4)}% | ${String(median(passed.map((r) => r.evalDays))).padStart(8)} | ${(fundedBlow * 100).toFixed(0).padStart(8)}% | $${Math.round(meanFees).toString().padStart(5)} | $${Math.round(meanNet).toLocaleString().padStart(6)} | $${Math.round(ev).toLocaleString().padStart(9)} | $${Math.round(pct(evs, 0.05)).toLocaleString()}..$${Math.round(pct(evs, 0.95)).toLocaleString()}${gateEvOk && gatePassOk ? '  << GATE PASS' : ''}`,
        );
        if (sizing.detail.startsWith('integer')) console.log(`           |   ${sizing.detail}`);
        rows.push({
          variant: variant.label.trim(), firm: firm.key, sizing: sizing.label.trim(), passPct: passRate * 100,
          medEvalDays: median(passed.map((r) => r.evalDays)), fundedBlowPct: fundedBlow * 100,
          meanFees, meanNet, evPerAttempt: ev, ev5: pct(evs, 0.05), ev95: pct(evs, 0.95),
          gateEvOk, gatePassOk,
        });
      }
      console.log('');
    }
  }

  console.log('DECISION GATE (E[net] > 3x fees AND P(pass) > 50%) — pass must hold across ALL variants:');
  const configs = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.firm} @ ${r.sizing}`;
    if (!configs.has(k)) configs.set(k, []);
    configs.get(k)!.push(r);
  }
  let anyRobust = false;
  for (const [k, rs] of configs) {
    const allPass = rs.every((r) => r.gateEvOk && r.gatePassOk);
    const passCount = rs.filter((r) => r.gateEvOk && r.gatePassOk).length;
    if (passCount > 0) {
      console.log(`  ${allPass ? 'ROBUST PASS' : `partial ${passCount}/${rs.length}`}: ${k} — EV range $${Math.round(Math.min(...rs.map((r) => r.evPerAttempt)))}..$${Math.round(Math.max(...rs.map((r) => r.evPerAttempt)))}`);
      if (allPass) anyRobust = true;
    }
  }
  if (!anyRobust) console.log('  NO configuration passes the gate across all variants — prop path stays SHELVED.');

  fs.writeFileSync(
    path.resolve(__dirname, '..', 'experiments', 'runs', 'prop-rule-mc.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), iters, variants: VARIANTS, friction: FRICTION, contractNotional, firms: FIRMS.map((f) => ({ ...f, split: undefined })), rows }, null, 2),
  );
  console.log('\nSaved → experiments/runs/prop-rule-mc.json');
}

main().catch((err) => {
  console.error('prop-rule-mc failed:', err);
  process.exit(1);
});
