#!/usr/bin/env npx tsx
/**
 * leverage-sweep.ts
 *
 * Re-simulate a canonical Run-20 positions dump at each leverage level and
 * print the leverage curve: terminalWealth, liqRate, maxDD, Sharpe, blown, trades.
 *
 * Usage:
 *   npx tsx scripts/leverage-sweep.ts --positions <path> [options]
 *
 * Required:
 *   --positions <path>   Path to positions dump JSON (array of DumpedPosition from Task 4)
 *
 * Optional:
 *   --leverages 1,2,5,10,25,50   Comma-separated leverage levels (default: 1,2,5,10,25,50)
 *   --f 0.02                     Fraction of equity posted per trade (default: 0.02)
 *   --mmr 0.005                  Maintenance margin ratio (default: 0.005)
 *   --liq-fee 0.005              Liquidation fee as fraction (default: 0.005)
 *   --friction 0.0007            One-way friction (default: 0.0007)
 *
 * partialTP and maxBars are fixed to Run-20 config:
 *   partialTP = { fraction: 0.50, triggerR: 1.41, beBuffer: 0.20 }
 *   maxBars   = 160
 *
 * L=1 fidelity sanity:
 *   The book MUST be profitable at L=1 (terminalWealth > 1) and all positions
 *   must resolve (trades == dumped count, skipped == 0). If either check fails,
 *   the script exits with code 1. This confirms the dump reproduces the
 *   validated Run-20 edge before trusting higher-L rows.
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '../src/types/candle';
import type { DumpedPosition } from '../src/lib/sim/position-dump';
import { sweepLeverage, type SweepEntry } from '../src/lib/sim/leverage-sweep-core';

// ---------------------------------------------------------------------------
// Run-20 fixed params (partialTP + maxBars) — must not be overridden by CLI
// ---------------------------------------------------------------------------
const RUN20_PARTIAL_TP = { fraction: 0.50, triggerR: 1.41, beBuffer: 0.20 };
const RUN20_MAX_BARS = 160;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  positionsPath: string;
  leverages: number[];
  f: number;
  mmr: number;
  liqFee: number;
  friction: number;
} {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length - 1; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag !== undefined && flag.startsWith('--') && value !== undefined && !value.startsWith('--')) {
      args[flag.slice(2)] = value;
    }
  }

  const positionsPath = args['positions'];
  if (!positionsPath) {
    console.error('Error: --positions <path> is required');
    process.exit(1);
  }

  const leveragesStr = args['leverages'] ?? '1,2,5,10,25,50';
  const leverages = leveragesStr.split(',').map((s) => {
    const n = Number(s.trim());
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`Error: invalid leverage value "${s}"`);
      process.exit(1);
    }
    return n;
  });

  return {
    positionsPath,
    leverages,
    f: Number(args['f'] ?? '0.02'),
    mmr: Number(args['mmr'] ?? '0.005'),
    liqFee: Number(args['liq-fee'] ?? '0.005'),
    friction: Number(args['friction'] ?? '0.0007'),
  };
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function loadDump(positionsPath: string): DumpedPosition[] {
  const abs = path.isAbsolute(positionsPath) ? positionsPath : path.join(process.cwd(), positionsPath);
  if (!fs.existsSync(abs)) {
    console.error(`Error: positions file not found: ${abs}`);
    process.exit(1);
  }
  const raw: unknown = JSON.parse(fs.readFileSync(abs, 'utf8'));
  if (!Array.isArray(raw)) {
    console.error('Error: positions file must be a JSON array of DumpedPosition objects');
    process.exit(1);
  }
  return raw as DumpedPosition[];
}

function loadCandleFile(symbol: string): Candle[] | null {
  const dataDir = path.join(process.cwd(), 'data');
  const filePath = path.join(dataDir, `${symbol}_1h.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return raw as Candle[];
}

// ---------------------------------------------------------------------------
// Table formatting
// ---------------------------------------------------------------------------

function fmtNum(n: number, digits: number): string {
  return n.toFixed(digits);
}

function fmtPct(n: number, digits: number): string {
  return (n * 100).toFixed(digits) + '%';
}

function printTable(rows: ReturnType<typeof sweepLeverage>): void {
  const header = ['L', 'terminalWealth', 'liqRate%', 'maxDD%', 'sharpe', 'blown', 'trades'];
  const colWidths = header.map((h) => h.length);

  // Build formatted rows
  const formatted = rows.map((r) => [
    String(r.leverage),
    fmtNum(r.terminalWealth, 4),
    fmtPct(r.liqRate, 2),
    fmtPct(r.maxDD, 2),
    fmtNum(r.sharpe, 4),
    String(r.blown),
    String(r.trades),
  ]);

  // Compute column widths
  for (const row of formatted) {
    for (let i = 0; i < row.length; i++) {
      const cell = row[i];
      if (cell !== undefined) {
        colWidths[i] = Math.max(colWidths[i] ?? 0, cell.length);
      }
    }
  }

  function formatRow(cells: string[]): string {
    return cells.map((cell, i) => cell.padStart(colWidths[i] ?? cell.length)).join('  ');
  }

  const separator = colWidths.map((w) => '-'.repeat(w)).join('  ');
  console.log(formatRow(header));
  console.log(separator);
  for (const row of formatted) {
    console.log(formatRow(row));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const { positionsPath, leverages, f, mmr, liqFee, friction } = parseArgs(process.argv.slice(2));

  // Load dump
  const dump = loadDump(positionsPath);
  console.log(`Loaded ${dump.length} positions from ${positionsPath}`);

  // Group by symbol, load candles
  const bySymbol = new Map<string, DumpedPosition[]>();
  for (const pos of dump) {
    const list = bySymbol.get(pos.symbol) ?? [];
    list.push(pos);
    bySymbol.set(pos.symbol, list);
  }

  const entries: SweepEntry[] = [];
  let skippedSymbols = 0;
  let skippedPositions = 0;

  for (const [symbol, positions] of bySymbol) {
    const candles = loadCandleFile(symbol);
    if (candles === null) {
      console.warn(`Warning: candle file not found for ${symbol} — skipping ${positions.length} position(s)`);
      skippedSymbols++;
      skippedPositions += positions.length;
      continue;
    }

    for (const pos of positions) {
      // Resolve the candle index matching this position's entry timestamp.
      // entryIndex must be set correctly so that barsHeld (= i - entryIndex) starts
      // at 1 on the first simulation bar (startIndex = idx + 1). Setting entryIndex=0
      // would cause barsHeld to start at idx+1 >> maxBars, triggering immediate exits.
      const entryIdx = candles.findIndex((c) => c.timestamp >= pos.entryTimestamp);
      if (entryIdx === -1) {
        console.warn(
          `Warning: cannot resolve entry index for ${symbol} ts=${pos.entryTimestamp} — skipping`,
        );
        skippedPositions++;
        continue;
      }

      entries.push({
        symbol,
        position: {
          direction: pos.direction,
          entryPrice: pos.entryPrice,
          entryTimestamp: pos.entryTimestamp,
          entryIndex: entryIdx,
          stopLoss: pos.stopLoss,
          takeProfit: pos.takeProfit,
          strategy: pos.strategy,
        },
        candles,
      });
    }
  }

  const totalResolvable = dump.length - skippedPositions;
  console.log(
    `Symbols: ${bySymbol.size} (${skippedSymbols} missing candles). ` +
    `Entries for sweep: ${entries.length}/${dump.length} (${skippedPositions} skipped).`,
  );
  console.log('');

  // Run sweep
  const rows = sweepLeverage(entries, {
    leverages,
    f,
    mmr,
    liqFeeFrac: liqFee,
    friction,
    partialTP: RUN20_PARTIAL_TP,
    maxBars: RUN20_MAX_BARS,
  });

  // Print table
  console.log(`Leverage curve (f=${f}, mmr=${mmr}, liqFee=${liqFee}, friction=${friction}):`);
  console.log('');
  printTable(rows);
  console.log('');

  // Summary lines
  const best = rows.reduce((a, b) => (b.terminalWealth > a.terminalWealth ? b : a), rows[0]!);
  console.log(`Best leverage by terminalWealth: L=${best.leverage} (${fmtNum(best.terminalWealth, 4)})`);

  const firstDangerous = rows.find((r) => r.liqRate > 0.01);
  if (firstDangerous) {
    console.log(`First L where liqRate > 1%: L=${firstDangerous.leverage} (${fmtPct(firstDangerous.liqRate, 2)})`);
  } else {
    console.log('No leverage level reaches liqRate > 1% in this sweep.');
  }

  console.log('');

  // ---------------------------------------------------------------------------
  // L=1 fidelity sanity check
  // ---------------------------------------------------------------------------
  const l1Row = rows.find((r) => r.leverage === 1);
  if (!l1Row) {
    console.warn('Warning: L=1 not in leverages list — skipping fidelity sanity check.');
    return;
  }

  const l1TradeCount = l1Row.trades;
  const fidelityProfitable = l1Row.terminalWealth > 1;
  const fidelityFullResolve = l1TradeCount === totalResolvable && skippedPositions === 0;

  console.log('--- L=1 fidelity sanity ---');
  console.log(
    `  terminalWealth = ${fmtNum(l1Row.terminalWealth, 6)}  [must be > 1: ${fidelityProfitable ? 'PASS' : 'FAIL'}]`,
  );
  console.log(
    `  trades = ${l1TradeCount} / ${dump.length} dumped  [skipped = ${dump.length - l1TradeCount}] ` +
    `[must == dumped and skipped==0: ${fidelityFullResolve ? 'PASS' : 'FAIL'}]`,
  );

  if (!fidelityProfitable || !fidelityFullResolve) {
    console.error('');
    console.error('ERROR: L=1 fidelity sanity FAILED. The dump does not reproduce the Run-20 edge.');
    console.error('  - If terminalWealth <= 1: positions may not match the canonical Run-20 config.');
    console.error('  - If trades != dumped or skipped > 0: candle files may be missing or timestamp mismatched.');
    process.exit(1);
  }

  console.log('  L=1 sanity: PASS — dump reproduces Run-20 edge at base leverage.');
}

main();
