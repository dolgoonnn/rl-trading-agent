/**
 * Hybrid Trading Environment
 * Rule-based entries + RL-controlled exits
 *
 * Architecture:
 * - Entry Filter (rules) decides WHEN to enter based on ICT confluence
 * - RL Agent decides WHEN to exit (hold, exit, tighten stop, partial)
 * - This simplifies the RL problem significantly
 */

import type { Candle } from '@/types';
import type {
  ExitAction,
  ExitState,
  HybridStepResult,
  HybridStepInfo,
  Portfolio,
  TradeRecord,
  HybridPosition,
  EntrySignal,
  EnvironmentConfig,
} from '../types';
import { ExitActions, exitActionToName } from '../types';
import { EntryFilter, EntryFilterConfig } from './entry-filter';
import { ExitStateBuilder, ExitStateBuilderConfig } from './exit-state-builder';

export interface HybridEnvConfig extends Partial<EnvironmentConfig> {
  // Exit agent specific
  maxHoldBars: number;       // Force exit after N bars (default: 50)
  defaultSLPercent: number;  // Default stop loss % (fallback if ATR not used)
  defaultTPPercent: number;  // Default take profit % (fallback if ATR not used)
  partialExitPercent: number; // % to exit on partial (default: 0.5)
  trailingActivation: number; // Activate trailing after this % profit (default: 0.01)

  // ATR-based SL/TP
  atrSlMultiplier: number;   // SL distance in ATR multiples (default: 1.5)
  atrTpMultiplier: number;   // TP distance in ATR multiples (default: 3.0)
  useATRStops: boolean;      // Use ATR-based SL/TP (default: true), false = fixed %

  // Progressive trailing stops
  useProgressiveTrailing: boolean; // Enable progressive trailing (default: true)

  // Dynamic position sizing (uses confluence level automatically)
  useDynamicSizing: boolean; // Use confluence-based sizing (default: true)
  // A+: 15%, A: 12%, B: 8%, C: 5%
}

const DEFAULT_HYBRID_CONFIG: HybridEnvConfig = {
  // From EnvironmentConfig
  initialCapital: 10000,
  positionSize: 0.1,
  maxPositionSize: 0.5,
  spread: 0.0001,
  commission: 0.001,
  slippage: 0.0005,
  lookbackPeriod: 60,
  episodeLength: null,
  randomStart: false,
  maxDrawdownLimit: 0.2,

  // Hybrid specific
  maxHoldBars: 50,
  defaultSLPercent: 0.02,
  defaultTPPercent: 0.04,
  partialExitPercent: 0.5,
  trailingActivation: 0.01, // 1% profit to activate trailing

  // ATR-based SL/TP (disabled by default - causes regression)
  atrSlMultiplier: 1.5,   // 1.5 ATR stop loss
  atrTpMultiplier: 3.0,   // 3.0 ATR take profit (2:1 R:R)
  useATRStops: false,     // DISABLED: causes -29 Sharpe regression vs fixed %

  // Progressive trailing (disabled by default - moderate regression)
  useProgressiveTrailing: false, // DISABLED: causes ~12pt Sharpe regression

  // Dynamic sizing (disabled by default - causes regression)
  useDynamicSizing: false, // DISABLED: causes ~10pt Sharpe regression
};

export class HybridTradingEnvironment {
  private candles: Candle[];
  private config: HybridEnvConfig;
  private entryFilter: EntryFilter;
  private stateBuilder: ExitStateBuilder;
  private training: boolean;

  // Episode state
  private currentIndex: number = 0;
  private startIndex: number = 0;
  private portfolio: Portfolio;
  private position: HybridPosition | null = null;
  private trades: TradeRecord[] = [];
  private done: boolean = false;

  // Tracking for rewards
  private lastEntrySignal: EntrySignal | null = null;

  constructor(
    candles: Candle[],
    envConfig: Partial<HybridEnvConfig> = {},
    entryConfig: Partial<EntryFilterConfig> = {},
    stateConfig: Partial<ExitStateBuilderConfig> = {},
    training: boolean = true
  ) {
    this.candles = candles;
    this.config = { ...DEFAULT_HYBRID_CONFIG, ...envConfig };
    this.entryFilter = new EntryFilter(entryConfig);
    this.stateBuilder = new ExitStateBuilder(stateConfig);
    this.training = training;
    this.portfolio = this.createInitialPortfolio();
  }

