#!/usr/bin/env tsx
/**
 * Validate the Deriv scalp through the PROJECT SIM ENGINE (src/lib/sim).
 *
 * My run-deriv-scalp backtest uses a crude intrabar rule (stop-before-target, exact fills).
 * This re-runs the SAME entry signals (src/lib/deriv/scalp-strategy.entrySignal) but resolves
 * every exit through `simulatePosition`, which gives:
 *   - conservative intrabar fidelity (pessimistic = stop fills first when a bar straddles both),
 *   - the maker/taker cost split (a resting TP limit = maker; SL/timeout cross = taker).
 *
 * The take-profit is the anchor EMA at signal time, modelled as a RESTING LIMIT at the mean
 * (which is how a scalper would really place it) — so the sim's maker-TP treatment is faithful.
 *
 * If the sim agrees with the crude backtest, the edge estimate is robust (not a fill artifact).
 *
 *   npx tsx scripts/validate-deriv-scalp-sim.ts --symbols stpRNG,frxXAUUSD,R_75 --ext 1.5 --sl-atr 3 --max-hold 15
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types/candle';
import { simulatePosition, DefaultFillModel, FlatFrictionCostModel, type SimPosition, type SimConfig, type SimTradeResult, type SimExitReason } from '@/lib/sim';
import type { MakerTakerConfig } from '@/lib/cost/trade-cost';
import { DEFAULT_SCALP, INSTRUMENT_PROFILE, computeState, entrySignal, type ScalpConfig } from '@/lib/deriv/scalp-strategy';

function getArg(name: string): string | undefined {
  const a = process.argv.slice(2);
  const i = a.indexOf(`--${name}`);
  return i !== -1 && a[i + 1] ? a[i + 1] : undefined;
}
const fmt = (n: number, d = 2) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

interface Row { r: number; net: number; reason: SimExitReason; }

type CostScenario = 'deriv' | 'passive_tp';

function runSymbol(sym: string, cfg: ScalpConfig, tier: 'pessimistic' | 'heuristic', scenario: CostScenario): Row[] | null {
  const p = path.resolve(__dirname, '..', 'data', `${sym}_1m.json`);
  if (!fs.existsSync(p)) { console.log(`  ${sym}: no data`); return null; }
  const candles = JSON.parse(fs.readFileSync(p, 'utf-8')) as Candle[];
  const prof = INSTRUMENT_PROFILE[sym] ?? { bias: cfg.bias, spreadBp: 1 };
  const c: ScalpConfig = { ...cfg, bias: prof.bias };
  const s = computeState(candles, c);

  // 'deriv'      : the house sets the price — half-spread on BOTH legs (entry + every exit).
  // 'passive_tp' : real-order-book COUNTERFACTUAL — a resting TP limit is maker (pays nothing);
  //                only the entry and SL/timeout cross the book (taker, half-spread).
  const halfSpreadFrac = (prof.spreadBp / 1e4) / 2;
  const cost = scenario === 'deriv'
    ? new FlatFrictionCostModel(halfSpreadFrac)
    : new FlatFrictionCostModel(0, { makerBps: 0, takerBps: prof.spreadBp / 2 } satisfies MakerTakerConfig);
  const fillModel = new DefaultFillModel(cost, { allowHeuristic: tier === 'heuristic' });
  const simConfig: SimConfig = { entryTiming: 'next_open', maxBars: c.maxHoldBars, barMs: 60_000, exitMode: 'simple' };

  const rows: Row[] = [];
  const warm = c.slowPeriod + c.atrPeriod + 2;
  for (let i = warm; i < candles.length - 1; i++) {
    const dir = entrySignal(s, i, c);
    if (dir === 0) continue;
    const entryRef = candles[i + 1]!.open;
    const risk = c.slAtr * s.atr[i]!;
    if (risk <= 0) continue;
    const pos: SimPosition = {
      direction: dir === 1 ? 'long' : 'short',
      entryPrice: entryRef,
      entryTimestamp: candles[i + 1]!.timestamp,
      entryIndex: i + 1,
      stopLoss: dir === 1 ? entryRef - risk : entryRef + risk,
      takeProfit: s.anchor[i]!,                 // resting limit at the mean (maker on fill)
      strategy: 'deriv_scalp',
    };
    const res: SimTradeResult | null = simulatePosition(pos, candles, i + 1, { fillModel, config: simConfig });
    if (!res) continue;
    const riskFrac = risk / entryRef;
    rows.push({ r: res.netReturn / riskFrac, net: res.netReturn, reason: res.exitReason });
  }
  return rows;
}

function report(sym: string, tier: string, rows: Row[]): void {
  if (!rows.length) { console.log(`  ${sym} [${tier}]: no trades`); return; }
  const r = rows.map((x) => x.r);
  const wins = r.filter((x) => x > 0).length;
  const netSum = rows.reduce((a, x) => a + x.net, 0);
  const avgR = r.reduce((a, b) => a + b, 0) / r.length;
  let eq = 0, peak = 0, dd = 0;
  for (const x of r) { eq += x; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const cnt = (rn: SimExitReason) => rows.filter((x) => x.reason === rn).length;
  console.log(`  ${sym.padEnd(10)} [${tier}]: n=${String(rows.length).padStart(5)}  win=${fmt(wins / rows.length * 100, 1)}%  ` +
    `avgR=${fmt(avgR, 3)}  netR=${fmt(r.reduce((a, b) => a + b, 0), 1)}  sum%=${fmt(netSum * 100, 1)}  maxDD=${fmt(dd, 1)}R  ` +
    `| TP=${cnt('take_profit')} SL=${cnt('stop_loss')} time=${cnt('max_bars')}`);
}

function main(): void {
  const symbols = (getArg('symbols') ?? 'stpRNG,frxXAUUSD,R_75').split(',').map((x) => x.trim()).filter(Boolean);
  const cfg: ScalpConfig = {
    ...DEFAULT_SCALP,
    extAtr: parseFloat(getArg('ext') ?? '1.5'),
    slAtr: parseFloat(getArg('sl-atr') ?? '3'),
    maxHoldBars: parseInt(getArg('max-hold') ?? '15', 10),
  };
  console.log(`\nDeriv Scalp — SIM-ENGINE validation | ext=${cfg.extAtr}ATR sl=${cfg.slAtr}ATR maxHold=${cfg.maxHoldBars}`);
  console.log(`(crude backtest for reference: stpRNG avgR≈-0.028, frxXAUUSD≈-0.009, R_75≈-0.073)\n`);
  console.log(`### SCENARIO 1 — DERIV REALITY: spread on both legs (the house sets the price). Pessimistic fills.`);
  for (const sym of symbols) {
    const rows = runSymbol(sym, cfg, 'pessimistic', 'deriv');
    if (rows) report(sym, 'deriv', rows);
  }
  console.log(`\n### SCENARIO 2 — COUNTERFACTUAL: passive resting TP (maker, no spread) — NOT achievable on Deriv,`);
  console.log(`    only on a real order book (Bybit/ECN). Quantifies the execution edge of resting the exit.`);
  for (const sym of symbols) {
    const rows = runSymbol(sym, cfg, 'pessimistic', 'passive_tp');
    if (rows) report(sym, 'passive-tp', rows);
  }
  console.log('');
}

main();
