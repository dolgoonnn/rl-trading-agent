/**
 * Reward Calculator
 * Computes composite reward for RL agent based on trading performance and ICT alignment
 */

import type {
  Action,
  Portfolio,
  TradeRecord,
  ICTContext,
  RewardComponents,
  RewardConfig,
} from '../types';
import { Actions } from '../types';

const DEFAULT_CONFIG: RewardConfig = {
  // Component weights (must sum to 1)
  // Dense reward - provide feedback every step to prevent exploration collapse
  pnlWeight: 0.6, // Main PnL signal
  sharpeWeight: 0.2, // Risk-adjusted returns
  drawdownWeight: 0.1, // Drawdown penalty
  ictAlignmentWeight: 0.1, // ICT features guide

  // Legacy ICT alignment bonuses (used as base for confluence scoring)
  withTrendBonus: 0.03,
  orderBlockBonus: 0.04,
  fvgBonus: 0.03,
  killZoneBonus: 0.02,
  liquiditySweepBonus: 0.03,

  // Penalties
  overTradingPenalty: -0.03,
  holdingTooLongPenalty: -0.02,

  // Structure-based rewards (NEW for M4.2)
  structureExitBonus: 0.05,     // Bonus for exiting at structure levels
  profitProtectionBonus: 0.03, // Bonus for moving stop to BE when profitable
  trailingStopBonus: 0.04,     // Bonus for using trailing stop
  optimalExitBonus: 0.08,      // Bonus for exiting at OB/FVG/liquidity

  // Dense signal settings (Iteration 2 - Research: "the denser, the better")
  // Sources: MDPI Deep RL Survey, Emergent Mind Dense Rewards
  // Key: Step-level credit assignment achieves 1.25-2x faster convergence
  useDenseReward: true, // Enable dense reward signals
  unrealizedPnLWeight: 1.0, // INCREASED from 0.7: maximize feedback from position changes
  holdingCostPerBar: 0.002, // INCREASED from 0.001: stronger cost for inaction
  inactivityPenalty: 0.03, // INCREASED from 0.01: 3x increase to strongly discourage waiting
  inactivityThreshold: 3, // DECREASED from 5: trigger penalty even earlier
  entryBonus: 0.15, // INCREASED from 0.05: 3x increase to encourage trading
  progressiveInactivityMultiplier: 1.5, // NEW: exponential penalty growth for extended inactivity

  // Strategy diversity settings (Model Improvement)
  // Research: "Strategy imbalance (56-66% BOS, 0% FVG/CHoCH) indicates poor exploration"
  useStrategyDiversity: true,
  strategyDiversityWeight: 0.1, // Bonus for using diverse strategies
  tradeFrequencyPenaltyWeight: 0.001, // Penalty per excessive trade
  targetTradesPerEpisode: 15, // Target trades per 1000-bar episode
};

export interface RewardInput {
  stepReturn: number;
  recentReturns: number[];
  portfolio: Portfolio;
  action: Action;
  trade?: TradeRecord;
  ictContext: ICTContext;
  holdingPeriod: number;
  isNewEntry?: boolean; // Flag if this action opened a new position
  // Dense reward inputs
  previousUnrealizedPnL?: number; // For calculating PnL change
  barsWithoutPosition?: number; // For inactivity penalty
  // Structure-based exit inputs (NEW for M4.2)
  exitAtStructure?: boolean; // Did exit occur at OB/FVG/liquidity level?
  stopMovedToBreakeven?: boolean; // Was stop moved to breakeven?
  trailingStopActive?: boolean; // Is trailing stop being used?
  exitedAtOptimalLevel?: boolean; // Did exit occur at key ICT level?
  profitLocked?: number; // Amount of profit locked via trailing/BE (as %)
  // Strategy diversity inputs (Model Improvement)
  strategyUsed?: number; // Index of strategy used (0-4: WAIT, OB, FVG, BOS, CHoCH)
  episodeTradeCount?: number; // Total trades taken in current episode
  episodeBars?: number; // Total bars in current episode
}

