/**
 * Trade Logger
 * Persists paper trades and sessions to SQLite database
 */

import { db, schema } from '@/lib/data/db';
import { eq } from 'drizzle-orm';
import type {
  PaperTrade,
  PaperSession,
  TradeLogEntry,
  PaperTraderConfig,
} from './types';
import type { ExitAction } from '../rl/types';

export class TradeLogger {
  private sessionId: string;
  private logBuffer: TradeLogEntry[] = [];
  private flushInterval: NodeJS.Timeout | null = null;
  private maxBufferSize: number = 100;

  constructor(
    sessionId: string,
    private readonly symbol: string,
    private readonly timeframe: string,
    private readonly modelPath: string,
    private readonly config: PaperTraderConfig
  ) {
    this.sessionId = sessionId;
  }

  /**
   * Initialize a new trading session
   */
  async initSession(): Promise<PaperSession> {
    const now = new Date();
    const session: PaperSession = {
      id: this.sessionId,
      symbol: this.symbol,
      timeframe: this.timeframe,
      modelPath: this.modelPath,
      config: this.config,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalPnl: 0,
      totalPnlPercent: 0,
      maxDrawdown: 0,
      sharpe: 0,
      startedAt: now,
      uptime: 0,
      isActive: true,
    };

    // Insert into database
    await db.insert(schema.paperSessions).values({
      id: session.id,
      symbol: session.symbol,
      timeframe: session.timeframe,
      modelPath: session.modelPath,
      config: JSON.stringify(session.config),
      totalTrades: session.totalTrades,
      wins: session.wins,
      losses: session.losses,
      totalPnl: session.totalPnl,
      totalPnlPercent: session.totalPnlPercent,
      maxDrawdown: session.maxDrawdown,
      sharpe: session.sharpe,
      startedAt: session.startedAt,
      isActive: true,
    });

    this.log('entry', 'Session started', { sessionId: session.id });

    return session;
  }

  /**
   * Log trade entry
   */
  async logEntry(trade: PaperTrade, signal: { confluence: number; factors: string[] }): Promise<void> {
    await db.insert(schema.paperTrades).values({
      tradeId: trade.id,
      sessionId: this.sessionId,
      symbol: trade.symbol,
      timeframe: trade.timeframe,
      side: trade.side,
      status: 'open',
      entryPrice: trade.entryPrice,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
      entryTime: trade.entryTime,
      entryIndex: trade.entryIndex,
      entryConfluence: signal.confluence,
      entryFactors: JSON.stringify(signal.factors),
      kbPrimaryConcept: trade.kbPrimaryConcept,
      kbAlignmentScore: trade.kbAlignmentScore,
      createdAt: new Date(),
    });

    this.log('entry', `Entry: ${trade.side.toUpperCase()} at ${trade.entryPrice}`, {
      tradeId: trade.id,
      confluence: signal.confluence,
      factors: signal.factors,
    });
  }

  /**
   * Log trade exit
   */
  async logExit(trade: PaperTrade): Promise<void> {
    await db
      .update(schema.paperTrades)
      .set({
        status: 'closed',
        exitPrice: trade.exitPrice,
        exitTime: trade.exitTime,
        exitIndex: trade.exitIndex,
        barsHeld: trade.barsHeld,
        exitAction: trade.exitAction !== undefined ? this.actionToString(trade.exitAction) : undefined,
        exitReason: trade.exitReason,
        pnl: trade.pnl,
        pnlPercent: trade.pnlPercent,
      })
      .where(eq(schema.paperTrades.tradeId, trade.id));

    // Update session stats
    const isWin = trade.pnl > 0;
    await this.updateSessionStats(trade.pnl, trade.pnlPercent, isWin);

    this.log('exit', `Exit: ${trade.exitReason} at ${trade.exitPrice} | PnL: ${trade.pnl?.toFixed(2)}`, {
      tradeId: trade.id,
      pnl: trade.pnl,
      pnlPercent: trade.pnlPercent,
      exitReason: trade.exitReason,
    });
  }

