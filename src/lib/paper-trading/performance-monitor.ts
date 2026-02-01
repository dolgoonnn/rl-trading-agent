/**
 * Performance Monitor
 * Real-time performance tracking for paper trading
 */

import type {
  PaperTrade,
  PerformanceMetrics,
  PerformanceSnapshot,
} from './types';

export class PerformanceMonitor {
  private trades: PaperTrade[] = [];
  private currentEquity: number;
  private initialCapital: number;
  private peakEquity: number;
  private equityHistory: { timestamp: Date; equity: number }[] = [];
  private backtestSharpe?: number;

  // Streak tracking
  private currentStreak: number = 0;
  private currentStreakType: 'win' | 'lose' | null = null;
  private longestWinStreak: number = 0;
  private longestLoseStreak: number = 0;

  constructor(initialCapital: number, backtestSharpe?: number) {
    this.initialCapital = initialCapital;
    this.currentEquity = initialCapital;
    this.peakEquity = initialCapital;
    this.backtestSharpe = backtestSharpe;
  }

  /**
   * Record a trade
   */
  recordTrade(trade: PaperTrade): void {
    this.trades.push(trade);

    if (trade.status === 'closed' && trade.pnl !== undefined) {
      this.currentEquity += trade.pnl;

      // Update peak equity
      if (this.currentEquity > this.peakEquity) {
        this.peakEquity = this.currentEquity;
      }

      // Update streaks
      const isWin = trade.pnl > 0;
      if (isWin) {
        if (this.currentStreakType === 'win') {
          this.currentStreak++;
        } else {
          this.currentStreak = 1;
          this.currentStreakType = 'win';
        }
        this.longestWinStreak = Math.max(this.longestWinStreak, this.currentStreak);
      } else {
        if (this.currentStreakType === 'lose') {
          this.currentStreak++;
        } else {
          this.currentStreak = 1;
          this.currentStreakType = 'lose';
        }
        this.longestLoseStreak = Math.max(this.longestLoseStreak, this.currentStreak);
      }

      // Record equity snapshot
      this.equityHistory.push({
        timestamp: new Date(),
        equity: this.currentEquity,
      });
    }
  }

  /**
   * Update unrealized PnL for open position
   */
  updateUnrealizedPnl(_unrealizedPnl: number): void {
    // Don't record this in equity history, just track for current display
    // Future: Could emit event or update live display
  }