  private createInitialPortfolio(): Portfolio {
    return {
      cash: this.config.initialCapital ?? 10000,
      equity: this.config.initialCapital ?? 10000,
      position: null,
      realizedPnL: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      maxDrawdown: 0,
      peakEquity: this.config.initialCapital ?? 10000,
    };
  }

  /**
   * Reset environment to initial state
   */
  reset(): ExitState | null {
    const lookbackPeriod = this.config.lookbackPeriod ?? 60;
    const minStart = lookbackPeriod;
    const maxStart = this.config.episodeLength
      ? Math.max(minStart, this.candles.length - this.config.episodeLength)
      : minStart;

    if (this.config.randomStart && maxStart > minStart) {
      this.startIndex = minStart + Math.floor(Math.random() * (maxStart - minStart));
    } else {
      this.startIndex = minStart;
    }

    this.currentIndex = this.startIndex;
    this.portfolio = this.createInitialPortfolio();
    this.position = null;
    this.trades = [];
    this.done = false;
    this.lastEntrySignal = null;

    // Return null if not in position (agent waits for entry)
    return null;
  }

  /**
   * Step the environment
   * If not in position: check for entry signal (agent has no control)
   * If in position: agent selects exit action
   */
  step(action: ExitAction | null): HybridStepResult {
    if (this.done) {
      throw new Error('Episode is done. Call reset() to start a new episode.');
    }

    const currentCandle = this.candles[this.currentIndex];
    if (!currentCandle) {
      throw new Error(`No candle at index ${this.currentIndex}`);
    }

    const currentPrice = currentCandle.close;
    let trade: TradeRecord | undefined;
    let entrySignal: EntrySignal | undefined;
    let exitReason: HybridStepInfo['exitReason'];

    // Track previous equity for reward calculation
    const previousEquity = this.portfolio.equity;

    // ============================================
    // Not in position: check for rule-based entry
    // ============================================
    if (!this.position) {
      const signal = this.entryFilter.checkEntry(this.candles, this.currentIndex);

      if (signal) {
        this.enterPosition(signal, currentCandle);
        entrySignal = signal;
        this.lastEntrySignal = signal;
      }
    }
    // ============================================
    // In position: handle exit logic
    // ============================================
    else {
      // First check SL/TP before agent action
      const slTpResult = this.checkStopLossTakeProfit(currentCandle);
      if (slTpResult) {
        trade = slTpResult.trade;
        exitReason = slTpResult.reason;
      }

      // Check max hold bars
      if (!trade && this.position.barsHeld >= this.config.maxHoldBars) {
        trade = this.closePosition(currentPrice, 'max_bars');
        exitReason = 'max_bars';
      }

      // Execute agent action if position still open
      if (!trade && action !== null) {
        const result = this.executeExitAction(action, currentPrice);
        if (result) {
          trade = result;
          exitReason = 'agent';
        }
      }

      // Update position state
      if (this.position) {
        this.position.barsHeld++;
        this.updatePositionPnL(currentPrice);

        // Update peak PnL for trailing
        if (this.position.unrealizedPnL > this.position.peakPnL) {
          this.position.peakPnL = this.position.unrealizedPnL;
        }

        // Apply progressive trailing stop (if enabled)
        if (this.config.useProgressiveTrailing ?? true) {
          this.applyProgressiveTrailingStop(currentPrice);
        }
      }
    }

    // Update portfolio equity
    this.portfolio.equity = this.portfolio.cash +
      (this.position?.unrealizedPnL ?? 0);

    // Update max drawdown
    if (this.portfolio.equity > this.portfolio.peakEquity) {
      this.portfolio.peakEquity = this.portfolio.equity;
    }
    const currentDrawdown = (this.portfolio.peakEquity - this.portfolio.equity) / this.portfolio.peakEquity;
    this.portfolio.maxDrawdown = Math.max(this.portfolio.maxDrawdown, currentDrawdown);

    // Move to next bar
    this.currentIndex++;

    // Check episode end conditions
    const reachedEnd = this.currentIndex >= this.candles.length - 1;
    const maxDrawdownExceeded = this.portfolio.maxDrawdown >= (this.config.maxDrawdownLimit ?? 0.2);
    const episodeLengthReached = this.config.episodeLength
      ? this.currentIndex - this.startIndex >= this.config.episodeLength
      : false;

    this.done = reachedEnd || maxDrawdownExceeded || episodeLengthReached;

    // Force close at end of episode
    if (this.done && this.position) {
      trade = this.closePosition(currentPrice, 'episode_end');
      exitReason = 'agent';
    }

    // Calculate reward
    const reward = this.calculateReward(previousEquity, trade, action);

    // Build state for agent (only if in position)
    const state = this.position
      ? this.stateBuilder.build(
          this.candles,
          this.currentIndex - 1, // State is from before we advanced
          this.position,
          this.training
        )
      : null;

    const info: HybridStepInfo = {
      action,
      actionName: action !== null ? exitActionToName(action) : 'waiting',
      price: currentPrice,
      portfolio: { ...this.portfolio },
      inPosition: this.position !== null,
      entrySignal,
      trade,
      exitReason,
    };

    return {
      state,
      reward,
      done: this.done,
      info,
    };
  }

