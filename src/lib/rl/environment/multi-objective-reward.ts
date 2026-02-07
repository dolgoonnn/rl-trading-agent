/**
 * Multi-Objective Reward Calculator
 * Separate reward components instead of weighted sum
 *
 * Research: "Multi-Objective RL has clear edge over Single-Objective
 * when reward is sparse" (Springer 2023)
 *
 * Instead of combining rewards into a single scalar, this maintains
 * separate Q-networks for each objective, enabling Pareto-optimal
 * action selection and better handling of sparse rewards.
 */

import type {
  Action,
  ICTContext,
} from '../types';
import { Actions } from '../types';
import type { RewardInput } from './reward-calculator';

/**
 * Individual objective components
 */
export interface ObjectiveRewards {
  /** Returns objective: Maximize profit */
  returns: number;
  /** Risk objective: Minimize drawdown / maximize risk-adjusted returns */
  risk: number;
  /** Activity objective: Encourage appropriate trading frequency */
  activity: number;
  /** ICT alignment objective: Follow ICT trading concepts */
  ictAlignment: number;
}

/**
 * Configuration for multi-objective reward
 */
export interface MultiObjectiveConfig {
  // Whether to use Pareto-optimal selection or scalarization
  usePareto: boolean;

  // Scalarization weights (used if usePareto is false)
  weights: {
    returns: number;
    risk: number;
    activity: number;
    ictAlignment: number;
  };

  // Objective-specific parameters
  returnsConfig: {
    tradeRewardScale: number;
    stepRewardScale: number;
    asymmetricLossPenalty: number;
  };

  riskConfig: {
    targetSortino: number;
    maxDrawdownPenalty: number;
    volatilityPenalty: number;
  };

  activityConfig: {
    targetTradesPerWindow: number;
    inactivityPenaltyRate: number;
    overTradingPenaltyRate: number;
    entryBonus: number;
  };

  ictConfig: {
    baseReward: number;
    confluenceMultipliers: number[];
    highEdgeComboBonus: number;
  };
}

const DEFAULT_CONFIG: MultiObjectiveConfig = {
  usePareto: false, // Start with scalarization, can switch to Pareto later
  weights: {
    returns: 0.4,
    risk: 0.2,
    activity: 0.2,
    ictAlignment: 0.2,
  },

  returnsConfig: {
    tradeRewardScale: 30,
    stepRewardScale: 20,
    asymmetricLossPenalty: 1.5,
  },

  riskConfig: {
    targetSortino: 1.5,
    maxDrawdownPenalty: -2.0,
    volatilityPenalty: 0.1,
  },

  activityConfig: {
    targetTradesPerWindow: 10, // Target 10 trades per 500 bars
    inactivityPenaltyRate: 0.02,
    overTradingPenaltyRate: 0.01,
    entryBonus: 0.1,
  },

  ictConfig: {
    baseReward: 0.2,
    confluenceMultipliers: [0.3, 0.6, 1.0, 1.5, 2.0], // 0, 1, 2, 3, 4+ signals
    highEdgeComboBonus: 0.4,
  },
};

/**
 * Running statistics for each objective
 */
class ObjectiveStats {
  private count: number = 0;
  private mean: number = 0;
  private m2: number = 0;

  update(value: number): void {
    this.count++;
    const delta = value - this.mean;
    this.mean += delta / this.count;
    const delta2 = value - this.mean;
    this.m2 += delta * delta2;
  }

  getStd(): number {
    if (this.count < 2) return 1;
    return Math.max(0.01, Math.sqrt(this.m2 / this.count));
  }

  getMean(): number {
    return this.mean;
  }

  normalize(value: number): number {
    if (this.count < 50) {
      return Math.max(-5, Math.min(5, value));
    }
    const normalized = (value - this.mean) / this.getStd();
    return Math.max(-5, Math.min(5, normalized));
  }

  reset(): void {
    this.count = 0;
    this.mean = 0;
    this.m2 = 0;
  }
}

export class MultiObjectiveRewardCalculator {
  private config: MultiObjectiveConfig;

  // Per-objective statistics for normalization
  private stats: {
    returns: ObjectiveStats;
    risk: ObjectiveStats;
    activity: ObjectiveStats;
    ictAlignment: ObjectiveStats;
  };

