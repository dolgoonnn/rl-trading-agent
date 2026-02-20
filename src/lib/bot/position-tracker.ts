/**
 * Position Tracker — State Persistence & Equity Tracking
 *
 * Manages the bot's persistent state: open positions, equity curve,
 * trade history, and equity snapshots. All state is stored in SQLite
 * via Drizzle ORM for crash recovery.
 */

import { eq } from 'drizzle-orm';
import type {
  BotPosition,
  BotTradeRecord,
  EquitySnapshot,
  BotState,
  CircuitBreakerState,
} from '@/types/bot';
import { db } from '@/lib/data/db';
import {
  botState,
  botPositions,
  botTrades,
  botEquitySnapshots,
} from '@/lib/data/schema';

export class PositionTracker {
  private state: BotState;

  constructor(initialCapital: number) {
    this.state = {
      openPositions: [],
      equity: initialCapital,
      peakEquity: initialCapital,
      consecutiveLosses: 0,
      circuitBreakers: [],
      lastProcessedTimestamp: {},
      dailyPnl: 0,
      weeklyPnl: 0,
      recentErrors: [],
      startedAt: Date.now(),
      totalTrades: 0,
    };
  }

  // ============================================
  // State Management
  // ============================================

  /** Load state from DB (returns false if no saved state) */
  loadState(): boolean {
    const row = db.select().from(botState).where(eq(botState.id, 1)).get();
    if (!row) return false;

    // Load open positions
    const openPosRows = db.select()
      .from(botPositions)
      .where(eq(botPositions.status, 'open'))
      .all();

    this.state = {
      openPositions: openPosRows.map(this.rowToPosition),
      equity: row.equity,
      peakEquity: row.peakEquity,
      consecutiveLosses: row.consecutiveLosses,
      circuitBreakers: JSON.parse(row.circuitBreakers) as CircuitBreakerState[],
      lastProcessedTimestamp: JSON.parse(row.lastProcessedTimestamp) as Record<string, number>,
      dailyPnl: row.dailyPnl,
      weeklyPnl: row.weeklyPnl,
      recentErrors: JSON.parse(row.recentErrors) as number[],
      startedAt: row.startedAt,
      totalTrades: row.totalTrades,
    };

    return true;
  }

  /** Save state to DB */
  saveState(): void {
    const existing = db.select().from(botState).where(eq(botState.id, 1)).get();

    const values = {
      id: 1,
      equity: this.state.equity,
      peakEquity: this.state.peakEquity,
      consecutiveLosses: this.state.consecutiveLosses,
      dailyPnl: this.state.dailyPnl,
      weeklyPnl: this.state.weeklyPnl,
      circuitBreakers: JSON.stringify(this.state.circuitBreakers),
      lastProcessedTimestamp: JSON.stringify(this.state.lastProcessedTimestamp),
      recentErrors: JSON.stringify(this.state.recentErrors),
      totalTrades: this.state.totalTrades,
      startedAt: this.state.startedAt,
      updatedAt: Date.now(),
    };

    if (existing) {
      db.update(botState).set(values).where(eq(botState.id, 1)).run();
    } else {
      db.insert(botState).values(values).run();
    }
  }

  // ============================================
  // Position Tracking
  // ============================================

  /** Add a newly opened position */
  addPosition(position: BotPosition): void {
    this.state.openPositions.push(position);

    // Persist to DB
    db.insert(botPositions).values({
      id: position.id,
      symbol: position.symbol,
      direction: position.direction,
      status: 'open',
      entryPrice: position.entryPrice,
      entryTimestamp: position.entryTimestamp,
      entryBarIndex: position.entryBarIndex,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      currentSL: position.currentSL,
      positionSizeUSDT: position.positionSizeUSDT,
      riskAmountUSDT: position.riskAmountUSDT,
      strategy: position.strategy,
      confluenceScore: position.confluenceScore,
      factorBreakdown: JSON.stringify(position.factorBreakdown),
      regime: position.regime,
      partialTaken: position.partialTaken,
      partialPnlPercent: position.partialPnlPercent,
      createdAt: Date.now(),
    }).run();

    this.saveState();
  }

  /** Update a position (e.g., partial TP taken, SL moved) */
  updatePosition(position: BotPosition): void {
    const idx = this.state.openPositions.findIndex((p) => p.id === position.id);
    if (idx >= 0) {
      this.state.openPositions[idx] = position;
    }

    db.update(botPositions).set({
      currentSL: position.currentSL,
      partialTaken: position.partialTaken,
      partialPnlPercent: position.partialPnlPercent,
    }).where(eq(botPositions.id, position.id)).run();
  }

