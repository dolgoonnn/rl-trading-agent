/**
 * Evaluator
 * Calculates performance metrics for the RL agent
 */

import type {
  TradeRecord,
  TrainingMetrics,
  EvaluationResult,
} from '../types';

export interface PerformanceMetrics {
  // Return metrics
  totalReturn: number;
  totalReturnPercent: number;
  averageReturn: number;

  // Risk metrics
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdown: number;
  calmarRatio: number;

  // Trade metrics
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  averageWin: number;
  averageLoss: number;
  largestWin: number;
  largestLoss: number;
  averageHoldingPeriod: number;

  // Expectancy
  expectancy: number;

  // Additional metrics for production readiness
  maxConsecutiveLosses: number; // Longest losing streak
  maxDrawdownDuration: number; // Bars in drawdown
  longWinRate: number; // Win rate for long trades
  shortWinRate: number; // Win rate for short trades
  profitFactorLong: number; // Profit factor for long trades
  profitFactorShort: number; // Profit factor for short trades
  recoveryFactor: number; // Total return / max drawdown
}

export class Evaluator {
  private readonly RISK_FREE_RATE = 0.02; // 2% annual risk-free rate
  private readonly ANNUALIZATION_FACTOR = 252; // Trading days per year

  /**
   * Calculate comprehensive performance metrics
   */
  calculateMetrics(
    trades: TradeRecord[],
    equityCurve: number[],
    initialCapital: number
  ): PerformanceMetrics {
    if (trades.length === 0) {
      return this.emptyMetrics();
    }

    const returns = this.calculateReturns(equityCurve);
    const finalEquity = equityCurve[equityCurve.length - 1] ?? initialCapital;

    // Return metrics
    const totalReturn = finalEquity - initialCapital;
    const totalReturnPercent = (totalReturn / initialCapital) * 100;
    const averageReturn = returns.reduce((a, b) => a + b, 0) / returns.length;

    // Risk metrics
    const sharpeRatio = this.calculateSharpe(returns);
    const sortinoRatio = this.calculateSortino(returns);
    const maxDrawdown = this.calculateMaxDrawdown(equityCurve);
    const calmarRatio = totalReturnPercent > 0 && maxDrawdown > 0
      ? totalReturnPercent / maxDrawdown
      : 0;

    // Trade metrics
    const winningTrades = trades.filter((t) => t.pnl > 0);
    const losingTrades = trades.filter((t) => t.pnl < 0);

    const totalTrades = trades.length;
    const winRate = (winningTrades.length / totalTrades) * 100;

    const totalWins = winningTrades.reduce((a, b) => a + b.pnl, 0);
    const totalLosses = Math.abs(losingTrades.reduce((a, b) => a + b.pnl, 0));
    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0;

    const averageWin = winningTrades.length > 0
      ? totalWins / winningTrades.length
      : 0;
    const averageLoss = losingTrades.length > 0
      ? totalLosses / losingTrades.length
      : 0;

    const largestWin = Math.max(...trades.map((t) => t.pnl), 0);
    const largestLoss = Math.abs(Math.min(...trades.map((t) => t.pnl), 0));

    const averageHoldingPeriod = trades.reduce((a, b) => a + b.holdingPeriod, 0) / totalTrades;

    // Expectancy (expected profit per trade)
    const expectancy = averageReturn * (winRate / 100) - averageLoss * ((100 - winRate) / 100);

    // Additional metrics
    const maxConsecutiveLosses = this.calculateMaxConsecutiveLosses(trades);
    const maxDrawdownDuration = this.calculateMaxDrawdownDuration(equityCurve);

    // Per-direction metrics
    const longTrades = trades.filter((t) => t.side === 'long');
    const shortTrades = trades.filter((t) => t.side === 'short');

    const longWinningTrades = longTrades.filter((t) => t.pnl > 0);
    const shortWinningTrades = shortTrades.filter((t) => t.pnl > 0);

    const longWinRate = longTrades.length > 0 ? (longWinningTrades.length / longTrades.length) * 100 : 0;
    const shortWinRate = shortTrades.length > 0 ? (shortWinningTrades.length / shortTrades.length) * 100 : 0;

    const longWins = longTrades.filter((t) => t.pnl > 0).reduce((a, b) => a + b.pnl, 0);
    const longLosses = Math.abs(longTrades.filter((t) => t.pnl < 0).reduce((a, b) => a + b.pnl, 0));
    const profitFactorLong = longLosses > 0 ? longWins / longLosses : longWins > 0 ? Infinity : 0;

    const shortWins = shortTrades.filter((t) => t.pnl > 0).reduce((a, b) => a + b.pnl, 0);
    const shortLosses = Math.abs(shortTrades.filter((t) => t.pnl < 0).reduce((a, b) => a + b.pnl, 0));
    const profitFactorShort = shortLosses > 0 ? shortWins / shortLosses : shortWins > 0 ? Infinity : 0;

    const recoveryFactor = maxDrawdown > 0 ? totalReturnPercent / maxDrawdown : 0;

    return {
      totalReturn,
      totalReturnPercent,
      averageReturn,
      sharpeRatio,
      sortinoRatio,
      maxDrawdown,
      calmarRatio,
      totalTrades,
      winRate,
      profitFactor,
      averageWin,
      averageLoss,
      largestWin,
      largestLoss,
      averageHoldingPeriod,
      expectancy,
      maxConsecutiveLosses,
      maxDrawdownDuration,
      longWinRate,
      shortWinRate,
      profitFactorLong,
      profitFactorShort,
      recoveryFactor,
    };
  }