  // Activity tracking
  private barsWithoutTrade: number = 0;
  private recentTradeCount: number = 0;
  private tradeTimestamps: number[] = [];
  private previousUnrealizedPnL: number = 0;

  // Risk tracking
  private recentReturns: number[] = [];
  private peakEquity: number = 0;

  constructor(config: Partial<MultiObjectiveConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.stats = {
      returns: new ObjectiveStats(),
      risk: new ObjectiveStats(),
      activity: new ObjectiveStats(),
      ictAlignment: new ObjectiveStats(),
    };
  }

  /**
   * Calculate all objective rewards separately
   * Returns both raw and normalized values
   */
  calculate(input: RewardInput): {
    objectives: ObjectiveRewards;
    normalized: ObjectiveRewards;
    scalarized: number;
  } {
    const raw = this.calculateRaw(input);

    // Update statistics
    this.stats.returns.update(raw.returns);
    this.stats.risk.update(raw.risk);
    this.stats.activity.update(raw.activity);
    this.stats.ictAlignment.update(raw.ictAlignment);

    // Normalize each objective
    const normalized: ObjectiveRewards = {
      returns: this.stats.returns.normalize(raw.returns),
      risk: this.stats.risk.normalize(raw.risk),
      activity: this.stats.activity.normalize(raw.activity),
      ictAlignment: this.stats.ictAlignment.normalize(raw.ictAlignment),
    };

    // Scalarize for backward compatibility
    const scalarized =
      normalized.returns * this.config.weights.returns +
      normalized.risk * this.config.weights.risk +
      normalized.activity * this.config.weights.activity +
      normalized.ictAlignment * this.config.weights.ictAlignment;

    return { objectives: raw, normalized, scalarized };
  }

  /**
   * Calculate raw objective rewards
   */
  private calculateRaw(input: RewardInput): ObjectiveRewards {
    return {
      returns: this.calculateReturnsObjective(input),
      risk: this.calculateRiskObjective(input),
      activity: this.calculateActivityObjective(input),
      ictAlignment: this.calculateICTObjective(input),
    };
  }

  /**
   * Returns objective: Maximize profit
   */
  private calculateReturnsObjective(input: RewardInput): number {
    const { stepReturn, trade, portfolio } = input;
    const cfg = this.config.returnsConfig;
    let reward = 0;

    // Dense signal from step returns
    reward += Math.tanh(stepReturn * cfg.stepRewardScale) * 0.2;

    // Main signal from closed trades
    if (trade) {
      const tradePnLPct = trade.pnlPercent ?? (trade.pnl / (trade.entryPrice * 100));
      const tradeReward = Math.tanh(tradePnLPct * cfg.tradeRewardScale);

      // Asymmetric: penalize losses more
      if (trade.pnl < 0) {
        reward += tradeReward * cfg.asymmetricLossPenalty;
      } else {
        reward += tradeReward;
      }
    }

    // Unrealized PnL tracking (for open positions)
    if (portfolio.position) {
      const pnlChange = portfolio.position.unrealizedPnL - this.previousUnrealizedPnL;
      const pnlChangePercent = pnlChange / (portfolio.cash + Math.abs(portfolio.position.unrealizedPnL));
      reward += Math.tanh(pnlChangePercent * 30) * 0.3;
      this.previousUnrealizedPnL = portfolio.position.unrealizedPnL;
    } else {
      this.previousUnrealizedPnL = 0;
    }

    return Math.max(-3, Math.min(3, reward));
  }

