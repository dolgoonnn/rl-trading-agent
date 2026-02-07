/**
 * Trading Environment
 * Simulates a trading environment for RL agent training
 */

import type { Candle } from '@/types';
import type {
  Action,
  TradingState,
  StepResult,
  StepInfo,
  Portfolio,
  TradeRecord,
  EnvironmentConfig,
} from '../types';
import { Actions, actionToName } from '../types';
import { StateBuilder, StateBuilderConfig } from './state-builder';
import { RewardCalculator, RewardConfig } from './reward-calculator';
import { FeatureReducer } from './feature-reducer';

const DEFAULT_ENV_CONFIG: EnvironmentConfig = {
  initialCapital: 10000,
  positionSize: 0.1,
  maxPositionSize: 0.5,
  // Realistic transaction costs for crypto - prevents reward hacking
  spread: 0.0001, // 0.01% bid-ask spread (typical for BTC)
  commission: 0.001, // 0.1% per trade (typical exchange fee)
  slippage: 0.0005, // 0.05% slippage
  lookbackPeriod: 60,
  episodeLength: null,
  randomStart: false,
  maxDrawdownLimit: 0.2,
  // Risk management
  stopLossPercent: 0.02, // 2% stop loss
  takeProfitPercent: 0.04, // 4% take profit (2:1 R:R)
};

export class TradingEnvironment {
  private candles: Candle[];
  private config: EnvironmentConfig;
  private stateBuilder: StateBuilder;
  private rewardCalculator: RewardCalculator;
  private training: boolean;

  // Optional feature reducer for dimensionality reduction
  private featureReducer: FeatureReducer | null = null;

  // Episode state
  private currentIndex: number = 0;
  private startIndex: number = 0;
  private portfolio: Portfolio;
  private trades: TradeRecord[] = [];
  private recentReturns: number[] = [];
  private done: boolean = false;

  constructor(
    candles: Candle[],
    envConfig: Partial<EnvironmentConfig> = {},
    stateConfig: Partial<StateBuilderConfig> = {},
    rewardConfig: Partial<RewardConfig> = {},
    training: boolean = true,
    featureReducer?: FeatureReducer
  ) {
    this.candles = candles;
    this.config = { ...DEFAULT_ENV_CONFIG, ...envConfig };
    this.stateBuilder = new StateBuilder(stateConfig);
    this.rewardCalculator = new RewardCalculator(rewardConfig);
    this.portfolio = this.createInitialPortfolio();
    this.training = training;
    this.featureReducer = featureReducer ?? null;
  }

  private createInitialPortfolio(): Portfolio {
    return {
      cash: this.config.initialCapital,
      equity: this.config.initialCapital,
      position: null,
      realizedPnL: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      maxDrawdown: 0,
      peakEquity: this.config.initialCapital,
    };
  }

  /**
   * Reset environment to initial state
   */
  reset(): TradingState {
    // Determine starting index
    const minStart = this.config.lookbackPeriod;
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
    this.trades = [];
    this.recentReturns = [];
    this.done = false;

    return this.getState();
  }