  /**
   * Update session statistics
   */
  private async updateSessionStats(pnl: number, pnlPercent: number, isWin: boolean): Promise<void> {
    // Fetch current session
    const sessions = await db
      .select()
      .from(schema.paperSessions)
      .where(eq(schema.paperSessions.id, this.sessionId));

    const session = sessions[0];
    if (!session) return;

    const newTotalTrades = (session.totalTrades ?? 0) + 1;
    const newWins = (session.wins ?? 0) + (isWin ? 1 : 0);
    const newLosses = (session.losses ?? 0) + (isWin ? 0 : 1);
    const newTotalPnl = (session.totalPnl ?? 0) + pnl;
    const newTotalPnlPercent = (session.totalPnlPercent ?? 0) + pnlPercent;

    await db
      .update(schema.paperSessions)
      .set({
        totalTrades: newTotalTrades,
        wins: newWins,
        losses: newLosses,
        totalPnl: newTotalPnl,
        totalPnlPercent: newTotalPnlPercent,
      })
      .where(eq(schema.paperSessions.id, this.sessionId));
  }

  /**
   * Update session drawdown and sharpe
   */
  async updateSessionMetrics(maxDrawdown: number, sharpe: number): Promise<void> {
    await db
      .update(schema.paperSessions)
      .set({
        maxDrawdown,
        sharpe,
      })
      .where(eq(schema.paperSessions.id, this.sessionId));
  }

  /**
   * End trading session
   */
  async endSession(metrics: { totalPnl: number; maxDrawdown: number; sharpe: number }): Promise<void> {
    const now = new Date();

    // Fetch session start time
    const sessions = await db
      .select()
      .from(schema.paperSessions)
      .where(eq(schema.paperSessions.id, this.sessionId));

    const session = sessions[0];
    const uptimeSeconds = session?.startedAt
      ? Math.floor((now.getTime() - new Date(session.startedAt).getTime()) / 1000)
      : 0;

    await db
      .update(schema.paperSessions)
      .set({
        endedAt: now,
        uptimeSeconds,
        isActive: false,
        totalPnl: metrics.totalPnl,
        maxDrawdown: metrics.maxDrawdown,
        sharpe: metrics.sharpe,
      })
      .where(eq(schema.paperSessions.id, this.sessionId));

    this.log('update', 'Session ended', {
      uptime: uptimeSeconds,
      ...metrics,
    });

    // Flush any remaining logs
    await this.flush();
  }

  /**
   * Get session by ID
   */
  async getSession(): Promise<PaperSession | null> {
    const sessions = await db
      .select()
      .from(schema.paperSessions)
      .where(eq(schema.paperSessions.id, this.sessionId));

    const row = sessions[0];
    if (!row) return null;

    return {
      id: row.id,
      symbol: row.symbol,
      timeframe: row.timeframe,
      modelPath: row.modelPath,
      config: JSON.parse(row.config) as PaperTraderConfig,
      totalTrades: row.totalTrades ?? 0,
      wins: row.wins ?? 0,
      losses: row.losses ?? 0,
      totalPnl: row.totalPnl ?? 0,
      totalPnlPercent: row.totalPnlPercent ?? 0,
      maxDrawdown: row.maxDrawdown ?? 0,
      sharpe: row.sharpe ?? 0,
      startedAt: new Date(row.startedAt),
      endedAt: row.endedAt ? new Date(row.endedAt) : undefined,
      uptime: row.uptimeSeconds ?? 0,
      isActive: row.isActive ?? false,
    };
  }

  /**
   * Get trades for current session
   */
  async getTrades(): Promise<PaperTrade[]> {
    const rows = await db
      .select()
      .from(schema.paperTrades)
      .where(eq(schema.paperTrades.sessionId, this.sessionId));

    return rows.map((row) => ({
      id: row.tradeId,
      sessionId: row.sessionId,
      symbol: row.symbol,
      timeframe: row.timeframe,
      side: row.side as 'long' | 'short',
      status: row.status as 'open' | 'closed',
      entryPrice: row.entryPrice,
      exitPrice: row.exitPrice ?? undefined,
      stopLoss: row.stopLoss,
      takeProfit: row.takeProfit,
      entryTime: new Date(row.entryTime),
      exitTime: row.exitTime ? new Date(row.exitTime) : undefined,
      entryIndex: row.entryIndex,
      exitIndex: row.exitIndex ?? 0,
      barsHeld: row.barsHeld ?? 0,
      holdingPeriod: row.barsHeld ?? 0,
      entryConfluence: row.entryConfluence ?? 0,
      exitAction: row.exitAction ? this.stringToAction(row.exitAction) : undefined,
      exitReason: row.exitReason as PaperTrade['exitReason'],
      pnl: row.pnl ?? 0,
      pnlPercent: row.pnlPercent ?? 0,
      kbPrimaryConcept: row.kbPrimaryConcept ?? undefined,
      kbAlignmentScore: row.kbAlignmentScore ?? undefined,
      createdAt: new Date(row.createdAt),
    }));
  }

