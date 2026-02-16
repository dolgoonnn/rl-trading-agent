/**
 * Order Manager — Paper + Live Order Execution
 *
 * Handles position lifecycle: entry, partial TP, SL management, time exits.
 * Uses an adapter pattern: PaperExecutor simulates fills with slippage,
 * LiveExecutor (future) sends orders to Bybit.
 *
 * The position simulation logic mirrors backtest-confluence.ts exactly
 * to ensure zero sim mismatch.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Candle } from '@/types/candle';
import type {
  BotPosition,
  BotSymbol,
  BotMode,
  ExitReason,
} from '@/types/bot';
import type { ScoredSignal } from '@/lib/rl/strategies/confluence-scorer';
import type { StrategyConfig } from '@/types/bot';
import { SYMBOL_ALLOCATION, getStrategyConfigForSymbol } from './config';

// ============================================
// Position Manager
// ============================================

export class OrderManager {
  private mode: BotMode;
  private defaultConfig: StrategyConfig;
  private paperSlippage: number;

  constructor(
    mode: BotMode,
    defaultConfig: StrategyConfig,
    paperSlippage = 0.001,
  ) {
    this.mode = mode;
    this.defaultConfig = defaultConfig;
    this.paperSlippage = paperSlippage;
  }

  /** Get the appropriate strategy config for a symbol */
  private getConfig(symbol: string): StrategyConfig {
    return getStrategyConfigForSymbol(symbol) ?? this.defaultConfig;
  }

  /**
   * Create a new position from a scored signal.
   *
   * @param signal The scored signal from the confluence scorer
   * @param symbol Symbol being traded
   * @param equity Current equity for position sizing
   * @param riskPerTrade Risk fraction per trade
   * @param barIndex Current bar index (for tracking)
   * @returns The new position, or null if position cannot be created
   */
  openPosition(
    signal: ScoredSignal,
    symbol: BotSymbol,
    equity: number,
    riskPerTrade: number,
    barIndex: number,
  ): BotPosition | null {
    const { entryPrice, stopLoss, takeProfit, direction, strategy } = signal.signal;
    const config = this.getConfig(symbol);

    // Apply entry friction (slippage simulation for paper)
    const adjustedEntry = this.applyEntrySlippage(entryPrice, direction, config);

    // Calculate risk distance
    const riskDistance = direction === 'long'
      ? adjustedEntry - stopLoss
      : stopLoss - adjustedEntry;

    if (riskDistance <= 0) return null;

    // Position sizing: risk-based with symbol allocation
    const symbolAlloc = SYMBOL_ALLOCATION[symbol] ?? 0.33;
    const riskAmount = equity * riskPerTrade * symbolAlloc;
    const riskPerUnit = riskDistance;
    const positionSize = riskAmount / riskPerUnit;
    const positionSizeUSDT = positionSize * adjustedEntry;

    const position: BotPosition = {
      id: uuidv4(),
      symbol,
      direction,
      status: 'open',

      entryPrice: adjustedEntry,
      entryTimestamp: Date.now(),
      entryBarIndex: barIndex,

      stopLoss,
      takeProfit,
      currentSL: stopLoss,

      positionSizeUSDT,
      riskAmountUSDT: riskAmount,

      strategy,
      confluenceScore: signal.totalScore,
      factorBreakdown: signal.factorBreakdown,
      regime: '',

      partialTaken: false,
      partialPnlPercent: 0,
    };

    return position;
  }

  /**
   * Check if a position should be exited on the current candle.
   * Mirrors the backtest partial TP logic exactly.
   *
   * @returns Updated position (with exit info) or null if still open
   */
  checkPositionExit(
    position: BotPosition,
    candle: Candle,
    currentBarIndex: number,
  ): { position: BotPosition; exitReason: ExitReason } | null {
    const config = this.getConfig(position.symbol);
    const barsHeld = currentBarIndex - position.entryBarIndex;
    const direction = position.direction;
    const currentSL = position.currentSL;

    // 1. Check SL hit
    if (direction === 'long' && candle.low <= currentSL) {
      return this.closePosition(position, currentSL, candle.timestamp, barsHeld, 'stop_loss');
    }
    if (direction === 'short' && candle.high >= currentSL) {
      return this.closePosition(position, currentSL, candle.timestamp, barsHeld, 'stop_loss');
    }

    // 2. Check TP hit
    if (direction === 'long' && candle.high >= position.takeProfit) {
      return this.closePosition(position, position.takeProfit, candle.timestamp, barsHeld, 'take_profit');
    }
    if (direction === 'short' && candle.low <= position.takeProfit) {
      return this.closePosition(position, position.takeProfit, candle.timestamp, barsHeld, 'take_profit');
    }

    // 3. Partial TP check (if configured and not yet taken)
    if (config.exitMode === 'partial_tp' && !position.partialTaken) {
      const riskDistance = direction === 'long'
        ? position.entryPrice - position.stopLoss
        : position.stopLoss - position.entryPrice;

      if (riskDistance > 0) {
        const unrealizedR = direction === 'long'
          ? (candle.close - position.entryPrice) / riskDistance
          : (position.entryPrice - candle.close) / riskDistance;

        if (unrealizedR >= config.partialTP.triggerR) {
          // Take partial — simulate exit for the fraction
          const partialExit = this.applyExitSlippage(candle.close, direction, config);
          const partialPnl = this.calculatePnlPercent(position.entryPrice, partialExit, direction);

          position.partialTaken = true;
          position.partialPnlPercent = partialPnl;

          // Move SL to breakeven + buffer (skip if beBuffer < 0)
          if (config.partialTP.beBuffer >= 0) {
            const buffer = riskDistance * config.partialTP.beBuffer;
            if (direction === 'long') {
              position.currentSL = Math.max(position.currentSL, position.entryPrice + buffer);
            } else {
              position.currentSL = Math.min(position.currentSL, position.entryPrice - buffer);
            }
          }

          // Don't return — position is still open with remaining fraction
        }
      }
    }

    // 4. Max bars time exit
    if (barsHeld >= config.maxBars) {
      return this.closePosition(position, candle.close, candle.timestamp, barsHeld, 'max_bars');
    }

    return null; // Position still open
  }

  /**
   * Force close a position at market price (e.g., shutdown, circuit breaker).
   */
  forceClose(
    position: BotPosition,
    currentPrice: number,
    reason: ExitReason,
  ): { position: BotPosition; exitReason: ExitReason } {
    const barsHeld = 0; // Unknown in force-close context
    return this.closePosition(position, currentPrice, Date.now(), barsHeld, reason);
  }

  // ============================================
  // Private helpers
  // ============================================

  private closePosition(
    position: BotPosition,
    rawExitPrice: number,
    exitTimestamp: number,
    barsHeld: number,
    reason: ExitReason,
  ): { position: BotPosition; exitReason: ExitReason } {
    const config = this.getConfig(position.symbol);
    const adjustedExit = this.applyExitSlippage(rawExitPrice, position.direction, config);

    // Calculate PnL (accounting for partial TP if taken)
    const exitPnl = this.calculatePnlPercent(position.entryPrice, adjustedExit, position.direction);
    let finalPnl: number;

    if (position.partialTaken && config.exitMode === 'partial_tp') {
      const fraction = config.partialTP.fraction;
      finalPnl = fraction * position.partialPnlPercent + (1 - fraction) * exitPnl;
    } else {
      finalPnl = exitPnl;
    }

    const pnlUSDT = finalPnl * position.positionSizeUSDT;

    return {
      position: {
        ...position,
        status: 'closed',
        exitPrice: adjustedExit,
        exitTimestamp,
        exitReason: reason,
        barsHeld,
        pnlPercent: finalPnl,
        pnlUSDT,
      },
      exitReason: reason,
    };
  }

  private applyEntrySlippage(price: number, direction: 'long' | 'short', config?: StrategyConfig): number {
    if (this.mode === 'paper') {
      const friction = (config ?? this.defaultConfig).frictionPerSide;
      return direction === 'long'
        ? price * (1 + friction)
        : price * (1 - friction);
    }
    return price; // Live mode: exchange handles fills
  }

  private applyExitSlippage(price: number, direction: 'long' | 'short', config?: StrategyConfig): number {
    if (this.mode === 'paper') {
      const friction = (config ?? this.defaultConfig).frictionPerSide;
      return direction === 'long'
        ? price * (1 - friction)
        : price * (1 + friction);
    }
    return price;
  }

  private calculatePnlPercent(
    entry: number,
    exit: number,
    direction: 'long' | 'short',
  ): number {
    if (direction === 'long') {
      return (exit - entry) / entry;
    }
    return (entry - exit) / entry;
  }
}