  /**
   * Enter position based on entry signal
   * Uses dynamic position sizing based on confluence level (if enabled)
   * Uses ATR-based SL/TP for volatility-adjusted risk management (if enabled)
   */
  private enterPosition(signal: EntrySignal, candle: Candle): void {
    const currentPrice = candle.close;
    const slippage = this.config.slippage ?? 0.0005;
    const commission = this.config.commission ?? 0.001;

    // Calculate ATR at entry for normalization AND SL/TP
    const lookbackCandles = this.candles.slice(
      Math.max(0, this.currentIndex - 14),
      this.currentIndex + 1
    );
    const entryATR = this.calculateATR(lookbackCandles);

    // Position sizing: dynamic based on confluence OR fixed from config
    let effectivePositionSize: number;
    if (this.config.useDynamicSizing ?? true) {
      // Dynamic position sizing based on confluence level
      // A+: 15%, A: 12%, B: 8%, C: 5%
      switch (signal.confluenceLevel) {
        case 'A+': effectivePositionSize = 0.15; break;
        case 'A': effectivePositionSize = 0.12; break;
        case 'B': effectivePositionSize = 0.08; break;
        case 'C': effectivePositionSize = 0.05; break;
        default: effectivePositionSize = this.config.positionSize ?? 0.1;
      }
    } else {
      effectivePositionSize = this.config.positionSize ?? 0.1;
    }

    // Cap at max position size
    const maxPositionSize = this.config.maxPositionSize ?? 0.5;
    effectivePositionSize = Math.min(effectivePositionSize, maxPositionSize);
    const positionValue = this.portfolio.cash * effectivePositionSize;

    // Adjust entry price for slippage
    const entryPrice = signal.direction === 'long'
      ? currentPrice * (1 + slippage)
      : currentPrice * (1 - slippage);

    const size = positionValue / entryPrice;

    // SL/TP: ATR-based OR fixed percentage
    let stopLoss: number;
    let takeProfit: number;

    if (this.config.useATRStops ?? true) {
      // ATR-based SL/TP
      const slMultiplier = this.config.atrSlMultiplier ?? 1.5;
      const tpMultiplier = this.config.atrTpMultiplier ?? 3.0;
      const slDistance = entryATR * slMultiplier;
      const tpDistance = entryATR * tpMultiplier;

      stopLoss = signal.direction === 'long'
        ? entryPrice - slDistance
        : entryPrice + slDistance;
      takeProfit = signal.direction === 'long'
        ? entryPrice + tpDistance
        : entryPrice - tpDistance;
    } else {
      // Fixed percentage SL/TP (original behavior)
      const slPercent = this.config.defaultSLPercent ?? 0.02;
      const tpPercent = this.config.defaultTPPercent ?? 0.04;

      stopLoss = signal.direction === 'long'
        ? entryPrice * (1 - slPercent)
        : entryPrice * (1 + slPercent);
      takeProfit = signal.direction === 'long'
        ? entryPrice * (1 + tpPercent)
        : entryPrice * (1 - tpPercent);
    }

    this.position = {
      side: signal.direction,
      entryPrice,
      entryIndex: this.currentIndex,
      size,
      unrealizedPnL: 0,
      stopLoss,
      takeProfit,
      confluenceLevel: signal.confluenceLevel,
      entryATR,
      peakPnL: 0,
      barsHeld: 0,
      partialExitTaken: false,
      stopTightened: false,
      trailingLevel: 0,
    };

    // Deduct commission
    this.portfolio.cash -= positionValue * commission;
  }

  /**
   * Execute exit action from agent
   */
  private executeExitAction(action: ExitAction, currentPrice: number): TradeRecord | undefined {
    if (!this.position) return undefined;

    switch (action) {
      case ExitActions.HOLD:
        return undefined;

      case ExitActions.EXIT_MARKET:
        return this.closePosition(currentPrice, 'agent_exit');

      case ExitActions.TIGHTEN_STOP:
        this.tightenStop(currentPrice);
        return undefined;

      case ExitActions.TAKE_PARTIAL:
        return this.takePartialProfit(currentPrice);

      default:
        return undefined;
    }
  }

