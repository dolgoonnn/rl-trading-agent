#!/usr/bin/env npx tsx
/**
 * Backtest Confluence Scorer via Walk-Forward Validation
 *
 * Connects the ConfluenceScorer (Iteration 2) to the Walk-Forward Validation
 * framework (Iteration 1) to test the rule-based system across all time windows.
 *
 * The script:
 * 1. Creates a WalkForwardStrategyRunner that uses the ConfluenceScorer
 * 2. Runs it through the walk-forward framework
 * 3. Saves results to experiments/iteration-2-confluence-scorer.md
 *
 * Usage:
 *   npx tsx scripts/backtest-confluence.ts
 *   npx tsx scripts/backtest-confluence.ts --threshold 3.5
 *   npx tsx scripts/backtest-confluence.ts --symbols BTCUSDT
 *   npx tsx scripts/backtest-confluence.ts --json
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import {
  ConfluenceScorer,
  type ConfluenceScorerResult,
  type ConfluenceConfig,
  DEFAULT_WEIGHTS,
  DEFAULT_CONFLUENCE_CONFIG,
  PRODUCTION_STRATEGY_CONFIG,
  FIFTEEN_MIN_STRATEGY_CONFIG,
  FIFTEEN_MIN_CONFLUENCE_OVERRIDES,
  DEFAULT_REGIME_FILTER,
  DEFAULT_MTF_BIAS,
  type RegimeFilterConfig,
  type MTFBiasConfig,
} from '../src/lib/rl/strategies/confluence-scorer';
import {
  detectRegime,
  regimeLabel,
} from '../src/lib/ict/regime-detector';
import { DEFAULT_OB_CONFIG } from '../src/lib/ict/order-blocks';
import type { StrategyName, StrategyExitSignal, SLPlacementMode } from '../src/lib/rl/strategies/ict-strategies';
import type { HybridPosition } from '../src/lib/rl/types';
import {
  runWalkForward,
  type WalkForwardStrategyRunner,
  type TradeResult,
  type WalkForwardResult,
} from './walk-forward-validate';

// ============================================
// Constants
// ============================================

/** Maximum bars to hold a position before force-closing (overridable via --max-bars) */
let MAX_POSITION_BARS = 100;

/** Exit mode: simple (SL/TP only), breakeven (move SL to entry at 1R), trailing, enhanced */
type ExitMode = 'simple' | 'breakeven' | 'trailing' | 'enhanced';

/** Partial take-profit config: close fraction of position at triggerR */
interface PartialTPConfig {
  /** Fraction to close (0-1, e.g. 0.5 = 50%) */
  fraction: number;
  /** R-multiple trigger (e.g. 1.0 = at 1R profit) */
  triggerR: number;
  /** Breakeven buffer as fraction of risk distance (0 = exact breakeven, -1 = no BE move, default: 0.1) */
  beBuffer: number;
}

/** A single level in a multi-level partial TP plan */
interface TPLevel {
  /** Fraction of ORIGINAL position to close at this level (sum of all fractions must be <= 1) */
  fraction: number;
  /** R-multiple trigger */
  triggerR: number;
  /** Where to move SL after this level triggers (in R-multiples from entry, e.g. 0.1 = BE+10%) */
  slMoveR: number;
}

/** Multi-level TP config with optional trailing stop */
interface MultiTPConfig {
  /** Ordered TP levels (lowest triggerR first) */
  levels: TPLevel[];
  /** Trailing stop config (activates after all partials taken). Distance in R-multiples. */
  trailDistanceR?: number;
  /** Min R-multiple before trailing activates (default: same as last partial triggerR) */
  trailActivationR?: number;
}

/** Default commission per side as a fraction (0.1% = 0.001) */
const DEFAULT_COMMISSION = 0.001;

/** Default slippage per side as a fraction (0.05% = 0.0005) */
const DEFAULT_SLIPPAGE = 0.0005;

/** Combined friction per side: commission + slippage (overridable via --friction) */
let FRICTION_PER_SIDE = DEFAULT_COMMISSION + DEFAULT_SLIPPAGE;

/** Experiment output path */
const EXPERIMENT_DOC_PATH = 'experiments/iteration-2-confluence-scorer.md';

/** Path to check for exp-014 RL results for comparison */
const EXP_014_RESULTS_PATH = 'experiments/walk-forward-results.json';

// ============================================
// Types
// ============================================

/** Circuit breaker config: pauses trading after consecutive losses */
interface CircuitBreakerConfig {
  /** Max consecutive losses before triggering pause */
  maxConsecutiveLosses: number;
  /** Number of bars to pause after triggering */
  cooldownBars: number;
}

/** Streak-aware sizing config: anti-Martingale position scaling */
interface StreakSizingConfig {
  /** Number of consecutive wins/losses to trigger multiplier */
  streakLength: number;
  /** Multiplier after consecutive wins (e.g., 1.5) */
  winMultiplier: number;
  /** Multiplier after consecutive losses (e.g., 0.5) */
  lossMultiplier: number;
}

/** Risk management config applied to trade PnL post-hoc */
interface RiskConfig {
  /** Scale PnL by inverse ATR percentile (vol-sizing proxy) */
  volSizing: boolean;
  /** Stop trading in window when cumulative PnL drops below this (e.g., -0.05 = -5%) */
  maxWindowDD?: number;
  /** Streak-aware position sizing */
  streakSizing?: StreakSizingConfig;
}

interface SimulatedPosition {
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  direction: 'long' | 'short';
  entryIndex: number;
  entryTimestamp: number;
  strategy: string;
}

interface StrategyStats {
  strategy: string;
  totalSignals: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnl: number;
  avgRR: number;
  totalPnl: number;
}

interface RegimeBreakdownEntry {
  regimeLabel: string;
  trades: number;
  wins: number;
  winRate: number;
  avgPnl: number;
  totalPnl: number;
}

interface ConfluenceBacktestResult {
  walkForwardResult: WalkForwardResult;
  strategyBreakdown: StrategyStats[];
  regimeBreakdown: RegimeBreakdownEntry[];
  threshold: number;
  symbols: string[];
  totalTrades: number;
  totalSignals: number;
  overallWinRate: number;
  overallPnl: number;
}

// ============================================
// Position Simulation
// ============================================

/**
 * Apply friction (commission + slippage) to a price.
 * For entries: buyer pays more, seller receives less.
 * For exits: buyer pays more, seller receives less.
 */
function applyEntryFriction(
  price: number,
  direction: 'long' | 'short',
): number {
  if (direction === 'long') {
    // Buying: price goes up by friction
    return price * (1 + FRICTION_PER_SIDE);
  }
  // Selling short: price goes down by friction
  return price * (1 - FRICTION_PER_SIDE);
}

function applyExitFriction(
  price: number,
  direction: 'long' | 'short',
): number {
  if (direction === 'long') {
    // Selling to close long: price goes down by friction
    return price * (1 - FRICTION_PER_SIDE);
  }
  // Buying to close short: price goes up by friction
  return price * (1 + FRICTION_PER_SIDE);
}

/**
 * Calculate PnL percentage for a completed trade.
 * Friction is already baked into adjusted entry/exit prices.
 */
function calculatePnlPercent(
  adjustedEntry: number,
  adjustedExit: number,
  direction: 'long' | 'short',
): number {
  if (direction === 'long') {
    return (adjustedExit - adjustedEntry) / adjustedEntry;
  }
  return (adjustedEntry - adjustedExit) / adjustedEntry;
}

/**
 * Simulate a position through subsequent candles until SL, TP, or max bars.
 * Returns the trade result with friction applied.
 *
 * SIMPLE MODE: No strategy exit logic, just SL/TP/max bars.
 */
function simulatePositionSimple(
  position: SimulatedPosition,
  candles: Candle[],
  startIndex: number,
): TradeResult | null {
  const adjustedEntry = applyEntryFriction(
    position.entryPrice,
    position.direction,
  );

  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;

    const barsHeld = i - position.entryIndex;
    const exitResult = checkSLTPMaxBars(position, candle, barsHeld);
    if (exitResult) {
      const adjustedExit = applyExitFriction(exitResult, position.direction);
      return {
        entryTimestamp: position.entryTimestamp,
        exitTimestamp: candle.timestamp,
        direction: position.direction,
        entryPrice: adjustedEntry,
        exitPrice: adjustedExit,
        pnlPercent: calculatePnlPercent(adjustedEntry, adjustedExit, position.direction),
        strategy: position.strategy,
      };
    }
  }

  return closeAtEnd(position, candles, adjustedEntry);
}

/** Check if SL, TP, or max bars hit. Returns exit price or null. */
function checkSLTPMaxBars(
  position: SimulatedPosition,
  candle: Candle,
  barsHeld: number,
): number | null {
  if (position.direction === 'long') {
    if (candle.low <= position.stopLoss) return position.stopLoss;
    if (candle.high >= position.takeProfit) return position.takeProfit;
  } else {
    if (candle.high >= position.stopLoss) return position.stopLoss;
    if (candle.low <= position.takeProfit) return position.takeProfit;
  }
  if (barsHeld >= MAX_POSITION_BARS) return candle.close;
  return null;
}

/** Close position at last available candle */
function closeAtEnd(
  position: SimulatedPosition,
  candles: Candle[],
  adjustedEntry: number,
): TradeResult | null {
  const lastCandle = candles[candles.length - 1];
  if (!lastCandle) return null;
  const adjustedExit = applyExitFriction(lastCandle.close, position.direction);
  return {
    entryTimestamp: position.entryTimestamp,
    exitTimestamp: lastCandle.timestamp,
    direction: position.direction,
    entryPrice: adjustedEntry,
    exitPrice: adjustedExit,
    pnlPercent: calculatePnlPercent(adjustedEntry, adjustedExit, position.direction),
    strategy: position.strategy,
  };
}

/**
 * BREAKEVEN MODE: Move SL to entry + buffer after 1R profit.
 * No trailing, no strategy exits. Just protects gains once position is 1R in profit.
 */
