/**
 * position-dump.ts
 *
 * Pure helper for building a DumpedPosition from a canonical SimulatedPosition.
 * Used by the --dump-positions flag in backtest-confluence.ts to capture the
 * exact Run-20 entries (pre-friction RAW signal price) so the leverage sweep
 * (Task 5) can re-simulate them at arbitrary leverage without re-deriving the
 * entry pipeline.
 */

export interface DumpedPosition {
  symbol: string;
  direction: 'long' | 'short';
  /** RAW signal entry price (pre-friction) — what the scorer emitted */
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  /** Unix ms — sweep finds candle index by timestamp */
  entryTimestamp: number;
  strategy: string;
}

/**
 * Build a DumpedPosition from the per-symbol position data captured at the
 * canonical entry point (after per-regime SL/TP multiplier, before exit-mode
 * switch) in the backtest-confluence trade loop.
 *
 * Kept deliberately trivial — one tested place owns the dump shape.
 */
export function buildDumpedPosition(
  p: {
    direction: 'long' | 'short';
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    entryTimestamp: number;
    strategy: string;
  },
  symbol: string,
): DumpedPosition {
  return {
    symbol,
    direction: p.direction,
    entryPrice: p.entryPrice,
    stopLoss: p.stopLoss,
    takeProfit: p.takeProfit,
    entryTimestamp: p.entryTimestamp,
    strategy: p.strategy,
  };
}