  /**
   * Risk objective: Minimize drawdown, maximize risk-adjusted returns
   */
  private calculateRiskObjective(input: RewardInput): number {
    const { stepReturn, portfolio } = input;
    const cfg = this.config.riskConfig;
    let reward = 0;

    // Track returns for Sortino calculation
    this.recentReturns.push(stepReturn);
    if (this.recentReturns.length > 50) {
      this.recentReturns.shift();
    }

    // Update peak equity
    if (portfolio.equity > this.peakEquity) {
      this.peakEquity = portfolio.equity;
    }

    // Drawdown penalty (progressive)
    const currentDrawdown = portfolio.maxDrawdown;
    if (currentDrawdown > 0.05) {
      reward += cfg.maxDrawdownPenalty * ((currentDrawdown - 0.05) / 0.1);
    }

    // Sortino-based reward
    if (this.recentReturns.length >= 10) {
      const mean = this.recentReturns.reduce((a, b) => a + b, 0) / this.recentReturns.length;
      const negReturns = this.recentReturns.filter(r => r < 0);

      if (negReturns.length > 0) {
        const downDev = Math.sqrt(
          negReturns.reduce((a, b) => a + Math.pow(b, 2), 0) / negReturns.length
        );
        const sortino = downDev > 0 ? mean / downDev : mean > 0 ? 2 : -2;

        // Reward for achieving target Sortino
        if (sortino >= cfg.targetSortino) {
          reward += 0.5;
        } else if (sortino > 0) {
          reward += 0.2 * (sortino / cfg.targetSortino);
        } else {
          reward += sortino * 0.3;
        }
      }
    }

    // Volatility penalty
    if (this.recentReturns.length >= 10) {
      const mean = this.recentReturns.reduce((a, b) => a + b, 0) / this.recentReturns.length;
      const variance = this.recentReturns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / this.recentReturns.length;
      const volatility = Math.sqrt(variance);
      reward -= volatility * cfg.volatilityPenalty * 10;
    }

    return Math.max(-2, Math.min(2, reward));
  }

  /**
   * Activity objective: Encourage appropriate trading frequency
   */
  private calculateActivityObjective(input: RewardInput): number {
    const { action, portfolio, trade } = input;
    const cfg = this.config.activityConfig;
    let reward = 0;

    // Track activity
    if (!portfolio.position) {
      this.barsWithoutTrade++;
    } else {
      this.barsWithoutTrade = 0;
    }

    // Track trade frequency
    if (trade) {
      this.recentTradeCount++;
      this.tradeTimestamps.push(Date.now());

      // Keep only recent trades
      const cutoff = Date.now() - 3600000; // Last hour
      this.tradeTimestamps = this.tradeTimestamps.filter(t => t > cutoff);
    }

    // Inactivity penalty (progressive)
    if (this.barsWithoutTrade > 5 && action === Actions.HOLD) {
      const excessBars = this.barsWithoutTrade - 5;
      reward -= cfg.inactivityPenaltyRate * Math.min(excessBars, 30);
    }

    // Entry bonus - reward for taking action
    if (action === Actions.BUY || action === Actions.SELL) {
      if (!portfolio.position || trade) {
        reward += cfg.entryBonus;
      }
    }

    // Over-trading penalty
    if (this.tradeTimestamps.length > 5) {
      // Check for rapid trading
      const avgInterval = (Date.now() - this.tradeTimestamps[0]!) / this.tradeTimestamps.length;
      if (avgInterval < 60000) { // Less than 1 minute average
        reward -= cfg.overTradingPenaltyRate * 5;
      }
    }

    return Math.max(-1, Math.min(1, reward));
  }

  /**
   * ICT alignment objective: Follow ICT trading concepts
   */
  private calculateICTObjective(input: RewardInput): number {
    const { action, ictContext } = input;
    const cfg = this.config.ictConfig;

    if (action === Actions.HOLD) {
      // Small reward for patience when no setup
      if (!this.hasGoodSetup(ictContext)) {
        return 0.05;
      }
      return 0;
    }

    // Count confluence signals
    const confluenceCount = this.countConfluence(action, ictContext);

    // Get multiplier based on confluence level
    const multiplierIndex = Math.min(confluenceCount, cfg.confluenceMultipliers.length - 1);
    const multiplier = cfg.confluenceMultipliers[multiplierIndex]!;

    let reward = cfg.baseReward * multiplier;

    // High-edge combo bonus
    if (this.isHighEdgeCombo(action, ictContext)) {
      reward += cfg.highEdgeComboBonus;
    }

    return Math.max(-0.5, Math.min(1, reward));
  }