function simulatePositionBreakeven(
  position: SimulatedPosition,
  candles: Candle[],
  startIndex: number,
): TradeResult | null {
  const adjustedEntry = applyEntryFriction(position.entryPrice, position.direction);
  let currentSL = position.stopLoss;

  // Calculate 1R distance
  const riskDistance = position.direction === 'long'
    ? position.entryPrice - position.stopLoss
    : position.stopLoss - position.entryPrice;
  let breakEvenTriggered = false;

  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;

    const barsHeld = i - position.entryIndex;

    // Check SL (possibly moved to breakeven) and TP
    if (position.direction === 'long') {
      if (candle.low <= currentSL) {
        const adjustedExit = applyExitFriction(currentSL, position.direction);
        return {
          entryTimestamp: position.entryTimestamp,
          exitTimestamp: candle.timestamp,
          direction: position.direction,
          entryPrice: adjustedEntry,
          exitPrice: adjustedExit,
          pnlPercent: calculatePnlPercent(adjustedEntry, adjustedExit, position.direction),
          strategy: position.strategy,
        };
      }
      if (candle.high >= position.takeProfit) {
        const adjustedExit = applyExitFriction(position.takeProfit, position.direction);
        return {
          entryTimestamp: position.entryTimestamp,
          exitTimestamp: candle.timestamp,
          direction: position.direction,
          entryPrice: adjustedEntry,
          exitPrice: adjustedExit,
          pnlPercent: calculatePnlPercent(adjustedEntry, adjustedExit, position.direction),
          strategy: position.strategy,
        };
      }
    } else {
      if (candle.high >= currentSL) {
        const adjustedExit = applyExitFriction(currentSL, position.direction);
        return {
          entryTimestamp: position.entryTimestamp,
          exitTimestamp: candle.timestamp,
          direction: position.direction,
          entryPrice: adjustedEntry,
          exitPrice: adjustedExit,
          pnlPercent: calculatePnlPercent(adjustedEntry, adjustedExit, position.direction),
          strategy: position.strategy,
        };
      }
      if (candle.low <= position.takeProfit) {
        const adjustedExit = applyExitFriction(position.takeProfit, position.direction);
        return {
          entryTimestamp: position.entryTimestamp,
          exitTimestamp: candle.timestamp,
          direction: position.direction,
          entryPrice: adjustedEntry,
          exitPrice: adjustedExit,
          pnlPercent: calculatePnlPercent(adjustedEntry, adjustedExit, position.direction),
          strategy: position.strategy,
        };
      }
    }

    // Move SL to breakeven at 1R profit
    if (!breakEvenTriggered && riskDistance > 0) {
      const unrealizedR = position.direction === 'long'
        ? (candle.close - position.entryPrice) / riskDistance
        : (position.entryPrice - candle.close) / riskDistance;

      if (unrealizedR >= 1.0) {
        breakEvenTriggered = true;
        // Buffer = 0.1 × risk distance (same scale as ATR-based buffer in enhanced mode)
        const buffer = riskDistance * 0.1;
        if (position.direction === 'long') {
          currentSL = Math.max(currentSL, position.entryPrice + buffer);
        } else {
          currentSL = Math.min(currentSL, position.entryPrice - buffer);
        }
      }
    }

    // Max bars
    if (barsHeld >= MAX_POSITION_BARS) {
      const adjustedExit = applyExitFriction(candle.close, position.direction);
      return {
        entryTimestamp: position.entryTimestamp,
        exitTimestamp: candle.timestamp,
        direction: position.direction,
        entryPrice: adjustedEntry,
        exitPrice: adjustedExit,
        pnlPercent: calculatePnlPercent(adjustedEntry, adjustedExit, position.direction),
        strategy: position.strategy,
      };
    }
  }

  return closeAtEnd(position, candles, adjustedEntry);
}

/**
 * PARTIAL TP MODE: Close a fraction at triggerR, move SL to breakeven, let rest run to TP.
 * PnL = weighted average of partial exit + final exit.
 */
function simulatePositionPartialTP(
  position: SimulatedPosition,
  candles: Candle[],
  startIndex: number,
  partialConfig: PartialTPConfig,
): TradeResult | null {
  const adjustedEntry = applyEntryFriction(position.entryPrice, position.direction);
  let currentSL = position.stopLoss;

  const riskDistance = position.direction === 'long'
    ? position.entryPrice - position.stopLoss
    : position.stopLoss - position.entryPrice;
  let partialTaken = false;
  let partialPnl = 0;

  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;

    const barsHeld = i - position.entryIndex;

    // Check SL and TP
    if (position.direction === 'long') {
      if (candle.low <= currentSL) {
        const adjustedExit = applyExitFriction(currentSL, position.direction);
        const exitPnl = calculatePnlPercent(adjustedEntry, adjustedExit, position.direction);
        const finalPnl = partialTaken
          ? partialConfig.fraction * partialPnl + (1 - partialConfig.fraction) * exitPnl
          : exitPnl;
        return {
          entryTimestamp: position.entryTimestamp,
          exitTimestamp: candle.timestamp,
          direction: position.direction,
          entryPrice: adjustedEntry,
          exitPrice: adjustedExit,
          pnlPercent: finalPnl,
          strategy: position.strategy,
        };
      }
      if (candle.high >= position.takeProfit) {
        const adjustedExit = applyExitFriction(position.takeProfit, position.direction);
        const exitPnl = calculatePnlPercent(adjustedEntry, adjustedExit, position.direction);
        const finalPnl = partialTaken
          ? partialConfig.fraction * partialPnl + (1 - partialConfig.fraction) * exitPnl
          : exitPnl;
        return {
          entryTimestamp: position.entryTimestamp,
          exitTimestamp: candle.timestamp,
          direction: position.direction,
          entryPrice: adjustedEntry,
          exitPrice: adjustedExit,
          pnlPercent: finalPnl,
          strategy: position.strategy,
        };
      }
    } else {
      if (candle.high >= currentSL) {
        const adjustedExit = applyExitFriction(currentSL, position.direction);
        const exitPnl = calculatePnlPercent(adjustedEntry, adjustedExit, position.direction);
        const finalPnl = partialTaken
          ? partialConfig.fraction * partialPnl + (1 - partialConfig.fraction) * exitPnl
          : exitPnl;
        return {
          entryTimestamp: position.entryTimestamp,
          exitTimestamp: candle.timestamp,
          direction: position.direction,
          entryPrice: adjustedEntry,
          exitPrice: adjustedExit,
          pnlPercent: finalPnl,
          strategy: position.strategy,
        };
      }
      if (candle.low <= position.takeProfit) {
        const adjustedExit = applyExitFriction(position.takeProfit, position.direction);
        const exitPnl = calculatePnlPercent(adjustedEntry, adjustedExit, position.direction);
        const finalPnl = partialTaken
          ? partialConfig.fraction * partialPnl + (1 - partialConfig.fraction) * exitPnl
          : exitPnl;
        return {
          entryTimestamp: position.entryTimestamp,
          exitTimestamp: candle.timestamp,
          direction: position.direction,
          entryPrice: adjustedEntry,
          exitPrice: adjustedExit,
          pnlPercent: finalPnl,
          strategy: position.strategy,
        };
      }
    }

    // Partial TP: close fraction at triggerR, move SL to breakeven
    if (!partialTaken && riskDistance > 0) {
      const unrealizedR = position.direction === 'long'
        ? (candle.close - position.entryPrice) / riskDistance
        : (position.entryPrice - candle.close) / riskDistance;

      if (unrealizedR >= partialConfig.triggerR) {
        partialTaken = true;
        const partialExit = applyExitFriction(candle.close, position.direction);
        partialPnl = calculatePnlPercent(adjustedEntry, partialExit, position.direction);
        // Move SL to breakeven + buffer (skip if beBuffer < 0)
        if (partialConfig.beBuffer >= 0) {
          const buffer = riskDistance * partialConfig.beBuffer;
          if (position.direction === 'long') {
            currentSL = Math.max(currentSL, position.entryPrice + buffer);
          } else {
            currentSL = Math.min(currentSL, position.entryPrice - buffer);
          }
        }
      }
    }

    // Max bars
    if (barsHeld >= MAX_POSITION_BARS) {
      const adjustedExit = applyExitFriction(candle.close, position.direction);
      const exitPnl = calculatePnlPercent(adjustedEntry, adjustedExit, position.direction);
      const finalPnl = partialTaken
        ? partialConfig.fraction * partialPnl + (1 - partialConfig.fraction) * exitPnl
        : exitPnl;
      return {
        entryTimestamp: position.entryTimestamp,
        exitTimestamp: candle.timestamp,
        direction: position.direction,
        entryPrice: adjustedEntry,
        exitPrice: adjustedExit,
        pnlPercent: finalPnl,
        strategy: position.strategy,
      };
    }
  }

  // Close at end with partial consideration
  const lastCandle = candles[candles.length - 1];
  if (!lastCandle) return null;
  const adjustedExit = applyExitFriction(lastCandle.close, position.direction);
  const exitPnl = calculatePnlPercent(adjustedEntry, adjustedExit, position.direction);
  const finalPnl = partialTaken
    ? partialConfig.fraction * partialPnl + (1 - partialConfig.fraction) * exitPnl
    : exitPnl;
  return {
    entryTimestamp: position.entryTimestamp,
    exitTimestamp: lastCandle.timestamp,
    direction: position.direction,
    entryPrice: adjustedEntry,
    exitPrice: adjustedExit,
    pnlPercent: finalPnl,
    strategy: position.strategy,
  };
}

/**
 * MULTI-LEVEL TP MODE: Close fractions at multiple R-levels with optional trailing stop.
 *
 * Example: Close 45% at 0.85R (SL→BE), close 25% at 1.5R (SL→0.5R), trail remaining 30%.
 * PnL = weighted sum of each partial exit + final remaining exit.
 */