  /**
   * Progressive trailing stop based on profit levels
   * Level 1: At 1% profit → move SL to breakeven
   * Level 2: At 2% profit → move SL to 1% profit
   * Level 3: At 3%+ profit → trail by 1.5 ATR
   *
   * Uses trailingLevel to track progression and allow upgrades
   */
  private applyProgressiveTrailingStop(currentPrice: number): void {
    if (!this.position) return;

    // Calculate peak profit percentage since entry
    const peakPnLPercent = this.position.peakPnL / (this.position.entryPrice * this.position.size);

    // Level 3: At 3%+ profit, trail by 1.5 ATR (always active once reached)
    if (peakPnLPercent >= 0.03) {
      const trailDistance = this.position.entryATR * 1.5;
      const trailStop = this.position.side === 'long'
        ? currentPrice - trailDistance
        : currentPrice + trailDistance;

      // Only move stop if it's more favorable (never move back)
      if (this.position.side === 'long' && trailStop > this.position.stopLoss) {
        this.position.stopLoss = trailStop;
        this.position.stopTightened = true;
        this.position.trailingLevel = 3;
      } else if (this.position.side === 'short' && trailStop < this.position.stopLoss) {
        this.position.stopLoss = trailStop;
        this.position.stopTightened = true;
        this.position.trailingLevel = 3;
      }
      return;
    }

    // Level 2: At 2% profit, move SL to 1% profit level (upgrades from Level 1)
    if (peakPnLPercent >= 0.02 && this.position.trailingLevel < 2) {
      const targetProfit = 0.01; // 1% profit
      const newStop = this.position.side === 'long'
        ? this.position.entryPrice * (1 + targetProfit)
        : this.position.entryPrice * (1 - targetProfit);

      if (this.position.side === 'long' && newStop > this.position.stopLoss) {
        this.position.stopLoss = newStop;
        this.position.stopTightened = true;
        this.position.trailingLevel = 2;
      } else if (this.position.side === 'short' && newStop < this.position.stopLoss) {
        this.position.stopLoss = newStop;
        this.position.stopTightened = true;
        this.position.trailingLevel = 2;
      }
      return;
    }

    // Level 1: At 1% profit, move SL to breakeven
    if (peakPnLPercent >= 0.01 && this.position.trailingLevel < 1) {
      const buffer = this.position.entryPrice * 0.001; // 0.1% buffer
      const beStop = this.position.side === 'long'
        ? this.position.entryPrice + buffer
        : this.position.entryPrice - buffer;

      if (this.position.side === 'long' && beStop > this.position.stopLoss) {
        this.position.stopLoss = beStop;
        this.position.stopTightened = true;
        this.position.trailingLevel = 1;
      } else if (this.position.side === 'short' && beStop < this.position.stopLoss) {
        this.position.stopLoss = beStop;
        this.position.stopTightened = true;
        this.position.trailingLevel = 1;
      }
    }
  }

  /**
   * Move stop loss to breakeven (or slightly profitable)
   * @deprecated Use applyProgressiveTrailingStop instead
   */
  private tightenStop(currentPrice: number): void {
    if (!this.position || this.position.stopTightened) return;

    const activationProfit = this.config.trailingActivation ?? 0.01;
    const pnlPercent = this.position.side === 'long'
      ? (currentPrice - this.position.entryPrice) / this.position.entryPrice
      : (this.position.entryPrice - currentPrice) / this.position.entryPrice;

    // Only tighten if we're in profit
    if (pnlPercent < activationProfit) return;

    // Move SL to entry + small profit
    const buffer = this.position.entryPrice * 0.002; // 0.2% buffer
    this.position.stopLoss = this.position.side === 'long'
      ? this.position.entryPrice + buffer
      : this.position.entryPrice - buffer;

    this.position.stopTightened = true;
  }

