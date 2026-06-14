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
import type { StrategyConfig, OrderbookSnapshot } from '@/types/bot';
import { SYMBOL_ALLOCATION, SAFETY_GATE_CONFIG, TRADEABILITY_CONFIG } from './config';
import { computePositionSize, checkTradeability } from './guards';
import type { RejectReason } from '@/types/bot';

// ============================================
// Position Manager
// ============================================

/**
 * Sink for guard-rejected signals. The caller (run-bot) wires this to
 * `logSkippedSignal(db, …)` so rejects are persisted to `skipped_signals`. It is
 * intentionally NOT a DB handle — OrderManager stays DB-free and this seam keeps
 * the observability concern at the wiring layer. Must never throw (it is invoked
 * from the hot order path); the wired implementation swallows its own errors.
 */
export interface SkipSignalSink {
  (info: {
    ts: number;
    symbol: BotSymbol;
    reason: RejectReason;
    signalEntry: number;
    score: number;
    detail?: unknown;
  }): void;
}

export class OrderManager {
  private mode: BotMode;
  private defaultConfig: StrategyConfig;
  /** Optional skipped-signal sink (e.g. persist to skipped_signals). */
  private onSkip?: SkipSignalSink;

  constructor(
    mode: BotMode,
    defaultConfig: StrategyConfig,
    onSkip?: SkipSignalSink,
  ) {
    this.mode = mode;
    this.defaultConfig = defaultConfig;
    this.onSkip = onSkip;
  }

  /**
   * Emit a skipped-signal record through the wired sink, if any. Never throws —
   * observability must not break the order path even if the table/db is absent.
   */
  private emitSkip(info: {
    symbol: BotSymbol;
    reason: RejectReason;
    signalEntry: number;
    score: number;
    detail?: unknown;
  }): void {
    if (!this.onSkip) return;
    try {
      this.onSkip({ ts: Date.now(), ...info });
    } catch (err) {
      console.warn(`[order-manager] skipped-signal sink threw (ignored):`, err);
    }
  }

  /** Get the strategy config (single config path for crypto-only) */
  private getConfig(_symbol: string): StrategyConfig {
    return this.defaultConfig;
  }