function simulatePositionMultiTP(
  position: SimulatedPosition,
  candles: Candle[],
  startIndex: number,
  multiConfig: MultiTPConfig,
): TradeResult | null {
  const adjustedEntry = applyEntryFriction(position.entryPrice, position.direction);
  let currentSL = position.stopLoss;

  const riskDistance = position.direction === 'long'
    ? position.entryPrice - position.stopLoss
    : position.stopLoss - position.entryPrice;

  // Track which levels have been taken
  const levelsTaken: boolean[] = multiConfig.levels.map(() => false);
  const levelPnls: number[] = multiConfig.levels.map(() => 0);
  let totalFractionTaken = 0;

  // Trailing stop state
  let trailActive = false;
  const trailDistR = multiConfig.trailDistanceR ?? 0;
  const trailActivR = multiConfig.trailActivationR ?? (multiConfig.levels[multiConfig.levels.length - 1]?.triggerR ?? 1.5);

  /** Compute weighted PnL from all taken partials + the final remaining portion */
  function computeFinalPnl(remainingExitPnl: number): number {
    let pnl = 0;
    for (let k = 0; k < multiConfig.levels.length; k++) {
      if (levelsTaken[k]) {
        pnl += multiConfig.levels[k]!.fraction * levelPnls[k]!;
      }
    }
    const remainingFraction = 1 - totalFractionTaken;
    if (remainingFraction > 0) {
      pnl += remainingFraction * remainingExitPnl;
    }
    return pnl;
  }

  /** Build a trade result from an exit */
  function buildResult(exitPrice: number, exitTimestamp: number): TradeResult {
    const adjustedExit = applyExitFriction(exitPrice, position.direction);
    const exitPnl = calculatePnlPercent(adjustedEntry, adjustedExit, position.direction);
    return {
      entryTimestamp: position.entryTimestamp,
      exitTimestamp,
      direction: position.direction,
      entryPrice: adjustedEntry,
      exitPrice: adjustedExit,
      pnlPercent: computeFinalPnl(exitPnl),
      strategy: position.strategy,
    };
  }

  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;

    const barsHeld = i - position.entryIndex;

    // Check SL hit
    const slHit = position.direction === 'long'
      ? candle.low <= currentSL
      : candle.high >= currentSL;
    if (slHit) return buildResult(currentSL, candle.timestamp);

    // Check TP hit (remaining position hits full TP)
    const tpHit = position.direction === 'long'
      ? candle.high >= position.takeProfit
      : candle.low <= position.takeProfit;
    if (tpHit) return buildResult(position.takeProfit, candle.timestamp);

    // Check partial TP levels
    if (riskDistance > 0) {
      const unrealizedR = position.direction === 'long'
        ? (candle.close - position.entryPrice) / riskDistance
        : (position.entryPrice - candle.close) / riskDistance;

      for (let k = 0; k < multiConfig.levels.length; k++) {
        if (levelsTaken[k]) continue;
        const level = multiConfig.levels[k]!;

        if (unrealizedR >= level.triggerR) {
          levelsTaken[k] = true;
          const partialExit = applyExitFriction(candle.close, position.direction);
          levelPnls[k] = calculatePnlPercent(adjustedEntry, partialExit, position.direction);
          totalFractionTaken += level.fraction;

          // Move SL to level.slMoveR * riskDistance above entry
          if (level.slMoveR >= 0) {
            const newSLOffset = riskDistance * level.slMoveR;
            if (position.direction === 'long') {
              currentSL = Math.max(currentSL, position.entryPrice + newSLOffset);
            } else {
              currentSL = Math.min(currentSL, position.entryPrice - newSLOffset);
            }
          }
        }
      }

      // Trailing stop after all partials taken
      if (trailDistR > 0 && totalFractionTaken > 0) {
        const allTaken = levelsTaken.every(Boolean);
        if (allTaken && unrealizedR >= trailActivR) {
          trailActive = true;
        }

        if (trailActive) {
          const trailDistance = riskDistance * trailDistR;
          if (position.direction === 'long') {
            const trailStop = candle.close - trailDistance;
            if (trailStop > currentSL) currentSL = trailStop;
          } else {
            const trailStop = candle.close + trailDistance;
            if (trailStop < currentSL) currentSL = trailStop;
          }
        }
      }
    }

    // Max bars
    if (barsHeld >= MAX_POSITION_BARS) {
      return buildResult(candle.close, candle.timestamp);
    }
  }

  // Close at end
  const lastCandle = candles[candles.length - 1];
  if (!lastCandle) return null;
  return buildResult(lastCandle.close, lastCandle.timestamp);
}

/**
 * ENHANCED MODE: Strategy-specific exit logic + dynamic position management.
 *
 * On each bar while holding a position:
 * 1. Check SL/TP hit (hard exit)
 * 2. Build ICT context
 * 3. Run strategy's detectExit() for structure-based exits
 * 4. Apply break-even stop movement at 1R profit
 * 5. Apply trailing stop at 1.5R profit
 * 6. Check max bars
 */
function simulatePositionEnhanced(
  position: SimulatedPosition,
  candles: Candle[],
  startIndex: number,
  scorer: ConfluenceScorer,
): TradeResult | null {
  const adjustedEntry = applyEntryFriction(position.entryPrice, position.direction);
  const strategyManager = scorer.getStrategyManager();
  const strategy = strategyManager.getStrategy(position.strategy as StrategyName);

  // Dynamic stop/TP tracking
  let currentSL = position.stopLoss;
  let currentTP = position.takeProfit;
  let breakEvenTriggered = false;
  let trailingTriggered = false;

  // Calculate initial risk (1R)
  const riskDistance = position.direction === 'long'
    ? position.entryPrice - position.stopLoss
    : position.stopLoss - position.entryPrice;

  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;

    const barsHeld = i - position.entryIndex;

    // 1. Check hard SL/TP hit with current (possibly adjusted) levels
    if (position.direction === 'long') {
      if (candle.low <= currentSL) {
        const adjustedExit = applyExitFriction(currentSL, position.direction);
        return {
          entryTimestamp: position.entryTimestamp,
          exitTimestamp: candle.timestamp,
          direction: position.direction,
          entryPrice: adjustedEntry,
          exitPrice: adjustedExit,
          pnlPercent: calculatePnlPercent(adjustedEntry, adjustedExit, position.direction),
          strategy: position.strategy,
        };
      }
      if (candle.high >= currentTP) {
        const adjustedExit = applyExitFriction(currentTP, position.direction);
        return {
          entryTimestamp: position.entryTimestamp,
          exitTimestamp: candle.timestamp,
          direction: position.direction,
          entryPrice: adjustedEntry,
          exitPrice: adjustedExit,
          pnlPercent: calculatePnlPercent(adjustedEntry, adjustedExit, position.direction),
          strategy: position.strategy,
        };
      }
    } else {
      if (candle.high >= currentSL) {
        const adjustedExit = applyExitFriction(currentSL, position.direction);
        return {
          entryTimestamp: position.entryTimestamp,
          exitTimestamp: candle.timestamp,
          direction: position.direction,
          entryPrice: adjustedEntry,
          exitPrice: adjustedExit,
          pnlPercent: calculatePnlPercent(adjustedEntry, adjustedExit, position.direction),
          strategy: position.strategy,
        };
      }
      if (candle.low <= currentTP) {
        const adjustedExit = applyExitFriction(currentTP, position.direction);
        return {
          entryTimestamp: position.entryTimestamp,
          exitTimestamp: candle.timestamp,
          direction: position.direction,
          entryPrice: adjustedEntry,
          exitPrice: adjustedExit,
          pnlPercent: calculatePnlPercent(adjustedEntry, adjustedExit, position.direction),
          strategy: position.strategy,
        };
      }
    }

    // 2. Build ICT context for strategy exit check
    const ctx = scorer.buildContextAt(candles, i);

    // 3. Strategy-specific exit logic
    const hybridPos: HybridPosition = {
      side: position.direction === 'long' ? 'long' : 'short',
      entryPrice: position.entryPrice,
      entryIndex: position.entryIndex,
      size: 1,
      unrealizedPnL: position.direction === 'long'
        ? (candle.close - position.entryPrice) / position.entryPrice
        : (position.entryPrice - candle.close) / position.entryPrice,
      stopLoss: currentSL,
      takeProfit: currentTP,
      confluenceLevel: 'B',
      entryATR: riskDistance,
      peakPnL: 0,
      barsHeld,
      partialExitTaken: false,
      stopTightened: breakEvenTriggered,
      trailingLevel: trailingTriggered ? 3 : breakEvenTriggered ? 1 : 0,
    };

    const exitSignal: StrategyExitSignal = strategy.detectExit(
      hybridPos,
      candles.slice(Math.max(0, i - 100), i + 1),
      Math.min(100, i),
      ctx,
    );

    // Strategy-specific exits are net negative: they chop us out of winning trades.
    // Only exit on CHoCH counter-signals (confidence 0.85+), which indicate actual reversal.
    if (exitSignal.shouldExit && exitSignal.confidence >= 0.85) {
      const adjustedExit = applyExitFriction(candle.close, position.direction);
      return {
        entryTimestamp: position.entryTimestamp,
        exitTimestamp: candle.timestamp,
        direction: position.direction,
        entryPrice: adjustedEntry,
        exitPrice: adjustedExit,
        pnlPercent: calculatePnlPercent(adjustedEntry, adjustedExit, position.direction),
        strategy: position.strategy,
      };
    }

    // 4. Dynamic stop management
    const unrealizedR = riskDistance > 0
      ? (position.direction === 'long'
        ? (candle.close - position.entryPrice) / riskDistance
        : (position.entryPrice - candle.close) / riskDistance)
      : 0;

    // Break-even at 1R
    if (!breakEvenTriggered && unrealizedR >= 1.0) {
      breakEvenTriggered = true;
      const buffer = ctx.atr * 0.1;
      if (position.direction === 'long') {
        currentSL = Math.max(currentSL, position.entryPrice + buffer);
      } else {
        currentSL = Math.min(currentSL, position.entryPrice - buffer);
      }
    }

    // Trailing stop at 1.5R
    if (!trailingTriggered && unrealizedR >= 1.5) {
      trailingTriggered = true;
    }

    if (trailingTriggered) {
      const trailDistance = ctx.atr * 1.5;
      if (position.direction === 'long') {
        const trailStop = candle.close - trailDistance;
        if (trailStop > currentSL) {
          currentSL = trailStop;
        }
      } else {
        const trailStop = candle.close + trailDistance;
        if (trailStop < currentSL) {
          currentSL = trailStop;
        }
      }
    }

    // 5. Max bars
    if (barsHeld >= MAX_POSITION_BARS) {
      const adjustedExit = applyExitFriction(candle.close, position.direction);
      return {
        entryTimestamp: position.entryTimestamp,
        exitTimestamp: candle.timestamp,
        direction: position.direction,
        entryPrice: adjustedEntry,
        exitPrice: adjustedExit,
        pnlPercent: calculatePnlPercent(adjustedEntry, adjustedExit, position.direction),
        strategy: position.strategy,
      };
    }
  }

  return closeAtEnd(position, candles, adjustedEntry);
}