  /** Close a position and record the trade */
  closePosition(position: BotPosition): void {
    // Remove from open positions
    this.state.openPositions = this.state.openPositions.filter((p) => p.id !== position.id);

    // Update equity
    const pnlUSDT = position.pnlUSDT ?? 0;
    this.state.equity += pnlUSDT;
    this.state.peakEquity = Math.max(this.state.peakEquity, this.state.equity);
    this.state.dailyPnl += pnlUSDT;
    this.state.weeklyPnl += pnlUSDT;
    this.state.totalTrades++;

    // Track consecutive losses
    if (pnlUSDT < 0) {
      this.state.consecutiveLosses++;
    } else {
      this.state.consecutiveLosses = 0;
    }

    // Update position in DB
    db.update(botPositions).set({
      status: 'closed',
      exitPrice: position.exitPrice,
      exitTimestamp: position.exitTimestamp,
      exitReason: position.exitReason,
      barsHeld: position.barsHeld,
      pnlPercent: position.pnlPercent,
      pnlUSDT: position.pnlUSDT,
      currentSL: position.currentSL,
      partialTaken: position.partialTaken,
      partialPnlPercent: position.partialPnlPercent,
    }).where(eq(botPositions.id, position.id)).run();

    // Insert trade record
    const drawdown = this.state.peakEquity > 0
      ? (this.state.peakEquity - this.state.equity) / this.state.peakEquity
      : 0;

    db.insert(botTrades).values({
      id: position.id,
      symbol: position.symbol,
      direction: position.direction,
      entryPrice: position.entryPrice,
      exitPrice: position.exitPrice!,
      entryTimestamp: position.entryTimestamp,
      exitTimestamp: position.exitTimestamp!,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      positionSizeUSDT: position.positionSizeUSDT,
      riskAmountUSDT: position.riskAmountUSDT,
      strategy: position.strategy,
      confluenceScore: position.confluenceScore,
      factorBreakdown: JSON.stringify(position.factorBreakdown),
      regime: position.regime,
      exitReason: position.exitReason!,
      barsHeld: position.barsHeld!,
      pnlPercent: position.pnlPercent!,
      pnlUSDT: position.pnlUSDT!,
      equityAfter: this.state.equity,
      drawdownFromPeak: drawdown,
      createdAt: Date.now(),
    }).run();

    this.saveState();
  }

  // ============================================
  // Equity Snapshots
  // ============================================

  /** Record an equity snapshot */
  recordSnapshot(): void {
    const drawdown = this.state.peakEquity > 0
      ? (this.state.peakEquity - this.state.equity) / this.state.peakEquity
      : 0;
    const cumulativePnl = this.state.equity - this.getInitialCapital();

    db.insert(botEquitySnapshots).values({
      timestamp: Date.now(),
      equity: this.state.equity,
      peakEquity: this.state.peakEquity,
      drawdown,
      openPositions: this.state.openPositions.length,
      dailyPnl: this.state.dailyPnl,
      cumulativePnl,
    }).run();
  }

  // ============================================
  // Getters
  // ============================================

  getState(): BotState { return this.state; }
  getEquity(): number { return this.state.equity; }
  getPeakEquity(): number { return this.state.peakEquity; }
  getOpenPositions(): BotPosition[] { return [...this.state.openPositions]; }
  getConsecutiveLosses(): number { return this.state.consecutiveLosses; }
  getDailyPnl(): number { return this.state.dailyPnl; }
  getWeeklyPnl(): number { return this.state.weeklyPnl; }
  getTotalTrades(): number { return this.state.totalTrades; }

  getDrawdown(): number {
    if (this.state.peakEquity <= 0) return 0;
    return (this.state.peakEquity - this.state.equity) / this.state.peakEquity;
  }

  hasOpenPosition(symbol: string): boolean {
    return this.state.openPositions.some((p) => p.symbol === symbol);
  }

  getOpenPosition(symbol: string): BotPosition | undefined {
    return this.state.openPositions.find((p) => p.symbol === symbol);
  }

  // ============================================
  // Daily/Weekly Reset
  // ============================================

  /** Reset daily PnL counter (call at midnight UTC) */
  resetDailyPnl(): void {
    this.state.dailyPnl = 0;
    this.saveState();
  }

