#!/usr/bin/env tsx
/**
 * Prop-firm barrier simulation — is a funded account a good barrier option on
 * the session book? (practitioner-mechanisms.md "free bonus test")
 *
 * A funded account = cheap leveraged capital IF the strategy survives a
 * trailing-drawdown barrier. We push the DEPLOYABLE session book
 * (sessionBookRetail daily log returns, venue-realistic costs) through
 * Topstep-50K-style rules from EVERY historical start date (2016+ after
 * warmup), sweeping book notional per account:
 *
 *   Evaluation: start $50k, pass at +$3k. Trailing Max Loss Limit $2k below
 *   the EOD equity peak, stops trailing once it reaches the starting balance.
 *   Daily loss limit $1k (breach = fail). Fee per attempt $165.
 *   Funded: same MLL mechanics; month-end payout sweeps equity above
 *   start + $2k cushion. Survive to end of data or blow.
 *
 * Intraday caveat: we have EOD granularity; Apex-style INTRADAY trailing is
 * stricter. --intraday-stress f (default 0.5) models each day's intraday
 * trough as dayPnL − f·σ_daily·notional for barrier checks. f=0 = pure EOD.
 *
 * Metrics per notional: eval pass %, median eval days, funded median months
 * survived, mean withdrawn per funded account, EV per attempt vs fee.
 */

import * as fs from 'fs';
import * as path from 'path';

const ACCOUNT = 50_000;
const TARGET = 3_000;
const TRAIL = 2_000;
const DAILY_LOSS = 1_000;
const FEE = 165;
const CUSHION = 2_000;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }

interface RunResult {
  passed: boolean;
  evalDays: number;
  fundedMonths: number;
  withdrawn: number;
  blown: boolean;
}

/**
 * One full lifecycle from start index: evaluation then funded.
 * rets = daily simple-return fractions of book notional. stressSigma = f·σ_daily.
 */
function simulate(rets: number[], dates: string[], start: number, notional: number, stressSigma: number): RunResult {
  let equity = ACCOUNT;
  let peak = ACCOUNT;
  let mll = ACCOUNT - TRAIL;
  let phase: 'eval' | 'funded' = 'eval';
  let evalDays = 0;
  let withdrawn = 0;
  let fundedStartIdx = -1;

  for (let i = start; i < rets.length; i++) {
    const pnl = notional * rets[i]!;
    const trough = equity + Math.min(0, pnl) - stressSigma * notional;
    // daily loss limit + trailing barrier (checked at modeled intraday trough)
    if (equity - trough >= DAILY_LOSS || trough <= mll) {
      return { passed: phase === 'funded', evalDays, fundedMonths: phase === 'funded' ? monthsBetween(dates[fundedStartIdx]!, dates[i]!) : 0, withdrawn, blown: true };
    }
    equity += pnl;
    if (equity <= mll) {
      return { passed: phase === 'funded', evalDays, fundedMonths: phase === 'funded' ? monthsBetween(dates[fundedStartIdx]!, dates[i]!) : 0, withdrawn, blown: true };
    }
    if (equity > peak) {
      peak = equity;
      mll = Math.min(ACCOUNT, peak - TRAIL); // trails, locks at starting balance
    }

    if (phase === 'eval') {
      evalDays++;
      if (equity >= ACCOUNT + TARGET) {
        phase = 'funded';
        fundedStartIdx = i;
      }
    } else {
      // month-end payout sweep
      const next = dates[i + 1];
      if (!next || next.slice(0, 7) !== dates[i]!.slice(0, 7)) {
        const sweep = Math.max(0, equity - (ACCOUNT + CUSHION));
        withdrawn += sweep;
        equity -= sweep;
        // peak/mll do not reset upward after withdrawal (locked at ACCOUNT already if earned)
        peak = Math.max(equity, ACCOUNT);
      }
    }
  }
  return { passed: phase === 'funded', evalDays, fundedMonths: phase === 'funded' ? monthsBetween(dates[fundedStartIdx]!, dates[dates.length - 1]!) : 0, withdrawn, blown: false };
}