  /**
   * Take partial profit (close portion of position)
   */
  private takePartialProfit(currentPrice: number): TradeRecord | undefined {
    if (!this.position || this.position.partialExitTaken) return undefined;

    const partialPercent = this.config.partialExitPercent ?? 0.5;
    const pnlPercent = this.position.side === 'long'
      ? (currentPrice - this.position.entryPrice) / this.position.entryPrice
      : (this.position.entryPrice - currentPrice) / this.position.entryPrice;

    // Only take partial if in profit
    if (pnlPercent <= 0) return undefined;

    // Close partial position
    const slippage = this.config.slippage ?? 0.0005;
    const commission = this.config.commission ?? 0.001;

    const exitPrice = this.position.side === 'long'
      ? currentPrice * (1 - slippage)
      : currentPrice * (1 + slippage);

    const partialSize = this.position.size * partialPercent;
    const pnl = this.position.side === 'long'
      ? (exitPrice - this.position.entryPrice) * partialSize
      : (this.position.entryPrice - exitPrice) * partialSize;

    // Update portfolio
    this.portfolio.cash += pnl - (pnl * commission);
    this.portfolio.realizedPnL += pnl;

    // Update position
    this.position.size -= partialSize;
    this.position.partialExitTaken = true;

    // Also tighten stop on partial exit
    this.tightenStop(currentPrice);

    // Create trade record for partial
    const trade: TradeRecord = {
      entryIndex: this.position.entryIndex,
      exitIndex: this.currentIndex,
      entryPrice: this.position.entryPrice,
      exitPrice,
      side: this.position.side,
      pnl,
      pnlPercent: pnl / (this.position.entryPrice * partialSize),
      holdingPeriod: this.position.barsHeld,
    };

    this.trades.push(trade);

    if (pnl > 0) {
      this.portfolio.winningTrades++;
    } else {
      this.portfolio.losingTrades++;
    }
    this.portfolio.totalTrades++;

    return trade;
  }

  /**
   * Close full position
   */
  private closePosition(
    currentPrice: number,
    _reason: string
  ): TradeRecord {
    if (!this.position) {
      throw new Error('No position to close');
    }

    const slippage = this.config.slippage ?? 0.0005;
    const commission = this.config.commission ?? 0.001;

    const exitPrice = this.position.side === 'long'
      ? currentPrice * (1 - slippage)
      : currentPrice * (1 + slippage);

    const pnl = this.position.side === 'long'
      ? (exitPrice - this.position.entryPrice) * this.position.size
      : (this.position.entryPrice - exitPrice) * this.position.size;

    const pnlPercent = pnl / (this.position.entryPrice * this.position.size);

    // Update portfolio
    this.portfolio.cash += pnl - (Math.abs(pnl) * commission);
    this.portfolio.realizedPnL += pnl;
    this.portfolio.totalTrades++;

    if (pnl > 0) {
      this.portfolio.winningTrades++;
    } else if (pnl < 0) {
      this.portfolio.losingTrades++;
    }

    // Create trade record
    const trade: TradeRecord = {
      entryIndex: this.position.entryIndex,
      exitIndex: this.currentIndex,
      entryPrice: this.position.entryPrice,
      exitPrice,
      side: this.position.side,
      pnl,
      pnlPercent,
      holdingPeriod: this.position.barsHeld,
    };

    this.trades.push(trade);
    this.position = null;

    return trade;
  }

  /**
   * Check for stop loss or take profit hit
   */
  private checkStopLossTakeProfit(
    candle: Candle
  ): { trade: TradeRecord; reason: 'stop_loss' | 'take_profit' } | null {
    if (!this.position) return null;

    if (this.position.side === 'long') {
      // Check SL (low touches stop)
      if (candle.low <= this.position.stopLoss) {
        return {
          trade: this.closePositionAtPrice(this.position.stopLoss),
          reason: 'stop_loss',
        };
      }
      // Check TP (high touches target)
      if (candle.high >= this.position.takeProfit) {
        return {
          trade: this.closePositionAtPrice(this.position.takeProfit),
          reason: 'take_profit',
        };
      }
    } else {
      // Short position
      // Check SL (high touches stop)
      if (candle.high >= this.position.stopLoss) {
        return {
          trade: this.closePositionAtPrice(this.position.stopLoss),
          reason: 'stop_loss',
        };
      }
      // Check TP (low touches target)
      if (candle.low <= this.position.takeProfit) {
        return {
          trade: this.closePositionAtPrice(this.position.takeProfit),
          reason: 'take_profit',
        };
      }
    }

    return null;
  }