  /**
   * Add log entry to buffer
   */
  private log(
    type: TradeLogEntry['type'],
    message: string,
    details?: Record<string, unknown>
  ): void {
    this.logBuffer.push({
      timestamp: new Date(),
      type,
      message,
      details,
    });

    if (this.logBuffer.length >= this.maxBufferSize) {
      this.flush();
    }
  }

  /**
   * Flush log buffer (for now just clears, could persist to file)
   */
  async flush(): Promise<void> {
    // Could write to log file here
    this.logBuffer = [];
  }

  /**
   * Convert ExitAction to string
   */
  private actionToString(action: ExitAction): string {
    switch (action) {
      case 0: return 'hold';
      case 1: return 'exit_market';
      case 2: return 'tighten_stop';
      case 3: return 'take_partial';
      default: return 'unknown';
    }
  }

  /**
   * Convert string to ExitAction
   */
  private stringToAction(str: string): ExitAction {
    switch (str) {
      case 'hold': return 0;
      case 'exit_market': return 1;
      case 'tighten_stop': return 2;
      case 'take_partial': return 3;
      default: return 0;
    }
  }

  /**
   * Start periodic flush
   */
  startPeriodicFlush(intervalMs: number = 10000): void {
    this.stopPeriodicFlush();
    this.flushInterval = setInterval(() => this.flush(), intervalMs);
  }

  /**
   * Stop periodic flush
   */
  stopPeriodicFlush(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }
}

/**
 * Get all paper trading sessions
 */
export async function getAllSessions(): Promise<PaperSession[]> {
  const rows = await db.select().from(schema.paperSessions);

  return rows.map((row) => ({
    id: row.id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    modelPath: row.modelPath,
    config: JSON.parse(row.config) as PaperTraderConfig,
    totalTrades: row.totalTrades ?? 0,
    wins: row.wins ?? 0,
    losses: row.losses ?? 0,
    totalPnl: row.totalPnl ?? 0,
    totalPnlPercent: row.totalPnlPercent ?? 0,
    maxDrawdown: row.maxDrawdown ?? 0,
    sharpe: row.sharpe ?? 0,
    startedAt: new Date(row.startedAt),
    endedAt: row.endedAt ? new Date(row.endedAt) : undefined,
    uptime: row.uptimeSeconds ?? 0,
    isActive: row.isActive ?? false,
  }));
}

/**
 * Get active sessions
 */
export async function getActiveSessions(): Promise<PaperSession[]> {
  const sessions = await getAllSessions();
  return sessions.filter((s) => s.isActive);
}

/**
 * Get session by ID
 */
export async function getSessionById(id: string): Promise<PaperSession | null> {
  const sessions = await db
    .select()
    .from(schema.paperSessions)
    .where(eq(schema.paperSessions.id, id));

  const row = sessions[0];
  if (!row) return null;

  return {
    id: row.id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    modelPath: row.modelPath,
    config: JSON.parse(row.config) as PaperTraderConfig,
    totalTrades: row.totalTrades ?? 0,
    wins: row.wins ?? 0,
    losses: row.losses ?? 0,
    totalPnl: row.totalPnl ?? 0,
    totalPnlPercent: row.totalPnlPercent ?? 0,
    maxDrawdown: row.maxDrawdown ?? 0,
    sharpe: row.sharpe ?? 0,
    startedAt: new Date(row.startedAt),
    endedAt: row.endedAt ? new Date(row.endedAt) : undefined,
    uptime: row.uptimeSeconds ?? 0,
    isActive: row.isActive ?? false,
  };
}

/**
 * Get trades for a session
 */
export async function getTradesForSession(sessionId: string): Promise<PaperTrade[]> {
  const logger = new TradeLogger(sessionId, '', '', '', {} as PaperTraderConfig);
  return logger.getTrades();
}
