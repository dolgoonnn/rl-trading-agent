/**
 * Position Sizer
 *
 * Dynamic position sizing based on multiple factors:
 * - Account balance (base size)
 * - ATR (volatility-adjusted)
 * - Win rate and R:R (Kelly criterion)
 * - Current drawdown (reduce size in drawdown)
 * - Confidence level (signal strength)
 *
 * Research: Proper position sizing is crucial for long-term survival.
 * Kelly criterion optimizes growth while managing ruin risk.
 */

export interface PositionSizingConfig {
  /** Base position size as fraction of capital (e.g., 0.1 = 10%) */
  baseSize: number;

  /** Minimum position size as fraction of capital */
  minSize: number;

  /** Maximum position size as fraction of capital */
  maxSize: number;

  /** Whether to use Kelly criterion */
  useKelly: boolean;

  /** Kelly fraction (e.g., 0.5 = half Kelly for safety) */
  kellyFraction: number;

  /** Whether to adjust for volatility */
  useVolatilityAdjustment: boolean;

  /** Target volatility (ATR % of price) */
  targetVolatility: number;

  /** Whether to reduce size in drawdown */
  useDrawdownScaling: boolean;

  /** Drawdown threshold to start reducing size */
  drawdownThreshold: number;

  /** Maximum reduction factor in drawdown */
  maxDrawdownReduction: number;

  /** Whether to scale by confidence */
  useConfidenceScaling: boolean;

  /** Minimum confidence for full size (below this, scale down) */
  minConfidenceForFullSize: number;
}

export interface PositionSizeInput {
  /** Current account equity */
  equity: number;

  /** Current ATR value */
  atr: number;

  /** Current price */
  price: number;

  /** Historical win rate (0-1) */
  winRate: number;

  /** Average risk:reward ratio */
  avgRiskReward: number;

  /** Current drawdown (0-1) */
  currentDrawdown: number;

  /** Signal confidence (0-1) */
  confidence: number;

  /** Stop loss distance in price */
  stopLossDistance: number;
}

export interface PositionSizeResult {
  /** Recommended position size as fraction of capital */
  sizeFraction: number;

  /** Position value in currency */
  positionValue: number;

  /** Number of units/contracts */
  units: number;

  /** Dollar risk (if stop hit) */
  dollarRisk: number;

  /** Breakdown of adjustments applied */
  adjustments: {
    base: number;
    kelly: number | null;
    volatility: number | null;
    drawdown: number | null;
    confidence: number | null;
    final: number;
  };

  /** Warnings or notes */
  warnings: string[];
}

const DEFAULT_CONFIG: PositionSizingConfig = {
  baseSize: 0.1, // 10% base
  minSize: 0.02, // 2% minimum
  maxSize: 0.15, // 15% maximum
  useKelly: true,
  kellyFraction: 0.25, // Quarter Kelly (conservative)
  useVolatilityAdjustment: true,
  targetVolatility: 0.02, // 2% target ATR/price
  useDrawdownScaling: true,
  drawdownThreshold: 0.03, // Start reducing at 3% drawdown
  maxDrawdownReduction: 0.5, // Reduce by max 50% in drawdown
  useConfidenceScaling: true,
  minConfidenceForFullSize: 0.6, // Below 60% confidence, scale down
};

export class PositionSizer {
  private config: PositionSizingConfig;

  // Historical tracking for Kelly calculation
  private recentWins: number = 0;
  private recentLosses: number = 0;
  private recentWinPnL: number = 0;
  private recentLossPnL: number = 0;
  private tradeWindow: number = 20; // Look at last 20 trades