  /**
   * Close position at specific price (for SL/TP)
   */
  private closePositionAtPrice(price: number): TradeRecord {
    if (!this.position) {
      throw new Error('No position to close');
    }

    const slippage = this.config.slippage ?? 0.0005;
    const commission = this.config.commission ?? 0.001;

    // Worse slippage on SL/TP execution
    const exitPrice = this.position.side === 'long'
      ? price * (1 - slippage)
      : price * (1 + slippage);

    const pnl = this.position.side === 'long'
      ? (exitPrice - this.position.entryPrice) * this.position.size
      : (this.position.entryPrice - exitPrice) * this.position.size;

    const pnlPercent = pnl / (this.position.entryPrice * this.position.size);

    // Update portfolio
    this.portfolio.cash += pnl - (Math.abs(pnl) * commission);
    this.portfolio.realizedPnL += pnl;
    this.portfolio.totalTrades++;

    if (pnl > 0) {
      this.portfolio.winningTrades++;
    } else if (pnl < 0) {
      this.portfolio.losingTrades++;
    }

    const trade: TradeRecord = {
      entryIndex: this.position.entryIndex,
      exitIndex: this.currentIndex,
      entryPrice: this.position.entryPrice,
      exitPrice,
      side: this.position.side,
      pnl,
      pnlPercent,
      holdingPeriod: this.position.barsHeld,
    };

    this.trades.push(trade);
    this.position = null;

    return trade;
  }

  /**
   * Update unrealized PnL
   */
  private updatePositionPnL(currentPrice: number): void {
    if (!this.position) return;

    this.position.unrealizedPnL = this.position.side === 'long'
      ? (currentPrice - this.position.entryPrice) * this.position.size
      : (this.position.entryPrice - currentPrice) * this.position.size;
  }

  /**
   * Calculate reward for exit decisions
   */
  private calculateReward(
    previousEquity: number,
    trade: TradeRecord | undefined,
    action: ExitAction | null
  ): number {
    // Step-wise equity change
    const equityChange = (this.portfolio.equity - previousEquity) / previousEquity;
    let reward = Math.tanh(equityChange * 50); // Bounded PnL reward

    // Trade closed - add timing bonuses/penalties
    if (trade) {
      // Base trade reward
      if (trade.pnl > 0) {
        reward += 0.1; // Bonus for winning trade
      } else {
        reward -= 0.15; // Penalty for losing trade
      }

      // Timing bonus: exited near peak
      if (this.position === null && this.lastEntrySignal) {
        // Can't calculate peak comparison after close, skip
      }

      // Penalty for exiting too early on winners
      if (trade.pnl > 0 && trade.holdingPeriod < 5) {
        reward -= 0.05; // Premature exit penalty
      }
    }

    // Action-specific rewards (when in position)
    if (action !== null && this.position) {
      // Reward for tightening stop when profitable
      if (action === ExitActions.TIGHTEN_STOP && this.position.stopTightened) {
        reward += 0.02;
      }

      // Reward for taking partial at good level
      if (action === ExitActions.TAKE_PARTIAL && this.position.partialExitTaken) {
        reward += 0.03;
      }

      // Small penalty for holding too long
      if (action === ExitActions.HOLD && this.position.barsHeld > 30) {
        reward -= 0.01;
      }
    }

    return Math.max(-1.5, Math.min(1.5, reward));
  }

  /**
   * Calculate ATR
   */
  private calculateATR(candles: Candle[]): number {
    if (candles.length < 2) return 1;

    const trueRanges: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i]!.high;
      const low = candles[i]!.low;
      const prevClose = candles[i - 1]!.close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trueRanges.push(tr);
    }

    const period = Math.min(14, trueRanges.length);
    const atr = trueRanges.slice(-period).reduce((a, b) => a + b, 0) / period;

    return atr > 0 ? atr : 1;
  }

  // ============================================
  // Getters
  // ============================================

  getPortfolio(): Portfolio {
    return { ...this.portfolio };
  }

  getTrades(): TradeRecord[] {
    return [...this.trades];
  }

  getCurrentIndex(): number {
    return this.currentIndex;
  }

  isDone(): boolean {
    return this.done;
  }

  getCandles(): Candle[] {
    return this.candles;
  }

  getStateSize(): number {
    return this.stateBuilder.getFeatureSize(); // 18
  }

  isInPosition(): boolean {
    return this.position !== null;
  }

  getPosition(): HybridPosition | null {
    return this.position ? { ...this.position } : null;
  }

  /**
   * Get current state using the state builder (for consistent state representation)
   * Returns null if not in position
   */
  getCurrentState(): { features: number[] } | null {
    if (!this.position) return null;

    return this.stateBuilder.build(
      this.candles,
      this.currentIndex,
      this.position,
      this.training
    );
  }
}