  /**
   * Execute action and return new state, reward, done flag
   */
  step(action: Action): StepResult {
    if (this.done) {
      throw new Error('Episode is done. Call reset() to start a new episode.');
    }

    const previousEquity = this.portfolio.equity;
    const currentCandle = this.candles[this.currentIndex];
    if (!currentCandle) {
      throw new Error(`No candle at index ${this.currentIndex}`);
    }

    const currentPrice = currentCandle.close;
    let trade: TradeRecord | undefined;
    let isNewEntry = false; // Track if this action opens a new position

    // Check stop loss / take profit BEFORE executing new action
    const slTpTrade = this.checkStopLossTakeProfit(currentCandle);
    if (slTpTrade) {
      trade = slTpTrade;
    }

    // Check if we're opening a new position (was flat, now entering)
    const wasFlat = this.portfolio.position === null;

    // Execute action (only if we didn't just close via SL/TP)
    if (!trade) {
      switch (action) {
        case Actions.BUY:
          trade = this.executeBuy(currentPrice);
          isNewEntry = wasFlat && this.portfolio.position !== null;
          break;
        case Actions.SELL:
          trade = this.executeSell(currentPrice);
          isNewEntry = wasFlat && this.portfolio.position !== null;
          break;
        case Actions.CLOSE:
          trade = this.executeClose(currentPrice);
          break;
        case Actions.HOLD:
          // Do nothing
          break;
      }
    }

    // Update unrealized PnL
    this.updateUnrealizedPnL(currentPrice);

    // Update equity and drawdown
    this.portfolio.equity = this.portfolio.cash + (this.portfolio.position?.unrealizedPnL ?? 0);
    if (this.portfolio.equity > this.portfolio.peakEquity) {
      this.portfolio.peakEquity = this.portfolio.equity;
    }
    const currentDrawdown = (this.portfolio.peakEquity - this.portfolio.equity) / this.portfolio.peakEquity;
    this.portfolio.maxDrawdown = Math.max(this.portfolio.maxDrawdown, currentDrawdown);

    // Calculate step return
    const stepReturn = (this.portfolio.equity - previousEquity) / previousEquity;
    this.recentReturns.push(stepReturn);
    if (this.recentReturns.length > 50) {
      this.recentReturns.shift();
    }

    // Move to next candle
    this.currentIndex++;

    // Check if episode is done
    const reachedEnd = this.currentIndex >= this.candles.length - 1;
    const maxDrawdownExceeded = this.portfolio.maxDrawdown >= this.config.maxDrawdownLimit;
    const episodeLengthReached = this.config.episodeLength
      ? this.currentIndex - this.startIndex >= this.config.episodeLength
      : false;

    this.done = reachedEnd || maxDrawdownExceeded || episodeLengthReached;

    // Close any open position at end of episode
    if (this.done && this.portfolio.position) {
      trade = this.executeClose(currentPrice);
    }

    // Get current state
    const state = this.getState();

    // Calculate reward
    const rewardComponents = this.rewardCalculator.calculate({
      stepReturn,
      recentReturns: this.recentReturns,
      portfolio: this.portfolio,
      action,
      trade,
      ictContext: state.ict,
      holdingPeriod: this.portfolio.position
        ? this.currentIndex - this.portfolio.position.entryIndex
        : 0,
      isNewEntry, // Flag to penalize new position entries
    });

    const info: StepInfo = {
      action,
      actionName: actionToName(action),
      price: currentPrice,
      portfolio: { ...this.portfolio },
      trade,
      rewardComponents,
    };

    return {
      state,
      reward: rewardComponents.total,
      done: this.done,
      info,
    };
  }

  /**
   * Get current state
   * If a feature reducer is configured, it will be applied to reduce dimensionality
   */
  getState(): TradingState {
    const lookbackCandles = this.candles.slice(
      Math.max(0, this.currentIndex - this.config.lookbackPeriod),
      this.currentIndex + 1
    );

    const currentCandle = this.candles[this.currentIndex];
    if (!currentCandle) {
      throw new Error(`No candle at index ${this.currentIndex}`);
    }

    const state = this.stateBuilder.build(
      lookbackCandles,
      this.currentIndex,
      currentCandle.close,
      this.portfolio.position,
      this.training // Pass training flag for feature noise
    );

    // Apply feature reduction if configured
    if (this.featureReducer) {
      return this.featureReducer.fitTransformState(state);
    }

    return state;
  }

