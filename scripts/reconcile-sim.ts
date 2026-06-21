#!/usr/bin/env npx tsx
/**
 * Reconcile Sim — diff simulated fills against live bot_trades
 *
 * For each completed trade in bot_trades, replays the position through
 * simulatePosition with a zero-friction model and diffs the result against
 * the stored netReturn and exitReason. Prints a ReconcileReport and exits
 * non-zero when the report fails tolerance checks.
 *
 * Usage:
 *   npx tsx scripts/reconcile-sim.ts
 *   npx tsx scripts/reconcile-sim.ts --symbol BTCUSDT
 *   npx tsx scripts/reconcile-sim.ts --friction 0.0007
 */

import fs from 'fs';
import path from 'path';
import { db } from '../src/lib/data/db';
import { loadLiveTrades, replayTrade, diffTrades, reconcileReport } from '../src/lib/sim/reconcile';
import type { TradeDiff } from '../src/lib/sim/reconcile';
import { DefaultFillModel } from '../src/lib/sim/fill-model';
import { FlatFrictionCostModel } from '../src/lib/sim/cost-model';
import type { SimConfig } from '../src/lib/sim/types';
import type { Candle } from '../src/types/candle';

// ─── CLI args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const symbolFilter = getArg('--symbol');
const frictionStr = getArg('--friction');
const frictionPerSide = frictionStr !== undefined ? parseFloat(frictionStr) : 0;

// Tolerances (starting values per brief)
const TOLERANCES = { netBps: 5, reasonRate: 0.95, barsRate: 0.90 };

// ─── Candle cache ────────────────────────────────────────────────────────────

const candleCache = new Map<string, Candle[]>();

function loadCandles(symbol: string): Candle[] | null {
  const cached = candleCache.get(symbol);
  if (cached) return cached;

  const dataPath = path.join(process.cwd(), 'data', `${symbol}_1h.json`);
  if (!fs.existsSync(dataPath)) {
    console.warn(`[warn] Candle file not found: ${dataPath}`);
    return null;
  }
  const candles = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as Candle[];
  candleCache.set(symbol, candles);
  return candles;
}

// ─── Default sim config (mirrors production Run 20 exit settings) ────────────

const SIM_CONFIG: SimConfig = {
  entryTiming: 'signal_close',
  maxBars: 160,
  barMs: 3_600_000,
  exitMode: 'simple',
};

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Reconcile Sim ===');
  console.log(`Symbol filter : ${symbolFilter ?? '(all)'}`);
  console.log(`Friction/side : ${frictionPerSide}`);
  console.log(`Tolerances    : netBps=${TOLERANCES.netBps} reasonRate=${TOLERANCES.reasonRate} barsRate=${TOLERANCES.barsRate}`);
  console.log('');

  const liveRows = await loadLiveTrades(db, symbolFilter);

  if (liveRows.length === 0) {
    console.log('No bot_trades found — nothing to reconcile.');
    console.log('(Run the bot first to populate bot_trades, or check --symbol filter.)');
    process.exit(0);
  }

  console.log(`Loaded ${liveRows.length} live trades`);

  const fillModel = new DefaultFillModel(new FlatFrictionCostModel(frictionPerSide));

  const diffs: TradeDiff[] = [];
  let skipped = 0;

  for (const row of liveRows) {
    const candles = loadCandles(row.symbol);
    if (!candles) {
      skipped++;
      continue;
    }

    const simResult = replayTrade(row, candles, fillModel, SIM_CONFIG);
    if (!simResult) {
      console.warn(`[warn] Could not replay trade ${row.id} (${row.symbol} @${row.entryTimestamp}) — candle not found`);
      skipped++;
      continue;
    }

    // barsHeld: compute from sim entry/exit timestamps (each bar = 1h)
    const simBarsHeld = Math.round((simResult.exitTimestamp - simResult.entryTimestamp) / SIM_CONFIG.barMs);

    const live = {
      netReturn: row.netReturn,
      exitReason: row.exitReason,
      barsHeld: row.barsHeld,
    };

    diffs.push(diffTrades(simResult, live, row.id, row.symbol, simBarsHeld));
  }

  if (diffs.length === 0) {
    console.log(`\nAll ${skipped} trades skipped (missing candle data). Cannot reconcile.`);
    process.exit(1);
  }

  const report = reconcileReport(diffs, TOLERANCES);

  console.log('\n─── Reconcile Report ───────────────────────────────────────');
  console.log(`Trades compared   : ${report.count}  (skipped: ${skipped})`);
  console.log(`Mean |netDelta|   : ${(report.meanAbsNetDelta * 1e4).toFixed(2)} bps  (tol: ${TOLERANCES.netBps} bps)`);
  console.log(`Reason match rate : ${(report.reasonMatchRate * 100).toFixed(1)}%  (tol: ≥${(TOLERANCES.reasonRate * 100).toFixed(0)}%)`);
  console.log(`BarsHeld match    : ${(report.barsHeldMatchRate * 100).toFixed(1)}%  (tol: ≥${(TOLERANCES.barsRate * 100).toFixed(0)}%)`);
  console.log(`Result            : ${report.pass ? '✓ PASS' : '✗ FAIL'}`);

  // Print worst outliers (top 5 by |netDelta|)
  const sorted = [...report.diffs].sort((a, b) => Math.abs(b.netDelta) - Math.abs(a.netDelta));
  const outliers = sorted.slice(0, 5).filter((d) => !d.reasonMatch || Math.abs(d.netDelta) > TOLERANCES.netBps / 1e4);
  if (outliers.length > 0) {
    console.log('\nTop outliers:');
    for (const d of outliers) {
      const delta = (d.netDelta * 1e4).toFixed(2);
      const reason = d.reasonMatch ? 'reason=ok' : `reason: sim=${getExitReason(d, sorted)} live=${d.id}`;
      console.log(`  ${d.id} (${d.symbol})  netDelta=${delta}bps  ${reason}  bars=${d.barsHeldMatch ? 'ok' : 'MISMATCH'}`);
    }
  }

  console.log('────────────────────────────────────────────────────────────\n');

  process.exit(report.pass ? 0 : 1);
}

// Helper: we only store diff, not individual sim exit reasons — print delta as proxy
function getExitReason(_d: TradeDiff, _allDiffs: TradeDiff[]): string {
  return '(see sim)';
}

main().catch((err: unknown) => {
  console.error('[fatal]', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