  /**
   * Calculate maximum consecutive losses
   */
  private calculateMaxConsecutiveLosses(trades: TradeRecord[]): number {
    let maxStreak = 0;
    let currentStreak = 0;

    for (const trade of trades) {
      if (trade.pnl < 0) {
        currentStreak++;
        maxStreak = Math.max(maxStreak, currentStreak);
      } else {
        currentStreak = 0;
      }
    }

    return maxStreak;
  }

  /**
   * Calculate maximum drawdown duration in bars
   */
  private calculateMaxDrawdownDuration(equityCurve: number[]): number {
    if (equityCurve.length === 0) return 0;

    let maxDuration = 0;
    let currentDuration = 0;
    let peak = equityCurve[0]!;

    for (const equity of equityCurve) {
      if (equity >= peak) {
        peak = equity;
        currentDuration = 0;
      } else {
        currentDuration++;
        maxDuration = Math.max(maxDuration, currentDuration);
      }
    }

    return maxDuration;
  }

  /**
   * Evaluate agent and return comprehensive results
   */
  evaluate(
    trades: TradeRecord[],
    equityCurve: number[],
    initialCapital: number,
    episode: number,
    totalReward: number,
    epsilon: number,
    loss: number
  ): EvaluationResult {
    const metrics = this.calculateMetrics(trades, equityCurve, initialCapital);

    const trainingMetrics: TrainingMetrics = {
      episode,
      totalReward,
      averageReward: equityCurve.length > 0 ? totalReward / equityCurve.length : 0,
      epsilon,
      loss,
      totalTrades: metrics.totalTrades,
      winRate: metrics.winRate,
      sharpeRatio: metrics.sharpeRatio,
      maxDrawdown: metrics.maxDrawdown,
      totalPnL: metrics.totalReturn,
    };

    return {
      metrics: trainingMetrics,
      trades,
      equityCurve,
    };
  }

