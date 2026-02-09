/**
 * Risk Manager
 *
 * Implements circuit breakers and risk controls for live/paper trading.
 * Protects capital by enforcing trading limits and pausing during drawdowns.
 *
 * Features:
 * - Daily loss limits (stops trading if exceeded)
 * - Max drawdown circuit breaker
 * - Position size limits
 * - Concurrent position limits
 * - Loss cooldown (wait N bars after a loss)
 */

export interface RiskLimits {
  /** Max daily loss as decimal (e.g., 0.02 = 2%). Stops trading if exceeded. */
  maxDailyLoss: number;

  /** Max drawdown as decimal (e.g., 0.05 = 5%). Stops trading if exceeded. */
  maxDrawdown: number;

  /** Max position size as % of capital (e.g., 0.1 = 10%) */
  maxPositionSize: number;

  /** Max concurrent open positions */
  maxConcurrentPositions: number;

  /** Bars to wait after a losing trade before trading again */
  cooldownAfterLoss: number;

  /** Max consecutive losses before forced cooldown */
  maxConsecutiveLosses: number;

  /** Forced cooldown duration (bars) after max consecutive losses */
  forcedCooldownBars: number;

  /** Minimum time between trades (bars) */
  minTimeBetweenTrades: number;
}

export interface RiskState {
  /** Current day's PnL */
  dailyPnL: number;

  /** Current day start time */
  dayStartTime: number;

  /** Current drawdown from peak */
  currentDrawdown: number;

  /** Peak equity */
  peakEquity: number;

  /** Current equity */
  currentEquity: number;

  /** Number of open positions */
  openPositions: number;

  /** Consecutive losing trades */
  consecutiveLosses: number;

  /** Bars since last trade */
  barsSinceLastTrade: number;

  /** Whether in forced cooldown */
  inForcedCooldown: boolean;

  /** Bars remaining in forced cooldown */
  forcedCooldownRemaining: number;

  /** Whether trading is halted */
  tradingHalted: boolean;

  /** Reason for halt (if any) */
  haltReason: string | null;
}

export interface RiskCheckResult {
  /** Whether trading is allowed */
  allowed: boolean;

  /** Reason if not allowed */
  reason: string | null;

  /** Recommended position size (may be reduced) */
  recommendedPositionSize: number;

  /** Risk level: 'low' | 'medium' | 'high' | 'critical' */
  riskLevel: 'low' | 'medium' | 'high' | 'critical';

  /** Warnings (non-blocking) */
  warnings: string[];
}

const DEFAULT_LIMITS: RiskLimits = {
  maxDailyLoss: 0.02, // 2% max daily loss
  maxDrawdown: 0.05, // 5% max drawdown
  maxPositionSize: 0.1, // 10% max per position
  maxConcurrentPositions: 1, // Single position
  cooldownAfterLoss: 5, // 5 bars after loss
  maxConsecutiveLosses: 3, // 3 consecutive losses triggers forced cooldown
  forcedCooldownBars: 20, // 20 bars forced cooldown
  minTimeBetweenTrades: 3, // 3 bars minimum between trades
};

export class RiskManager {
  private limits: RiskLimits;
  private state: RiskState;
  private initialCapital: number;

  constructor(initialCapital: number, limits: Partial<RiskLimits> = {}) {
    this.initialCapital = initialCapital;
    this.limits = { ...DEFAULT_LIMITS, ...limits };

    this.state = {
      dailyPnL: 0,
      dayStartTime: Date.now(),
      currentDrawdown: 0,
      peakEquity: initialCapital,
      currentEquity: initialCapital,
      openPositions: 0,
      consecutiveLosses: 0,
      barsSinceLastTrade: 999, // Allow immediate first trade
      inForcedCooldown: false,
      forcedCooldownRemaining: 0,
      tradingHalted: false,
      haltReason: null,
    };
  }