export { RewardConfig };

/**
 * Running statistics for reward normalization
 * Uses Welford's online algorithm for numerical stability
 */
class RunningStats {
  private count: number = 0;
  private mean: number = 0;
  private m2: number = 0; // sum of squared differences from mean
  private readonly minStd: number = 0.01;

  update(value: number): void {
    this.count++;
    const delta = value - this.mean;
    this.mean += delta / this.count;
    const delta2 = value - this.mean;
    this.m2 += delta * delta2;
  }

  getStd(): number {
    if (this.count < 2) return 1;
    return Math.max(this.minStd, Math.sqrt(this.m2 / this.count));
  }

  getMean(): number {
    return this.mean;
  }

  normalize(value: number): number {
    if (this.count < 100) {
      // Not enough samples yet - use light clipping only
      return Math.max(-10, Math.min(10, value));
    }
    // Z-score normalization with clipping
    const normalized = (value - this.mean) / this.getStd();
    return Math.max(-5, Math.min(5, normalized));
  }

  reset(): void {
    this.count = 0;
    this.mean = 0;
    this.m2 = 0;
  }
}

export class RewardCalculator {
  private config: RewardConfig;
  private tradeTimestamps: number[] = [];
  private readonly MIN_TRADE_INTERVAL = 10; // Minimum bars between trades
  private readonly MAX_HOLDING_PERIOD = 50; // Maximum bars to hold position

  // Reward normalization (running statistics)
  private runningStats: RunningStats = new RunningStats();
  private enableNormalization: boolean = true;

  // Dense reward tracking
  private barsWithoutPosition: number = 0;
  private previousUnrealizedPnL: number = 0;

  // Strategy diversity tracking (Model Improvement)
  private strategyUsageCount: number[] = [0, 0, 0, 0, 0]; // WAIT, OB, FVG, BOS, CHoCH
  private episodeTradeCount: number = 0;