// ============================================
// Confluence Strategy Runner
// ============================================

/**
 * Create a WalkForwardStrategyRunner backed by the ConfluenceScorer.
 *
 * The runner receives trainCandles (for warm-up) and valCandles (for evaluation).
 * It concatenates them so the scorer has full lookback, but only counts trades
 * whose entry occurs during the validation window.
 */
function createConfluenceRunner(
  threshold: number,
  exitMode: ExitMode,
  scorerConfig?: Partial<ConfluenceConfig>,
  circuitBreaker?: CircuitBreakerConfig,
  partialTP?: PartialTPConfig,
  regimeSLMultipliers?: Record<string, number>,
  riskConfig?: RiskConfig,
  multiTP?: MultiTPConfig,
  futuresDataMap?: Map<string, { timestamp: number; fundingRate: number }[]>,
): {
  runner: WalkForwardStrategyRunner;
  allTrades: TradeResult[];
  signalCounts: Map<string, number>;
  tradeRegimes: Map<number, string>;
  circuitBreakerFirings: number;
} {
  const allTrades: TradeResult[] = [];
  const signalCounts = new Map<string, number>();
  /** Maps trade entry timestamp to regime label */
  const tradeRegimes = new Map<number, string>();
  let circuitBreakerFirings = 0;

  const modeName = exitMode;
  const cbLabel = circuitBreaker ? `,cb=${circuitBreaker.maxConsecutiveLosses}/${circuitBreaker.cooldownBars}` : '';
  const partialLabel = partialTP ? `,partial=${partialTP.fraction}@${partialTP.triggerR}R` : '';
  const runner: WalkForwardStrategyRunner = {
    name: `ConfluenceScorer(threshold=${threshold},exits=${modeName}${cbLabel}${partialLabel})`,

    async run(
      trainCandles: Candle[],
      valCandles: Candle[],
      meta?: { symbol?: string },
    ): Promise<TradeResult[]> {
      const scorer = new ConfluenceScorer({
        minThreshold: threshold,
        ...scorerConfig,
      });

      // Inject futures data for funding rate filtering
      if (futuresDataMap && meta?.symbol) {
        const snapshots = futuresDataMap.get(meta.symbol);
        if (snapshots) {
          scorer.setFuturesData(snapshots);
        }
      }

      // Concatenate for full lookback -- scorer needs historical context
      const allCandles = [...trainCandles, ...valCandles];
      const valStartIndex = trainCandles.length;

      const windowTrades: TradeResult[] = [];
      let currentPosition: SimulatedPosition | null = null;
      let positionExitIndex = -1;

      // Circuit breaker state (reset per window)
      let consecutiveLosses = 0;
      let cbActiveUntilBar = -1;

      // Risk management state (reset per window)
      let cumulativeWindowPnl = 0;
      let winStreak = 0;
      let lossStreak = 0;
      let windowDDTriggered = false;

      // Iterate through validation period only
      for (let i = valStartIndex; i < allCandles.length; i++) {
        const candle = allCandles[i];
        if (!candle) continue;

        // If we have an active position, skip until it closes
        if (currentPosition !== null && i <= positionExitIndex) {
          continue;
        }
        currentPosition = null;

        // Circuit breaker: skip entry if breaker is active
        if (circuitBreaker && i < cbActiveUntilBar) {
          continue;
        }

        // Window DD limit: stop trading after cumulative loss exceeds threshold
        if (riskConfig?.maxWindowDD !== undefined && windowDDTriggered) {
          continue;
        }

        // Evaluate confluence at this bar
        const result: ConfluenceScorerResult = scorer.evaluate(allCandles, i);

        // Track all signals for diagnostics
        for (const scored of result.allScored) {
          const strategy = scored.signal.strategy;
          const prev = signalCounts.get(strategy) ?? 0;
          signalCounts.set(strategy, prev + 1);
        }

        // If a trade signal is selected, simulate the position
        if (result.action === 'trade' && result.selectedSignal !== null) {
          const signal = result.selectedSignal.signal;

          // Apply per-regime SL/TP multiplier if configured
          let adjustedSL = signal.stopLoss;
          let adjustedTP = signal.takeProfit;
          if (regimeSLMultipliers && Object.keys(regimeSLMultipliers).length > 0) {
            const regime = detectRegime(allCandles, i);
            const label = regimeLabel(regime);
            const mult = regimeSLMultipliers[label];
            if (mult !== undefined && mult !== 1.0) {
              const slDist = Math.abs(signal.entryPrice - signal.stopLoss);
              const tpDist = Math.abs(signal.takeProfit - signal.entryPrice);
              if (signal.direction === 'long') {
                adjustedSL = signal.entryPrice - slDist * mult;
                adjustedTP = signal.entryPrice + tpDist * mult;
              } else {
                adjustedSL = signal.entryPrice + slDist * mult;
                adjustedTP = signal.entryPrice - tpDist * mult;
              }
            }
          }

          const position: SimulatedPosition = {
            entryPrice: signal.entryPrice,
            stopLoss: adjustedSL,
            takeProfit: adjustedTP,
            direction: signal.direction,
            entryIndex: i,
            entryTimestamp: candle.timestamp,
            strategy: signal.strategy,
          };

          // Simulate the trade from the next bar forward
          let trade: TradeResult | null;
          switch (exitMode) {
            case 'enhanced':
              trade = simulatePositionEnhanced(position, allCandles, i + 1, scorer);
              break;
            case 'breakeven':
              trade = simulatePositionBreakeven(position, allCandles, i + 1);
              break;
            case 'simple':
            default:
              if (multiTP) {
                trade = simulatePositionMultiTP(position, allCandles, i + 1, multiTP);
              } else if (partialTP) {
                trade = simulatePositionPartialTP(position, allCandles, i + 1, partialTP);
              } else {
                trade = simulatePositionSimple(position, allCandles, i + 1);
              }
              break;
          }

          if (trade) {
            // Apply risk management adjustments to PnL
            let adjustedPnl = trade.pnlPercent;

            // Vol-sizing: scale PnL by inverse ATR percentile
            if (riskConfig?.volSizing) {
              const regime = detectRegime(allCandles, i);
              // atrPercentile near 1.0 → smaller position, near 0.0 → larger
              // Scale factor = 1 / atrPercentile, capped at [0.5, 2.0]
              const pctile = Math.max(0.1, regime.atrPercentile);
              const volScale = Math.min(2.0, Math.max(0.5, 1.0 / pctile));
              // Normalize so median vol (0.5 pctile) = 1.0×
              const normalizedScale = volScale / 2.0; // 1/0.5 = 2.0, /2 = 1.0 at median
              adjustedPnl = trade.pnlPercent * normalizedScale;
            }

            // Streak-aware sizing
            if (riskConfig?.streakSizing) {
              const ss = riskConfig.streakSizing;
              if (winStreak >= ss.streakLength) {
                adjustedPnl = adjustedPnl * ss.winMultiplier;
              } else if (lossStreak >= ss.streakLength) {
                adjustedPnl = adjustedPnl * ss.lossMultiplier;
              }
            }

            // Create adjusted trade
            const adjustedTrade: TradeResult = { ...trade, pnlPercent: adjustedPnl };
            windowTrades.push(adjustedTrade);
            allTrades.push(adjustedTrade);

            // Update streak tracking
            if (trade.pnlPercent > 0) {
              winStreak++;
              lossStreak = 0;
            } else {
              lossStreak++;
              winStreak = 0;
            }

            // Update window cumulative PnL and check DD limit
            cumulativeWindowPnl += adjustedPnl;
            if (riskConfig?.maxWindowDD !== undefined && cumulativeWindowPnl < riskConfig.maxWindowDD) {
              windowDDTriggered = true;
            }

            // Tag trade with regime at entry point
            const tradeRegime = detectRegime(allCandles, i);
            tradeRegimes.set(adjustedTrade.entryTimestamp, regimeLabel(tradeRegime));

            // Circuit breaker: track consecutive losses
            if (circuitBreaker) {
              if (adjustedTrade.pnlPercent < 0) {
                consecutiveLosses++;
                if (consecutiveLosses >= circuitBreaker.maxConsecutiveLosses) {
                  // Find the exit bar index for cooldown calculation
                  let exitBar = i + 1;
                  for (let j = i + 1; j < allCandles.length; j++) {
                    const c = allCandles[j];
                    if (c && c.timestamp >= adjustedTrade.exitTimestamp) {
                      exitBar = j;
                      break;
                    }
                  }
                  cbActiveUntilBar = exitBar + circuitBreaker.cooldownBars;
                  circuitBreakerFirings++;
                }
              } else {
                consecutiveLosses = 0;
              }
            }

            // Figure out the exit index so we skip bars while in position
            let exitIdx = i + 1;
            for (let j = i + 1; j < allCandles.length; j++) {
              const c = allCandles[j];
              if (c && c.timestamp >= adjustedTrade.exitTimestamp) {
                exitIdx = j;
                break;
              }
            }
            currentPosition = position;
            positionExitIndex = exitIdx;
          }
        }
      }

      return windowTrades;
    },
  };

  return { runner, allTrades, signalCounts, tradeRegimes, circuitBreakerFirings };
}

// ============================================
// Strategy Breakdown Analysis
// ============================================

function computeStrategyBreakdown(
  trades: TradeResult[],
  signalCounts: Map<string, number>,
): StrategyStats[] {
  const strategyNames = [
    'order_block',
    'fvg',
    'bos_continuation',
    'choch_reversal',
  ];

  const stats: StrategyStats[] = [];

  for (const strategyName of strategyNames) {
    const strategyTrades = trades.filter((t) => t.strategy === strategyName);
    const wins = strategyTrades.filter((t) => t.pnlPercent > 0);
    const losses = strategyTrades.filter((t) => t.pnlPercent <= 0);

    const totalPnl =
      strategyTrades.length > 0
        ? strategyTrades.reduce((sum, t) => sum + t.pnlPercent, 0)
        : 0;

    const avgPnl =
      strategyTrades.length > 0 ? totalPnl / strategyTrades.length : 0;

    // Average risk:reward from actual trades
    const avgRR =
      wins.length > 0
        ? wins.reduce((sum, t) => {
            const absGain = Math.abs(t.pnlPercent);
            // Approximate R:R from the realized trade
            return sum + absGain;
          }, 0) / wins.length
        : 0;

    stats.push({
      strategy: strategyName,
      totalSignals: signalCounts.get(strategyName) ?? 0,
      trades: strategyTrades.length,
      wins: wins.length,
      losses: losses.length,
      winRate:
        strategyTrades.length > 0
          ? (wins.length / strategyTrades.length) * 100
          : 0,
      avgPnl,
      avgRR,
      totalPnl,
    });
  }

  return stats;
}