  /**
   * Check if trading is allowed and get risk assessment
   */
  checkRisk(requestedPositionSize: number = this.limits.maxPositionSize): RiskCheckResult {
    const warnings: string[] = [];
    let allowed = true;
    let reason: string | null = null;
    let recommendedSize = requestedPositionSize;
    let riskLevel: RiskCheckResult['riskLevel'] = 'low';

    // Check if trading is halted
    if (this.state.tradingHalted) {
      return {
        allowed: false,
        reason: this.state.haltReason ?? 'Trading halted',
        recommendedPositionSize: 0,
        riskLevel: 'critical',
        warnings: [],
      };
    }

    // Check daily loss limit
    const dailyLossPercent = -this.state.dailyPnL / this.initialCapital;
    if (dailyLossPercent >= this.limits.maxDailyLoss) {
      return {
        allowed: false,
        reason: `Daily loss limit reached: ${(dailyLossPercent * 100).toFixed(2)}% >= ${(this.limits.maxDailyLoss * 100).toFixed(0)}%`,
        recommendedPositionSize: 0,
        riskLevel: 'critical',
        warnings: [],
      };
    }

    // Check drawdown limit
    if (this.state.currentDrawdown >= this.limits.maxDrawdown) {
      return {
        allowed: false,
        reason: `Max drawdown reached: ${(this.state.currentDrawdown * 100).toFixed(2)}% >= ${(this.limits.maxDrawdown * 100).toFixed(0)}%`,
        recommendedPositionSize: 0,
        riskLevel: 'critical',
        warnings: [],
      };
    }

    // Check concurrent positions
    if (this.state.openPositions >= this.limits.maxConcurrentPositions) {
      return {
        allowed: false,
        reason: `Max concurrent positions reached: ${this.state.openPositions}`,
        recommendedPositionSize: 0,
        riskLevel: 'high',
        warnings: [],
      };
    }

    // Check forced cooldown
    if (this.state.inForcedCooldown && this.state.forcedCooldownRemaining > 0) {
      return {
        allowed: false,
        reason: `In forced cooldown: ${this.state.forcedCooldownRemaining} bars remaining`,
        recommendedPositionSize: 0,
        riskLevel: 'high',
        warnings: [],
      };
    }

    // Check minimum time between trades
    if (this.state.barsSinceLastTrade < this.limits.minTimeBetweenTrades) {
      return {
        allowed: false,
        reason: `Minimum time between trades not met: ${this.state.barsSinceLastTrade}/${this.limits.minTimeBetweenTrades} bars`,
        recommendedPositionSize: 0,
        riskLevel: 'medium',
        warnings: [],
      };
    }

    // Check loss cooldown
    if (this.state.consecutiveLosses > 0 && this.state.barsSinceLastTrade < this.limits.cooldownAfterLoss) {
      return {
        allowed: false,
        reason: `In loss cooldown: ${this.state.barsSinceLastTrade}/${this.limits.cooldownAfterLoss} bars`,
        recommendedPositionSize: 0,
        riskLevel: 'medium',
        warnings: [],
      };
    }

    // Calculate risk level and adjust position size
    if (dailyLossPercent >= this.limits.maxDailyLoss * 0.75) {
      riskLevel = 'high';
      recommendedSize = Math.min(recommendedSize, this.limits.maxPositionSize * 0.5);
      warnings.push(`Approaching daily loss limit: ${(dailyLossPercent * 100).toFixed(1)}%`);
    } else if (dailyLossPercent >= this.limits.maxDailyLoss * 0.5) {
      riskLevel = 'medium';
      recommendedSize = Math.min(recommendedSize, this.limits.maxPositionSize * 0.75);
      warnings.push(`Daily loss at ${(dailyLossPercent * 100).toFixed(1)}%`);
    }

    if (this.state.currentDrawdown >= this.limits.maxDrawdown * 0.7) {
      riskLevel = riskLevel === 'high' ? 'high' : 'medium';
      recommendedSize = Math.min(recommendedSize, this.limits.maxPositionSize * 0.5);
      warnings.push(`Drawdown at ${(this.state.currentDrawdown * 100).toFixed(1)}%`);
    }

    if (this.state.consecutiveLosses >= 2) {
      warnings.push(`${this.state.consecutiveLosses} consecutive losses`);
      recommendedSize = Math.min(recommendedSize, this.limits.maxPositionSize * 0.75);
    }

    // Enforce max position size
    recommendedSize = Math.min(recommendedSize, this.limits.maxPositionSize);

    return {
      allowed,
      reason,
      recommendedPositionSize: recommendedSize,
      riskLevel,
      warnings,
    };
  }