  /**
   * Execute buy order
   */
  private executeBuy(price: number): TradeRecord | undefined {
    // If already long, do nothing
    if (this.portfolio.position?.side === 'long') {
      return undefined;
    }

    // Close short if exists
    let closedTrade: TradeRecord | undefined;
    if (this.portfolio.position?.side === 'short') {
      closedTrade = this.executeClose(price);
    }

    // Calculate position size
    const positionValue = this.portfolio.cash * this.config.positionSize;
    const adjustedPrice = price * (1 + this.config.slippage); // Slippage on entry
    const size = positionValue / adjustedPrice;

    // Create position
    this.portfolio.position = {
      side: 'long',
      entryPrice: adjustedPrice,
      entryIndex: this.currentIndex,
      size,
      unrealizedPnL: 0,
    };

    // Deduct commission
    this.portfolio.cash -= this.config.commission;

    return closedTrade;
  }

  /**
   * Execute sell order
   */
  private executeSell(price: number): TradeRecord | undefined {
    // If already short, do nothing
    if (this.portfolio.position?.side === 'short') {
      return undefined;
    }

    // Close long if exists
    let closedTrade: TradeRecord | undefined;
    if (this.portfolio.position?.side === 'long') {
      closedTrade = this.executeClose(price);
    }

    // Calculate position size
    const positionValue = this.portfolio.cash * this.config.positionSize;
    const adjustedPrice = price * (1 - this.config.slippage); // Slippage on entry
    const size = positionValue / adjustedPrice;

    // Create position
    this.portfolio.position = {
      side: 'short',
      entryPrice: adjustedPrice,
      entryIndex: this.currentIndex,
      size,
      unrealizedPnL: 0,
    };

    // Deduct commission
    this.portfolio.cash -= this.config.commission;

    return closedTrade;
  }

  /**
   * Close current position
   */
  private executeClose(price: number): TradeRecord | undefined {
    const position = this.portfolio.position;
    if (!position) {
      return undefined;
    }

    // Calculate exit price with slippage
    const exitPrice = position.side === 'long'
      ? price * (1 - this.config.slippage)
      : price * (1 + this.config.slippage);

    // Calculate PnL
    const pnl = position.side === 'long'
      ? (exitPrice - position.entryPrice) * position.size
      : (position.entryPrice - exitPrice) * position.size;

    const pnlPercent = pnl / (position.entryPrice * position.size);

    // Update portfolio
    this.portfolio.cash += pnl - this.config.commission;
    this.portfolio.realizedPnL += pnl;
    this.portfolio.totalTrades++;

    if (pnl > 0) {
      this.portfolio.winningTrades++;
    } else if (pnl < 0) {
      this.portfolio.losingTrades++;
    }

    // Create trade record
    const trade: TradeRecord = {
      entryIndex: position.entryIndex,
      exitIndex: this.currentIndex,
      entryPrice: position.entryPrice,
      exitPrice,
      side: position.side,
      pnl,
      pnlPercent,
      holdingPeriod: this.currentIndex - position.entryIndex,
    };

    this.trades.push(trade);

    // Clear position
    this.portfolio.position = null;

    return trade;
  }

  /**
   * Update unrealized PnL for current position
   */
  private updateUnrealizedPnL(currentPrice: number): void {
    const position = this.portfolio.position;
    if (!position) return;

    position.unrealizedPnL = position.side === 'long'
      ? (currentPrice - position.entryPrice) * position.size
      : (position.entryPrice - currentPrice) * position.size;
  }