// ============================================
// Per-Regime Breakdown
// ============================================

function computeRegimeBreakdown(
  trades: TradeResult[],
  tradeRegimes: Map<number, string>,
): RegimeBreakdownEntry[] {
  const buckets = new Map<string, TradeResult[]>();

  for (const trade of trades) {
    const label = tradeRegimes.get(trade.entryTimestamp) ?? 'unknown';
    const existing = buckets.get(label) ?? [];
    existing.push(trade);
    buckets.set(label, existing);
  }

  const entries: RegimeBreakdownEntry[] = [];

  for (const [label, regimeTrades] of buckets.entries()) {
    const wins = regimeTrades.filter((t) => t.pnlPercent > 0);
    const totalPnl = regimeTrades.reduce((sum, t) => sum + t.pnlPercent, 0);
    const avgPnl = regimeTrades.length > 0 ? totalPnl / regimeTrades.length : 0;

    entries.push({
      regimeLabel: label,
      trades: regimeTrades.length,
      wins: wins.length,
      winRate: regimeTrades.length > 0 ? (wins.length / regimeTrades.length) * 100 : 0,
      avgPnl,
      totalPnl,
    });
  }

  entries.sort((a, b) => b.trades - a.trades);
  return entries;
}

function printRegimeBreakdown(breakdown: RegimeBreakdownEntry[]): void {
  if (jsonOutputMode) return;

  log('');
  log('============================================================');
  log('PER-REGIME BREAKDOWN');
  log('============================================================');
  log('');
  log(
    '| Regime           | Trades | Wins | Win Rate | Avg PnL  | Total PnL |',
  );
  log(
    '|------------------|--------|------|----------|----------|-----------|',
  );

  for (const r of breakdown) {
    log(
      `| ${r.regimeLabel.padEnd(16)} ` +
        `| ${r.trades.toString().padStart(6)} ` +
        `| ${r.wins.toString().padStart(4)} ` +
        `| ${r.winRate.toFixed(1).padStart(7)}% ` +
        `| ${(r.avgPnl * 100).toFixed(2).padStart(7)}% ` +
        `| ${(r.totalPnl * 100).toFixed(2).padStart(8)}% |`,
    );
  }

  log('');
}

// ============================================
// Experiment Document Generation
// ============================================

function loadExp014Results(): WalkForwardResult | null {
  const resultsPath = path.resolve(EXP_014_RESULTS_PATH);
  if (!fs.existsSync(resultsPath)) return null;

  try {
    const raw = fs.readFileSync(resultsPath, 'utf-8');
    return JSON.parse(raw) as WalkForwardResult;
  } catch {
    return null;
  }
}

function generateComparisonTable(
  confluenceResult: WalkForwardResult,
  rlResult: WalkForwardResult | null,
): string {
  if (!rlResult) {
    return '_No exp-014 RL results found for comparison. Run walk-forward-validate.ts with the RL model first._\n';
  }

  let table =
    '| Metric | Confluence Scorer | RL Meta-Agent (exp-014) |\n';
  table +=
    '|--------|-------------------|-------------------------|\n';

  // Overall pass rate
  table += `| Overall Pass Rate | ${(confluenceResult.passRate * 100).toFixed(1)}% | ${(rlResult.passRate * 100).toFixed(1)}% |\n`;
  table += `| Overall Passed | ${confluenceResult.overallPassed ? 'YES' : 'NO'} | ${rlResult.overallPassed ? 'YES' : 'NO'} |\n`;

  // Per-symbol comparison
  for (const confSymbol of confluenceResult.symbols) {
    const rlSymbol = rlResult.symbols.find(
      (s) => s.symbol === confSymbol.symbol,
    );

    const rlAvgSharpe = rlSymbol ? rlSymbol.avgSharpe.toFixed(2) : 'N/A';
    const rlPositive = rlSymbol
      ? `${rlSymbol.positiveWindows}/${rlSymbol.totalWindows}`
      : 'N/A';
    const rlPassed = rlSymbol
      ? rlSymbol.passed
        ? 'PASS'
        : 'FAIL'
      : 'N/A';

    table += `| ${confSymbol.symbol} Avg Sharpe | ${confSymbol.avgSharpe.toFixed(2)} | ${rlAvgSharpe} |\n`;
    table += `| ${confSymbol.symbol} Positive Windows | ${confSymbol.positiveWindows}/${confSymbol.totalWindows} | ${rlPositive} |\n`;
    table += `| ${confSymbol.symbol} Status | ${confSymbol.passed ? 'PASS' : 'FAIL'} | ${rlPassed} |\n`;
  }

  return table;
}

function generateKeyLearnings(result: ConfluenceBacktestResult): string {
  const lines: string[] = [];

  // Trade volume analysis
  if (result.totalTrades === 0) {
    lines.push(
      '- **Zero trades generated.** The threshold may be too high, or strategy signals are too rare. Consider lowering the threshold or loosening strategy entry conditions.',
    );
    return lines.join('\n');
  }

  if (result.totalTrades < 20) {
    lines.push(
      `- **Low trade count (${result.totalTrades}).** May not be statistically significant. Consider lowering threshold or expanding validation period.`,
    );
  }

  // Win rate analysis
  if (result.overallWinRate > 55) {
    lines.push(
      `- **Strong win rate (${result.overallWinRate.toFixed(1)}%).** The confluence filter is selecting high-quality setups.`,
    );
  } else if (result.overallWinRate > 45) {
    lines.push(
      `- **Moderate win rate (${result.overallWinRate.toFixed(1)}%).** Acceptable if average winners exceed average losers.`,
    );
  } else {
    lines.push(
      `- **Low win rate (${result.overallWinRate.toFixed(1)}%).** May need to increase threshold or add additional filters.`,
    );
  }

  // Strategy contribution analysis
  const sorted = [...result.strategyBreakdown].sort(
    (a, b) => b.trades - a.trades,
  );
  const topStrategy = sorted[0];
  if (topStrategy && topStrategy.trades > 0) {
    lines.push(
      `- **${topStrategy.strategy}** is the most active strategy (${topStrategy.trades} trades, ${topStrategy.winRate.toFixed(1)}% win rate).`,
    );
  }

  // Check for strategies with zero trades
  const deadStrategies = result.strategyBreakdown.filter(
    (s) => s.trades === 0,
  );
  if (deadStrategies.length > 0) {
    const names = deadStrategies.map((s) => s.strategy).join(', ');
    lines.push(
      `- **Dead strategies (0 trades):** ${names}. These may need looser entry conditions or the confluence threshold may be filtering them out.`,
    );
  }

  // Walk-forward robustness
  const { walkForwardResult } = result;
  const failedSymbols = walkForwardResult.symbols.filter((s) => !s.passed);
  if (failedSymbols.length === 0) {
    lines.push(
      '- **All symbols passed walk-forward gate.** The rule-based system shows robustness across time windows.',
    );
  } else {
    const names = failedSymbols.map((s) => s.symbol).join(', ');
    lines.push(
      `- **Failed symbols:** ${names}. The confluence scorer may need symbol-specific weight tuning.`,
    );
  }

  // Signal-to-trade conversion
  if (result.totalSignals > 0) {
    const conversionRate =
      (result.totalTrades / result.totalSignals) * 100;
    lines.push(
      `- **Signal-to-trade conversion:** ${conversionRate.toFixed(1)}% (${result.totalTrades} trades from ${result.totalSignals} signals above threshold).`,
    );
  }

  return lines.join('\n');
}

