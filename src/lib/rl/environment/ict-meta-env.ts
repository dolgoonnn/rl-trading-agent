/**
 * ICT Meta-Strategy Environment
 *
 * A trading environment where the RL agent selects which ICT strategy to use
 * rather than directly predicting price movements.
 *
 * Architecture:
 * - Agent receives 42-feature state (18 base + 20 strategy + 4 KB)
 * - Agent outputs 1 of 5 strategies: WAIT, ORDER_BLOCK, FVG, BOS_CONTINUATION, CHOCH_REVERSAL
 * - Selected strategy executes using rule-based ICT detection
 * - KB reward shaping provides bonuses for ICT-aligned decisions
 *
 * Feature breakdown:
 * - Base features (18): price, returns, volatility, structure, position
 * - Strategy features (20): OB, FVG, BOS, CHoCH specific signals
 * - KB features (4): knowledge base alignment scores
 *
 * NOTE: Multi-period features (6) were tested in EXP-015 but hurt performance - removed.
 *
 * This approach:
 * 1. Is more interpretable (we know WHY agent traded)
 * 2. Leverages proven ICT concepts
 * 3. Uses KB for principled guidance
 * 4. Reduces overfitting (strategies are rule-based)
 */

import type { Candle } from '@/types';
import type {
  Portfolio,
  TradeRecord,
  HybridPosition,
  ConfluenceLevel,
} from '../types';
import {
  ICTStrategyManager,
  type StrategyAction,
  type StrategySignal,
  type StrategyName,
  type ICTStrategyContext,
  StrategyActions,
  STRATEGY_COUNT,
  strategyActionToName,
} from '../strategies';
import {
  KBConceptMatcher,
  KBRewardShaper,
  type KBContext,
  type KBRewardResult,
  type KBIntegrationConfig,
  DEFAULT_KB_CONFIG,
} from '../kb-integration';

// ============================================
// Types
// ============================================

/** State representation for meta-strategy agent */
export interface MetaStrategyState {
  /** Combined features (42 total) */
  features: number[];
  /** Current ICT context */
  ictContext: ICTStrategyContext;
  /** Current KB context (if enabled) */
  kbContext: KBContext | null;
  /** Price info */
  currentPrice: number;
  timestamp: number;
  currentIndex: number;
}

/** Step result from meta-strategy environment */
export interface MetaStrategyStepResult {
  state: MetaStrategyState | null;
  reward: number;
  done: boolean;
  info: MetaStrategyStepInfo;
}

/** Detailed step info */
export interface MetaStrategyStepInfo {
  action: StrategyAction | null;
  strategyName: StrategyName | 'waiting';
  signal: StrategySignal | null;
  trade: TradeRecord | null;
  portfolio: Portfolio;
  inPosition: boolean;
  kbReward: KBRewardResult | null;
  kbExplanation: string | null;
}

/** Environment configuration */
export interface MetaStrategyEnvConfig {
  // Capital
  initialCapital: number;
  positionSizePercent: number;

  // Costs
  commission: number;
  slippage: number;

  // Episode
  lookbackPeriod: number;
  maxBarsPerEpisode: number | null;
  randomStart: boolean;

  // Risk
  maxDrawdownLimit: number;
  maxBarsInPosition: number;

  // KB integration
  kbConfig: Partial<KBIntegrationConfig>;
}

const DEFAULT_CONFIG: MetaStrategyEnvConfig = {
  initialCapital: 10000,
  positionSizePercent: 0.1,
  commission: 0.001,
  slippage: 0.0005,
  lookbackPeriod: 100,
  maxBarsPerEpisode: null,
  randomStart: false,
  maxDrawdownLimit: 0.15,
  maxBarsInPosition: 100,
  kbConfig: {},
};

// ============================================
// Meta-Strategy Environment
// ============================================

export class ICTMetaStrategyEnvironment {
  private candles: Candle[];
  private config: MetaStrategyEnvConfig;
  private kbConfig: KBIntegrationConfig;

  // Managers
  private strategyManager: ICTStrategyManager;
  private conceptMatcher: KBConceptMatcher;
  private rewardShaper: KBRewardShaper;

  // Episode state
  private currentIndex: number = 0;
  private startIndex: number = 0;
  private portfolio: Portfolio;
  private position: HybridPosition | null = null;
  private currentStrategy: StrategyName | null = null;
  private trades: TradeRecord[] = [];
  private done: boolean = false;
  protected training: boolean = true;

