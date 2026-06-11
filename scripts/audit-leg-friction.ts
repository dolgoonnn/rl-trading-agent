#!/usr/bin/env tsx
/**
 * Execution-feasibility friction ladder for every session-book leg.
 *
 * Leg daily returns embed friction as −2×f0 per active day (one round trip).
 * We recover the gross by adding 2×f0 back, then re-price each leg at
 * realistic venue tiers and report Sharpe/total at each tier plus the
 * BREAKEVEN friction (avg gross per active day ÷ 2) — the number to compare
 * against actual venue costs from the execution audit.
 *
 * Tiers per instrument (bps/side): validated (= backtest assumption),
 * retail-good (raw-spread/micro-futures done well), retail-typical.
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildLegs } from './analyze-combo-portfolio';

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function annSharpe(xs: number[]): number { const s = std(xs); return s > 0 ? (mean(xs) / s) * Math.sqrt(252) : 0; }

/**
 * Per-side friction tiers per leg (decimal). `venueRealistic` comes from the
 * 2026-06-11 execution-cost research (experiments/execution-audit.md):
 *   MGC gold: 0.45bp RTH / 0.55bp overnight / 0.8bp reopen-pessimistic
 *   SIL silver: 1.0bp fix window / 2.0bp overnight / 2.5bp pessimistic
 *   MES: 0.5bp / EURUSD raw-spread: 0.35bp London, 0.9bp 22h rollover window
 */
const LEG_FRICTION: Record<string, { f0: number; tiers: Record<string, number> }> = {
  'A:Au-overnight':     { f0: 0.00003,  tiers: { validated: 0.00003, venueRealistic: 0.000055, pessimistic: 0.00008 } },
  'B:Ag-overnight':     { f0: 0.0001,   tiers: { validated: 0.0001,  venueRealistic: 0.0002, pessimistic: 0.00025 } },
  'C:Au-fix-short':     { f0: 0.00003,  tiers: { validated: 0.00003, venueRealistic: 0.000045, pessimistic: 0.00008 } },
  'D:Au-AMfix-long':    { f0: 0.00003,  tiers: { validated: 0.00003, venueRealistic: 0.000045, pessimistic: 0.00008 } },
  'I:Ag-ownfix-short':  { f0: 0.0001,   tiers: { validated: 0.0001,  venueRealistic: 0.0001, pessimistic: 0.00015 } },
  'F:Au-NFP-mom':       { f0: 0.00003,  tiers: { validated: 0.00003, venueRealistic: 0.000045, pessimistic: 0.00008 } },
  'J:US500-overnight':  { f0: 0.00005,  tiers: { validated: 0.00005, venueRealistic: 0.00005, pessimistic: 0.00008 } },
  'K:EUR-morning-short': { f0: 0.000015, tiers: { validated: 0.000015, venueRealistic: 0.000035, pessimistic: 0.00005 } },
  'L:EUR-h22-long':     { f0: 0.000015, tiers: { validated: 0.000015, venueRealistic: 0.00009, pessimistic: 0.00015 } },
};

async function main(): Promise<void> {
  const legs = await buildLegs();
  console.log('Leg friction ladder (per-side bps in parens; Sharpe / total%):\n');
  console.log('leg                  | n    | breakeven bps/side | validated | venue-realistic | pessimistic | verdict@venue-realistic');

  const rows: Record<string, unknown>[] = [];
  for (const [name, series] of legs) {
    const spec = LEG_FRICTION[name];
    if (!spec) { console.log(`${name}: no friction spec — skipped`); continue; }
    const net = [...series.values()];
    const gross = net.map((r) => r + 2 * spec.f0);
    const breakevenBps = (mean(gross) / 2) * 10000;

    const at = (f: number): { sharpe: number; totalPct: number } => {
      const xs = gross.map((g) => g - 2 * f);
      return { sharpe: Math.round(annSharpe(xs) * 100) / 100, totalPct: Math.round(xs.reduce((s, x) => s + x, 0) * 1000) / 10 };
    };
    const v = at(spec.tiers.validated!);
    const g = at(spec.tiers.venueRealistic!);
    const t = at(spec.tiers.pessimistic!);
    const verdict = g.sharpe > 0.3 ? 'PASS' : g.sharpe > 0 ? 'MARGINAL' : 'FAIL';
    console.log(
      `${name.padEnd(20)} | ${String(net.length).padStart(4)} | ${breakevenBps.toFixed(2).padStart(18)} | ` +
      `${v.sharpe}/${v.totalPct}% (${(spec.tiers.validated! * 10000).toFixed(2)}) | ` +
      `${g.sharpe}/${g.totalPct}% (${(spec.tiers.venueRealistic! * 10000).toFixed(2)}) | ` +
      `${t.sharpe}/${t.totalPct}% (${(spec.tiers.pessimistic! * 10000).toFixed(2)}) | ${verdict}`,
    );
    rows.push({ leg: name, activeDays: net.length, breakevenBpsPerSide: Math.round(breakevenBps * 100) / 100, validated: v, venueRealistic: g, pessimistic: t, verdictAtVenueRealistic: verdict });
  }

  const outPath = path.resolve(__dirname, '..', 'experiments', 'runs', 'leg-friction-ladder.json');
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));
  console.log(`\nSaved → ${outPath}`);

  // Emit the DEPLOYABLE retail book: only legs that survive retail-good costs,
  // priced AT retail-good costs — appended to strategy-daily-returns.json as
  // 'sessionBookRetail' so combine-strategies.ts can run a realistic universe.
  const { legWeight } = await import('./analyze-combo-portfolio');
  const surviving = rows.filter((r) => r.verdictAtVenueRealistic === 'PASS').map((r) => r.leg as string);
  const retail = new Map<string, number>();
  for (const name of surviving) {
    const spec = LEG_FRICTION[name]!;
    const w = legWeight(name);
    for (const [date, r] of legs.get(name)!) {
      const repriced = r + 2 * spec.f0 - 2 * spec.tiers.venueRealistic!;
      retail.set(date, (retail.get(date) ?? 0) + w * repriced);
    }
  }
  const retailXs = [...retail.values()];
  console.log(`\nsessionBookRetail (${surviving.join(', ')} @ venue-realistic): ` +
    `sharpe=${annSharpe(retailXs).toFixed(2)} total=${(retailXs.reduce((s, x) => s + x, 0) * 100).toFixed(1)}%`);

  const returnsPath = path.resolve(__dirname, '..', 'experiments', 'runs', 'strategy-daily-returns.json');
  const returnsData = JSON.parse(fs.readFileSync(returnsPath, 'utf-8')) as { series: Record<string, Record<string, number>> };
  returnsData.series.sessionBookRetail = Object.fromEntries([...retail.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  fs.writeFileSync(returnsPath, JSON.stringify(returnsData, null, 2));
  console.log(`Appended 'sessionBookRetail' → ${returnsPath}`);
}

main().catch((err) => { console.error('Friction audit failed:', err); process.exit(1); });
