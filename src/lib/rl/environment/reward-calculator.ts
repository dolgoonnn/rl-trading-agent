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
  // Pure PnL focus - simpler reward signal for clearer learning
  pnlWeight: 1.0, // Pure PnL
  sharpeWeight: 0.0,
  drawdownWeight: 0.0,
  ictAlignmentWeight: 0.0, // ICT features guide via state, not reward

  // Legacy ICT alignment bonuses (used as base for confluence scoring)
  withTrendBonus: 0.03,
  orderBlockBonus: 0.04,
  fvgBonus: 0.03,
  killZoneBonus: 0.02,
  liquiditySweepBonus: 0.03,

  // Penalties
  overTradingPenalty: -0.03,
  holdingTooLongPenalty: -0.02,
};

export interface RewardInput {
  stepReturn: number;
  recentReturns: number[];
  portfolio: Portfolio;
  action: Action;
  trade?: TradeRecord;
  ictContext: ICTContext;
  holdingPeriod: number;
}

export { RewardConfig };

export class RewardCalculator {
  private config: RewardConfig;
  private tradeTimestamps: number[] = [];
  private readonly MIN_TRADE_INTERVAL = 10; // Minimum bars between trades
  private readonly MAX_HOLDING_PERIOD = 50; // Maximum bars to hold position

  constructor(config: Partial<RewardConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Calculate composite reward
   */
  calculate(input: RewardInput): RewardComponents {
    const pnl = this.calculatePnLReward(input);
    const sharpe = this.calculateSharpeReward(input);
    const drawdown = this.calculateDrawdownPenalty(input);
    const ictAlignment = this.calculateICTAlignmentBonus(input);

    // Weighted sum
    const total =
      pnl * this.config.pnlWeight +
      sharpe * this.config.sharpeWeight +
      drawdown * this.config.drawdownWeight +
      ictAlignment * this.config.ictAlignmentWeight;

    return {
      pnl,
      sharpe,
      drawdown,
      ictAlignment,
      total,
    };
  }

  /**
   * PnL-based reward
   * Uses tanh scaling to prevent reward hacking from extreme returns
   * Removes double-dipping on trade PnL
   */
  private calculatePnLReward(input: RewardInput): number {
    const { stepReturn, trade } = input;

    // Use tanh for smooth, bounded scaling that prevents reward hacking
    // tanh(x * 50) gives sensitivity to small returns while capping extreme values
    let reward = Math.tanh(stepReturn * 50);

    // Only add trade reward if trade closed, and use tanh to bound it
    // Don't double-count - stepReturn already includes the trade PnL
    if (trade) {
      // Small asymmetric bonus/penalty to encourage quality over quantity
      if (trade.pnl > 0) {
        reward += 0.05; // Small bonus for win
      } else {
        reward -= 0.08; // Slightly larger penalty for loss (encourages selectivity)
      }
    }

    // Already bounded by tanh, but clip for safety
    return Math.max(-1.5, Math.min(1.5, reward));
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
   * ICT alignment bonus using CONFLUENCE SCORING
   * Instead of individual bonuses, we count how many ICT signals align
   * and apply multipliers based on confluence level.
   *
   * Confluence Levels:
   * - A+ (4+ signals): 2.0x multiplier
   * - A  (3 signals):  1.5x multiplier
   * - B  (2 signals):  1.0x multiplier
   * - C  (1 signal):   0.5x multiplier
   * - None (0):       -0.5x (penalty for no ICT alignment)
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

    // Base multiplier based on confluence level
    let multiplier: number;
    if (confluenceCount >= 4) {
      multiplier = 2.0; // A+ setup
    } else if (confluenceCount === 3) {
      multiplier = 1.5; // A setup
    } else if (confluenceCount === 2) {
      multiplier = 1.0; // B setup
    } else if (confluenceCount === 1) {
      multiplier = 0.5; // C setup
    } else {
      multiplier = -0.5; // No ICT alignment - penalty
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
   */
  reset(): void {
    this.tradeTimestamps = [];
  }
}
