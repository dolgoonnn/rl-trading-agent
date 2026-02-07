/**
 * Position Manager
 *
 * Manages position exits with ICT-based logic:
 * - Trailing stops based on market structure
 * - Break-even after 1R profit
 * - Partial profit taking at key levels
 * - Structure-based stop adjustments
 */

import type { Candle } from '@/types';
import type { HybridPosition, ExitAction } from '../rl/types';
import type { ICTStrategyContext } from '../rl/strategies/ict-strategies';

export interface PositionManagerConfig {
  /** Move to break-even after this multiple of risk (default: 1.0 = 1R) */
  breakEvenAfterR: number;
  /** Start trailing after this multiple of risk (default: 2.0 = 2R) */
  trailAfterR: number;
  /** Trailing stop distance as ATR multiple (default: 1.5) */
  trailATRMultiple: number;
  /** Take partial profit at this multiple of risk (default: 1.5 = 1.5R) */
  partialTakeProfitR: number;
  /** Percentage to exit on partial take (default: 0.5 = 50%) */
  partialExitPercent: number;
  /** Maximum bars to hold position (default: 50) */
  maxHoldBars: number;
  /** Use structure-based trailing (default: true) */
  useStructureTrailing: boolean;
}

const DEFAULT_CONFIG: PositionManagerConfig = {
  breakEvenAfterR: 1.0,
  trailAfterR: 2.0,
  trailATRMultiple: 1.5,
  partialTakeProfitR: 1.5,
  partialExitPercent: 0.5,
  maxHoldBars: 50,
  useStructureTrailing: true,
};

export interface PositionUpdate {
  action: ExitAction;
  newStopLoss?: number;
  newTakeProfit?: number;
  exitReason?: string;
  reasoning: string[];
}

export interface PositionManagerState {
  originalStopLoss: number;
  originalTakeProfit: number;
  currentStopLoss: number;
  currentTakeProfit: number;
  breakEvenTriggered: boolean;
  trailingTriggered: boolean;
  partialTaken: boolean;
  highestPnLR: number; // Peak PnL in R multiples
  structureHigh?: number; // Most recent swing high
  structureLow?: number; // Most recent swing low
}

/**
 * Position Manager class for ICT-based position management
 */
export class PositionManager {
  private config: PositionManagerConfig;