  /**
   * Record a new trade opening
   */
  onTradeOpened(): void {
    this.state.openPositions++;
    this.state.barsSinceLastTrade = 0;
  }

  /**
   * Record a trade closing
   */
  onTradeClosed(pnl: number): void {
    this.state.openPositions = Math.max(0, this.state.openPositions - 1);
    this.state.dailyPnL += pnl;

    // Update equity
    this.state.currentEquity += pnl;

    // Update peak and drawdown
    if (this.state.currentEquity > this.state.peakEquity) {
      this.state.peakEquity = this.state.currentEquity;
    }
    this.state.currentDrawdown =
      (this.state.peakEquity - this.state.currentEquity) / this.state.peakEquity;

    // Track consecutive losses
    if (pnl < 0) {
      this.state.consecutiveLosses++;

      // Check for forced cooldown
      if (this.state.consecutiveLosses >= this.limits.maxConsecutiveLosses) {
        this.state.inForcedCooldown = true;
        this.state.forcedCooldownRemaining = this.limits.forcedCooldownBars;
      }
    } else if (pnl > 0) {
      this.state.consecutiveLosses = 0;
    }
  }

  /**
   * Called each bar to update time-based state
   */
  onBar(): void {
    this.state.barsSinceLastTrade++;

    // Update forced cooldown
    if (this.state.inForcedCooldown && this.state.forcedCooldownRemaining > 0) {
      this.state.forcedCooldownRemaining--;
      if (this.state.forcedCooldownRemaining <= 0) {
        this.state.inForcedCooldown = false;
        this.state.consecutiveLosses = 0; // Reset after cooldown
      }
    }

    // Check for new day (reset daily PnL)
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    if (now - this.state.dayStartTime >= dayMs) {
      this.resetDaily();
    }
  }

  /**
   * Reset daily counters
   */
  resetDaily(): void {
    this.state.dailyPnL = 0;
    this.state.dayStartTime = Date.now();
  }

  /**
   * Halt all trading (emergency stop)
   */
  haltTrading(reason: string): void {
    this.state.tradingHalted = true;
    this.state.haltReason = reason;
  }

  /**
   * Resume trading after halt
   */
  resumeTrading(): void {
    this.state.tradingHalted = false;
    this.state.haltReason = null;
  }

  /**
   * Get current risk state
   */
  getState(): Readonly<RiskState> {
    return { ...this.state };
  }

  /**
   * Get risk limits
   */
  getLimits(): Readonly<RiskLimits> {
    return { ...this.limits };
  }

  /**
   * Update risk limits
   */
  updateLimits(limits: Partial<RiskLimits>): void {
    this.limits = { ...this.limits, ...limits };
  }

  /**
   * Get current equity
   */
  getCurrentEquity(): number {
    return this.state.currentEquity;
  }

  /**
   * Update equity (for unrealized PnL tracking)
   */
  updateEquity(equity: number): void {
    this.state.currentEquity = equity;

    if (equity > this.state.peakEquity) {
      this.state.peakEquity = equity;
    }

    this.state.currentDrawdown =
      (this.state.peakEquity - equity) / this.state.peakEquity;
  }

  /**
   * Get risk summary for display
   */
  getRiskSummary(): {
    dailyPnL: string;
    dailyLossPercent: string;
    drawdown: string;
    consecutiveLosses: number;
    tradingAllowed: boolean;
    riskLevel: string;
    warnings: string[];
  } {
    const check = this.checkRisk();
    const dailyLossPercent = -this.state.dailyPnL / this.initialCapital;

    return {
      dailyPnL: this.state.dailyPnL.toFixed(2),
      dailyLossPercent: `${(dailyLossPercent * 100).toFixed(2)}%`,
      drawdown: `${(this.state.currentDrawdown * 100).toFixed(2)}%`,
      consecutiveLosses: this.state.consecutiveLosses,
      tradingAllowed: check.allowed,
      riskLevel: check.riskLevel,
      warnings: check.warnings,
    };
  }
}

export { DEFAULT_LIMITS as DEFAULT_RISK_LIMITS };