  /** Reset weekly PnL counter (call on Monday UTC) */
  resetWeeklyPnl(): void {
    this.state.weeklyPnl = 0;
    this.saveState();
  }

  /** Record last processed timestamp for a symbol */
  setLastProcessedTimestamp(symbol: string, timestamp: number): void {
    this.state.lastProcessedTimestamp[symbol] = timestamp;
  }

  getLastProcessedTimestamp(symbol: string): number {
    return this.state.lastProcessedTimestamp[symbol] ?? 0;
  }

  // ============================================
  // Circuit Breakers
  // ============================================

  setCircuitBreakers(breakers: CircuitBreakerState[]): void {
    this.state.circuitBreakers = breakers;
    this.saveState();
  }

  getCircuitBreakers(): CircuitBreakerState[] {
    return this.state.circuitBreakers;
  }

  // ============================================
  // Error tracking
  // ============================================

  recordError(): void {
    this.state.recentErrors.push(Date.now());
    // Keep only last hour
    const hourAgo = Date.now() - 3600_000;
    this.state.recentErrors = this.state.recentErrors.filter((t) => t > hourAgo);
    this.saveState();
  }

  getRecentErrorCount(): number {
    const hourAgo = Date.now() - 3600_000;
    return this.state.recentErrors.filter((t) => t > hourAgo).length;
  }

  // ============================================
  // Performance Stats
  // ============================================

  /** Get trade history from DB */
  getTradeHistory(limit = 100): BotTradeRecord[] {
    const rows = db.select()
      .from(botTrades)
      .orderBy(botTrades.createdAt)
      .limit(limit)
      .all();

    return rows.map((row) => ({
      id: row.id,
      symbol: row.symbol as BotTradeRecord['symbol'],
      direction: row.direction as BotTradeRecord['direction'],
      entryPrice: row.entryPrice,
      exitPrice: row.exitPrice,
      entryTimestamp: row.entryTimestamp,
      exitTimestamp: row.exitTimestamp,
      stopLoss: row.stopLoss,
      takeProfit: row.takeProfit,
      positionSizeUSDT: row.positionSizeUSDT,
      riskAmountUSDT: row.riskAmountUSDT,
      strategy: row.strategy,
      confluenceScore: row.confluenceScore,
      factorBreakdown: row.factorBreakdown,
      regime: row.regime,
      exitReason: row.exitReason as BotTradeRecord['exitReason'],
      barsHeld: row.barsHeld,
      pnlPercent: row.pnlPercent,
      pnlUSDT: row.pnlUSDT,
      equityAfter: row.equityAfter,
      drawdownFromPeak: row.drawdownFromPeak,
    }));
  }

  // ============================================
  // Private
  // ============================================

  private getInitialCapital(): number {
    // Derived from first equity snapshot or from state start
    const firstSnapshot = db.select()
      .from(botEquitySnapshots)
      .orderBy(botEquitySnapshots.timestamp)
      .limit(1)
      .get();

    return firstSnapshot?.equity ?? this.state.equity;
  }

  private rowToPosition(row: typeof botPositions.$inferSelect): BotPosition {
    return {
      id: row.id,
      symbol: row.symbol as BotPosition['symbol'],
      direction: row.direction as BotPosition['direction'],
      status: row.status as BotPosition['status'],
      entryPrice: row.entryPrice,
      entryTimestamp: row.entryTimestamp,
      entryBarIndex: row.entryBarIndex,
      stopLoss: row.stopLoss,
      takeProfit: row.takeProfit,
      currentSL: row.currentSL,
      positionSizeUSDT: row.positionSizeUSDT,
      riskAmountUSDT: row.riskAmountUSDT,
      strategy: row.strategy,
      confluenceScore: row.confluenceScore,
      factorBreakdown: JSON.parse(row.factorBreakdown) as Record<string, number>,
      regime: row.regime,
      partialTaken: row.partialTaken ?? false,
      partialPnlPercent: row.partialPnlPercent ?? 0,
      exitPrice: row.exitPrice ?? undefined,
      exitTimestamp: row.exitTimestamp ?? undefined,
      exitReason: row.exitReason as BotPosition['exitReason'],
      barsHeld: row.barsHeld ?? undefined,
      pnlPercent: row.pnlPercent ?? undefined,
      pnlUSDT: row.pnlUSDT ?? undefined,
    };
  }
}