  constructor(config: Partial<PositionManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize state for a new position
   */
  initState(position: HybridPosition): PositionManagerState {
    return {
      originalStopLoss: position.stopLoss,
      originalTakeProfit: position.takeProfit,
      currentStopLoss: position.stopLoss,
      currentTakeProfit: position.takeProfit,
      breakEvenTriggered: false,
      trailingTriggered: false,
      partialTaken: false,
      highestPnLR: 0,
    };
  }

  /**
   * Evaluate position and recommend action
   */
  evaluate(
    position: HybridPosition,
    state: PositionManagerState,
    candle: Candle,
    ctx: ICTStrategyContext
  ): PositionUpdate {
    const reasoning: string[] = [];

    // Calculate current R multiple
    const risk = position.side === 'long'
      ? position.entryPrice - state.originalStopLoss
      : state.originalStopLoss - position.entryPrice;

    const unrealizedPnL = position.side === 'long'
      ? candle.close - position.entryPrice
      : position.entryPrice - candle.close;

    const currentR = risk > 0 ? unrealizedPnL / risk : 0;

    // Update peak R
    if (currentR > state.highestPnLR) {
      state.highestPnLR = currentR;
    }

    // Check for stop loss hit
    if (this.isStopHit(position, candle, state.currentStopLoss)) {
      return {
        action: 1 as ExitAction, // EXIT_MARKET
        exitReason: 'stop_loss',
        reasoning: ['Stop loss hit'],
      };
    }

    // Check for take profit hit
    if (this.isTakeProfitHit(position, candle, state.currentTakeProfit)) {
      return {
        action: 1 as ExitAction, // EXIT_MARKET
        exitReason: 'take_profit',
        reasoning: ['Take profit hit'],
      };
    }

    // Check max hold time
    if (position.barsHeld >= this.config.maxHoldBars) {
      return {
        action: 1 as ExitAction, // EXIT_MARKET
        exitReason: 'max_bars',
        reasoning: [`Max hold time reached (${this.config.maxHoldBars} bars)`],
      };
    }

    // Check for structure-based exit signals
    const structureExit = this.checkStructureExit(position, ctx);
    if (structureExit) {
      return {
        action: 1 as ExitAction, // EXIT_MARKET
        exitReason: 'structure',
        reasoning: [structureExit],
      };
    }

    // Check for break-even move
    if (!state.breakEvenTriggered && currentR >= this.config.breakEvenAfterR) {
      state.breakEvenTriggered = true;
      const newStopLoss = this.calculateBreakEvenStop(position, ctx);
      state.currentStopLoss = newStopLoss;

      reasoning.push(`Break-even triggered at ${currentR.toFixed(1)}R`);
      reasoning.push(`SL moved to ${newStopLoss.toFixed(2)}`);

      return {
        action: 2 as ExitAction, // TIGHTEN_STOP
        newStopLoss,
        reasoning,
      };
    }

    // Check for partial take profit
    if (!state.partialTaken && currentR >= this.config.partialTakeProfitR) {
      state.partialTaken = true;
      reasoning.push(`Partial TP at ${currentR.toFixed(1)}R`);
      reasoning.push(`Taking ${(this.config.partialExitPercent * 100).toFixed(0)}% profit`);

      return {
        action: 3 as ExitAction, // TAKE_PARTIAL
        reasoning,
      };
    }

    // Check for trailing stop activation
    if (!state.trailingTriggered && currentR >= this.config.trailAfterR) {
      state.trailingTriggered = true;
      reasoning.push(`Trailing activated at ${currentR.toFixed(1)}R`);
    }

    // Update trailing stop if active
    if (state.trailingTriggered) {
      const trailUpdate = this.updateTrailingStop(position, candle, ctx, state);
      if (trailUpdate.newStopLoss && trailUpdate.newStopLoss !== state.currentStopLoss) {
        state.currentStopLoss = trailUpdate.newStopLoss;
        reasoning.push(...trailUpdate.reasoning);

        return {
          action: 2 as ExitAction, // TIGHTEN_STOP
          newStopLoss: trailUpdate.newStopLoss,
          reasoning,
        };
      }
    }

    // No action needed
    return {
      action: 0 as ExitAction, // HOLD
      reasoning: reasoning.length > 0 ? reasoning : ['Holding position'],
    };
  }

  /**
   * Check if stop loss is hit
   */
  private isStopHit(position: HybridPosition, candle: Candle, stopLoss: number): boolean {
    if (position.side === 'long') {
      return candle.low <= stopLoss;
    } else {
      return candle.high >= stopLoss;
    }
  }

  /**
   * Check if take profit is hit
   */
  private isTakeProfitHit(position: HybridPosition, candle: Candle, takeProfit: number): boolean {
    if (position.side === 'long') {
      return candle.high >= takeProfit;
    } else {
      return candle.low <= takeProfit;
    }
  }

  /**
   * Check for structure-based exit signals
   */
  private checkStructureExit(position: HybridPosition, ctx: ICTStrategyContext): string | null {
    // Check for CHoCH against position
    const recentCHoCH = ctx.structure.structureBreaks.find(
      (sb) => sb.type === 'choch' && sb.confidence >= 0.7
    );

    if (recentCHoCH) {
      if (position.side === 'long' && recentCHoCH.direction === 'bearish') {
        return 'Bearish CHoCH - structure reversal against long';
      }
      if (position.side === 'short' && recentCHoCH.direction === 'bullish') {
        return 'Bullish CHoCH - structure reversal against short';
      }
    }

    return null;
  }

  /**
   * Calculate break-even stop with small buffer
   */
  private calculateBreakEvenStop(position: HybridPosition, ctx: ICTStrategyContext): number {
    const buffer = ctx.atr * 0.1; // Small buffer above/below entry

    if (position.side === 'long') {
      return position.entryPrice + buffer;
    } else {
      return position.entryPrice - buffer;
    }
  }

  /**
   * Update trailing stop based on structure or ATR
   */
  private updateTrailingStop(
    position: HybridPosition,
    candle: Candle,
    ctx: ICTStrategyContext,
    state: PositionManagerState
  ): { newStopLoss?: number; reasoning: string[] } {
    const reasoning: string[] = [];

    if (this.config.useStructureTrailing) {
      // Use structure-based trailing (swing points)
      const structureStop = this.getStructureBasedStop(position, ctx, candle);
      if (structureStop) {
        const improved = position.side === 'long'
          ? structureStop > state.currentStopLoss
          : structureStop < state.currentStopLoss;

        if (improved) {
          reasoning.push(`Structure-based trail to ${structureStop.toFixed(2)}`);
          return { newStopLoss: structureStop, reasoning };
        }
      }
    }

    // Fallback to ATR-based trailing
    const atrStop = this.getATRBasedStop(position, candle, ctx);
    const improved = position.side === 'long'
      ? atrStop > state.currentStopLoss
      : atrStop < state.currentStopLoss;

    if (improved) {
      reasoning.push(`ATR trail to ${atrStop.toFixed(2)}`);
      return { newStopLoss: atrStop, reasoning };
    }

    return { reasoning };
  }

  /**
   * Get structure-based stop (most recent swing point)
   */
  private getStructureBasedStop(
    position: HybridPosition,
    ctx: ICTStrategyContext,
    candle: Candle
  ): number | null {
    if (position.side === 'long') {
      // For longs, trail below recent swing lows
      const recentSwingLows = ctx.structure.swingLows.slice(-3);
      if (recentSwingLows.length === 0) return null;

      // Find the highest swing low that's below current price
      const validLows = recentSwingLows.filter((sl) => sl.price < candle.close);
      if (validLows.length === 0) return null;

      const highestLow = Math.max(...validLows.map((sl) => sl.price));
      return highestLow - ctx.atr * 0.2; // Small buffer below swing
    } else {
      // For shorts, trail above recent swing highs
      const recentSwingHighs = ctx.structure.swingHighs.slice(-3);
      if (recentSwingHighs.length === 0) return null;

      const validHighs = recentSwingHighs.filter((sh) => sh.price > candle.close);
      if (validHighs.length === 0) return null;

      const lowestHigh = Math.min(...validHighs.map((sh) => sh.price));
      return lowestHigh + ctx.atr * 0.2; // Small buffer above swing
    }
  }

  /**
   * Get ATR-based trailing stop
   */
  private getATRBasedStop(position: HybridPosition, candle: Candle, ctx: ICTStrategyContext): number {
    const trailDistance = ctx.atr * this.config.trailATRMultiple;

    if (position.side === 'long') {
      return candle.close - trailDistance;
    } else {
      return candle.close + trailDistance;
    }
  }
}

/**
 * Create a position manager with default config
 */
export function createPositionManager(config: Partial<PositionManagerConfig> = {}): PositionManager {
  return new PositionManager(config);
}

/**
 * Quick utility to check if position should exit based on structure
 */
export function shouldExitOnStructure(
  position: HybridPosition,
  ctx: ICTStrategyContext
): { shouldExit: boolean; reason?: string } {
  // Check for CHoCH against position
  const recentCHoCH = ctx.structure.structureBreaks.find(
    (sb) => sb.type === 'choch' && sb.confidence >= 0.7
  );

  if (recentCHoCH) {
    if (position.side === 'long' && recentCHoCH.direction === 'bearish') {
      return { shouldExit: true, reason: 'Bearish CHoCH detected' };
    }
    if (position.side === 'short' && recentCHoCH.direction === 'bullish') {
      return { shouldExit: true, reason: 'Bullish CHoCH detected' };
    }
  }

  // Check if price breaks opposite order block
  const oppositeOBs = ctx.orderBlocks.filter((ob) => {
    if (position.side === 'long') return ob.type === 'bearish';
    return ob.type === 'bullish';
  });

  for (const ob of oppositeOBs) {
    if (ob.status === 'unmitigated') {
      const currentPrice = ctx.currentPrice;
      if (position.side === 'long' && currentPrice >= ob.low && currentPrice <= ob.high) {
        return { shouldExit: true, reason: 'Price in opposing OB zone' };
      }
      if (position.side === 'short' && currentPrice >= ob.low && currentPrice <= ob.high) {
        return { shouldExit: true, reason: 'Price in opposing OB zone' };
      }
    }
  }

  return { shouldExit: false };
}