  /**
   * Check if stop loss or take profit has been hit
   * Uses candle high/low to check intra-bar price action
   */
  private checkStopLossTakeProfit(candle: Candle): TradeRecord | undefined {
    const position = this.portfolio.position;
    if (!position) return undefined;

    const stopLossPercent = this.config.stopLossPercent ?? 0.02; // Default 2%
    const takeProfitPercent = this.config.takeProfitPercent ?? 0.04; // Default 4%

    if (position.side === 'long') {
      // Long position - SL below entry, TP above entry
      const stopPrice = position.entryPrice * (1 - stopLossPercent);
      const takeProfitPrice = position.entryPrice * (1 + takeProfitPercent);

      // Check if low hit stop loss
      if (candle.low <= stopPrice) {
        return this.executeCloseAtPrice(stopPrice, 'stop_loss');
      }

      // Check if high hit take profit
      if (candle.high >= takeProfitPrice) {
        return this.executeCloseAtPrice(takeProfitPrice, 'take_profit');
      }
    } else {
      // Short position - SL above entry, TP below entry
      const stopPrice = position.entryPrice * (1 + stopLossPercent);
      const takeProfitPrice = position.entryPrice * (1 - takeProfitPercent);

      // Check if high hit stop loss
      if (candle.high >= stopPrice) {
        return this.executeCloseAtPrice(stopPrice, 'stop_loss');
      }

      // Check if low hit take profit
      if (candle.low <= takeProfitPrice) {
        return this.executeCloseAtPrice(takeProfitPrice, 'take_profit');
      }
    }

    return undefined;
  }

  /**
   * Close position at a specific price (for SL/TP execution)
   */
  private executeCloseAtPrice(price: number, _reason: 'stop_loss' | 'take_profit'): TradeRecord | undefined {
    const position = this.portfolio.position;
    if (!position) return undefined;

    // Apply slippage (worse execution for SL)
    const exitPrice = position.side === 'long'
      ? price * (1 - this.config.slippage)
      : price * (1 + this.config.slippage);

    // Calculate PnL
    const pnl = position.side === 'long'
      ? (exitPrice - position.entryPrice) * position.size
      : (position.entryPrice - exitPrice) * position.size;

    const pnlPercent = pnl / (position.entryPrice * position.size);

    // Update portfolio
    this.portfolio.cash += pnl - this.config.commission;
    this.portfolio.realizedPnL += pnl;
    this.portfolio.totalTrades++;

    if (pnl > 0) {
      this.portfolio.winningTrades++;
    } else if (pnl < 0) {
      this.portfolio.losingTrades++;
    }

    // Create trade record
    const trade: TradeRecord = {
      entryIndex: position.entryIndex,
      exitIndex: this.currentIndex,
      entryPrice: position.entryPrice,
      exitPrice,
      side: position.side,
      pnl,
      pnlPercent,
      holdingPeriod: this.currentIndex - position.entryIndex,
    };

    this.trades.push(trade);
    this.portfolio.position = null;

    return trade;
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
    // If feature reducer is ready, return reduced size
    if (this.featureReducer && this.featureReducer.isReady()) {
      return this.featureReducer.getOutputDimension();
    }
    return this.stateBuilder.getFeatureSize();
  }

  /**
   * Get the raw (unreduced) state size
   */
  getRawStateSize(): number {
    return this.stateBuilder.getFeatureSize();
  }

  /**
   * Get the feature reducer (if configured)
   */
  getFeatureReducer(): FeatureReducer | null {
    return this.featureReducer;
  }

  /**
   * Set or update the feature reducer
   * Use this to share a fitted reducer across multiple environments
   */
  setFeatureReducer(reducer: FeatureReducer | null): void {
    this.featureReducer = reducer;
  }

  /**
   * Get state at a specific index (for dataset export)
   * Does not modify the environment state
   * Applies feature reduction if configured
   */
  getStateAt(index: number): TradingState | null {
    if (index < this.config.lookbackPeriod || index >= this.candles.length) {
      return null;
    }

    const lookbackCandles = this.candles.slice(
      Math.max(0, index - this.config.lookbackPeriod),
      index + 1
    );

    const currentCandle = this.candles[index];
    if (!currentCandle) {
      return null;
    }

    const state = this.stateBuilder.build(
      lookbackCandles,
      index,
      currentCandle.close,
      null // No position when exporting features
    );

    // Apply feature reduction if configured and ready
    if (this.featureReducer && this.featureReducer.isReady()) {
      return {
        ...state,
        features: this.featureReducer.transform(state.features),
      };
    }

    return state;
  }
}