function generateExperimentDoc(result: ConfluenceBacktestResult): string {
  const { walkForwardResult, strategyBreakdown, threshold, symbols } = result;
  const rlResult = loadExp014Results();

  // Walk-forward summary table
  let wfTable =
    '| Symbol | Windows | Positive | Avg Sharpe | Worst Sharpe | Status |\n';
  wfTable +=
    '|--------|---------|----------|------------|--------------|--------|\n';

  for (const s of walkForwardResult.symbols) {
    const status = s.passed ? 'PASS' : 'FAIL';
    wfTable += `| ${s.symbol} | ${s.totalWindows} | ${s.positiveWindows}/${s.totalWindows} | ${s.avgSharpe.toFixed(2)} | ${s.worstWindowSharpe.toFixed(2)} | ${status} |\n`;
  }

  // Per-strategy breakdown table
  let stratTable =
    '| Strategy | Signals | Trades | Wins | Losses | Win Rate | Avg PnL | Total PnL |\n';
  stratTable +=
    '|----------|---------|--------|------|--------|----------|---------|-----------|\n';

  for (const s of strategyBreakdown) {
    stratTable += `| ${s.strategy} | ${s.totalSignals} | ${s.trades} | ${s.wins} | ${s.losses} | ${s.winRate.toFixed(1)}% | ${(s.avgPnl * 100).toFixed(2)}% | ${(s.totalPnl * 100).toFixed(2)}% |\n`;
  }

  // Comparison table
  const comparisonTable = generateComparisonTable(walkForwardResult, rlResult);

  // Key learnings
  const learnings = generateKeyLearnings(result);

  // Decision logic
  let decision: string;
  if (walkForwardResult.overallPassed) {
    decision = 'Continue -- proceed to Iteration 3 (Threshold & Weight Calibration)';
  } else if (walkForwardResult.passRate > 0.5) {
    decision =
      'Adjust -- the system shows promise but needs threshold/weight tuning before proceeding';
  } else {
    decision =
      'Pivot -- fundamental approach may need rethinking. Consider different confluence factors or entry logic.';
  }

  const doc = `# Iteration 2: Rule-Based Confluence Scorer

## Hypothesis
A weighted scoring system selecting strategies based on ICT confluence factors will be more robust than the RL meta-agent because it cannot overfit.

## Implementation Summary
- Confluence Scorer with 10 factors, threshold=${threshold}
- Walk-forward validation: ${walkForwardResult.symbols[0]?.totalWindows ?? 0} windows per symbol
- Symbols: ${symbols.join(', ')}
- Commission: ${(DEFAULT_COMMISSION * 100).toFixed(1)}% per side
- Slippage: ${(DEFAULT_SLIPPAGE * 100).toFixed(2)}% per side
- Max position hold: ${MAX_POSITION_BARS} bars

### Confluence Weights
| Factor | Weight |
|--------|--------|
| Structure Alignment | ${DEFAULT_WEIGHTS.structureAlignment} |
| Kill Zone Active | ${DEFAULT_WEIGHTS.killZoneActive} |
| Liquidity Sweep | ${DEFAULT_WEIGHTS.liquiditySweep} |
| OB Proximity | ${DEFAULT_WEIGHTS.obProximity} |
| FVG at CE | ${DEFAULT_WEIGHTS.fvgAtCE} |
| Recent BOS | ${DEFAULT_WEIGHTS.recentBOS} |
| R:R Ratio | ${DEFAULT_WEIGHTS.rrRatio} |
| OTE Zone | ${DEFAULT_WEIGHTS.oteZone} |
| Breaker Confluence | ${DEFAULT_WEIGHTS.breakerConfluence} |
| OB+FVG Confluence | ${DEFAULT_WEIGHTS.obFvgConfluence} |

**Max possible score:** ${Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0).toFixed(1)}
**Threshold:** ${threshold}

## Results

### Walk-Forward Summary
${wfTable}

**Overall pass rate:** ${(walkForwardResult.passRate * 100).toFixed(1)}%
**Overall verdict:** ${walkForwardResult.overallPassed ? 'PASSED' : 'FAILED'}

### Per-Strategy Breakdown
${stratTable}

**Total trades:** ${result.totalTrades}
**Overall win rate:** ${result.overallWinRate.toFixed(1)}%
**Overall PnL:** ${(result.overallPnl * 100).toFixed(2)}%

### Comparison to RL (exp-014)
${comparisonTable}

## Key Learnings
${learnings}

## Decision: ${decision}

## Impact on Next Iteration
${walkForwardResult.overallPassed
    ? 'The confluence scorer provides a stable baseline. Iteration 3 should focus on calibrating weights and threshold via grid search to maximize Sharpe while maintaining walk-forward robustness.'
    : 'The scorer needs adjustment before proceeding. Focus areas:\n1. Analyze which factors contribute most to winning trades\n2. Consider lowering threshold to increase trade count\n3. Review strategy entry conditions for each failing symbol'}

---
_Generated: ${new Date().toISOString()}_
_Script: scripts/backtest-confluence.ts_
`;

  return doc;
}

// ============================================
// Console Output
// ============================================

let jsonOutputMode = false;

function log(message: string): void {
  if (!jsonOutputMode) {
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
  }
}

function printStrategyBreakdown(breakdown: StrategyStats[]): void {
  if (jsonOutputMode) return;

  log('');
  log('============================================================');
  log('PER-STRATEGY BREAKDOWN');
  log('============================================================');
  log('');
  log(
    '| Strategy          | Signals | Trades | Wins | Losses | Win Rate | Avg PnL  | Total PnL |',
  );
  log(
    '|-------------------|---------|--------|------|--------|----------|----------|-----------|',
  );

  for (const s of breakdown) {
    log(
      `| ${s.strategy.padEnd(17)} ` +
        `| ${s.totalSignals.toString().padStart(7)} ` +
        `| ${s.trades.toString().padStart(6)} ` +
        `| ${s.wins.toString().padStart(4)} ` +
        `| ${s.losses.toString().padStart(6)} ` +
        `| ${s.winRate.toFixed(1).padStart(7)}% ` +
        `| ${(s.avgPnl * 100).toFixed(2).padStart(7)}% ` +
        `| ${(s.totalPnl * 100).toFixed(2).padStart(8)}% |`,
    );
  }

  log('');
}

function printOverallSummary(result: ConfluenceBacktestResult): void {
  if (jsonOutputMode) return;

  log('============================================================');
  log('CONFLUENCE SCORER SUMMARY');
  log('============================================================');
  log('');
  log(`Threshold:         ${result.threshold}`);
  log(`Total signals:     ${result.totalSignals}`);
  log(`Total trades:      ${result.totalTrades}`);
  log(`Overall win rate:  ${result.overallWinRate.toFixed(1)}%`);
  log(`Overall PnL:       ${(result.overallPnl * 100).toFixed(2)}%`);
  log(
    `WF pass rate:      ${(result.walkForwardResult.passRate * 100).toFixed(1)}%`,
  );
  log(
    `WF verdict:        ${result.walkForwardResult.overallPassed ? '\x1b[32mPASSED\x1b[0m' : '\x1b[31mFAILED\x1b[0m'}`,
  );
}

// ============================================
// CLI Argument Parsing
// ============================================

function getArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

// ============================================
// Strategy Shorthand Parser
// ============================================

/** Map CLI shorthand to StrategyName: ob -> order_block, fvg -> fvg */
const STRATEGY_SHORTHAND: Record<string, StrategyName> = {
  ob: 'order_block',
  order_block: 'order_block',
  fvg: 'fvg',
  bos: 'bos_continuation',
  bos_continuation: 'bos_continuation',
  choch: 'choch_reversal',
  choch_reversal: 'choch_reversal',
};

