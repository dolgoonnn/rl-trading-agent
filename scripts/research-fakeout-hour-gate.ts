/**
 * Does the M5 gold family have a SESSION edge, or is 16:00-20:00 UTC just the
 * best of 48 slices?
 *
 * The vol-conditional test killed the volatility story: 100% of the fit-window
 * profit sat in the top vol quintile, and that exact quintile is NEGATIVE out of
 * sample. But the hour slice showed something odd — two DIFFERENT trigger
 * families (counter-trend `run-exhaust` and continuation `break-cont`)
 * independently put their positive hours in the same 16:00-20:00 UTC block, in
 * the holdout.
 *
 * Agreement across unrelated triggers is the one pattern that noise does not
 * usually produce, so it deserves a real test rather than a shrug. But the
 * multiple-testing burden here is severe: 2,592 configs already searched, then
 * 24 hours x 2 configs on top. This script therefore does NOT ask "is this hour
 * good" — that question is already contaminated. It asks the three questions
 * that can still be answered honestly:
 *
 *   1. Does the gate hold in BOTH windows? A real session effect appears where
 *      the parameters were fit AND where they were not. A selection artifact
 *      appears in one.
 *   2. Does it survive costs? The gate cuts trade count hard, which helps.
 *   3. Does it hold for triggers that were NOT used to find the window?
 *
 * The hour gate is applied at ENTRY. Gating on exit time would be untradeable —
 * you cannot know at entry which bar your bracket fills on.
 */
import { loadM5, atr, run, type Params, type Trigger } from './research-fakeout-fade';

const FIT = [Date.parse('2025-03-01'), Date.parse('2026-06-09')] as const;
const HOLDOUT = [Date.parse('2020-01-01'), Date.parse('2024-12-31')] as const;
const COST = 0.175;

/** The window both families flagged, and its complement as a control. */
const WINDOW = [16, 17, 18, 19, 20];
const CONTROL = Array.from({ length: 24 }, (_, h) => h).filter((h) => !WINDOW.includes(h));

const base = (trigger: Trigger, over: Partial<Params> = {}): Params => ({
  trigger, n: 5, compression: 2.5, tp: 3.5, slMult: 1.5,
  maxReflips: 1, maxConcurrent: 6, mode: 'atr', costPerSide: COST, ...over,
});

const CONFIGS: Array<{ name: string; p: Params }> = [
  { name: 'break-cont (found the window)', p: base('break-cont') },
  { name: 'run-exhaust (found the window)', p: base('run-exhaust', { compression: 0, tp: 2 }) },
  // Families that did NOT participate in choosing the window — the honest check.
  { name: 'fade-break (independent)', p: base('fade-break') },
  { name: 'inside-break (independent)', p: base('inside-break', { n: 1, compression: 0 }) },
];

function line(label: string, r: ReturnType<typeof run>): string {
  return `${label.padEnd(22)} n=${String(r.trades).padStart(6)}  $/day ${r.perDay.toFixed(2).padStart(7)}  ` +
    `$/trade ${r.meanPerTrade.toFixed(3).padStart(7)}  net ${('$' + r.net.toFixed(0)).padStart(9)}  t=${r.t.toFixed(2).padStart(6)}`;
}

function main(): void {
  console.log('loading …');
  const bars = loadM5();
  const a = atr(bars, 14);

  for (const { name, p } of CONFIGS) {
    console.log(`\n════════ ${name} ════════`);
    for (const [wname, wins] of [['GATED 16-20 UTC', WINDOW], ['CONTROL (all other hours)', CONTROL], ['UNGATED', undefined]] as const) {
      const cfg: Params = { ...p, hours: wins as number[] | undefined };
      const rf = run(bars, a, cfg, FIT[0], FIT[1]);
      const rh = run(bars, a, cfg, HOLDOUT[0], HOLDOUT[1]);
      console.log(`  ${wname}`);
      console.log(`    ${line('fit 2025-26', rf)}`);
      console.log(`    ${line('holdout 2020-24', rh)}`);
    }
  }

  console.log('\n════════ VERDICT TABLE — gated, net of cost, both windows ════════');
  console.log('trigger                    fit $/day (t)      holdout $/day (t)     both positive?');
  for (const { name, p } of CONFIGS) {
    const cfg: Params = { ...p, hours: WINDOW };
    const rf = run(bars, a, cfg, FIT[0], FIT[1]);
    const rh = run(bars, a, cfg, HOLDOUT[0], HOLDOUT[1]);
    const both = rf.net > 0 && rh.net > 0;
    console.log(
      `${name.padEnd(28)} ${rf.perDay.toFixed(2).padStart(7)} (${rf.t.toFixed(2).padStart(5)})  ` +
      `${rh.perDay.toFixed(2).padStart(12)} (${rh.t.toFixed(2).padStart(5)})   ${both ? 'YES' : 'no'}`);
  }

  // Year-by-year on the holdout: a real session effect should not live in one year.
  console.log('\n════════ GATED break-cont, HOLDOUT year by year ════════');
  const cfg: Params = { ...base('break-cont'), hours: WINDOW };
  for (const y of [2020, 2021, 2022, 2023, 2024]) {
    const r = run(bars, a, cfg, Date.parse(`${y}-01-01`), Date.parse(`${y}-12-31`));
    console.log(`  ${y}  ${line('', r)}`);
  }
}

main();