  // KB state
  private currentKBContext: KBContext | null = null;
  private lastKBReward: KBRewardResult | null = null;
  private kbInitialized: boolean = false;

  // Tracking
  private barsWithoutTrade: number = 0;
  private consecutiveWaits: number = 0;
  private barsSinceLastTrade: number = 0; // Cooldown tracking
  private minCooldownBars: number = 3; // Balanced cooldown
  private lastTradeWon: boolean | null = null; // Track last trade result

  // Risk tracking (Sortino-based)
  private downsideReturns: number[] = []; // For downside deviation
  private episodeBars: number = 0; // Track bars in episode for trade frequency

  constructor(
    candles: Candle[],
    config: Partial<MetaStrategyEnvConfig> = {},
    training: boolean = true
  ) {
    this.candles = candles;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.kbConfig = { ...DEFAULT_KB_CONFIG, ...this.config.kbConfig };
    this.training = training;

    this.strategyManager = new ICTStrategyManager();
    this.conceptMatcher = new KBConceptMatcher(this.kbConfig);
    this.rewardShaper = new KBRewardShaper(this.kbConfig);

    this.portfolio = this.createInitialPortfolio();
  }

  // ============================================
  // Initialization
  // ============================================

  async initializeKB(): Promise<void> {
    if (this.kbInitialized) return;

    await this.conceptMatcher.initialize();
    this.kbInitialized = true;
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

  // ============================================
  // Episode Management
  // ============================================

  reset(): MetaStrategyState | null {
    // Set starting index
    const minStart = this.config.lookbackPeriod;
    const maxStart = this.config.maxBarsPerEpisode
      ? Math.max(minStart, this.candles.length - this.config.maxBarsPerEpisode)
      : minStart;

    if (this.config.randomStart && maxStart > minStart) {
      this.startIndex = minStart + Math.floor(Math.random() * (maxStart - minStart));
    } else {
      this.startIndex = minStart;
    }

    this.currentIndex = this.startIndex;
    this.portfolio = this.createInitialPortfolio();
    this.position = null;
    this.currentStrategy = null;
    this.trades = [];
    this.done = false;
    this.barsWithoutTrade = 0;
    this.consecutiveWaits = 0;
    this.barsSinceLastTrade = 100; // Allow immediate trading at start
    this.lastTradeWon = null;
    this.currentKBContext = null;
    this.downsideReturns = [];
    this.episodeBars = 0;
    this.lastKBReward = null;

    return this.getState();
  }

  // ============================================
  // Step
  // ============================================

  step(action: StrategyAction | null): MetaStrategyStepResult {
    if (this.done) {
      throw new Error('Episode is done. Call reset() first.');
    }

    const previousEquity = this.portfolio.equity;
    const current = this.candles[this.currentIndex];
    if (!current) {
      throw new Error(`No candle at index ${this.currentIndex}`);
    }

    let trade: TradeRecord | null = null;
    let signal: StrategySignal | null = null;

    // Build ICT context
    const ictContext = this.strategyManager.buildContext(this.candles, this.currentIndex);

    // If in position, check for exit
    if (this.position) {
      trade = this.checkAndExecuteExit(current, ictContext);

      // If position still open, check for stop loss / take profit / max bars
      if (this.position) {
        trade = this.checkStopLossTakeProfit(current);
      }
    }

    // Increment cooldown counter
    this.barsSinceLastTrade++;

    // If not in position and action provided, execute strategy
    if (!this.position && action !== null) {
      const strategyName = strategyActionToName(action);

      if (action === StrategyActions.WAIT) {
        this.consecutiveWaits++;
      } else {
        this.consecutiveWaits = 0;

        // Check cooldown - skip if traded too recently
        const cooldownActive = this.barsSinceLastTrade < this.minCooldownBars;

        // Increase cooldown after loss (loss avoidance)
        const effectiveCooldown = this.lastTradeWon === false
          ? this.minCooldownBars * 2
          : this.minCooldownBars;

        if (cooldownActive && this.barsSinceLastTrade < effectiveCooldown) {
          // Cooldown active - don't trade yet, but don't penalize
          this.barsWithoutTrade++;
        } else {
          // Execute strategy with RSI quality filter
          signal = this.strategyManager.executeStrategy(action, this.candles, this.currentIndex, ictContext);

          if (signal) {
            // Quality filter: BALANCED with REGIME AWARENESS
            const trendAligned =
              (signal.direction === 'long' && ictContext.structure.bias === 'bullish') ||
              (signal.direction === 'short' && ictContext.structure.bias === 'bearish');

            // Regime detection: avoid choppy/unclear markets
            const hasRecentStructure = ictContext.structure.structureBreaks.some(
              (sb) => this.currentIndex - sb.breakIndex <= 20
            );
            const hasClearBias = ictContext.structure.bias !== 'neutral';

            // CHoCH is a REVERSAL strategy - it trades AGAINST the current trend by design
            // So trendAligned will be FALSE for valid CHoCH signals, which is expected
            const isReversalStrategy = signal.strategy === 'choch_reversal';

            // Quality requirements
            const highQuality =
              (signal.confidence >= 0.5 && (hasRecentStructure || hasClearBias)) || // Good confidence + structure
              (trendAligned && hasClearBias) || // Trend alignment + clear bias
              signal.riskReward >= 2.0 || // OR excellent R:R setup
              (isReversalStrategy && signal.confidence >= 0.4 && hasRecentStructure); // Reversal trades need recent structure

            if (highQuality) {
              this.openPosition(signal, current);
              this.currentStrategy = strategyName;
              this.barsWithoutTrade = 0;
              this.barsSinceLastTrade = 0; // Reset cooldown
            } else {
              signal = null; // Filter out low-quality signal
              this.barsWithoutTrade++;
            }
          } else {
            this.barsWithoutTrade++;
          }
        }
      }
    }

    // Update unrealized PnL
    this.updateUnrealizedPnL(current.close);

    // Update equity and drawdown
    this.portfolio.equity = this.portfolio.cash + (this.position?.unrealizedPnL ?? 0);
    if (this.portfolio.equity > this.portfolio.peakEquity) {
      this.portfolio.peakEquity = this.portfolio.equity;
    }
    const currentDrawdown = (this.portfolio.peakEquity - this.portfolio.equity) / this.portfolio.peakEquity;
    this.portfolio.maxDrawdown = Math.max(this.portfolio.maxDrawdown, currentDrawdown);

    // Move to next bar
    this.currentIndex++;
    this.episodeBars++;

    // Check episode end conditions
    const reachedEnd = this.currentIndex >= this.candles.length - 1;
    const maxDrawdownExceeded = this.portfolio.maxDrawdown >= this.config.maxDrawdownLimit;
    const episodeLengthReached = this.config.maxBarsPerEpisode
      ? this.currentIndex - this.startIndex >= this.config.maxBarsPerEpisode
      : false;

    this.done = reachedEnd || maxDrawdownExceeded || episodeLengthReached;

    // Force close position at episode end
    if (this.done && this.position) {
      trade = this.closePosition(current.close, 'episode_end');
    }

    // Calculate reward
    const reward = this.calculateReward(
      action,
      signal,
      trade,
      previousEquity,
      ictContext
    );

    // Get new state
    const state = this.done ? null : this.getState();

    return {
      state,
      reward,
      done: this.done,
      info: {
        action,
        strategyName: action !== null ? strategyActionToName(action) : 'waiting',
        signal,
        trade,
        portfolio: { ...this.portfolio },
        inPosition: this.position !== null,
        kbReward: this.lastKBReward,
        kbExplanation: this.currentKBContext?.explanation ?? null,
      },
    };
  }

  // ============================================
  // Position Management
  // ============================================

  private openPosition(signal: StrategySignal, _candle: Candle): void {
    const positionValue = this.portfolio.cash * this.config.positionSizePercent;
    const adjustedEntry = signal.direction === 'long'
      ? signal.entryPrice * (1 + this.config.slippage)
      : signal.entryPrice * (1 - this.config.slippage);
    const size = positionValue / adjustedEntry;

    // Map confidence to confluence level
    let confluenceLevel: ConfluenceLevel = 'C';
    if (signal.confidence >= 0.8) confluenceLevel = 'A+';
    else if (signal.confidence >= 0.7) confluenceLevel = 'A';
    else if (signal.confidence >= 0.5) confluenceLevel = 'B';

    this.position = {
      side: signal.direction,
      entryPrice: adjustedEntry,
      entryIndex: this.currentIndex,
      size,
      unrealizedPnL: 0,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      confluenceLevel,
      entryATR: Math.abs(signal.takeProfit - signal.entryPrice) / 3,
      peakPnL: 0,
      barsHeld: 0,
      partialExitTaken: false,
      stopTightened: false,
      trailingLevel: 0,
    };

    // Deduct commission
    this.portfolio.cash -= this.config.commission * positionValue;
  }

  private checkAndExecuteExit(candle: Candle, ictContext: ICTStrategyContext): TradeRecord | null {
    if (!this.position || !this.currentStrategy) return null;

    // Increment bars held
    this.position.barsHeld++;

    // Check strategy-specific exit
    const exitSignal = this.strategyManager.checkExit(
      this.currentStrategy,
      this.position,
      this.candles,
      this.currentIndex,
      ictContext
    );

    if (exitSignal.shouldExit && exitSignal.confidence > 0.5) {
      return this.closePosition(candle.close, 'strategy_exit');
    }

    // Check max bars
    if (this.position.barsHeld >= this.config.maxBarsInPosition) {
      return this.closePosition(candle.close, 'max_bars');
    }

    return null;
  }

  private checkStopLossTakeProfit(candle: Candle): TradeRecord | null {
    if (!this.position) return null;

    if (this.position.side === 'long') {
      if (candle.low <= this.position.stopLoss) {
        return this.closePosition(this.position.stopLoss, 'stop_loss');
      }
      if (candle.high >= this.position.takeProfit) {
        return this.closePosition(this.position.takeProfit, 'take_profit');
      }
    } else {
      if (candle.high >= this.position.stopLoss) {
        return this.closePosition(this.position.stopLoss, 'stop_loss');
      }
      if (candle.low <= this.position.takeProfit) {
        return this.closePosition(this.position.takeProfit, 'take_profit');
      }
    }

    return null;
  }

  private closePosition(exitPrice: number, _reason: string): TradeRecord | null {
    if (!this.position) return null;

    // Apply slippage
    const adjustedExit = this.position.side === 'long'
      ? exitPrice * (1 - this.config.slippage)
      : exitPrice * (1 + this.config.slippage);

    // Calculate PnL
    const pnl = this.position.side === 'long'
      ? (adjustedExit - this.position.entryPrice) * this.position.size
      : (this.position.entryPrice - adjustedExit) * this.position.size;

    const pnlPercent = pnl / (this.position.entryPrice * this.position.size);

    // Update portfolio
    this.portfolio.cash += pnl - this.config.commission * Math.abs(pnl);
    this.portfolio.realizedPnL += pnl;
    this.portfolio.totalTrades++;

    if (pnl > 0) {
      this.portfolio.winningTrades++;
      this.lastTradeWon = true;
    } else if (pnl < 0) {
      this.portfolio.losingTrades++;
      this.lastTradeWon = false;
    }

    // Create trade record
    const trade: TradeRecord = {
      entryIndex: this.position.entryIndex,
      exitIndex: this.currentIndex,
      entryPrice: this.position.entryPrice,
      exitPrice: adjustedExit,
      side: this.position.side,
      pnl,
      pnlPercent,
      holdingPeriod: this.position.barsHeld,
    };

    this.trades.push(trade);

    // Clear position
    this.position = null;
    this.currentStrategy = null;

    return trade;
  }

  private updateUnrealizedPnL(currentPrice: number): void {
    if (!this.position) return;

    this.position.unrealizedPnL = this.position.side === 'long'
      ? (currentPrice - this.position.entryPrice) * this.position.size
      : (this.position.entryPrice - currentPrice) * this.position.size;

    // Track peak PnL for trailing
    if (this.position.unrealizedPnL > this.position.peakPnL) {
      this.position.peakPnL = this.position.unrealizedPnL;
    }
  }

  // ============================================
  // State Building
  // ============================================

  getState(): MetaStrategyState | null {
    if (this.currentIndex >= this.candles.length) return null;

    const current = this.candles[this.currentIndex];
    if (!current) return null;

    // Build ICT context
    const ictContext = this.strategyManager.buildContext(this.candles, this.currentIndex);

    // Get base features (18)
    const baseFeatures = this.buildBaseFeatures(current, ictContext);

    // Get strategy features (20)
    const strategyFeatures = this.strategyManager.getCombinedFeatures(
      this.candles,
      this.currentIndex,
      ictContext
    );

    // Get KB features (4) - sync version using cached context
    const kbFeatures = this.buildKBFeatures();

    // Combine all features
    const features = [...baseFeatures, ...strategyFeatures, ...kbFeatures];

    return {
      features,
      ictContext,
      kbContext: this.currentKBContext,
      currentPrice: current.close,
      timestamp: current.timestamp,
      currentIndex: this.currentIndex,
    };
  }

  private buildBaseFeatures(candle: Candle, ctx: ICTStrategyContext): number[] {
    const features: number[] = [];

    // Price features (6)
    const lookback = this.candles.slice(
      Math.max(0, this.currentIndex - 20),
      this.currentIndex + 1
    );

    // Returns
    const returns1 = lookback.length >= 2
      ? (candle.close - lookback[lookback.length - 2]!.close) / lookback[lookback.length - 2]!.close
      : 0;
    features.push(Math.tanh(returns1 * 100));

    const returns5 = lookback.length >= 6
      ? (candle.close - lookback[lookback.length - 6]!.close) / lookback[lookback.length - 6]!.close
      : 0;
    features.push(Math.tanh(returns5 * 50));

    const returns10 = lookback.length >= 11
      ? (candle.close - lookback[lookback.length - 11]!.close) / lookback[lookback.length - 11]!.close
      : 0;
    features.push(Math.tanh(returns10 * 30));

    // Volatility (ATR normalized)
    features.push(Math.min(1, ctx.atr / candle.close * 100));

    // Price position in recent range
    const recentHigh = Math.max(...lookback.map((c) => c.high));
    const recentLow = Math.min(...lookback.map((c) => c.low));
    const range = recentHigh - recentLow;
    features.push(range > 0 ? (candle.close - recentLow) / range : 0.5);

    // Candle body ratio
    const bodySize = Math.abs(candle.close - candle.open);
    const totalRange = candle.high - candle.low;
    features.push(totalRange > 0 ? bodySize / totalRange : 0.5);

    // ============================================
    // Multi-period features (EXP-020) - DISABLED
    // Tested in EXP-015 with Dueling DQN - hurt performance significantly
    // BTC Sharpe went from +8.11 to -8.77
    // Keep commented for future experimentation
    // ============================================

    // Structure features (6)
    // Bias encoding
    features.push(ctx.structure.bias === 'bullish' ? 1 : ctx.structure.bias === 'bearish' ? -1 : 0);

    // Recent structure breaks
    const recentBOS = ctx.structure.structureBreaks.filter(
      (sb) => sb.type === 'bos' && this.currentIndex - sb.breakIndex <= 20
    );
    const recentCHoCH = ctx.structure.structureBreaks.filter(
      (sb) => sb.type === 'choch' && this.currentIndex - sb.breakIndex <= 20
    );

    features.push(recentBOS.length > 0 ? recentBOS[recentBOS.length - 1]!.direction === 'bullish' ? 1 : -1 : 0);
    features.push(Math.min(1, recentBOS.length / 5));
    features.push(recentCHoCH.length > 0 ? recentCHoCH[recentCHoCH.length - 1]!.direction === 'bullish' ? 1 : -1 : 0);
    features.push(Math.min(1, recentCHoCH.length / 3));

    // Swing structure trend
    const swingTrend = this.calculateSwingTrend(ctx.structure);
    features.push(swingTrend);

    // Position features (6)
    if (this.position) {
      features.push(this.position.side === 'long' ? 1 : -1);
      features.push(Math.tanh(this.position.unrealizedPnL / (this.config.initialCapital * 0.01)));
      features.push(Math.min(1, this.position.barsHeld / 50));
      features.push(Math.max(-1, Math.min(1,
        (candle.close - this.position.stopLoss) / ctx.atr * (this.position.side === 'long' ? 1 : -1)
      )));
      features.push(Math.max(-1, Math.min(1,
        (this.position.takeProfit - candle.close) / ctx.atr * (this.position.side === 'long' ? 1 : -1)
      )));
      features.push(this.position.peakPnL > 0
        ? Math.max(0, (this.position.peakPnL - this.position.unrealizedPnL) / this.position.peakPnL)
        : 0
      );
    } else {
      features.push(0, 0, 0, 0, 0, 0);
    }

    return features;
  }

  private buildKBFeatures(): number[] {
    if (!this.kbConfig.enabled || !this.currentKBContext) {
      return [0, 0, 0, 0];
    }

    return [
      this.currentKBContext.matches[0]?.similarity ?? 0,
      Math.min(1, this.currentKBContext.matches.length / 5),
      (this.currentKBContext.alignmentScore + 1) / 2, // Normalize -1,1 to 0,1
      this.currentKBContext.alignedRules.length / Math.max(1,
        this.currentKBContext.alignedRules.length + this.currentKBContext.conflictingRules.length
      ),
    ];
  }

  private calculateSwingTrend(structure: ICTStrategyContext['structure']): number {
    const highs = structure.swingHighs.slice(-3);
    const lows = structure.swingLows.slice(-3);

    if (highs.length < 2 || lows.length < 2) return 0;

    let hhCount = 0;
    let llCount = 0;

    for (let i = 1; i < highs.length; i++) {
      if (highs[i]!.price > highs[i - 1]!.price) hhCount++;
    }
    for (let i = 1; i < lows.length; i++) {
      if (lows[i]!.price < lows[i - 1]!.price) llCount++;
    }

    const total = Math.max(1, (highs.length - 1) + (lows.length - 1));
    return (hhCount - llCount) / total;
  }

  // ============================================
  // Reward Calculation
  // ============================================

  private calculateReward(
    action: StrategyAction | null,
    signal: StrategySignal | null,
    trade: TradeRecord | null,
    previousEquity: number,
    ictContext: ICTStrategyContext
  ): number {
    let reward = 0;

    // PnL-based reward
    const equityChange = (this.portfolio.equity - previousEquity) / previousEquity;
    reward += Math.tanh(equityChange * 50) * 0.5;

    // Trade outcome reward - LARGE BONUS for winning, penalty for losing
    if (trade) {
      if (trade.pnl > 0) {
        // Winning trade: large bonus
        reward += 0.2 + Math.tanh(trade.pnlPercent * 30) * 1.5;
      } else {
        // Losing trade: smaller penalty to encourage trying
        reward += 0.03 + Math.tanh(trade.pnlPercent * 30) * 1.0;
      }
    }

    // Strategy selection reward - SIGNIFICANTLY INCREASED (Iteration 3)
    if (action !== null && action !== StrategyActions.WAIT) {
      // Large exploration bonus for trying strategies (even without signal)
      reward += 0.08;

      // CHoCH exploration bonus - encourage trying CHoCH when CHoCH events exist
      const hasChochOpportunity = ictContext.structure.structureBreaks.some(
        (sb) => sb.type === 'choch' && this.currentIndex - sb.breakIndex <= 30 && sb.confidence >= 0.4
      );
      if (action === StrategyActions.CHOCH_REVERSAL && hasChochOpportunity) {
        reward += 0.05; // Extra bonus for selecting CHoCH when opportunity exists
      }

      if (signal) {
        // Large reward for successful signal generation
        reward += 0.15 + signal.confidence * 0.1;

        // Extra reward for high R:R setups
        if (signal.riskReward >= 2) {
          reward += 0.05;
        }
        if (signal.riskReward >= 3) {
          reward += 0.05;
        }

        // === KILL ZONE TIMING BONUS (Research: institutional activity peaks during sessions) ===
        if (ictContext.killZone?.inKillZone) {
          reward += 0.08; // Bonus for trading during London/NY sessions
          if (ictContext.killZone.name === 'London' || ictContext.killZone.name === 'New York AM') {
            reward += 0.05; // Extra bonus for highest-volume sessions
          }
        }

        // === OB+FVG CONFLUENCE BONUS (Research: highest probability zones) ===
        const hasOBandFVGConfluence = signal.orderBlock && signal.fvg;
        if (hasOBandFVGConfluence) {
          reward += 0.12; // Significant bonus for OB+FVG alignment
        }

        // === LIQUIDITY SWEEP BONUS (Research: confirms institutional activity) ===
        if (ictContext.recentSweeps && ictContext.recentSweeps.length > 0) {
          const recentSweep = ictContext.recentSweeps.find(
            (s) => this.currentIndex - s.index <= 10
          );
          if (recentSweep) {
            const sweepAligned =
              (signal.direction === 'long' && recentSweep.level.type === 'ssl') ||
              (signal.direction === 'short' && recentSweep.level.type === 'bsl');
            if (sweepAligned) {
              reward += 0.08; // Bonus for liquidity sweep confirmation
            }
          }
        }

        // TREND ALIGNMENT BONUS - trade with the trend
        const trendAligned =
          (signal.direction === 'long' && ictContext.structure.bias === 'bullish') ||
          (signal.direction === 'short' && ictContext.structure.bias === 'bearish');

        // CHoCH REVERSAL BONUS - reversal strategies trade AGAINST trend by design
        const isReversalStrategy = signal.strategy === 'choch_reversal';
        const hasRecentChoch = ictContext.structure.structureBreaks.some(
          (sb) => sb.type === 'choch' && this.currentIndex - sb.breakIndex <= 15
        );

        if (trendAligned && !isReversalStrategy) {
          reward += 0.1; // Bonus for trend-following strategies trading with trend
        } else if (isReversalStrategy && hasRecentChoch && !trendAligned) {
          // CHoCH correctly identified reversal - HIGHER bonus to encourage exploration
          reward += 0.15; // Extra bonus for correct reversal identification
        }
      } else {
        // Small penalty for strategy that didn't produce signal (reduced)
        reward -= 0.01;
      }
    }

    // Wait strategy - HEAVY PENALTIES (Iteration 3)
    if (action === StrategyActions.WAIT) {
      // Base penalty for waiting
      reward -= 0.02;

      if (this.hasGoodSetup(ictContext)) {
        // Large penalty for waiting when good setups exist
        reward -= 0.08;
      }
      // Penalty for consecutive waits (kicks in immediately, exponential)
      if (this.consecutiveWaits > 2) {
        const excessWaits = this.consecutiveWaits - 2;
        reward -= 0.03 * Math.pow(1.2, Math.min(excessWaits, 10));
      }
    }

    // KB reward shaping
    if (this.kbConfig.enabled && this.kbConfig.useKBRewardShaping && action !== null) {
      // Use position side if in position, otherwise infer from action
      const positionSide: 'long' | 'short' = this.position?.side ?? (
        signal?.direction ?? 'long'
      );

      // Map StrategyAction to ExitAction equivalent for KB reward shaping
      // WAIT(0)->HOLD(0), ORDER_BLOCK(1)->EXIT_MARKET(1), FVG(2)->TIGHTEN_STOP(2),
      // BOS_CONTINUATION(3)->TAKE_PARTIAL(3), CHOCH_REVERSAL(4)->HOLD(0)
      const mappedAction = action === 4 ? 0 : action;
      const { reward: shapedReward, result } = this.rewardShaper.shapeReward(
        reward,
        this.currentKBContext,
        mappedAction as 0 | 1 | 2 | 3,
        positionSide,
        trade !== null,
        trade?.pnl
      );

      reward = shapedReward;
      this.lastKBReward = result;
    }

    // === RISK-ADJUSTED PENALTIES (Research: balance return and risk) ===

    // Track downside returns for Sortino-style penalty
    if (trade && trade.pnl < 0) {
      this.downsideReturns.push(trade.pnlPercent);
    }

    // Downside deviation penalty (Sortino-inspired)
    if (this.downsideReturns.length >= 3) {
      const meanDownside = this.downsideReturns.reduce((a, b) => a + b, 0) / this.downsideReturns.length;
      const downsideDeviation = Math.sqrt(
        this.downsideReturns.reduce((sum, r) => sum + Math.pow(r - meanDownside, 2), 0) / this.downsideReturns.length
      );
      // Penalty for high downside volatility
      if (downsideDeviation > 0.02) {
        reward -= (downsideDeviation - 0.02) * 5;
      }
    }

    // Overtrading penalty (Research: excessive trading hurts returns)
    const tradesPerHundredBars = this.episodeBars > 0 ? (this.portfolio.totalTrades / this.episodeBars) * 100 : 0;
    if (tradesPerHundredBars > 8) {
      // More than 8 trades per 100 bars = overtrading
      reward -= (tradesPerHundredBars - 8) * 0.02;
    }

    // Drawdown penalty
    if (this.portfolio.maxDrawdown > 0.05) {
      reward -= (this.portfolio.maxDrawdown - 0.05) * 2;
    }

    return reward;
  }

  private hasGoodSetup(ctx: ICTStrategyContext): boolean {
    // Check for unmitigated OBs
    const activeOBs = ctx.orderBlocks.filter(
      (ob) => ob.status === 'unmitigated' && this.currentIndex - ob.index <= 50
    );

    // Check for unfilled FVGs
    const activeFVGs = ctx.fvgs.filter(
      (fvg) => fvg.status !== 'filled' && this.currentIndex - fvg.index <= 30
    );

    // Check for recent structure breaks
    const recentBreaks = ctx.structure.structureBreaks.filter(
      (sb) => this.currentIndex - sb.breakIndex <= 15
    );

    return activeOBs.length > 0 || activeFVGs.length > 0 || recentBreaks.length > 0;
  }

  // ============================================
  // KB Integration
  // ============================================

  async refreshKBContext(): Promise<void> {
    if (!this.kbConfig.enabled || !this.kbInitialized) return;

    const current = this.candles[this.currentIndex];
    if (!current) return;

    const ictContext = this.strategyManager.buildContext(this.candles, this.currentIndex);

    try {
      this.currentKBContext = await this.conceptMatcher.matchConcepts({
        positionSide: this.position?.side ?? 'long',
        bias: ictContext.structure.bias,
        priceAction: this.describeRecentPriceAction(ictContext),
        nearbyStructures: this.getNearbyStructureDescriptions(ictContext),
        pnlPercent: this.position
          ? this.position.unrealizedPnL / (this.position.entryPrice * this.position.size)
          : 0,
        barsHeld: this.position?.barsHeld ?? 0,
      });
    } catch {
      this.currentKBContext = null;
    }
  }

  private describeRecentPriceAction(ctx: ICTStrategyContext): string {
    const parts: string[] = [];

    if (ctx.structure.bias !== 'neutral') {
      parts.push(`${ctx.structure.bias} trend`);
    }

    const recentBreaks = ctx.structure.structureBreaks.filter(
      (sb) => this.currentIndex - sb.breakIndex <= 10
    );

    if (recentBreaks.length > 0) {
      const latest = recentBreaks[recentBreaks.length - 1]!;
      parts.push(`recent ${latest.direction} ${latest.type}`);
    }

    return parts.join(', ') || 'consolidation';
  }

  private getNearbyStructureDescriptions(ctx: ICTStrategyContext): string[] {
    const descriptions: string[] = [];

    const nearbyOBs = ctx.orderBlocks.filter(
      (ob) => ob.status === 'unmitigated' && this.currentIndex - ob.index <= 30
    );

    for (const ob of nearbyOBs.slice(0, 2)) {
      descriptions.push(`${ob.type} order block`);
    }

    const nearbyFVGs = ctx.fvgs.filter(
      (fvg) => fvg.status !== 'filled' && this.currentIndex - fvg.index <= 20
    );

    for (const fvg of nearbyFVGs.slice(0, 2)) {
      descriptions.push(`${fvg.type} fvg`);
    }

    return descriptions;
  }

  // ============================================
  // Getters
  // ============================================

  getActionSize(): number {
    return STRATEGY_COUNT;
  }

  getStateSize(): number {
    // 18 base + 20 strategy + 4 KB = 42
    // NOTE: Multi-period features (6) removed after EXP-015 showed degradation
    return 18 + 20 + 4;
  }

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

  isInPosition(): boolean {
    return this.position !== null;
  }

  getPosition(): HybridPosition | null {
    return this.position ? { ...this.position } : null;
  }

  getCurrentStrategy(): StrategyName | null {
    return this.currentStrategy;
  }

  getKBContext(): KBContext | null {
    return this.currentKBContext;
  }

  getLastKBReward(): KBRewardResult | null {
    return this.lastKBReward;
  }

  getCandles(): Candle[] {
    return this.candles;
  }

  isKBEnabled(): boolean {
    return this.kbConfig.enabled;
  }

  getKBCacheStats() {
    return this.conceptMatcher.getCacheStats();
  }
}

// ============================================
// Exports
// ============================================

export { DEFAULT_CONFIG as DEFAULT_META_STRATEGY_CONFIG };