function monthsBetween(a: string, b: string): number {
  return (parseInt(b.slice(0, 4)) - parseInt(a.slice(0, 4))) * 12 + (parseInt(b.slice(5, 7)) - parseInt(a.slice(5, 7)));
}

function main(): void {
  const args = process.argv.slice(2);
  const stressF = args.includes('--intraday-stress') ? parseFloat(args[args.indexOf('--intraday-stress') + 1]!) : 0.5;

  const file = path.resolve(__dirname, '..', 'experiments', 'runs', 'strategy-daily-returns.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as { series: Record<string, Record<string, number>> };
  const book = data.series.sessionBookRetail;
  if (!book) throw new Error('sessionBookRetail missing — run audit-leg-friction.ts');
  const dates = Object.keys(book).sort();
  const rets = dates.map((d) => Math.exp(book[d]!) - 1); // simple returns of notional
  const sigma = Math.sqrt(mean(rets.map((r) => r * r)));
  console.log(`Session book: ${dates.length} active days ${dates[0]} → ${dates.at(-1)}, daily σ=${(sigma * 100).toFixed(3)}% of notional`);
  console.log(`Rules: $${ACCOUNT / 1000}k account, target +$${TARGET}, trailing $${TRAIL} (EOD, locks at start), DLL $${DAILY_LOSS}, fee $${FEE}, cushion $${CUSHION}`);
  console.log(`Intraday stress f=${stressF} (trough = dayPnL − f·σ·notional)\n`);

  console.log('notional | evalPass% | medEvalDays | blowEver% | medFundedMo | meanWithdrawn | EV/attempt');
  const sweep = [25_000, 50_000, 75_000, 100_000, 150_000];
  const out: Record<string, unknown>[] = [];
  for (const notional of sweep) {
    const stressSigma = stressF * sigma;
    const results: RunResult[] = [];
    for (let s = 0; s + 60 < rets.length; s += 5) { // every 5th day as a start
      results.push(simulate(rets, dates, s, notional, stressSigma));
    }
    const passed = results.filter((r) => r.passed);
    const passRate = passed.length / results.length;
    const blowRate = results.filter((r) => r.blown).length / results.length;
    const meanW = mean(passed.map((r) => r.withdrawn));
    const ev = passRate * meanW - FEE;
    console.log(
      `$${(notional / 1000).toString().padStart(3)}k    | ${(passRate * 100).toFixed(0).padStart(8)} | ${String(median(passed.map((r) => r.evalDays))).padStart(11)} | ${(blowRate * 100).toFixed(0).padStart(8)} | ${String(median(passed.map((r) => r.fundedMonths))).padStart(11)} | $${Math.round(meanW).toLocaleString().padStart(12)} | $${Math.round(ev).toLocaleString()}`,
    );
    out.push({ notional, passRatePct: passRate * 100, blowEverPct: blowRate * 100, medianEvalDays: median(passed.map((r) => r.evalDays)), medianFundedMonths: median(passed.map((r) => r.fundedMonths)), meanWithdrawn: meanW, evPerAttempt: ev });
  }

  console.log('\nNOTES: withdrawn means are over the remaining history from each start (long horizons');
  console.log('for early starts) — compare across notionals, not as absolute yield. EOD-trailing rules;');
  console.log('Apex intraday trailing is stricter than f=0.5 in fast markets.');

  fs.writeFileSync(
    path.resolve(__dirname, '..', 'experiments', 'runs', 'prop-barrier-results.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), stressF, rules: { ACCOUNT, TARGET, TRAIL, DAILY_LOSS, FEE, CUSHION }, sweep: out }, null, 2),
  );
  console.log('Saved → experiments/runs/prop-barrier-results.json');
}

main();
