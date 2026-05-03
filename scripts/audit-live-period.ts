#!/usr/bin/env tsx
/**
 * Audit live period (Feb 23 → Apr 17, 2026) for the F2F gold strategy.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '../src/types/candle';
import { generateSignals, runF2FSimulation } from '../src/lib/gold';

const dataPath = path.resolve(__dirname, '..', 'data', 'GC_F_1d.json');
const candles: Candle[] = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

const liveStart = new Date('2026-02-23').getTime();
const startIdx = candles.findIndex(c => c.timestamp >= liveStart);
const startBar = candles[startIdx]!;
const lastBar = candles[candles.length - 1]!;

console.log(`Total daily bars: ${candles.length}`);
console.log(`Live start idx: ${startIdx} (${new Date(startBar.timestamp).toISOString().slice(0, 10)})`);
console.log(`Live end:       ${new Date(lastBar.timestamp).toISOString().slice(0, 10)}`);

// Train on full history before live period
const trainStart = 0;
const trainEnd = startIdx;

console.log(
  `\nTrain window: ${new Date(candles[0]!.timestamp).toISOString().slice(0, 10)} → ${new Date(candles[trainEnd - 1]!.timestamp).toISOString().slice(0, 10)} (${trainEnd} bars)`,
);

const signals = generateSignals(
  candles,
  { lambda: 0.95, theta: 0.91 },
  trainStart,
  trainEnd,
  startIdx,
  candles.length,
  'zscore50',
);

console.log(`Live signals: ${signals.length}`);
console.log(`  Long entries: ${signals.filter(s => s.isLongEntry).length}`);
console.log(`  Short entries: ${signals.filter(s => s.isShortEntry).length}`);
console.log(`  Regime suppressed: ${signals.filter(s => s.isRegimeSuppressed).length}`);

const result = runF2FSimulation(signals, 0.0005, 'long-only');

console.log('\n=== F2F Gold — Live Period Audit ===');
console.log(`Trades: ${result.trades.length}`);
console.log(`PnL: ${(result.totalPnl * 100).toFixed(2)}%`);
console.log(`Sharpe: ${result.sharpe.toFixed(2)}`);
console.log(`Max DD: ${(result.maxDrawdown * 100).toFixed(2)}%`);
console.log(`Win rate: ${(result.winRate * 100).toFixed(1)}%`);
console.log(`Avg days held: ${result.avgDaysHeld.toFixed(1)}`);

if (result.trades.length > 0) {
  console.log('\nTrades:');
  for (const t of result.trades) {
    const entry = new Date(t.entryTimestamp).toISOString().slice(0, 10);
    const exit = new Date(t.exitTimestamp).toISOString().slice(0, 10);
    console.log(
      `  ${entry} → ${exit} | ${t.direction} | weight=${t.weight.toFixed(2)} | pnl=${(t.pnlPercent * 100).toFixed(2)}% | ${t.daysHeld}d | exit=${t.exitReason}`,
    );
  }
}