  constructor(config: Partial<RewardConfig> = {}, enableNormalization: boolean = true) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.enableNormalization = enableNormalization;
  }

  /**
   * Calculate composite reward
   * Includes dense signals to prevent exploration collapse
   */
  calculate(input: RewardInput): RewardComponents {
    const pnl = this.calculatePnLReward(input);
    const sharpe = this.calculateSharpeReward(input);
    const drawdown = this.calculateDrawdownPenalty(input);
    const ictAlignment = this.calculateICTAlignmentBonus(input);

    // Weighted sum (raw reward before normalization)
    let total =
      pnl * this.config.pnlWeight +
      sharpe * this.config.sharpeWeight +
      drawdown * this.config.drawdownWeight +
      ictAlignment * this.config.ictAlignmentWeight;

    // Dense reward signals (to prevent "hold" collapse)
    const useDense = this.config.useDenseReward ?? true;
    if (useDense) {
      total += this.calculateDenseSignals(input);
    }

    // Structure-based exit rewards (M4.2)
    total += this.calculateStructureExitBonus(input);

    // Strategy diversity rewards (Model Improvement)
    const useStrategyDiversity = this.config.useStrategyDiversity ?? true;
    if (useStrategyDiversity) {
      total += this.calculateStrategyDiversityReward(input);
    }

    // Apply reward normalization if enabled
    if (this.enableNormalization) {
      this.runningStats.update(total);
      total = this.runningStats.normalize(total);
    }

    return {
      pnl,
      sharpe,
      drawdown,
      ictAlignment,
      total,
    };
  }

  /**
   * Calculate dense reward signals to encourage trading activity
   * These signals provide feedback every step, not just on trade close
   */
  private calculateDenseSignals(input: RewardInput): number {
    const { portfolio, action, trade } = input;
    let denseReward = 0;

    // 1. Unrealized PnL change reward
    // Reward positive movement in position, penalize negative
    if (portfolio.position) {
      const currentUnrealizedPnL = portfolio.position.unrealizedPnL;
      const pnlChange = currentUnrealizedPnL - this.previousUnrealizedPnL;
      const unrealizedWeight = this.config.unrealizedPnLWeight ?? 0.3;

      // Normalize by initial capital to get percentage
      const pnlChangePercent = pnlChange / (portfolio.cash + Math.abs(portfolio.position.unrealizedPnL));
      denseReward += Math.tanh(pnlChangePercent * 50) * unrealizedWeight;

      this.previousUnrealizedPnL = currentUnrealizedPnL;
      this.barsWithoutPosition = 0;
    } else {
      this.previousUnrealizedPnL = 0;
      this.barsWithoutPosition++;
    }

    // 2. Inactivity penalty - discourage staying out of the market too long
    // Research: Step-level credit assignment with progressive penalties
    const inactivityThreshold = this.config.inactivityThreshold ?? 3;
    const inactivityPenalty = this.config.inactivityPenalty ?? 0.03;
    const progressiveMultiplier = this.config.progressiveInactivityMultiplier ?? 1.5;

    if (this.barsWithoutPosition > inactivityThreshold && action === Actions.HOLD) {
      // Progressive exponential penalty for staying out too long
      const excessBars = this.barsWithoutPosition - inactivityThreshold;
      // Exponential growth: penalty * multiplier^(excess/5) - grows faster over time
      const multiplier = Math.pow(progressiveMultiplier, excessBars / 5);
      denseReward -= inactivityPenalty * multiplier * Math.min(excessBars, 30);
    }

    // 3. Entry bonus - reward for taking decisive action
    // This counteracts the natural tendency to avoid risk by holding
    // Research: Encouraging action-taking is crucial for sparse reward environments
    const entryBonus = this.config.entryBonus ?? 0.05;
    if (action === Actions.BUY || action === Actions.SELL) {
      if (!portfolio.position || trade) {
        // Just entered a position - give exploration bonus
        denseReward += entryBonus;
      }
    }

    // 4. Holding cost - encourage closing losing positions, keeping winners
    if (portfolio.position) {
      const holdingCost = this.config.holdingCostPerBar ?? 0.001;
      const holdingPeriod = input.holdingPeriod;

      // Lower cost for profitable positions, higher for losing
      if (portfolio.position.unrealizedPnL < 0) {
        // Losing position - higher holding cost
        denseReward -= holdingCost * 2 * Math.min(holdingPeriod, 50);
      } else {
        // Winning position - minimal holding cost
        denseReward -= holdingCost * 0.5 * Math.min(holdingPeriod, 50);
      }
    }

    return denseReward;
  }

  /**
   * Calculate bonus rewards for structure-based exit management (M4.2)
   * Encourages:
   * - Exiting at key ICT levels (OB, FVG, liquidity)
   * - Using break-even stops to protect profits
   * - Using trailing stops to lock in gains
   * - Optimal exit timing at structure levels
   */
  private calculateStructureExitBonus(input: RewardInput): number {
    let bonus = 0;

    // 1. Bonus for exiting at structure levels
    if (input.exitAtStructure && input.trade) {
      const structureBonus = this.config.structureExitBonus ?? 0.05;
      // Scale bonus by trade profitability
      if (input.trade.pnl > 0) {
        bonus += structureBonus * 1.5; // Higher bonus for profitable exits at structure
      } else {
        bonus += structureBonus * 0.5; // Still reward structure-based loss cuts
      }
    }

    // 2. Bonus for moving stop to break-even when profitable
    if (input.stopMovedToBreakeven && input.profitLocked && input.profitLocked > 0) {
      const beBonus = this.config.profitProtectionBonus ?? 0.03;
      bonus += beBonus;
    }

    // 3. Bonus for using trailing stop
    if (input.trailingStopActive) {
      const trailBonus = this.config.trailingStopBonus ?? 0.04;
      // Scale by how much profit is locked
      const lockedMultiplier = input.profitLocked ? Math.min(input.profitLocked * 2, 1) : 0.5;
      bonus += trailBonus * lockedMultiplier;
    }

    // 4. Bonus for optimal exit at key ICT level
    if (input.exitedAtOptimalLevel && input.trade && input.trade.pnl > 0) {
      const optimalBonus = this.config.optimalExitBonus ?? 0.08;
      bonus += optimalBonus;
    }

    // 5. Progressive holding penalty (enhanced)
    // Penalize holding losing positions too long more severely
    if (input.portfolio.position && input.portfolio.position.unrealizedPnL < 0) {
      const holdingPeriod = input.holdingPeriod;
      const maxHold = this.MAX_HOLDING_PERIOD;

      if (holdingPeriod > maxHold * 0.5) {
        // Start penalizing at 50% of max hold for losing positions
        const excessRatio = (holdingPeriod - maxHold * 0.5) / (maxHold * 0.5);
        const holdPenalty = this.config.holdingTooLongPenalty ?? -0.02;
        bonus += holdPenalty * excessRatio * 2; // Double penalty for losers
      }
    }

    // 6. Reward quick loss cuts
    if (input.trade && input.trade.pnl < 0 && input.holdingPeriod < 5) {
      // Quick loss cut - small bonus for not letting losses run
      bonus += 0.02;
    }

    return Math.max(-0.2, Math.min(0.3, bonus));
  }

  /**
   * Calculate strategy diversity reward (Model Improvement)
   *
   * Encourages the agent to use diverse trading strategies instead of
   * over-relying on a single strategy (e.g., 66% BOS, 0% FVG/CHoCH).
   *
   * Components:
   * 1. Strategy entropy bonus - reward when all strategies are used
   * 2. Trade frequency penalty - discourage overtrading
   * 3. Underused strategy bonus - extra reward for using rare strategies
   */
  private calculateStrategyDiversityReward(input: RewardInput): number {
    let reward = 0;

    // Track strategy usage if provided
    if (input.strategyUsed !== undefined && input.strategyUsed > 0) {
      // Only track non-WAIT strategies (1-4)
      const idx = input.strategyUsed;
      if (idx >= 0 && idx < this.strategyUsageCount.length && this.strategyUsageCount[idx] !== undefined) {
        this.strategyUsageCount[idx]++;
      }
      this.episodeTradeCount++;

      // 1. Calculate strategy entropy bonus
      // Higher entropy = more diverse strategy usage = higher bonus
      const totalUsage = this.strategyUsageCount.slice(1).reduce((a, b) => a + b, 0); // Exclude WAIT
      if (totalUsage > 0) {
        const strategyDiversityWeight = this.config.strategyDiversityWeight ?? 0.1;

        // Calculate normalized Shannon entropy
        let entropy = 0;
        const numStrategies = 4; // OB, FVG, BOS, CHoCH

        for (let i = 1; i <= numStrategies; i++) {
          const usage = this.strategyUsageCount[i];
          if (usage !== undefined && usage > 0) {
            const p = usage / totalUsage;
            entropy -= p * Math.log(p);
          }
        }

        // Normalize by max entropy (log(4) for 4 strategies)
        const maxEntropy = Math.log(numStrategies);
        const normalizedEntropy = maxEntropy > 0 ? entropy / maxEntropy : 0;

        // Bonus scales with entropy
        reward += normalizedEntropy * strategyDiversityWeight;
      }

      // 2. Bonus for using underrepresented strategies (FVG, CHoCH)
      // These are often ignored by the model (0% usage in current model)
      const currentStrategyUsage = this.strategyUsageCount[idx];
      if (currentStrategyUsage !== undefined && totalUsage > 5) {
        const usageRatio = currentStrategyUsage / totalUsage;

        // If this strategy is underused (< 10%), give a bonus
        if (usageRatio < 0.1) {
          // Larger bonus for very underused strategies
          const underuseBonus = (0.1 - usageRatio) * 0.5;
          reward += underuseBonus;
        }

        // Extra bonus for FVG (idx=2) and CHoCH (idx=4) which are chronically underused
        if ((idx === 2 || idx === 4) && usageRatio < 0.15) {
          reward += 0.05; // Small extra bonus
        }
      }
    }

    // 3. Trade frequency penalty
    // Penalize if trading too much relative to episode length
    if (input.episodeBars !== undefined && input.episodeBars > 0) {
      const targetTrades = this.config.targetTradesPerEpisode ?? 15;
      const currentTradeCount = input.episodeTradeCount ?? this.episodeTradeCount;
      const expectedBarsPerTrade = 1000 / targetTrades; // ~66 bars per trade
      const currentBarsPerTrade = input.episodeBars / Math.max(1, currentTradeCount);

      // Penalize if trading more than 2x the expected frequency
      if (currentBarsPerTrade < expectedBarsPerTrade / 2) {
        const frequencyPenalty = this.config.tradeFrequencyPenaltyWeight ?? 0.001;
        const excessTrades = currentTradeCount - (input.episodeBars / expectedBarsPerTrade);
        if (excessTrades > 0) {
          reward -= frequencyPenalty * excessTrades;
        }
      }
    }

    return Math.max(-0.1, Math.min(0.2, reward));
  }

  /**
   * Get current strategy usage distribution (for diagnostics)
   */
  getStrategyDistribution(): { strategy: string; count: number; percentage: number }[] {
    const strategies = ['WAIT', 'OB', 'FVG', 'BOS', 'CHoCH'];
    const total = this.strategyUsageCount.reduce((a, b) => a + b, 0);

    return strategies.map((name, idx) => ({
      strategy: name,
      count: this.strategyUsageCount[idx] ?? 0,
      percentage: total > 0 ? ((this.strategyUsageCount[idx] ?? 0) / total) * 100 : 0,
    }));
  }

  /**
   * Get raw reward without normalization (for logging)
   */
  calculateRaw(input: RewardInput): number {
    const pnl = this.calculatePnLReward(input);
    const sharpe = this.calculateSharpeReward(input);
    const drawdown = this.calculateDrawdownPenalty(input);
    const ictAlignment = this.calculateICTAlignmentBonus(input);

    return (
      pnl * this.config.pnlWeight +
      sharpe * this.config.sharpeWeight +
      drawdown * this.config.drawdownWeight +
      ictAlignment * this.config.ictAlignmentWeight
    );
  }

  /**
   * PnL-based reward
   * Hybrid approach:
   * - Small dense signal for step returns (scaled down)
   * - Larger signal when trades close
   */
  private calculatePnLReward(input: RewardInput): number {
    const { stepReturn, trade } = input;

    let reward = 0;

    // Small dense signal from step returns (but heavily dampened)
    // This prevents the model from thinking "no trade = no learning"
    reward += Math.tanh(stepReturn * 20) * 0.1; // Very small contribution

    // Main signal: trade close reward
    if (trade) {
      // Use pnlPercent directly if available, otherwise calculate from pnl and entryPrice
      const tradePnLPct = trade.pnlPercent || (trade.pnl / (trade.entryPrice * 100));
      // Larger scaling for trade outcome
      const tradeReward = Math.tanh(tradePnLPct * 30);

      // Asymmetric: penalize losses more
      if (trade.pnl < 0) {
        reward += tradeReward * 1.5;
      } else {
        reward += tradeReward;
      }
    }

    // Note: Removed HOLD bonus (was +0.001) as it discouraged entering trades.
    // Instead, we want the model to learn from trade outcomes directly.

    return Math.max(-2, Math.min(2, reward));
  }

  /**
   * Risk-adjusted return reward using Differential Sortino
   * Uses downside deviation only - rewards consistent returns with low downside risk
   */
  private calculateSharpeReward(input: RewardInput): number {
    const { recentReturns, stepReturn } = input;

    if (recentReturns.length < 5) {
      return 0;
    }

    const mean = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;

    // Sortino: only penalize downside deviation
    const negativeReturns = recentReturns.filter((r) => r < 0);
    if (negativeReturns.length === 0) {
      // No downside - reward based on mean
      return Math.tanh(mean * 100) * 0.8;
    }

    const downsideVariance = negativeReturns.reduce((a, b) => a + Math.pow(b, 2), 0) / negativeReturns.length;
    const downsideDeviation = Math.sqrt(downsideVariance);

    if (downsideDeviation === 0) {
      return mean > 0 ? 0.5 : mean < 0 ? -0.5 : 0;
    }

    // Differential Sortino - how much did this step improve/hurt the ratio
    const sortino = mean / downsideDeviation;
    const contribution = stepReturn >= 0
      ? sortino * 0.1 // Positive step maintains ratio
      : -Math.abs(stepReturn) / downsideDeviation * 0.5; // Negative step hurts more

    // Use tanh for bounded output
    return Math.tanh(sortino * 0.5 + contribution);
  }

  /**
   * Drawdown penalty
   * Penalizes large drawdowns
   */
  private calculateDrawdownPenalty(input: RewardInput): number {
    const { portfolio } = input;

    // Current drawdown from peak
    const currentDrawdown = portfolio.maxDrawdown;

    // Progressive penalty - larger drawdowns get penalized more
    if (currentDrawdown < 0.05) {
      return 0; // No penalty for small drawdowns
    } else if (currentDrawdown < 0.10) {
      return -0.3 * (currentDrawdown - 0.05) / 0.05;
    } else if (currentDrawdown < 0.15) {
      return -0.3 - 0.5 * (currentDrawdown - 0.10) / 0.05;
    } else {
      return -0.8 - (currentDrawdown - 0.15); // Heavy penalty above 15%
    }
  }

  /**
   * ICT alignment bonus using PROGRESSIVE CONFLUENCE SCORING
   * Instead of individual bonuses, we count how many ICT signals align
   * and apply multipliers based on confluence level.
   *
   * UPDATED Confluence Levels (Phase 2 research):
   * Research shows strict thresholds cause exploration collapse.
   * Now using progressive multipliers without penalty:
   * - A+ (4+ signals): 2.0x multiplier (unchanged)
   * - A  (3 signals):  1.5x multiplier (unchanged)
   * - B  (2 signals):  1.0x multiplier (was penalty)
   * - C  (1 signal):   0.5x multiplier (was penalty)
   * - None (0):        0.2x (small reward, not penalty - encourages exploration)
   *
   * High-Edge Combos (extra +0.3 multiplier):
   * - Sweep + OB/FVG (classic ICT model)
   * - CHoCH + OB + KillZone (reversal model)
   */
  private calculateICTAlignmentBonus(input: RewardInput): number {
    const { action, ictContext, holdingPeriod } = input;

    // Only apply bonuses when taking action (not holding)
    if (action === Actions.HOLD) {
      // Small bonus for holding when there's no setup
      if (!this.hasGoodSetup(ictContext)) {
        return 0.02; // Reward patience
      }
      return 0;
    }

    // Count confluence signals
    const signals = this.countConfluenceSignals(action, ictContext);
    const confluenceCount = signals.count;

    // Progressive multiplier based on confluence level
    // CHANGED: Removed penalties to encourage more trading
    // Research: "Strict confluence thresholds cause the model to never trade"
    let multiplier: number;
    if (confluenceCount >= 4) {
      multiplier = 2.0; // A+ setup - best setups get highest multiplier
    } else if (confluenceCount === 3) {
      multiplier = 1.5; // A setup - still excellent
    } else if (confluenceCount === 2) {
      multiplier = 1.0; // B setup - good enough (was penalty before!)
    } else if (confluenceCount === 1) {
      multiplier = 0.5; // C setup - marginal but still rewarded (was penalty!)
    } else {
      multiplier = 0.2; // No ICT alignment - small reward (was -0.5 penalty!)
    }

    // Check for high-edge combos
    if (this.isHighEdgeCombo(signals)) {
      multiplier += 0.3;
    }

    // Check for BOS/CHoCH alignment (new feature)
    if (this.isBOSCHoCHAligned(action, ictContext)) {
      multiplier += 0.2;
    }

    // Base reward value
    const baseReward = 0.15;
    let bonus = baseReward * multiplier;

    // Penalties
    if (this.isOverTrading(action)) {
      bonus += this.config.overTradingPenalty;
    }

    if (holdingPeriod > this.MAX_HOLDING_PERIOD) {
      const excessPeriod = holdingPeriod - this.MAX_HOLDING_PERIOD;
      bonus += this.config.holdingTooLongPenalty * Math.min(excessPeriod / 10, 5);
    }

    // Cap total ICT bonus
    return Math.max(-0.3, Math.min(0.5, bonus));
  }

  /**
   * Count how many ICT confluence signals are present
   */
  private countConfluenceSignals(
    action: Action,
    ctx: ICTContext
  ): { count: number; hasOB: boolean; hasFVG: boolean; hasSweep: boolean; hasKillZone: boolean; hasTrend: boolean; hasCHoCH: boolean } {
    let count = 0;
    const signals = {
      count: 0,
      hasOB: false,
      hasFVG: false,
      hasSweep: false,
      hasKillZone: false,
      hasTrend: false,
      hasCHoCH: false,
    };

    // 1. Trading with trend
    if (this.isTradingWithTrend(action, ctx)) {
      count++;
      signals.hasTrend = true;
    }

    // 2. Order block entry
    if (this.isOrderBlockEntry(action, ctx)) {
      count++;
      signals.hasOB = true;
    }

    // 3. FVG entry
    if (this.isFVGEntry(action, ctx)) {
      count++;
      signals.hasFVG = true;
    }

    // 4. Kill zone
    if (ctx.inKillZone) {
      count++;
      signals.hasKillZone = true;
    }

    // 5. Post-sweep entry
    if (this.isPostSweepEntry(action, ctx)) {
      count++;
      signals.hasSweep = true;
    }

    // 6. CHoCH alignment (for reversal plays)
    if (this.isCHoCHEntry(action, ctx)) {
      count++;
      signals.hasCHoCH = true;
    }

    signals.count = count;
    return signals;
  }

  /**
   * Check for high-edge combo patterns
   */
  private isHighEdgeCombo(
    signals: { hasOB: boolean; hasFVG: boolean; hasSweep: boolean; hasKillZone: boolean; hasCHoCH: boolean }
  ): boolean {
    // Classic ICT model: Sweep + OB or Sweep + FVG
    if (signals.hasSweep && (signals.hasOB || signals.hasFVG)) {
      return true;
    }

    // Reversal model: CHoCH + OB + KillZone
    if (signals.hasCHoCH && signals.hasOB && signals.hasKillZone) {
      return true;
    }

    return false;
  }

  /**
   * Check if trade aligns with recent BOS/CHoCH
   */
  private isBOSCHoCHAligned(action: Action, ctx: ICTContext): boolean {
    // Recent BOS alignment (continuation)
    if (ctx.barsFromLastBOS < 20 && ctx.lastBOSConfidence > 0.6) {
      if (action === Actions.BUY && ctx.lastBOSDirection === 1) return true;
      if (action === Actions.SELL && ctx.lastBOSDirection === -1) return true;
    }

    // Recent CHoCH alignment (reversal)
    if (ctx.barsFromLastCHoCH < 15 && ctx.lastCHoCHConfidence > 0.6) {
      if (action === Actions.BUY && ctx.lastCHoCHDirection === 1) return true;
      if (action === Actions.SELL && ctx.lastCHoCHDirection === -1) return true;
    }

    return false;
  }

  /**
   * Check if this is a CHoCH-based entry (reversal play)
   */
  private isCHoCHEntry(action: Action, ctx: ICTContext): boolean {
    // Recent CHoCH with high confidence
    if (ctx.barsFromLastCHoCH > 20 || ctx.lastCHoCHConfidence < 0.5) {
      return false;
    }

    // Buy after bullish CHoCH, sell after bearish CHoCH
    if (action === Actions.BUY && ctx.lastCHoCHDirection === 1) return true;
    if (action === Actions.SELL && ctx.lastCHoCHDirection === -1) return true;

    return false;
  }

  // ============================================
  // Helper methods
  // ============================================

  private hasGoodSetup(ctx: ICTContext): boolean {
    return (
      ctx.priceInBullishOB ||
      ctx.priceInBearishOB ||
      ctx.priceInBullishFVG ||
      ctx.priceInBearishFVG ||
      ctx.recentSweep !== 'none' ||
      (ctx.lastStructureBreakType === 'choch' && ctx.barsFromLastBreak < 20)
    );
  }

  private isTradingWithTrend(action: Action, ctx: ICTContext): boolean {
    if (action === Actions.BUY) {
      return ctx.bias === 'bullish' || ctx.trendStrength > 0.3;
    }
    if (action === Actions.SELL) {
      return ctx.bias === 'bearish' || ctx.trendStrength < -0.3;
    }
    return true;
  }

  private isOrderBlockEntry(action: Action, ctx: ICTContext): boolean {
    if (action === Actions.BUY && ctx.priceInBullishOB) {
      return true;
    }
    if (action === Actions.SELL && ctx.priceInBearishOB) {
      return true;
    }
    return false;
  }

  private isFVGEntry(action: Action, ctx: ICTContext): boolean {
    if (action === Actions.BUY && ctx.priceInBullishFVG) {
      return true;
    }
    if (action === Actions.SELL && ctx.priceInBearishFVG) {
      return true;
    }
    return false;
  }

  private isPostSweepEntry(action: Action, ctx: ICTContext): boolean {
    // Buy after SSL sweep, sell after BSL sweep
    if (action === Actions.BUY && ctx.recentSweep === 'ssl') {
      return true;
    }
    if (action === Actions.SELL && ctx.recentSweep === 'bsl') {
      return true;
    }
    return false;
  }

  private isOverTrading(action: Action): boolean {
    if (action !== Actions.BUY && action !== Actions.SELL) {
      return false;
    }

    const now = Date.now();
    this.tradeTimestamps.push(now);

    // Keep only recent trades
    const cutoff = now - 60000 * 60; // Last hour
    this.tradeTimestamps = this.tradeTimestamps.filter((t) => t > cutoff);

    // Check if trading too frequently
    if (this.tradeTimestamps.length > 1) {
      const lastTradeInterval = now - this.tradeTimestamps[this.tradeTimestamps.length - 2]!;
      if (lastTradeInterval < this.MIN_TRADE_INTERVAL * 60000) {
        return true;
      }
    }

    return false;
  }

  /**
   * Reset internal state (call at episode start)
   * Note: Does NOT reset running stats - those should persist across episodes
   */
  reset(): void {
    this.tradeTimestamps = [];
    this.barsWithoutPosition = 0;
    this.previousUnrealizedPnL = 0;
    // Reset strategy tracking for new episode
    this.strategyUsageCount = [0, 0, 0, 0, 0];
    this.episodeTradeCount = 0;
  }

  /**
   * Reset running statistics (call at beginning of new training run)
   */
  resetStats(): void {
    this.runningStats.reset();
  }

  /**
   * Get normalization stats for logging
   */
  getNormalizationStats(): { mean: number; std: number } {
    return {
      mean: this.runningStats.getMean(),
      std: this.runningStats.getStd(),
    };
  }
}
