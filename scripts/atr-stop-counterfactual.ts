/**
 * Multi-arm ATR-stop counterfactual (Task 9 PROBE).
 *
 * Replays every closed bot_trade (Run-20 log) forward over the SAME candle
 * series under four EXIT rules — never recreating strategy/entry logic:
 *   ARM A baseline          — current SL/TP as stored.
 *   ARM B atr_floor         — SL = max(SL_orig, k·ATR14@entry), R:R preserved.
 *   ARM C chandelier        — trailing stop = highest-high − k·ATR (mirror short).
 *   ARM D vertical_barrier  — exit at min(SL, TP, N-bar horizon); horizons 40/80/120/160.
 *                             (Lopez de Prado, Advances in Financial ML, 2018, §3.)
 *
 * PER-ARM FUNDING DEBIT: each arm holds a different length, so each crosses a
 * different number of 00/08/16 UTC funding settlements. Funding is debited per
 * arm over THAT arm's actual hold (shared `funding-ledger` keystone). Every
 * headline metric is NET-of-funding R — comparing arms on gross R would falsely
 * favor the longest-hold arm.
 *
 * DIAGNOSTIC ONLY — a winning arm must survive WF/PBO before any live exit
 * change (project canon: WF pass-rate decides). Nothing here is auto-wired.
 *
 * Emits experiments/runs/atr-stop-arms.json.
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  atrAt,
  findEntryIndex,
  rateAtFromSnapshots,
  simulateAtrFloor,
  simulateBaseline,
  simulateChandelier,
  simulateVerticalBarrier,
  summarizeArm,
  type ArmOutcome,
  type ArmStats,
  type Candle,
  type RateAt,
  type Trade,
} from '../src/lib/research/atr-stop-arms';

const MAX_BARS = 160;
const ATR_FLOOR_K = 1.5; // sweep target 1.0–3.0; default per plan
const CHANDELIER_K = 3.0; // sweep target 2.5–4.0; default per plan
const VERTICAL_HORIZONS = [40, 80, 120, 160] as const;

function loadCandles(symbol: string): Candle[] {
  const file = path.resolve(`data/${symbol}_1h.json`);
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Candle[];
  return raw.sort((a, b) => a.timestamp - b.timestamp);
}

function loadRateAt(symbol: string): RateAt {
  const file = path.resolve(`data/${symbol}_futures_1h.json`);
  if (!fs.existsSync(file)) return () => 0;
  const snaps = JSON.parse(fs.readFileSync(file, 'utf-8')) as { timestamp: number; fundingRate: number }[];
  return rateAtFromSnapshots(snaps);
}

/**
 * Baseline outcome from the SAME replay engine (not from stored fields) so all
 * arms share identical bar-stepping/R semantics. Uses stored SL/TP and the same
 * MAX_BARS horizon as the alt arms.
 */
function baselineOutcome(candles: Candle[], entryIdx: number, t: Trade, rateAt: RateAt): ArmOutcome {
  return simulateBaseline({
    candles,
    entryIdx,
    direction: t.direction,
    entry: t.entry_price,
    sl: t.stop_loss,
    tp: t.take_profit,
    maxBars: MAX_BARS,
    rateAt,
  });
}

interface ArmAccumulator {
  baseline: ArmOutcome[];
  atrFloor: ArmOutcome[];
  chandelier: ArmOutcome[];
  vertical: Map<number, ArmOutcome[]>;
}

function newAccumulator(): ArmAccumulator {
  const vertical = new Map<number, ArmOutcome[]>();
  for (const h of VERTICAL_HORIZONS) vertical.set(h, []);
  return { baseline: [], atrFloor: [], chandelier: [], vertical };
}