  /**
   * Calculate period returns from equity curve
   */
  private calculateReturns(equityCurve: number[]): number[] {
    const returns: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) {
      const prev = equityCurve[i - 1]!;
      const curr = equityCurve[i]!;
      if (prev > 0) {
        returns.push((curr - prev) / prev);
      }
    }
    return returns;
  }

  /**
   * Calculate Sharpe ratio
   */
  private calculateSharpe(returns: number[]): number {
    if (returns.length < 2) return 0;

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
    const std = Math.sqrt(variance);

    if (std === 0) return mean > 0 ? Infinity : mean < 0 ? -Infinity : 0;

    // Annualized Sharpe
    const dailyRiskFree = this.RISK_FREE_RATE / this.ANNUALIZATION_FACTOR;
    const excessReturn = mean - dailyRiskFree;
    const annualizedSharpe = (excessReturn / std) * Math.sqrt(this.ANNUALIZATION_FACTOR);

    return annualizedSharpe;
  }

  /**
   * Calculate Sortino ratio (only considers downside deviation)
   */
  private calculateSortino(returns: number[]): number {
    if (returns.length < 2) return 0;

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const negativeReturns = returns.filter((r) => r < 0);

    if (negativeReturns.length === 0) {
      return mean > 0 ? Infinity : 0;
    }

    const downsideVariance = negativeReturns.reduce((a, b) => a + Math.pow(b, 2), 0) / negativeReturns.length;
    const downsideDeviation = Math.sqrt(downsideVariance);

    if (downsideDeviation === 0) return mean > 0 ? Infinity : 0;

    const dailyRiskFree = this.RISK_FREE_RATE / this.ANNUALIZATION_FACTOR;
    const excessReturn = mean - dailyRiskFree;

    return (excessReturn / downsideDeviation) * Math.sqrt(this.ANNUALIZATION_FACTOR);
  }

  /**
   * Calculate maximum drawdown
   */
  private calculateMaxDrawdown(equityCurve: number[]): number {
    if (equityCurve.length === 0) return 0;

    let maxDrawdown = 0;
    let peak = equityCurve[0]!;

    for (const equity of equityCurve) {
      if (equity > peak) {
        peak = equity;
      }
      const drawdown = (peak - equity) / peak;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    return maxDrawdown * 100; // Return as percentage
  }

  /**
   * Return empty metrics structure
   */
  private emptyMetrics(): PerformanceMetrics {
    return {
      totalReturn: 0,
      totalReturnPercent: 0,
      averageReturn: 0,
      sharpeRatio: 0,
      sortinoRatio: 0,
      maxDrawdown: 0,
      calmarRatio: 0,
      totalTrades: 0,
      winRate: 0,
      profitFactor: 0,
      averageWin: 0,
      averageLoss: 0,
      largestWin: 0,
      largestLoss: 0,
      averageHoldingPeriod: 0,
      expectancy: 0,
      maxConsecutiveLosses: 0,
      maxDrawdownDuration: 0,
      longWinRate: 0,
      shortWinRate: 0,
      profitFactorLong: 0,
      profitFactorShort: 0,
      recoveryFactor: 0,
    };
  }

  /**
   * Compare two evaluation results
   */
  compare(a: EvaluationResult, b: EvaluationResult): ComparisonResult {
    const metrics: ComparisonMetric[] = [
      {
        name: 'Total PnL',
        a: a.metrics.totalPnL,
        b: b.metrics.totalPnL,
        better: a.metrics.totalPnL > b.metrics.totalPnL ? 'a' : 'b',
      },
      {
        name: 'Sharpe Ratio',
        a: a.metrics.sharpeRatio,
        b: b.metrics.sharpeRatio,
        better: a.metrics.sharpeRatio > b.metrics.sharpeRatio ? 'a' : 'b',
      },
      {
        name: 'Win Rate',
        a: a.metrics.winRate,
        b: b.metrics.winRate,
        better: a.metrics.winRate > b.metrics.winRate ? 'a' : 'b',
      },
      {
        name: 'Max Drawdown',
        a: a.metrics.maxDrawdown,
        b: b.metrics.maxDrawdown,
        better: a.metrics.maxDrawdown < b.metrics.maxDrawdown ? 'a' : 'b',
      },
      {
        name: 'Total Trades',
        a: a.metrics.totalTrades,
        b: b.metrics.totalTrades,
        better: 'equal',
      },
    ];

    const aWins = metrics.filter((m) => m.better === 'a').length;
    const bWins = metrics.filter((m) => m.better === 'b').length;

    return {
      metrics,
      winner: aWins > bWins ? 'a' : aWins < bWins ? 'b' : 'tie',
    };
  }

  /**
   * Format metrics for logging
   */
  formatMetrics(metrics: TrainingMetrics): string {
    return [
      `Episode: ${metrics.episode}`,
      `Reward: ${metrics.totalReward.toFixed(2)}`,
      `PnL: ${metrics.totalPnL.toFixed(2)}`,
      `Trades: ${metrics.totalTrades}`,
      `Win Rate: ${metrics.winRate.toFixed(1)}%`,
      `Sharpe: ${metrics.sharpeRatio.toFixed(2)}`,
      `Max DD: ${metrics.maxDrawdown.toFixed(1)}%`,
      `Epsilon: ${metrics.epsilon.toFixed(3)}`,
      `Loss: ${metrics.loss.toFixed(6)}`,
    ].join(' | ');
  }
}

interface ComparisonMetric {
  name: string;
  a: number;
  b: number;
  better: 'a' | 'b' | 'equal';
}

interface ComparisonResult {
  metrics: ComparisonMetric[];
  winner: 'a' | 'b' | 'tie';
}