  /**
   * Get current performance metrics
   */
  getMetrics(unrealizedPnl: number = 0): PerformanceMetrics {
    const closedTrades = this.trades.filter((t) => t.status === 'closed');
    const openTrades = this.trades.filter((t) => t.status === 'open');

    // Win/loss counts
    const wins = closedTrades.filter((t) => t.pnl > 0).length;
    const losses = closedTrades.filter((t) => t.pnl <= 0).length;

    // PnL calculations
    const winningPnls = closedTrades.filter((t) => t.pnl > 0).map((t) => t.pnl);
    const losingPnls = closedTrades.filter((t) => t.pnl <= 0).map((t) => t.pnl);

    const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    const totalPnlPercent = (totalPnl / this.initialCapital) * 100;

    const avgWin = winningPnls.length > 0
      ? winningPnls.reduce((a, b) => a + b, 0) / winningPnls.length
      : 0;
    const avgLoss = losingPnls.length > 0
      ? Math.abs(losingPnls.reduce((a, b) => a + b, 0)) / losingPnls.length
      : 0;

    const largestWin = winningPnls.length > 0 ? Math.max(...winningPnls) : 0;
    const largestLoss = losingPnls.length > 0 ? Math.min(...losingPnls) : 0;

    // Profit factor
    const grossProfit = winningPnls.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losingPnls.reduce((a, b) => a + b, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // Drawdown
    const currentDrawdown = this.peakEquity - this.currentEquity;
    const maxDrawdown = this.calculateMaxDrawdown();
    const maxDrawdownPercent = (maxDrawdown / this.peakEquity) * 100;

    // Risk metrics
    const sharpe = this.calculateSharpe();
    const sortino = this.calculateSortino();

    // Holding period
    const holdingBars = closedTrades.map((t) => t.holdingPeriod);
    const avgHoldingBars = holdingBars.length > 0
      ? holdingBars.reduce((a, b) => a + b, 0) / holdingBars.length
      : 0;

    const metrics: PerformanceMetrics = {
      totalTrades: this.trades.length,
      openTrades: openTrades.length,
      closedTrades: closedTrades.length,
      wins,
      losses,
      winRate: closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0,
      profitFactor,
      totalPnl,
      totalPnlPercent,
      unrealizedPnl,
      avgWin,
      avgLoss,
      largestWin,
      largestLoss,
      maxDrawdown,
      maxDrawdownPercent,
      currentDrawdown,
      sharpe,
      sortino,
      avgHoldingBars,
      longestWinStreak: this.longestWinStreak,
      longestLoseStreak: this.longestLoseStreak,
      currentStreak: this.currentStreakType === 'win' ? this.currentStreak : -this.currentStreak,
    };

    // Add backtest comparison if available
    if (this.backtestSharpe !== undefined) {
      metrics.backtestSharpe = this.backtestSharpe;
      metrics.sharpeDeviation = sharpe - this.backtestSharpe;
    }

    return metrics;
  }

  /**
   * Calculate maximum drawdown from equity history
   */
  private calculateMaxDrawdown(): number {
    if (this.equityHistory.length === 0) {
      return this.peakEquity - this.currentEquity;
    }

    let maxDrawdown = 0;
    let peak = this.initialCapital;

    for (const point of this.equityHistory) {
      if (point.equity > peak) {
        peak = point.equity;
      }
      const drawdown = peak - point.equity;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    // Also check current state
    const currentDrawdown = this.peakEquity - this.currentEquity;
    return Math.max(maxDrawdown, currentDrawdown);
  }

  /**
   * Calculate Sharpe ratio (annualized)
   */
  private calculateSharpe(): number {
    const closedTrades = this.trades.filter((t) => t.status === 'closed');
    if (closedTrades.length < 2) return 0;

    const returns = closedTrades.map((t) => t.pnlPercent);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
    const std = Math.sqrt(variance);

    if (std === 0) return mean > 0 ? 1 : mean < 0 ? -1 : 0;

    // Annualize assuming hourly trades
    return (mean / std) * Math.sqrt(252 * 24);
  }

  /**
   * Calculate Sortino ratio (only downside volatility)
   */
  private calculateSortino(): number {
    const closedTrades = this.trades.filter((t) => t.status === 'closed');
    if (closedTrades.length < 2) return 0;

    const returns = closedTrades.map((t) => t.pnlPercent);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;

    // Only negative returns for downside deviation
    const negativeReturns = returns.filter((r) => r < 0);
    if (negativeReturns.length === 0) return mean > 0 ? Infinity : 0;

    const downsideVariance = negativeReturns.reduce((a, b) => a + Math.pow(b, 2), 0) / negativeReturns.length;
    const downsideStd = Math.sqrt(downsideVariance);

    if (downsideStd === 0) return 0;

    // Annualize
    return (mean / downsideStd) * Math.sqrt(252 * 24);
  }

  /**
   * Get performance snapshot
   */
  getSnapshot(unrealizedPnl: number = 0): PerformanceSnapshot {
    return {
      timestamp: new Date(),
      equity: this.currentEquity + unrealizedPnl,
      drawdown: this.peakEquity - (this.currentEquity + unrealizedPnl),
      metrics: this.getMetrics(unrealizedPnl),
    };
  }

  /**
   * Get equity curve
   */
  getEquityCurve(): { timestamp: Date; equity: number }[] {
    return [...this.equityHistory];
  }

  /**
   * Get current equity
   */
  getCurrentEquity(): number {
    return this.currentEquity;
  }

  /**
   * Get peak equity
   */
  getPeakEquity(): number {
    return this.peakEquity;
  }

  /**
   * Set backtest Sharpe for comparison
   */
  setBacktestSharpe(sharpe: number): void {
    this.backtestSharpe = sharpe;
  }

  /**
   * Reset monitor
   */
  reset(): void {
    this.trades = [];
    this.currentEquity = this.initialCapital;
    this.peakEquity = this.initialCapital;
    this.equityHistory = [];
    this.currentStreak = 0;
    this.currentStreakType = null;
    this.longestWinStreak = 0;
    this.longestLoseStreak = 0;
  }

  /**
   * Format metrics for console output
   */
  formatMetrics(metrics: PerformanceMetrics): string {
    const lines: string[] = [];

    lines.push('-'.repeat(72));
    lines.push('SESSION PERFORMANCE');

    const winRateStr = metrics.winRate.toFixed(1);
    const pfStr = metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(2);
    lines.push(`  Trades: ${metrics.closedTrades} | Win Rate: ${winRateStr}% | Profit Factor: ${pfStr}`);

    const pnlSign = metrics.totalPnl >= 0 ? '+' : '';
    const pctSign = metrics.totalPnlPercent >= 0 ? '+' : '';
    lines.push(`  Total PnL: ${pnlSign}$${metrics.totalPnl.toFixed(2)} (${pctSign}${metrics.totalPnlPercent.toFixed(2)}%) | Max DD: -${metrics.maxDrawdownPercent.toFixed(1)}%`);

    const sharpeStr = metrics.sharpe.toFixed(2);
    if (metrics.backtestSharpe !== undefined && metrics.sharpeDeviation !== undefined) {
      const devSign = metrics.sharpeDeviation >= 0 ? '+' : '';
      lines.push(`  Sharpe: ${sharpeStr} | Backtest Sharpe: ${metrics.backtestSharpe.toFixed(2)} (${devSign}${metrics.sharpeDeviation.toFixed(2)} deviation)`);
    } else {
      lines.push(`  Sharpe: ${sharpeStr} | Sortino: ${metrics.sortino.toFixed(2)}`);
    }

    lines.push('='.repeat(72));

    return lines.join('\n');
  }
}