function main(): void {
  const dbPath = path.resolve('data/ict-trading.db');
  const db = new Database(dbPath, { readonly: true });

  const trades = db
    .prepare(
      `SELECT id, symbol, direction, entry_price, exit_price, entry_timestamp, exit_timestamp,
              stop_loss, take_profit, bars_held, exit_reason, pnl_percent
       FROM bot_trades WHERE exit_price IS NOT NULL ORDER BY entry_timestamp ASC`,
    )
    .all() as Trade[];
  db.close();

  console.log(`\nLoaded ${trades.length} closed trades.\n`);

  const bySymbol = new Map<string, Trade[]>();
  for (const t of trades) {
    if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, []);
    bySymbol.get(t.symbol)!.push(t);
  }

  const all = newAccumulator();
  const perSymbol = new Map<string, ArmAccumulator>();
  let replayed = 0;
  let skipped = 0;

  for (const [symbol, symbolTrades] of bySymbol) {
    const candles = loadCandles(symbol);
    if (candles.length < 100) {
      console.log(`  ${symbol}: insufficient candles (${candles.length}), skipping ${symbolTrades.length} trades`);
      skipped += symbolTrades.length;
      continue;
    }
    const rateAt = loadRateAt(symbol);
    const acc = newAccumulator();

    for (const t of symbolTrades) {
      const entryIdx = findEntryIndex(candles, t.entry_timestamp);
      if (entryIdx < 14) {
        skipped++;
        continue;
      } // need ATR window
      const atr = atrAt(candles, entryIdx, 14);
      if (atr <= 0) {
        skipped++;
        continue;
      }
      replayed++;

      acc.baseline.push(baselineOutcome(candles, entryIdx, t, rateAt));
      acc.atrFloor.push(
        simulateAtrFloor({ candles, entryIdx, direction: t.direction, entry: t.entry_price, sl: t.stop_loss, tp: t.take_profit, k: ATR_FLOOR_K, maxBars: MAX_BARS, rateAt }),
      );
      acc.chandelier.push(
        simulateChandelier({ candles, entryIdx, direction: t.direction, entry: t.entry_price, sl: t.stop_loss, atr, k: CHANDELIER_K, maxBars: MAX_BARS, rateAt }),
      );
      for (const h of VERTICAL_HORIZONS) {
        acc.vertical.get(h)!.push(
          simulateVerticalBarrier({ candles, entryIdx, direction: t.direction, entry: t.entry_price, sl: t.stop_loss, tp: t.take_profit, horizonBars: h, rateAt }),
        );
      }
    }

    perSymbol.set(symbol, acc);
    all.baseline.push(...acc.baseline);
    all.atrFloor.push(...acc.atrFloor);
    all.chandelier.push(...acc.chandelier);
    for (const h of VERTICAL_HORIZONS) all.vertical.get(h)!.push(...acc.vertical.get(h)!);
  }

  console.log(`Replayed ${replayed} trades (${skipped} skipped: pre-ATR-window or missing candles).\n`);

  // ── Build the arm → stats record ───────────────────────────────────────────
  interface ArmRow {
    arm: string;
    label: string;
    stats: ArmStats;
  }
  const rows: ArmRow[] = [
    { arm: 'A_baseline', label: 'A baseline (stored SL/TP)', stats: summarizeArm(all.baseline) },
    { arm: 'B_atr_floor', label: `B atr_floor (k=${ATR_FLOOR_K})`, stats: summarizeArm(all.atrFloor) },
    { arm: 'C_chandelier', label: `C chandelier (k=${CHANDELIER_K})`, stats: summarizeArm(all.chandelier) },
  ];
  for (const h of VERTICAL_HORIZONS) {
    rows.push({ arm: `D_vertical_${h}`, label: `D vertical_barrier (N=${h})`, stats: summarizeArm(all.vertical.get(h)!) });
  }

  const baselineMeanNet = rows[0]!.stats.meanNetR;

  const printRow = (label: string, s: ArmStats): void => {
    const delta = s.meanNetR - baselineMeanNet;
    console.log(
      `${label.padEnd(28)} n=${String(s.n).padStart(4)}  WR=${(s.winRate * 100).toFixed(1).padStart(5)}%  ` +
        `SL%=${(s.slRate * 100).toFixed(1).padStart(5)}%  fastSL%=${(s.fastStopRate * 100).toFixed(1).padStart(5)}%  ` +
        `meanNetR=${s.meanNetR.toFixed(4).padStart(8)}  ΔvsA=${(delta >= 0 ? '+' : '') + delta.toFixed(4)}  ` +
        `meanGrossR=${s.meanGrossR.toFixed(4).padStart(8)}  meanFundR=${s.meanFundingR.toFixed(5).padStart(9)}  meanBars=${s.meanBars.toFixed(1)}`,
    );
  };

  console.log('═'.repeat(150));
  console.log('AGGREGATE (all symbols) — headline metric is meanNetR (net of per-arm funding)');
  console.log('─'.repeat(150));
  for (const r of rows) printRow(r.label, r.stats);

  // Verdict: does any arm beat baseline on mean net R?
  const beaters = rows
    .slice(1)
    .filter((r) => r.stats.meanNetR > baselineMeanNet + 1e-6)
    .sort((a, b) => b.stats.meanNetR - a.stats.meanNetR);
  console.log('\n' + '─'.repeat(150));
  if (beaters.length === 0) {
    console.log('VERDICT: NO arm beats baseline on mean net-of-funding R. Run-20 partial_tp exits look near-optimal on this window.');
  } else {
    const top = beaters[0]!;
    console.log(
      `VERDICT: ${beaters.length} arm(s) beat baseline on mean net R. Top = ${top.label} ` +
        `(meanNetR=${top.stats.meanNetR.toFixed(4)} vs baseline ${baselineMeanNet.toFixed(4)}, Δ=+${(top.stats.meanNetR - baselineMeanNet).toFixed(4)}). ` +
        `DIAGNOSTIC ONLY — must clear WF/PBO before any live exit change.`,
    );
  }

  console.log('\n' + '═'.repeat(150));
  console.log('PER-SYMBOL');
  for (const [symbol, acc] of perSymbol) {
    console.log('─'.repeat(150));
    console.log(symbol);
    printRow('  A baseline', summarizeArm(acc.baseline));
    printRow(`  B atr_floor (k=${ATR_FLOOR_K})`, summarizeArm(acc.atrFloor));
    printRow(`  C chandelier (k=${CHANDELIER_K})`, summarizeArm(acc.chandelier));
    for (const h of VERTICAL_HORIZONS) printRow(`  D vertical (N=${h})`, summarizeArm(acc.vertical.get(h)!));
  }
  console.log('═'.repeat(150));

  // ── Emit JSON ───────────────────────────────────────────────────────────────
  const out = {
    generatedAt: new Date().toISOString(),
    note: 'DIAGNOSTIC. In-sample replay of Run-20 bot_trades; per-arm funding debited net-of-funding R. A winning arm must clear WF/PBO before any live exit change.',
    config: { maxBars: MAX_BARS, atrFloorK: ATR_FLOOR_K, chandelierK: CHANDELIER_K, verticalHorizons: VERTICAL_HORIZONS, atrPeriod: 14 },
    nTradesTotal: trades.length,
    nReplayed: replayed,
    nSkipped: skipped,
    baselineMeanNetR: baselineMeanNet,
    arms: rows.map((r) => ({ arm: r.arm, label: r.label, deltaNetRvsBaseline: r.stats.meanNetR - baselineMeanNet, ...r.stats })),
    verdict:
      beaters.length === 0
        ? 'NO arm beats baseline on mean net-of-funding R; Run-20 partial_tp exits near-optimal on this window.'
        : `${beaters.length} arm(s) beat baseline; top=${beaters[0]!.arm}. DIAGNOSTIC — must clear WF/PBO before any live exit change.`,
    perSymbol: Object.fromEntries(
      [...perSymbol.entries()].map(([symbol, acc]) => [
        symbol,
        {
          A_baseline: summarizeArm(acc.baseline),
          B_atr_floor: summarizeArm(acc.atrFloor),
          C_chandelier: summarizeArm(acc.chandelier),
          ...Object.fromEntries(VERTICAL_HORIZONS.map((h) => [`D_vertical_${h}`, summarizeArm(acc.vertical.get(h)!)])),
        },
      ]),
    ),
  };

  const outPath = path.resolve('experiments/runs/atr-stop-arms.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log('Headline metric = meanNetR (net of per-arm funding). Comparing arms on gross R would falsely favor the longest-hold arm.\n');
}

main();