  /**
   * Create a new position from a scored signal.
   *
   * @param signal The scored signal from the confluence scorer
   * @param symbol Symbol being traded
   * @param equity Current equity for position sizing
   * @param riskPerTrade Risk fraction per trade
   * @param barIndex Current bar index (for tracking)
   * @param orderbook Optional L2 snapshot. When provided (LIVE path), the
   *   tradeability gate runs; when omitted (tests/backtest), it is skipped so the
   *   Run-20 edge measurement is unaffected.
   * @returns The new position, or null if position cannot be created
   */
  openPosition(
    signal: ScoredSignal,
    symbol: BotSymbol,
    equity: number,
    riskPerTrade: number,
    barIndex: number,
    orderbook?: OrderbookSnapshot,
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

    // Position sizing through the pre-trade safety gate: floors riskDistance
    // (so a tiny stop can't explode size) AND caps notional. Hard-rejects.
    const symbolAlloc = SYMBOL_ALLOCATION[symbol] ?? 0.33;
    const sizing = computePositionSize({
      equity,
      riskPerTrade,
      symbolAlloc,
      riskDistance,
      entryPrice: adjustedEntry,
      maxNotionalPctEquity: SAFETY_GATE_CONFIG.maxNotionalPctEquity,
      minStopPct: SAFETY_GATE_CONFIG.minStopPct,
    });
    if (!sizing.ok) {
      // Warn for log visibility AND persist a skipped_signal via the wired sink.
      console.warn(`[guards] openPosition rejected ${symbol}: ${sizing.reason}`);
      this.emitSkip({
        symbol,
        reason: sizing.reason,
        signalEntry: adjustedEntry,
        score: signal.totalScore,
        detail: { path: 'openPosition', riskDistance },
      });
      return null;
    }
    const riskAmount = equity * riskPerTrade * symbolAlloc;
    const positionSizeUSDT = sizing.notionalUsdt;

    // OPTIONAL L2 tradeability gate (LIVE-only): only runs when a real order-book
    // snapshot is injected. Cross the ASK on a long, the BID on a short, so the
    // depth we need is on the side we'd actually take.
    if (orderbook) {
      const depthUsdt = direction === 'long' ? orderbook.askDepthUsdt : orderbook.bidDepthUsdt;
      const tradeable = checkTradeability({
        spreadBps: orderbook.spreadBps,
        depthUsdt,
        intendedNotionalUsdt: positionSizeUSDT,
        maxSpreadBps: TRADEABILITY_CONFIG.maxSpreadBps,
        depthMultiple: TRADEABILITY_CONFIG.depthMultiple,
      });
      if (!tradeable.ok) {
        console.warn(`[guards] openPosition rejected ${symbol}: ${tradeable.reason}`);
        this.emitSkip({
          symbol,
          reason: tradeable.reason,
          signalEntry: adjustedEntry,
          score: signal.totalScore,
          detail: {
            path: 'openPosition',
            spreadBps: orderbook.spreadBps,
            depthUsdt,
            intendedNotionalUsdt: positionSizeUSDT,
          },
        });
        return null;
      }
    }

    const position: BotPosition = {
      id: uuidv4(),
      symbol,
      direction,
      status: 'open',

      entryPrice: adjustedEntry,
      rawEntryPrice: entryPrice, // Pre-friction price for riskDistance/unrealizedR (matches backtest)
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
   * Create a position with LTF-refined entry and stop loss.
   * Uses the 5m-confirmed entry price and tighter 5m swing SL.
   * TP remains the same as the original 1H signal.
   */
  openLTFPosition(
    signal: ScoredSignal,
    symbol: BotSymbol,
    equity: number,
    riskPerTrade: number,
    barIndex: number,
    ltfEntry: number,
    ltfStopLoss: number,
  ): BotPosition | null {
    const { takeProfit, direction, strategy } = signal.signal;
    const config = this.getConfig(symbol);

    // Apply entry friction to LTF entry
    const adjustedEntry = this.applyEntrySlippage(ltfEntry, direction, config);

    // Calculate risk distance from LTF levels (tighter SL)
    const riskDistance = direction === 'long'
      ? adjustedEntry - ltfStopLoss
      : ltfStopLoss - adjustedEntry;

    if (riskDistance <= 0) return null;

    // Position sizing through the pre-trade safety gate (same as openPosition).
    const symbolAlloc = SYMBOL_ALLOCATION[symbol] ?? 0.33;
    const sizing = computePositionSize({
      equity,
      riskPerTrade,
      symbolAlloc,
      riskDistance,
      entryPrice: adjustedEntry,
      maxNotionalPctEquity: SAFETY_GATE_CONFIG.maxNotionalPctEquity,
      minStopPct: SAFETY_GATE_CONFIG.minStopPct,
    });
    if (!sizing.ok) {
      // Warn for log visibility AND persist a skipped_signal via the wired sink.
      console.warn(`[guards] openLTFPosition rejected ${symbol}: ${sizing.reason}`);
      this.emitSkip({
        symbol,
        reason: sizing.reason,
        signalEntry: adjustedEntry,
        score: signal.totalScore,
        detail: { path: 'openLTFPosition', riskDistance },
      });
      return null;
    }
    const riskAmount = equity * riskPerTrade * symbolAlloc;
    const positionSizeUSDT = sizing.notionalUsdt;

    const position: BotPosition = {
      id: uuidv4(),
      symbol,
      direction,
      status: 'open',

      entryPrice: adjustedEntry,
      rawEntryPrice: ltfEntry, // Pre-friction LTF price for riskDistance/unrealizedR (matches backtest)
      entryTimestamp: Date.now(),
      entryBarIndex: barIndex,

      stopLoss: ltfStopLoss,
      takeProfit,
      currentSL: ltfStopLoss,

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
   * @param position The open position to check
   * @param candle Current candle data
   * @param currentBarIndex Current index into the candle array (matches backtest index-based counting)
   * @returns Updated position (with exit info) or null if still open
   */
  checkPositionExit(
    position: BotPosition,
    candle: Candle,
    currentBarIndex: number,
  ): { position: BotPosition; exitReason: ExitReason } | null {
    const config = this.getConfig(position.symbol);
    // Index-based barsHeld — matches backtest exactly (i - position.entryIndex)
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
      // Use rawEntryPrice for riskDistance/unrealizedR — matches backtest which uses
      // position.entryPrice (raw signal price) not adjustedEntry for these calculations
      const rawEntry = position.rawEntryPrice;
      const riskDistance = direction === 'long'
        ? rawEntry - position.stopLoss
        : position.stopLoss - rawEntry;

      if (riskDistance > 0) {
        const unrealizedR = direction === 'long'
          ? (candle.close - rawEntry) / riskDistance
          : (rawEntry - candle.close) / riskDistance;

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

  /** True when fills are simulated (paper or paper-forward) vs live exchange fills. */
  private get simulatesFills(): boolean {
    return this.mode === 'paper' || this.mode === 'paper-forward';
  }

  private applyEntrySlippage(price: number, direction: 'long' | 'short', config?: StrategyConfig): number {
    if (this.simulatesFills) {
      const friction = (config ?? this.defaultConfig).frictionPerSide;
      return direction === 'long'
        ? price * (1 + friction)
        : price * (1 - friction);
    }
    return price; // Live mode: exchange handles fills
  }

  private applyExitSlippage(price: number, direction: 'long' | 'short', config?: StrategyConfig): number {
    if (this.simulatesFills) {
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
