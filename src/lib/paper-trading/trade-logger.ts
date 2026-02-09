/**
 * Trade Logger
 * Persists paper trades and sessions via a PaperTradingRepository.
 * Works with both SQLite (local) and PostgreSQL (Railway).
 */

import type {
  PaperTrade,
  PaperSession,
  TradeLogEntry,
  PaperTraderConfig,
} from './types';
import type { ExitAction } from '../rl/types';
import type { PaperTradingRepository, SessionRow } from './repository';

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
    private readonly config: PaperTraderConfig,
    private readonly repo: PaperTradingRepository,
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

    await this.repo.insertSession({
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
    await this.repo.insertTrade({
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
    await this.repo.updateTradeByTradeId(trade.id, {
      status: 'closed',
      exitPrice: trade.exitPrice,
      exitTime: trade.exitTime,
      exitIndex: trade.exitIndex,
      barsHeld: trade.barsHeld,
      exitAction: trade.exitAction !== undefined ? this.actionToString(trade.exitAction) : undefined,
      exitReason: trade.exitReason,
      pnl: trade.pnl,
      pnlPercent: trade.pnlPercent,
    });

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
    const session = await this.repo.getSessionById(this.sessionId);
    if (!session) return;

    const newTotalTrades = (session.totalTrades ?? 0) + 1;
    const newWins = (session.wins ?? 0) + (isWin ? 1 : 0);
    const newLosses = (session.losses ?? 0) + (isWin ? 0 : 1);
    const newTotalPnl = (session.totalPnl ?? 0) + pnl;
    const newTotalPnlPercent = (session.totalPnlPercent ?? 0) + pnlPercent;

    await this.repo.updateSession(this.sessionId, {
      totalTrades: newTotalTrades,
      wins: newWins,
      losses: newLosses,
      totalPnl: newTotalPnl,
      totalPnlPercent: newTotalPnlPercent,
    });
  }

  /**
   * Update session drawdown and sharpe
   */
  async updateSessionMetrics(maxDrawdown: number, sharpe: number): Promise<void> {
    await this.repo.updateSession(this.sessionId, {
      maxDrawdown,
      sharpe,
    });
  }

  /**
   * End trading session
   */
  async endSession(metrics: { totalPnl: number; maxDrawdown: number; sharpe: number }): Promise<void> {
    const now = new Date();

    const session = await this.repo.getSessionById(this.sessionId);
    const startedAt = session?.startedAt;
    const startMs = startedAt instanceof Date
      ? startedAt.getTime()
      : typeof startedAt === 'string'
        ? new Date(startedAt).getTime()
        : typeof startedAt === 'number'
          ? startedAt
          : 0;
    const uptimeSeconds = startMs > 0 ? Math.floor((now.getTime() - startMs) / 1000) : 0;

    await this.repo.updateSession(this.sessionId, {
      endedAt: now,
      uptimeSeconds,
      isActive: false,
      totalPnl: metrics.totalPnl,
      maxDrawdown: metrics.maxDrawdown,
      sharpe: metrics.sharpe,
    });

    this.log('update', 'Session ended', {
      uptime: uptimeSeconds,
      ...metrics,
    });

    await this.flush();
  }

  /**
   * Get session by ID
   */
  async getSession(): Promise<PaperSession | null> {
    const row = await this.repo.getSessionById(this.sessionId);
    if (!row) return null;
    return sessionRowToModel(row);
  }

  /**
   * Get trades for current session
   */
  async getTrades(): Promise<PaperTrade[]> {
    const rows = await this.repo.getTradesBySessionId(this.sessionId);
    return rows.map((row) => tradeRowToModel(row, this));
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
   * Flush log buffer
   */
  async flush(): Promise<void> {
    this.logBuffer = [];
  }

  /** Convert ExitAction enum to string */
  actionToString(action: ExitAction): string {
    switch (action) {
      case 0: return 'hold';
      case 1: return 'exit_market';
      case 2: return 'tighten_stop';
      case 3: return 'take_partial';
      default: return 'unknown';
    }
  }

  /** Convert string to ExitAction enum */
  stringToAction(str: string): ExitAction {
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

// ============================================
// Row → Model Helpers
// ============================================

function toDate(val: Date | string | number | null | undefined): Date | undefined {
  if (val == null) return undefined;
  if (val instanceof Date) return val;
  return new Date(val);
}

function sessionRowToModel(row: SessionRow): PaperSession {
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
    startedAt: toDate(row.startedAt) ?? new Date(),
    endedAt: toDate(row.endedAt),
    uptime: row.uptimeSeconds ?? 0,
    isActive: row.isActive === true || row.isActive === 1,
  };
}

function tradeRowToModel(row: import('./repository').TradeRow, logger: TradeLogger): PaperTrade {
  return {
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
    entryTime: toDate(row.entryTime) ?? new Date(),
    exitTime: toDate(row.exitTime),
    entryIndex: row.entryIndex,
    exitIndex: row.exitIndex ?? 0,
    barsHeld: row.barsHeld ?? 0,
    holdingPeriod: row.barsHeld ?? 0,
    entryConfluence: row.entryConfluence ?? 0,
    exitAction: row.exitAction ? logger.stringToAction(row.exitAction) : undefined,
    exitReason: row.exitReason as PaperTrade['exitReason'],
    pnl: row.pnl ?? 0,
    pnlPercent: row.pnlPercent ?? 0,
    kbPrimaryConcept: row.kbPrimaryConcept ?? undefined,
    kbAlignmentScore: row.kbAlignmentScore ?? undefined,
    createdAt: toDate(row.createdAt) ?? new Date(),
  };
}

// ============================================
// Free-standing Functions (accept repo param)
// ============================================

/**
 * Get all paper trading sessions
 */
export async function getAllSessions(repo: PaperTradingRepository): Promise<PaperSession[]> {
  const rows = await repo.getAllSessions();
  return rows.map(sessionRowToModel);
}

/**
 * Get active sessions
 */
export async function getActiveSessions(repo: PaperTradingRepository): Promise<PaperSession[]> {
  const sessions = await getAllSessions(repo);
  return sessions.filter((s) => s.isActive);
}

/**
 * Get session by ID
 */
export async function getSessionById(id: string, repo: PaperTradingRepository): Promise<PaperSession | null> {
  const row = await repo.getSessionById(id);
  if (!row) return null;
  return sessionRowToModel(row);
}