  constructor(config: Partial<PositionSizingConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Calculate optimal position size
   */
  calculate(input: PositionSizeInput): PositionSizeResult {
    const warnings: string[] = [];
    let sizeFraction = this.config.baseSize;

    const adjustments = {
      base: this.config.baseSize,
      kelly: null as number | null,
      volatility: null as number | null,
      drawdown: null as number | null,
      confidence: null as number | null,
      final: 0,
    };

    // 1. Kelly Criterion Adjustment
    if (this.config.useKelly && input.winRate > 0 && input.avgRiskReward > 0) {
      const kellySize = this.calculateKelly(input.winRate, input.avgRiskReward);
      const adjustedKelly = kellySize * this.config.kellyFraction;

      adjustments.kelly = adjustedKelly;

      // Use minimum of base and Kelly (conservative)
      if (adjustedKelly < sizeFraction) {
        sizeFraction = adjustedKelly;
        warnings.push(`Kelly suggests smaller size: ${(kellySize * 100).toFixed(1)}%`);
      }
    }

    // 2. Volatility Adjustment
    if (this.config.useVolatilityAdjustment && input.atr > 0 && input.price > 0) {
      const currentVol = input.atr / input.price;
      const volRatio = this.config.targetVolatility / currentVol;

      // Scale position inversely with volatility
      // High volatility = smaller position
      const volAdjustment = Math.max(0.5, Math.min(1.5, volRatio));
      adjustments.volatility = volAdjustment;

      sizeFraction *= volAdjustment;

      if (volAdjustment < 0.8) {
        warnings.push(`High volatility: size reduced by ${((1 - volAdjustment) * 100).toFixed(0)}%`);
      }
    }

    // 3. Drawdown Scaling
    if (this.config.useDrawdownScaling && input.currentDrawdown > this.config.drawdownThreshold) {
      const excessDrawdown = input.currentDrawdown - this.config.drawdownThreshold;
      const maxExcess = this.config.maxSize - this.config.drawdownThreshold;

      // Linear reduction: at maxDrawdown, reduce by maxDrawdownReduction
      const reductionFactor = 1 - (excessDrawdown / maxExcess) * this.config.maxDrawdownReduction;
      const ddAdjustment = Math.max(1 - this.config.maxDrawdownReduction, reductionFactor);

      adjustments.drawdown = ddAdjustment;
      sizeFraction *= ddAdjustment;

      warnings.push(`In drawdown: size reduced by ${((1 - ddAdjustment) * 100).toFixed(0)}%`);
    }

    // 4. Confidence Scaling
    if (this.config.useConfidenceScaling && input.confidence < this.config.minConfidenceForFullSize) {
      const confRatio = input.confidence / this.config.minConfidenceForFullSize;
      const confAdjustment = Math.max(0.5, confRatio); // At least 50%

      adjustments.confidence = confAdjustment;
      sizeFraction *= confAdjustment;

      warnings.push(`Low confidence: size reduced by ${((1 - confAdjustment) * 100).toFixed(0)}%`);
    }

    // 5. Enforce min/max limits
    sizeFraction = Math.max(this.config.minSize, Math.min(this.config.maxSize, sizeFraction));
    adjustments.final = sizeFraction;

    // Calculate actual values
    const positionValue = input.equity * sizeFraction;
    const units = positionValue / input.price;
    const dollarRisk = units * input.stopLossDistance;

    // Risk check
    const riskPercent = dollarRisk / input.equity;
    if (riskPercent > 0.02) {
      warnings.push(`High risk per trade: ${(riskPercent * 100).toFixed(2)}%`);
    }

    return {
      sizeFraction,
      positionValue,
      units,
      dollarRisk,
      adjustments,
      warnings,
    };
  }

  /**
   * Calculate Kelly criterion
   * Kelly % = W - [(1-W) / R]
   * W = win rate, R = avg win / avg loss (risk:reward)
   */
  private calculateKelly(winRate: number, avgRiskReward: number): number {
    // Kelly formula
    const kelly = winRate - (1 - winRate) / avgRiskReward;

    // Kelly can be negative (edge is negative), return 0 in that case
    return Math.max(0, kelly);
  }

  /**
   * Record a trade result to update internal stats
   */
  recordTrade(won: boolean, pnlPercent: number): void {
    if (won) {
      this.recentWins++;
      this.recentWinPnL += pnlPercent;
    } else {
      this.recentLosses++;
      this.recentLossPnL += Math.abs(pnlPercent);
    }

    // Keep within window
    const totalTrades = this.recentWins + this.recentLosses;
    if (totalTrades > this.tradeWindow) {
      // Simple decay: reduce all by proportional amount
      const decayFactor = this.tradeWindow / totalTrades;
      this.recentWins *= decayFactor;
      this.recentLosses *= decayFactor;
      this.recentWinPnL *= decayFactor;
      this.recentLossPnL *= decayFactor;
    }
  }

  /**
   * Get current calculated win rate and R:R from tracked trades
   */
  getTrackedStats(): { winRate: number; avgRiskReward: number; trades: number } {
    const totalTrades = this.recentWins + this.recentLosses;
    if (totalTrades === 0) {
      return { winRate: 0.5, avgRiskReward: 1, trades: 0 };
    }

    const winRate = this.recentWins / totalTrades;
    const avgWin = this.recentWins > 0 ? this.recentWinPnL / this.recentWins : 0;
    const avgLoss = this.recentLosses > 0 ? this.recentLossPnL / this.recentLosses : 1;
    const avgRiskReward = avgLoss > 0 ? avgWin / avgLoss : 1;

    return { winRate, avgRiskReward, trades: totalTrades };
  }

  /**
   * Get optimal size for risk-per-trade approach
   * Risk a fixed % of capital per trade, regardless of stop distance
   */
  calculateRiskBased(
    equity: number,
    price: number,
    stopLossDistance: number,
    riskPercent: number = 0.01 // Default 1% risk per trade
  ): { sizeFraction: number; units: number; positionValue: number } {
    // Dollar risk = equity * riskPercent
    const dollarRisk = equity * riskPercent;

    // Units = dollarRisk / stopLossDistance
    const units = dollarRisk / stopLossDistance;

    // Position value
    const positionValue = units * price;

    // Size fraction
    const sizeFraction = positionValue / equity;

    return {
      sizeFraction: Math.min(sizeFraction, this.config.maxSize),
      units,
      positionValue: Math.min(positionValue, equity * this.config.maxSize),
    };
  }

  /**
   * Get current config
   */
  getConfig(): Readonly<PositionSizingConfig> {
    return { ...this.config };
  }

  /**
   * Update config
   */
  updateConfig(config: Partial<PositionSizingConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

export { DEFAULT_CONFIG as DEFAULT_POSITION_SIZING_CONFIG };
