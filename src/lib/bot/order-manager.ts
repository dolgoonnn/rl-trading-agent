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
import { computePositionSize, checkTradeability, checkPreTradeGuards } from './guards';
import type { RejectReason } from '@/types/bot';
import { DefaultFillModel, FlatFrictionCostModel } from '@/lib/sim';

// Module-level singleton: zero friction so resolveExit cost path is unused;
// allowHeuristic:false forces pessimistic floor (SL wins on straddle) — matches
// the live behavior captured by the characterization tests.
const _exitFillModel = new DefaultFillModel(new FlatFrictionCostModel(0), { allowHeuristic: false });

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

/**
 * Mark-collar / staleness / OHLC-sanity inputs for the pre-trade guard. Supplied
 * ONLY on the live path (run-bot fetches mark + clock + the signal candle); when
 * omitted the guard is skipped so backtest/paper sims that lack a mark feed are
 * unaffected. All fields are caller-injected so the guard stays deterministic.
 */
export interface MarkGuardInputs {
  /** Current Bybit MARK price (dual-price / liquidation reference). */
  markPrice: number;
  /** High of the signal candle. */
  candleHigh: number;
  /** Low of the signal candle. */
  candleLow: number;
  /** Close of the signal candle. */
  candleClose: number;
  /** Close timestamp of the signal candle (ms). */
  candleCloseMs: number;
  /** Current wall-clock time (ms) — injected for determinism. */
  nowMs: number;
}

/**
 * Optional LIVE-only guard inputs for {@link OrderManager.openPosition} /
 * {@link OrderManager.openLTFPosition}. When `markGuard` is present the pre-trade
 * mark-collar / stale-candle / crossed-candle guard runs; when `orderbook` is
 * present the L2 tradeability gate runs. Both are omitted by backtest/paper sim
 * callers, so the Run-20 edge measurement is unchanged.
 */
export interface LiveGuardInputs {
  /** L2 order-book snapshot for the tradeability gate. */
  orderbook?: OrderbookSnapshot;
  /** Mark/candle/clock inputs for the pre-trade guard. */
  markGuard?: MarkGuardInputs;
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
   * @param live Optional LIVE-only guard inputs. When `live.markGuard` is
   *   provided the pre-trade mark-collar / stale-candle / crossed-candle guard
   *   runs; when `live.orderbook` is provided the L2 tradeability gate runs. Both
   *   are omitted by tests/backtest so the Run-20 edge measurement is unaffected.
   * @returns The new position, or null if position cannot be created
   */
  openPosition(
    signal: ScoredSignal,
    symbol: BotSymbol,
    equity: number,
    riskPerTrade: number,
    barIndex: number,
    live?: LiveGuardInputs,
  ): BotPosition | null {
    const { entryPrice, stopLoss, takeProfit, direction, strategy } = signal.signal;
    const config = this.getConfig(symbol);

    // Apply entry friction (slippage simulation for paper)
    const adjustedEntry = this.applyEntrySlippage(entryPrice, direction, config);

    // LIVE pre-trade guard (mark collar + staleness + OHLC sanity). Runs ONLY
    // when the live path injects markGuard; checked against the RAW signal entry
    // (pre-slippage) — that's the price the mark collar is meant to bound.
    const markGuard = live?.markGuard;
    if (markGuard) {
      const guard = checkPreTradeGuards({
        signalEntry: entryPrice,
        markPrice: markGuard.markPrice,
        candleHigh: markGuard.candleHigh,
        candleLow: markGuard.candleLow,
        candleClose: markGuard.candleClose,
        candleCloseMs: markGuard.candleCloseMs,
        nowMs: markGuard.nowMs,
        maxDeviationBps: SAFETY_GATE_CONFIG.maxDeviationBps,
        maxCandleAgeMs: SAFETY_GATE_CONFIG.maxCandleAgeMs,
      });
      if (!guard.ok) {
        console.warn(`[guards] openPosition rejected ${symbol}: ${guard.reason}`);
        this.emitSkip({
          symbol,
          reason: guard.reason,
          signalEntry: entryPrice,
          score: signal.totalScore,
          detail: {
            path: 'openPosition',
            markPrice: markGuard.markPrice,
            candleCloseMs: markGuard.candleCloseMs,
            nowMs: markGuard.nowMs,
          },
        });
        return null;
      }
    }

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
    const orderbook = live?.orderbook;
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
    live?: LiveGuardInputs,
  ): BotPosition | null {
    const { takeProfit, direction, strategy } = signal.signal;
    const config = this.getConfig(symbol);

    // Apply entry friction to LTF entry
    const adjustedEntry = this.applyEntrySlippage(ltfEntry, direction, config);

    // LIVE pre-trade guard — mark collar is checked against the LTF entry (the
    // price we'd actually take), staleness/OHLC against the LTF signal candle.
    const markGuard = live?.markGuard;
    if (markGuard) {
      const guard = checkPreTradeGuards({
        signalEntry: ltfEntry,
        markPrice: markGuard.markPrice,
        candleHigh: markGuard.candleHigh,
        candleLow: markGuard.candleLow,
        candleClose: markGuard.candleClose,
        candleCloseMs: markGuard.candleCloseMs,
        nowMs: markGuard.nowMs,
        maxDeviationBps: SAFETY_GATE_CONFIG.maxDeviationBps,
        maxCandleAgeMs: SAFETY_GATE_CONFIG.maxCandleAgeMs,
      });
      if (!guard.ok) {
        console.warn(`[guards] openLTFPosition rejected ${symbol}: ${guard.reason}`);
        this.emitSkip({
          symbol,
          reason: guard.reason,
          signalEntry: ltfEntry,
          score: signal.totalScore,
          detail: {
            path: 'openLTFPosition',
            markPrice: markGuard.markPrice,
            candleCloseMs: markGuard.candleCloseMs,
            nowMs: markGuard.nowMs,
          },
        });
        return null;
      }
    }

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

    // OPTIONAL L2 tradeability gate (LIVE-only): same as openPosition. Cross the
    // ASK on a long, the BID on a short, so the depth we need is on our side.
    const orderbook = live?.orderbook;
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
        console.warn(`[guards] openLTFPosition rejected ${symbol}: ${tradeable.reason}`);
        this.emitSkip({
          symbol,
          reason: tradeable.reason,
          signalEntry: ltfEntry,
          score: signal.totalScore,
          detail: {
            path: 'openLTFPosition',
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

    // 1 + 2. SL and TP — delegated to shared DefaultFillModel (pessimistic floor:
    // SL wins on straddle). maxBars is suppressed (POSITIVE_INFINITY) here so the
    // partial-TP block (step 3) still runs before the time-exit (step 4), preserving
    // the exact SL/TP → partial → maxBars order. The returned exitPrice is the
    // SL or TP level — same value the old manual code passed to closePosition.
    // applyExitSlippage is applied inside closePosition as before.
    const slTpFill = _exitFillModel.resolveExit({
      levels: { direction, stopLoss: currentSL, takeProfit: position.takeProfit },
      bar: candle,
      barsHeld,
      maxBars: Number.POSITIVE_INFINITY,
    });
    if (slTpFill && (slTpFill.exitReason === 'stop_loss' || slTpFill.exitReason === 'take_profit')) {
      return this.closePosition(position, slTpFill.exitPrice, candle.timestamp, barsHeld, slTpFill.exitReason);
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
