/**
 * Risk Engine — Circuit Breakers & Position Limits
 *
 * Enforces risk management rules:
 * - Daily/weekly loss limits
 * - Max drawdown from peak
 * - Consecutive loss limits
 * - System error rate limits
 * - Max concurrent positions
 *
 * Circuit breakers pause trading for a defined period when triggered.
 */

import type {
  CircuitBreakerConfig,
  CircuitBreakerState,
  CircuitBreakerType,
  BotSymbol,
} from '@/types/bot';
import type { PositionTracker } from './position-tracker';
import { DEFAULT_CIRCUIT_BREAKERS } from './config';

/** Duration constants in milliseconds */
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export class RiskEngine {
  private config: CircuitBreakerConfig;
  private maxPositions: number;

  constructor(
    config: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKERS,
    maxPositions = 3,
  ) {
    this.config = config;
    this.maxPositions = maxPositions;
  }

  /**
   * Check if trading is allowed. Returns null if OK, or the blocking
   * circuit breaker if trading should be paused.
   */
  canTrade(tracker: PositionTracker): CircuitBreakerState | null {
    // Check active circuit breakers
    const activeBreakers = tracker.getCircuitBreakers()
      .filter((cb) => Date.now() < cb.resumeAt);

    if (activeBreakers.length > 0) {
      return activeBreakers[0]!;
    }

    // Check position count limit
    if (tracker.getOpenPositions().length >= this.maxPositions) {
      return {
        type: 'max_drawdown', // Reuse type, not a real circuit breaker
        triggeredAt: Date.now(),
        resumeAt: Date.now() + 60_000, // Re-check in 1 min
        reason: `Max positions reached (${this.maxPositions})`,
      };
    }

    return null;
  }

  /**
   * Check if a specific symbol can be traded (no existing position).
   */
  canTradeSymbol(tracker: PositionTracker, symbol: BotSymbol): boolean {
    return !tracker.hasOpenPosition(symbol);
  }

  /**
   * Evaluate circuit breaker conditions after a trade close.
   * Returns any newly triggered circuit breakers.
   */
  evaluateAfterTrade(tracker: PositionTracker): CircuitBreakerState[] {
    const triggered: CircuitBreakerState[] = [];
    const now = Date.now();

    // 1. Daily loss limit
    const dailyPnlPct = tracker.getDailyPnl() / tracker.getEquity();
    if (dailyPnlPct < -this.config.dailyLossLimit) {
      triggered.push({
        type: 'daily_loss',
        triggeredAt: now,
        resumeAt: now + DAY_MS,
        reason: `Daily loss limit hit: ${(dailyPnlPct * 100).toFixed(2)}% < -${(this.config.dailyLossLimit * 100).toFixed(1)}%`,
      });
    }

    // 2. Weekly loss limit
    const weeklyPnlPct = tracker.getWeeklyPnl() / tracker.getEquity();
    if (weeklyPnlPct < -this.config.weeklyLossLimit) {
      triggered.push({
        type: 'weekly_loss',
        triggeredAt: now,
        resumeAt: now + WEEK_MS,
        reason: `Weekly loss limit hit: ${(weeklyPnlPct * 100).toFixed(2)}% < -${(this.config.weeklyLossLimit * 100).toFixed(1)}%`,
      });
    }

    // 3. Max drawdown from peak
    const drawdown = tracker.getDrawdown();
    if (drawdown > this.config.maxDrawdown) {
      triggered.push({
        type: 'max_drawdown',
        triggeredAt: now,
        resumeAt: Infinity, // Manual review required
        reason: `Max drawdown exceeded: ${(drawdown * 100).toFixed(2)}% > ${(this.config.maxDrawdown * 100).toFixed(1)}%`,
      });
    }

    // 4. Consecutive losses
    if (tracker.getConsecutiveLosses() >= this.config.maxConsecutiveLosses) {
      triggered.push({
        type: 'consecutive_losses',
        triggeredAt: now,
        resumeAt: now + 2 * DAY_MS, // 48 hours
        reason: `${tracker.getConsecutiveLosses()} consecutive losses (limit: ${this.config.maxConsecutiveLosses})`,
      });
    }

    // 5. System error rate
    if (tracker.getRecentErrorCount() >= this.config.maxSystemErrorsPerHour) {
      triggered.push({
        type: 'system_errors',
        triggeredAt: now,
        resumeAt: now + HOUR_MS,
        reason: `${tracker.getRecentErrorCount()} errors in the last hour (limit: ${this.config.maxSystemErrorsPerHour})`,
      });
    }

    // Update tracker with new breakers
    if (triggered.length > 0) {
      const existing = tracker.getCircuitBreakers().filter((cb) => Date.now() < cb.resumeAt);
      tracker.setCircuitBreakers([...existing, ...triggered]);
    }

    return triggered;
  }

  /**
   * Clean up expired circuit breakers.
   */
  cleanupExpiredBreakers(tracker: PositionTracker): void {
    const active = tracker.getCircuitBreakers().filter((cb) => Date.now() < cb.resumeAt);
    tracker.setCircuitBreakers(active);
  }

  /**
   * Get human-readable status of all circuit breakers.
   */
  getStatus(tracker: PositionTracker): string[] {
    const lines: string[] = [];
    const breakers = tracker.getCircuitBreakers();

    if (breakers.length === 0) {
      lines.push('All circuit breakers OK');
    } else {
      for (const cb of breakers) {
        const active = Date.now() < cb.resumeAt;
        const resumeStr = cb.resumeAt === Infinity
          ? 'manual review required'
          : new Date(cb.resumeAt).toISOString();
        lines.push(
          `[${active ? 'ACTIVE' : 'EXPIRED'}] ${cb.type}: ${cb.reason} (resume: ${resumeStr})`,
        );
      }
    }

    lines.push(`Equity: $${tracker.getEquity().toFixed(2)}`);
    lines.push(`Peak: $${tracker.getPeakEquity().toFixed(2)}`);
    lines.push(`Drawdown: ${(tracker.getDrawdown() * 100).toFixed(2)}%`);
    lines.push(`Daily PnL: $${tracker.getDailyPnl().toFixed(2)}`);
    lines.push(`Open positions: ${tracker.getOpenPositions().length}/${this.maxPositions}`);

    return lines;
  }
}
