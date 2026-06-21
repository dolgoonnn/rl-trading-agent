#!/usr/bin/env npx tsx
/**
 * gen-golden-slice.ts — ONE-SHOT GENERATOR (run once, commit the output)
 *
 * Generates a golden fixture for the parity-regression test (Task 8).
 *
 * Strategy:
 *   1. Load data/BTCUSDT_1h.json, take the first 2000 candles.
 *   2. Place a synthetic position every 50 bars (entryIndex = 50, 100, …).
 *      Directions alternate long/short. SL/TP at fixed % offsets from bar close.
 *   3. Compute `expected[]` using a self-contained legacyExpected() that replicates
 *      backtest-confluence.ts's simulatePositionSimple arithmetic INLINE.
 *      DO NOT import simulatePosition — doing so would make the fixture circular.
 *   4. Write { candles, positions, expected } to
 *      tests/sim/fixtures/golden-run20-slice.json.
 *
 * Run: npx tsx scripts/gen-golden-slice.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Candle } from '../src/types/candle';
import type { SimPosition } from '../src/lib/sim/types';

// ---------------------------------------------------------------------------
// Constants — must match the parity test exactly
// ---------------------------------------------------------------------------
const FRICTION = 0.0007;
const MAXBARS = 100;
const CANDLE_LIMIT = 2000;
const STEP = 50;
const FIXTURE_PATH = 'tests/sim/fixtures/golden-run20-slice.json';

// ---------------------------------------------------------------------------
// Expected-result shape (subset of SimTradeResult we care about)
// ---------------------------------------------------------------------------
interface GoldenExpected {
  entryPrice: number;
  exitPrice: number;
  pnlPercent: number;
  exitReason: 'stop_loss' | 'take_profit' | 'max_bars';
}

// ---------------------------------------------------------------------------
// Self-contained legacy oracle
// Mirrors backtest-confluence.ts (simulatePositionSimple + checkSLTPMaxBars +
// applyEntryFriction + applyExitFriction + calculatePnlPercent).
// SL is checked FIRST within a candle (pessimistic / worst-case floor).
// Uniform FRICTION on both legs (MAKER_TAKER = null path).
// ---------------------------------------------------------------------------
function legacyExpected(
  pos: SimPosition,
  candles: Candle[],
  friction: number,
  maxBars: number,
): GoldenExpected {
  // --- Entry cost (mirrors applyEntryFriction, taker) ---
  const adjustedEntry =
    pos.direction === 'long'
      ? pos.entryPrice * (1 + friction)  // long: buy price goes UP
      : pos.entryPrice * (1 - friction); // short: sell price goes DOWN

  // --- Loop (mirrors simulatePositionSimple / checkSLTPMaxBars) ---
  for (let i = pos.entryIndex; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;

    const barsHeld = i - pos.entryIndex;

    let exitLevel: number | null = null;
    let exitReason: GoldenExpected['exitReason'] | null = null;

    if (pos.direction === 'long') {
      // SL checked FIRST (pessimistic floor)
      if (candle.low <= pos.stopLoss) {
        exitLevel = pos.stopLoss;
        exitReason = 'stop_loss';
      } else if (candle.high >= pos.takeProfit) {
        exitLevel = pos.takeProfit;
        exitReason = 'take_profit';
      }
    } else {
      // short: SL checked first
      if (candle.high >= pos.stopLoss) {
        exitLevel = pos.stopLoss;
        exitReason = 'stop_loss';
      } else if (candle.low <= pos.takeProfit) {
        exitLevel = pos.takeProfit;
        exitReason = 'take_profit';
      }
    }

    // max_bars timeout
    if (exitLevel === null && barsHeld >= maxBars) {
      exitLevel = candle.close;
      exitReason = 'max_bars';
    }

    if (exitLevel !== null && exitReason !== null) {
      // --- Exit cost (mirrors applyExitFriction, taker) ---
      const adjustedExit =
        pos.direction === 'long'
          ? exitLevel * (1 - friction)   // long close: sell → price goes DOWN
          : exitLevel * (1 + friction);  // short close: buy → price goes UP

      // --- PnL (mirrors calculatePnlPercent) ---
      const pnlPercent =
        pos.direction === 'long'
          ? (adjustedExit - adjustedEntry) / adjustedEntry
          : (adjustedEntry - adjustedExit) / adjustedEntry;

      return { entryPrice: adjustedEntry, exitPrice: adjustedExit, pnlPercent, exitReason };
    }
  }

  // --- No exit triggered: closeAtEnd (mirrors closeAtEnd in backtest-confluence) ---
  const lastCandle = candles[candles.length - 1];
  if (!lastCandle) {
    throw new Error('gen-golden-slice: empty candle array — cannot compute closeAtEnd');
  }
  const adjustedExit =
    pos.direction === 'long'
      ? lastCandle.close * (1 - friction)
      : lastCandle.close * (1 + friction);
  const pnlPercent =
    pos.direction === 'long'
      ? (adjustedExit - adjustedEntry) / adjustedEntry
      : (adjustedEntry - adjustedExit) / adjustedEntry;

  return { entryPrice: adjustedEntry, exitPrice: adjustedExit, pnlPercent, exitReason: 'max_bars' };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(): void {
  // Load candles
  const rawData = readFileSync('data/BTCUSDT_1h.json', 'utf-8');
  const allCandles: Candle[] = JSON.parse(rawData) as Candle[];
  const candles = allCandles.slice(0, CANDLE_LIMIT);

  if (candles.length < CANDLE_LIMIT) {
    console.warn(`Warning: only ${candles.length} candles available (expected ${CANDLE_LIMIT})`);
  }

  // Generate deterministic positions — skip last MAXBARS candles so most trades can resolve
  const positions: SimPosition[] = [];
  const expected: GoldenExpected[] = [];

  // Last safe entry index: CANDLE_LIMIT - 1 - 1 = 1998 but we want at least 1 candle to check
  // The generator places positions at 50, 100, ..., stopping before CANDLE_LIMIT - STEP
  // so all positions have at least STEP candles to work with (most will resolve via SL/TP).
  const maxEntryIndex = CANDLE_LIMIT - STEP;

  let directionToggle = 0; // 0=long, 1=short
  for (let idx = STEP; idx <= maxEntryIndex; idx += STEP) {
    const candle = candles[idx];
    if (!candle) continue;

    const direction: 'long' | 'short' = directionToggle % 2 === 0 ? 'long' : 'short';
    directionToggle++;

    const stopLoss = direction === 'long' ? candle.close * 0.98 : candle.close * 1.02;
    const takeProfit = direction === 'long' ? candle.close * 1.04 : candle.close * 0.96;

    const pos: SimPosition = {
      direction,
      entryPrice: candle.close,
      entryTimestamp: candle.timestamp,
      entryIndex: idx,
      stopLoss,
      takeProfit,
      strategy: 'golden',
    };

    positions.push(pos);
    expected.push(legacyExpected(pos, candles, FRICTION, MAXBARS));
  }

  // Sanity checks
  console.log(`Generated ${positions.length} positions`);
  const reasonCounts = { stop_loss: 0, take_profit: 0, max_bars: 0 };
  for (const e of expected) {
    reasonCounts[e.exitReason]++;
  }
  console.log('Exit reason distribution:', reasonCounts);

  if (positions.length < 30) {
    throw new Error(`Too few positions (${positions.length}); expected ≥30`);
  }

  // Write fixture
  const fixture = { candles, positions, expected };
  mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
  writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 0));
  console.log(`Fixture written to ${FIXTURE_PATH} (${positions.length} trades)`);
}

main();