  /**
   * Count confluence signals for an action
   */
  private countConfluence(action: Action, ctx: ICTContext): number {
    let count = 0;

    // Trend alignment
    if (action === Actions.BUY && (ctx.bias === 'bullish' || ctx.trendStrength > 0.3)) count++;
    if (action === Actions.SELL && (ctx.bias === 'bearish' || ctx.trendStrength < -0.3)) count++;

    // Order block
    if (action === Actions.BUY && ctx.priceInBullishOB) count++;
    if (action === Actions.SELL && ctx.priceInBearishOB) count++;

    // FVG
    if (action === Actions.BUY && ctx.priceInBullishFVG) count++;
    if (action === Actions.SELL && ctx.priceInBearishFVG) count++;

    // Kill zone
    if (ctx.inKillZone) count++;

    // Liquidity sweep
    if (action === Actions.BUY && ctx.recentSweep === 'ssl') count++;
    if (action === Actions.SELL && ctx.recentSweep === 'bsl') count++;

    // BOS/CHoCH alignment
    if (action === Actions.BUY && ctx.lastBOSDirection === 1 && ctx.barsFromLastBOS < 20) count++;
    if (action === Actions.SELL && ctx.lastBOSDirection === -1 && ctx.barsFromLastBOS < 20) count++;

    return count;
  }

  /**
   * Check for high-edge combo patterns
   */
  private isHighEdgeCombo(action: Action, ctx: ICTContext): boolean {
    // Sweep + OB/FVG
    if (action === Actions.BUY) {
      if (ctx.recentSweep === 'ssl' && (ctx.priceInBullishOB || ctx.priceInBullishFVG)) {
        return true;
      }
    }
    if (action === Actions.SELL) {
      if (ctx.recentSweep === 'bsl' && (ctx.priceInBearishOB || ctx.priceInBearishFVG)) {
        return true;
      }
    }

    // CHoCH + OB + KillZone
    if (ctx.barsFromLastCHoCH < 15 && ctx.lastCHoCHConfidence > 0.6 && ctx.inKillZone) {
      if (action === Actions.BUY && ctx.lastCHoCHDirection === 1 && ctx.priceInBullishOB) {
        return true;
      }
      if (action === Actions.SELL && ctx.lastCHoCHDirection === -1 && ctx.priceInBearishOB) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if there's a good setup present
   */
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

  /**
   * Get Pareto-optimal actions
   * Returns actions that are not dominated by any other action
   */
  getParetoOptimalActions(
    actionRewards: Map<Action, ObjectiveRewards>
  ): Action[] {
    const actions = Array.from(actionRewards.keys());
    const paretoOptimal: Action[] = [];

    for (const action of actions) {
      const rewards = actionRewards.get(action)!;
      let isDominated = false;

      for (const otherAction of actions) {
        if (otherAction === action) continue;
        const otherRewards = actionRewards.get(otherAction)!;

        // Check if otherAction dominates action
        // (all objectives >= and at least one >)
        const allBetterOrEqual =
          otherRewards.returns >= rewards.returns &&
          otherRewards.risk >= rewards.risk &&
          otherRewards.activity >= rewards.activity &&
          otherRewards.ictAlignment >= rewards.ictAlignment;

        const atLeastOneBetter =
          otherRewards.returns > rewards.returns ||
          otherRewards.risk > rewards.risk ||
          otherRewards.activity > rewards.activity ||
          otherRewards.ictAlignment > rewards.ictAlignment;

        if (allBetterOrEqual && atLeastOneBetter) {
          isDominated = true;
          break;
        }
      }

      if (!isDominated) {
        paretoOptimal.push(action);
      }
    }

    return paretoOptimal;
  }

  /**
   * Reset internal state (call at episode start)
   */
  reset(): void {
    this.barsWithoutTrade = 0;
    this.recentTradeCount = 0;
    this.tradeTimestamps = [];
    this.previousUnrealizedPnL = 0;
    this.recentReturns = [];
  }

  /**
   * Reset statistics (call at beginning of new training run)
   */
  resetStats(): void {
    this.stats.returns.reset();
    this.stats.risk.reset();
    this.stats.activity.reset();
    this.stats.ictAlignment.reset();
    this.peakEquity = 0;
  }

  /**
   * Get statistics for logging
   */
  getStats(): {
    returns: { mean: number; std: number };
    risk: { mean: number; std: number };
    activity: { mean: number; std: number };
    ictAlignment: { mean: number; std: number };
  } {
    return {
      returns: { mean: this.stats.returns.getMean(), std: this.stats.returns.getStd() },
      risk: { mean: this.stats.risk.getMean(), std: this.stats.risk.getStd() },
      activity: { mean: this.stats.activity.getMean(), std: this.stats.activity.getStd() },
      ictAlignment: { mean: this.stats.ictAlignment.getMean(), std: this.stats.ictAlignment.getStd() },
    };
  }
}