function parseStrategyArg(arg: string): StrategyName[] {
  return arg.split(',').map((s) => {
    const key = s.trim().toLowerCase();
    const mapped = STRATEGY_SHORTHAND[key];
    if (!mapped) {
      throw new Error(`Unknown strategy shorthand: "${key}". Valid: ${Object.keys(STRATEGY_SHORTHAND).join(', ')}`);
    }
    return mapped;
  });
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
  const thresholdArg = getArg('threshold');
  const symbolsArg = getArg('symbols');
  const minRRArg = getArg('min-rr');
  const strategyArg = getArg('strategy');
  const shouldSave = hasFlag('save');
  jsonOutputMode = hasFlag('json');
  const useSimple = hasFlag('simple');       // --simple to disable enhanced exits
  const killZone = hasFlag('kill-zone');     // --kill-zone to require kill zones
  const useProduction = hasFlag('production'); // --production for tighter strategy configs
  const useRegime = hasFlag('regime');       // --regime to enable regime filtering
  const minEffArg = getArg('min-efficiency');
  const minTrendArg = getArg('min-trend-strength');
  const suppressRegimeArg = getArg('suppress-regime'); // --suppress-regime ranging+normal,ranging+low
  const useMTF = hasFlag('mtf');            // --mtf to enable multi-timeframe bias
  const frictionArg = getArg('friction');   // --friction 0.0007 for maker mode
  const slModeArg = getArg('sl-mode');     // --sl-mode entry_based|dynamic_rr|ob_based
  const timeframeArg = getArg('timeframe'); // --timeframe 15m|1h (default: 1h)
  const cbArg = getArg('circuit-breaker'); // --circuit-breaker "3,50" (maxLosses,cooldownBars)
  const exitModeArg = getArg('exit-mode'); // --exit-mode simple|breakeven|trailing|enhanced
  const partialTpArg = getArg('partial-tp'); // --partial-tp "0.5,1.0" (fraction,triggerR)
  const maxBarsArg = getArg('max-bars'); // --max-bars 60
  const obHalfLifeArg = getArg('ob-half-life'); // --ob-half-life 15
  const atrExtArg = getArg('atr-extension'); // --atr-extension 2.0
  const obVolWeightArg = getArg('ob-volume-weight'); // --ob-volume-weight 1.0
  const obMinMoveArg = getArg('ob-min-move'); // --ob-min-move 1.5 (percent)
  const regimeThresholdArg = getArg('regime-threshold'); // --regime-threshold "uptrend+high:3.5,uptrend+normal:5.0"
  const regimeSLMultArg = getArg('regime-sl-mult'); // --regime-sl-mult "uptrend+high:1.3,ranging+low:0.8"
  const regimeConfGateArg = getArg('regime-conf-gate'); // --regime-conf-gate 0.3
  const volSizing = hasFlag('vol-sizing'); // --vol-sizing
  const maxWindowDDArg = getArg('max-window-dd'); // --max-window-dd -0.05
  const streakArg = getArg('streak'); // --streak "2,1.5,0.5" (streakLen,winMult,lossMult)
  const structureAgeArg = getArg('structure-age'); // --structure-age 80
  const bosLookbackArg = getArg('bos-lookback'); // --bos-lookback 25
  const momentumBarsArg = getArg('momentum-bars'); // --momentum-bars 2
  const cooldownBarsArg = getArg('cooldown-bars'); // --cooldown-bars 4
  const weightsArg = getArg('weights'); // --weights "structureAlignment:2.5,liquiditySweep:1.5,rrRatio:2.0"
  const reactionBodyArg = getArg('reaction-body'); // --reaction-body 0.3 (min body % for OB reaction)
  const multiTpArg = getArg('multi-tp'); // --multi-tp "0.45@0.85>0.1,0.25@1.5>0.5" (fraction@triggerR>slMoveR)
  const trailArg = getArg('trail-after-partial'); // --trail-after-partial "0.8,1.5" (distanceR,activationR)
  const trainBarsArg = getArg('train-bars'); // --train-bars 2880 (4 months instead of 3)
  const valBarsArg = getArg('val-bars'); // --val-bars 1440 (2 months instead of 1)
  const slideBarsArg = getArg('slide-bars'); // --slide-bars 360 (half-month slide)
  const withOrderflow = hasFlag('with-orderflow'); // --with-orderflow to load futures data
  const fundingMaxLongArg = getArg('funding-max-long'); // --funding-max-long 0.0002
  const fundingMinShortArg = getArg('funding-min-short'); // --funding-min-short 0
  const fundingScoringArg = getArg('funding-scoring'); // --funding-scoring contrarian|aligned

  // Resolve exit mode (--exit-mode overrides --simple for backward compat)
  let exitMode: ExitMode = 'enhanced';
  if (exitModeArg) {
    if (!['simple', 'breakeven', 'trailing', 'enhanced'].includes(exitModeArg)) {
      console.error('Error: --exit-mode must be one of: simple, breakeven, trailing, enhanced');
      process.exit(1);
    }
    exitMode = exitModeArg as ExitMode;
  } else if (useSimple) {
    exitMode = 'simple';
  }

  // Parse partial TP config
  let partialTP: PartialTPConfig | undefined;
  if (partialTpArg) {
    const parts = partialTpArg.split(',');
    if (parts.length < 2 || parts.length > 3) {
      console.error('Error: --partial-tp format: "fraction,triggerR[,beBuffer]" e.g., "0.5,1.0" or "0.5,1.0,-1"');
      process.exit(1);
    }
    const fraction = parseFloat(parts[0]!);
    const triggerR = parseFloat(parts[1]!);
    const beBuffer = parts.length === 3 ? parseFloat(parts[2]!) : 0.1;
    if (Number.isNaN(fraction) || Number.isNaN(triggerR) || fraction <= 0 || fraction >= 1 || triggerR <= 0) {
      console.error('Error: --partial-tp fraction must be (0,1) and triggerR must be > 0');
      process.exit(1);
    }
    partialTP = { fraction, triggerR, beBuffer };
  }

  // Parse multi-level TP config
  let multiTP: MultiTPConfig | undefined;
  if (multiTpArg) {
    const levels: TPLevel[] = [];
    for (const levelStr of multiTpArg.split(',')) {
      // Format: fraction@triggerR>slMoveR e.g. "0.45@0.85>0.1"
      const match = levelStr.trim().match(/^([\d.]+)@([\d.]+)>([-\d.]+)$/);
      if (!match) {
        console.error(`Error: Invalid multi-tp level format "${levelStr}". Use "fraction@triggerR>slMoveR"`);
        process.exit(1);
      }
      levels.push({
        fraction: parseFloat(match[1]!),
        triggerR: parseFloat(match[2]!),
        slMoveR: parseFloat(match[3]!),
      });
    }
    // Validate total fraction <= 1
    const totalFrac = levels.reduce((sum, l) => sum + l.fraction, 0);
    if (totalFrac > 1.0) {
      console.error(`Error: Multi-tp fractions sum to ${totalFrac}, must be <= 1.0`);
      process.exit(1);
    }
    multiTP = { levels };

    // Parse trailing stop if provided
    if (trailArg) {
      const trailParts = trailArg.split(',');
      if (trailParts.length !== 2) {
        console.error('Error: --trail-after-partial format: "distanceR,activationR" e.g., "0.8,1.5"');
        process.exit(1);
      }
      multiTP.trailDistanceR = parseFloat(trailParts[0]!);
      multiTP.trailActivationR = parseFloat(trailParts[1]!);
    }
  }

  // Parse max bars override
  if (maxBarsArg) {
    const parsed = parseInt(maxBarsArg, 10);
    if (Number.isNaN(parsed) || parsed < 10) {
      console.error('Error: --max-bars must be an integer >= 10');
      process.exit(1);
    }
    MAX_POSITION_BARS = parsed;
  }

  // Apply friction override
  if (frictionArg) {
    FRICTION_PER_SIDE = parseFloat(frictionArg);
    if (Number.isNaN(FRICTION_PER_SIDE) || FRICTION_PER_SIDE < 0) {
      console.error('Error: --friction must be a non-negative number (per-side fraction, e.g., 0.0007)');
      process.exit(1);
    }
  }

  // Parse SL placement mode
  const slPlacementMode: SLPlacementMode = (['ob_based', 'entry_based', 'dynamic_rr'] as const).includes(
    slModeArg as SLPlacementMode
  ) ? (slModeArg as SLPlacementMode) : 'ob_based';

  // Parse timeframe
  const timeframe = timeframeArg ?? '1h';

  const threshold = thresholdArg
    ? parseFloat(thresholdArg)
    : DEFAULT_CONFLUENCE_CONFIG.minThreshold;

  if (Number.isNaN(threshold)) {
    console.error('Error: --threshold must be a valid number');
    process.exit(1);
  }

  const minSignalRR = minRRArg ? parseFloat(minRRArg) : 1.5;

  const configOverrides: Partial<import('./walk-forward-validate').WalkForwardConfig> = {};
  if (symbolsArg) {
    configOverrides.symbols = symbolsArg.split(',').map((s) => s.trim());
  }
  if (timeframe !== '1h') {
    configOverrides.timeframe = timeframe;
    // Scale walk-forward windows for 15m (4× more bars per time period)
    if (timeframe === '15m') {
      configOverrides.trainWindowBars = 2160 * 4; // 8640 bars (~3 months at 15m)
      configOverrides.valWindowBars = 720 * 4;    // 2880 bars (~1 month at 15m)
      configOverrides.slideStepBars = 720 * 4;    // 2880 bars
    }
  }
  // Manual WF window overrides (applied after timeframe defaults)
  if (trainBarsArg) configOverrides.trainWindowBars = parseInt(trainBarsArg, 10);
  if (valBarsArg) configOverrides.valWindowBars = parseInt(valBarsArg, 10);
  if (slideBarsArg) configOverrides.slideStepBars = parseInt(slideBarsArg, 10);

  // Build regime filter if enabled
  let regimeFilter: RegimeFilterConfig | undefined;
  if (useRegime) {
    regimeFilter = {
      ...DEFAULT_REGIME_FILTER,
      enabled: true,
      minEfficiency: minEffArg ? parseFloat(minEffArg) : DEFAULT_REGIME_FILTER.minEfficiency,
      minTrendStrength: minTrendArg ? parseFloat(minTrendArg) : DEFAULT_REGIME_FILTER.minTrendStrength,
    };
  }

  // Parse active strategies
  const activeStrategies: StrategyName[] | undefined = strategyArg
    ? parseStrategyArg(strategyArg)
    : undefined;

  // Parse suppressed regimes
  const suppressedRegimes: string[] = suppressRegimeArg
    ? suppressRegimeArg.split(',').map((s) => s.trim())
    : [];

  // Build MTF bias config
  const mtfBias: MTFBiasConfig | undefined = useMTF
    ? { ...DEFAULT_MTF_BIAS, enabled: true }
    : undefined;

  // Parse circuit breaker config
  let circuitBreaker: CircuitBreakerConfig | undefined;
  if (cbArg) {
    const parts = cbArg.split(',');
    if (parts.length !== 2) {
      console.error('Error: --circuit-breaker format: "maxLosses,cooldownBars" e.g., "3,50"');
      process.exit(1);
    }
    const maxLosses = parseInt(parts[0]!, 10);
    const cooldown = parseInt(parts[1]!, 10);
    if (Number.isNaN(maxLosses) || Number.isNaN(cooldown) || maxLosses < 1 || cooldown < 1) {
      console.error('Error: --circuit-breaker values must be positive integers');
      process.exit(1);
    }
    circuitBreaker = { maxConsecutiveLosses: maxLosses, cooldownBars: cooldown };
  }

  // Parse regime threshold overrides
  const regimeThresholdOverrides: Record<string, number> = {};
  if (regimeThresholdArg) {
    for (const pair of regimeThresholdArg.split(',')) {
      const [regime, val] = pair.split(':');
      if (regime && val) {
        const parsed = parseFloat(val);
        if (!Number.isNaN(parsed)) {
          regimeThresholdOverrides[regime.trim()] = parsed;
        }
      }
    }
  }

  // Parse regime SL multipliers
  const regimeSLMultipliers: Record<string, number> = {};
  if (regimeSLMultArg) {
    for (const pair of regimeSLMultArg.split(',')) {
      const [regime, val] = pair.split(':');
      if (regime && val) {
        const parsed = parseFloat(val);
        if (!Number.isNaN(parsed) && parsed > 0) {
          regimeSLMultipliers[regime.trim()] = parsed;
        }
      }
    }
  }

  // Build strategy config with SL mode + timeframe scaling
  const is15m = timeframe === '15m';
  const baseStrategyConfig = is15m
    ? { ...FIFTEEN_MIN_STRATEGY_CONFIG }
    : (useProduction ? { ...PRODUCTION_STRATEGY_CONFIG } : {});
  const strategyConfig = {
    ...baseStrategyConfig,
    slPlacementMode,
    ...(reactionBodyArg ? { minReactionBodyPercent: parseFloat(reactionBodyArg) } : {}),
  };

  // Scorer configuration (apply 15m bar-scaling overrides when on 15m)
  const scorerConfig: Partial<ConfluenceConfig> = {
    minSignalRR,
    requireKillZone: killZone,
    strategyConfig,
    ...(is15m ? FIFTEEN_MIN_CONFLUENCE_OVERRIDES : {}),
    ...(regimeFilter ? { regimeFilter } : {}),
    ...(activeStrategies ? { activeStrategies } : {}),
    ...(suppressedRegimes.length > 0 ? { suppressedRegimes } : {}),
    ...(mtfBias ? { mtfBias } : {}),
    ...(obHalfLifeArg ? { obFreshnessHalfLife: parseFloat(obHalfLifeArg) } : {}),
    ...(atrExtArg ? { atrExtensionBands: parseFloat(atrExtArg) } : {}),
    ...((() => {
      const baseWeights = { ...DEFAULT_WEIGHTS };
      if (obVolWeightArg) baseWeights.obVolumeQuality = parseFloat(obVolWeightArg);
      if (weightsArg) {
        for (const pair of weightsArg.split(',')) {
          const [key, val] = pair.split(':');
          if (key && val && key.trim() in baseWeights) {
            (baseWeights as Record<string, number>)[key.trim()] = parseFloat(val);
          }
        }
      }
      if (obVolWeightArg || weightsArg) return { weights: baseWeights };
      return {};
    })()),
    ...(Object.keys(regimeThresholdOverrides).length > 0 ? { regimeThresholdOverrides } : {}),
    ...(regimeConfGateArg ? { regimeConfidenceGate: parseFloat(regimeConfGateArg) } : {}),
    ...(structureAgeArg ? { maxStructureAge: parseInt(structureAgeArg, 10) } : {}),
    ...(bosLookbackArg ? { bosLookback: parseInt(bosLookbackArg, 10) } : {}),
    ...(momentumBarsArg ? { momentumBars: parseInt(momentumBarsArg, 10) } : {}),
    ...(cooldownBarsArg ? { cooldownBars: parseInt(cooldownBarsArg, 10) } : {}),
    ...(fundingMaxLongArg ? { fundingMaxForLong: parseFloat(fundingMaxLongArg) } : {}),
    ...(fundingMinShortArg ? { fundingMinForShort: parseFloat(fundingMinShortArg) } : {}),
    ...(fundingScoringArg && ['contrarian', 'aligned'].includes(fundingScoringArg)
      ? { fundingScoringMode: fundingScoringArg as 'contrarian' | 'aligned' } : {}),
  };

  // MAX_POSITION_BARS scaling for 15m (module-level isn't const so can't reassign, but passed through config)
  // The MAX_POSITION_BARS = 100 constant is equivalent to ~100 hours at 1H or ~25 hours at 15m
  // For 15m, we'd want 400 bars to maintain the same ~100 hour window — but this is a module const
  // and the backtest already respects it as-is. Future: make configurable.

  if (!jsonOutputMode) {
    log('============================================================');
    log('BACKTEST: CONFLUENCE SCORER via WALK-FORWARD VALIDATION');
    log('============================================================');
    log('');
    log(`Threshold:     ${threshold}`);
    log(`Strategies:    ${activeStrategies ? activeStrategies.join(', ') : 'default (order_block, fvg)'}`);
    log(`Min Signal RR: ${minSignalRR}`);
    const exitLabel = multiTP
      ? `MULTI-TP [${multiTP.levels.map(l => `${(l.fraction*100).toFixed(0)}%@${l.triggerR}R→SL${l.slMoveR}R`).join(', ')}]${multiTP.trailDistanceR ? ` + trail ${multiTP.trailDistanceR}R@${multiTP.trailActivationR}R` : ''}`
      : partialTP ? ` + partial ${partialTP.fraction*100}%@${partialTP.triggerR}R` : '';
    log(`Exit mode:     ${exitMode.toUpperCase()}${exitLabel}`);
    log(`Strategy cfg:  ${useProduction ? 'PRODUCTION (tighter entries)' : 'DEFAULT (RL-loosened)'}`);
    log(`Kill zone:     ${killZone ? 'REQUIRED' : useProduction ? 'via strategy config' : 'optional (scored)'}`);
    log(`Regime filter: ${useRegime ? 'ENABLED' : 'disabled'}`);
    if (regimeFilter) {
      log(`  Min eff:     ${regimeFilter.minEfficiency}`);
      log(`  Min trend:   ${regimeFilter.minTrendStrength}`);
    }
    log(`Suppress regime: ${suppressedRegimes.length > 0 ? suppressedRegimes.join(', ') : 'none'}`);
    log(`MTF bias:      ${useMTF ? 'ENABLED (4H)' : 'disabled'}`);
    log(`SL mode:       ${slPlacementMode}`);
    log(`Timeframe:     ${timeframe}`);
    log(`Friction:      ${(FRICTION_PER_SIDE * 100).toFixed(3)}% per side (${(FRICTION_PER_SIDE * 2 * 100).toFixed(3)}% RT)`);
    if (fundingMaxLongArg || fundingMinShortArg) {
      log(`Funding filter: maxLong=${fundingMaxLongArg ?? 'off'} minShort=${fundingMinShortArg ?? 'off'}`);
    }
    log(`Circuit break: ${circuitBreaker ? `${circuitBreaker.maxConsecutiveLosses} losses → ${circuitBreaker.cooldownBars} bar pause` : 'disabled'}`);
    log(`Regime thresh: ${Object.keys(regimeThresholdOverrides).length > 0 ? Object.entries(regimeThresholdOverrides).map(([k, v]) => `${k}:${v}`).join(', ') : 'none (global)'}`);
    log(`Max hold:      ${MAX_POSITION_BARS} bars`);
    log('');
  }

  // Apply OB min-move override (mutates the detection-level config)
  if (obMinMoveArg) {
    const parsed = parseFloat(obMinMoveArg);
    if (!Number.isNaN(parsed) && parsed > 0) {
      DEFAULT_OB_CONFIG.minMovePercent = parsed;
    }
  }

  // Build risk config
  let riskConfig: RiskConfig | undefined;
  if (volSizing || maxWindowDDArg || streakArg) {
    riskConfig = { volSizing };
    if (maxWindowDDArg) {
      const parsed = parseFloat(maxWindowDDArg);
      if (!Number.isNaN(parsed) && parsed < 0) {
        riskConfig.maxWindowDD = parsed;
      }
    }
    if (streakArg) {
      const parts = streakArg.split(',');
      if (parts.length === 3) {
        const streakLength = parseInt(parts[0]!, 10);
        const winMult = parseFloat(parts[1]!);
        const lossMult = parseFloat(parts[2]!);
        if (!Number.isNaN(streakLength) && !Number.isNaN(winMult) && !Number.isNaN(lossMult)) {
          riskConfig.streakSizing = { streakLength, winMultiplier: winMult, lossMultiplier: lossMult };
        }
      }
    }
  }

  // Load futures data for order flow filtering
  type FuturesSnapshot = { timestamp: number; fundingRate: number };
  let futuresDataMap: Map<string, FuturesSnapshot[]> | undefined;
  if (withOrderflow || fundingMaxLongArg || fundingMinShortArg || fundingScoringArg) {
    futuresDataMap = new Map();
    const symbols = configOverrides.symbols ?? ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
    for (const symbol of symbols) {
      const futuresPath = path.join(process.cwd(), 'data', `${symbol}_futures_1h.json`);
      if (fs.existsSync(futuresPath)) {
        const snapshots: FuturesSnapshot[] = JSON.parse(fs.readFileSync(futuresPath, 'utf-8'));
        futuresDataMap.set(symbol, snapshots);
        if (!jsonOutputMode) log(`[OrderFlow] Loaded ${snapshots.length} futures snapshots for ${symbol}`);
      } else {
        if (!jsonOutputMode) log(`[OrderFlow] Warning: ${futuresPath} not found. Run sync-binance-futures.ts first.`);
      }
    }
  }

  // Create the confluence runner
  const { runner, allTrades, signalCounts, tradeRegimes, circuitBreakerFirings } =
    createConfluenceRunner(threshold, exitMode, scorerConfig, circuitBreaker, partialTP, regimeSLMultipliers, riskConfig, multiTP, futuresDataMap);

  // Run walk-forward validation
  const walkForwardResult = await runWalkForward(runner, configOverrides, { quiet: jsonOutputMode });

  // Compute strategy breakdown from all trades collected
  const strategyBreakdown = computeStrategyBreakdown(allTrades, signalCounts);

  // Compute per-regime breakdown
  const regimeBreakdown = computeRegimeBreakdown(allTrades, tradeRegimes);

  // Compute total signals
  let totalSignals = 0;
  signalCounts.forEach((count) => {
    totalSignals += count;
  });

  // Overall stats
  const winningTrades = allTrades.filter((t) => t.pnlPercent > 0);
  const overallWinRate =
    allTrades.length > 0
      ? (winningTrades.length / allTrades.length) * 100
      : 0;

  const overallPnl =
    allTrades.length > 0
      ? allTrades.reduce((sum, t) => {
          // Compounded equity
          return sum * (1 + t.pnlPercent);
        }, 1.0) - 1.0
      : 0;

  const resolvedSymbols =
    configOverrides.symbols ?? ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

  const backtestResult: ConfluenceBacktestResult = {
    walkForwardResult,
    strategyBreakdown,
    regimeBreakdown,
    threshold,
    symbols: resolvedSymbols,
    totalTrades: allTrades.length,
    totalSignals,
    overallWinRate,
    overallPnl,
  };

  // Print results
  if (jsonOutputMode) {
    console.log(JSON.stringify(backtestResult, null, 2));
  } else {
    printStrategyBreakdown(strategyBreakdown);
    if (regimeBreakdown.length > 0) {
      printRegimeBreakdown(regimeBreakdown);
    }
    printOverallSummary(backtestResult);
    if (circuitBreaker) {
      log(`Circuit breaker fired: ${circuitBreakerFirings} times`);
    }

    // Print comparison to exp-014
    const rlResult = loadExp014Results();
    if (rlResult) {
      log('');
      log('--- Comparison to RL (exp-014) ---');
      log(
        `RL pass rate:      ${(rlResult.passRate * 100).toFixed(1)}%`,
      );
      log(
        `Confluence pass rate: ${(walkForwardResult.passRate * 100).toFixed(1)}%`,
      );
      for (const confSymbol of walkForwardResult.symbols) {
        const rlSymbol = rlResult.symbols.find(
          (s) => s.symbol === confSymbol.symbol,
        );
        if (rlSymbol) {
          log(
            `  ${confSymbol.symbol}: Confluence Sharpe=${confSymbol.avgSharpe.toFixed(2)} vs RL Sharpe=${rlSymbol.avgSharpe.toFixed(2)}`,
          );
        }
      }
    } else {
      log('');
      log(
        'No exp-014 RL results found for comparison. Run walk-forward-validate.ts with --save first.',
      );
    }
  }

  // Save experiment doc (always, or when --save is passed)
  const experimentDocPath = path.resolve(EXPERIMENT_DOC_PATH);
  const experimentDir = path.dirname(experimentDocPath);

  if (!fs.existsSync(experimentDir)) {
    fs.mkdirSync(experimentDir, { recursive: true });
  }

  const doc = generateExperimentDoc(backtestResult);
  fs.writeFileSync(experimentDocPath, doc);

  if (!jsonOutputMode) {
    log('');
    log(`Experiment doc saved to: ${EXPERIMENT_DOC_PATH}`);
  }

  // Save detailed JSON results if requested
  if (shouldSave) {
    const jsonPath = path.resolve(
      'experiments',
      'iteration-2-confluence-results.json',
    );
    fs.writeFileSync(jsonPath, JSON.stringify(backtestResult, null, 2));
    if (!jsonOutputMode) {
      log(`Detailed results saved to: experiments/iteration-2-confluence-results.json`);
    }
  }

  process.exit(walkForwardResult.overallPassed ? 0 : 1);
}

// ============================================
// Run if invoked directly
// ============================================

const isDirectRun =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('backtest-confluence.ts') ||
    process.argv[1].endsWith('backtest-confluence'));

if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error('Backtest failed:', err);
    process.exit(1);
  });
}
