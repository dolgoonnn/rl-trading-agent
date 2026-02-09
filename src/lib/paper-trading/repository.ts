/**
 * Paper Trading Repository Interface
 *
 * Abstracts database operations so the paper trader can run against
 * SQLite (local dev) or PostgreSQL (Railway deployment).
 */

// ============================================
// Shared Row Types (dialect-agnostic)
// ============================================

export interface SessionRow {
  id: string;
  symbol: string;
  timeframe: string;
  modelPath: string;
  config: string; // JSON-serialized PaperTraderConfig
  totalTrades: number | null;
  wins: number | null;
  losses: number | null;
  totalPnl: number | null;
  totalPnlPercent: number | null;
  maxDrawdown: number | null;
  sharpe: number | null;
  startedAt: Date | string | number;
  endedAt: Date | string | number | null;
  uptimeSeconds: number | null;
  isActive: boolean | number | null; // SQLite uses 0/1, PG uses boolean
}

export interface TradeRow {
  id: number;
  tradeId: string;
  sessionId: string;
  symbol: string;
  timeframe: string;
  side: string;
  status: string;
  entryPrice: number;
  exitPrice: number | null;
  stopLoss: number;
  takeProfit: number;
  entryTime: Date | string | number;
  exitTime: Date | string | number | null;
  entryIndex: number;
  exitIndex: number | null;
  barsHeld: number | null;
  entryConfluence: number | null;
  entryFactors: string | null; // JSON array
  exitAction: string | null;
  exitReason: string | null;
  pnl: number | null;
  pnlPercent: number | null;
  kbPrimaryConcept: string | null;
  kbAlignmentScore: number | null;
  createdAt: Date | string | number;
}

// ============================================
// Insert/Update Shapes
// ============================================

export interface InsertSession {
  id: string;
  symbol: string;
  timeframe: string;
  modelPath: string;
  config: string;
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  totalPnlPercent: number;
  maxDrawdown: number;
  sharpe: number;
  startedAt: Date;
  isActive: boolean;
}

export interface UpdateSession {
  totalTrades?: number;
  wins?: number;
  losses?: number;
  totalPnl?: number;
  totalPnlPercent?: number;
  maxDrawdown?: number;
  sharpe?: number;
  endedAt?: Date;
  uptimeSeconds?: number;
  isActive?: boolean;
}

export interface InsertTrade {
  tradeId: string;
  sessionId: string;
  symbol: string;
  timeframe: string;
  side: string;
  status: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  entryTime: Date;
  entryIndex: number;
  entryConfluence: number;
  entryFactors: string;
  kbPrimaryConcept?: string;
  kbAlignmentScore?: number;
  createdAt: Date;
}

export interface UpdateTrade {
  status?: string;
  exitPrice?: number;
  exitTime?: Date;
  exitIndex?: number;
  barsHeld?: number;
  exitAction?: string;
  exitReason?: string;
  pnl?: number;
  pnlPercent?: number;
}

// ============================================
// Repository Interface
// ============================================

export interface PaperTradingRepository {
  insertSession(session: InsertSession): Promise<void>;
  updateSession(id: string, data: UpdateSession): Promise<void>;
  getSessionById(id: string): Promise<SessionRow | null>;
  getAllSessions(): Promise<SessionRow[]>;

  insertTrade(trade: InsertTrade): Promise<void>;
  updateTradeByTradeId(tradeId: string, data: UpdateTrade): Promise<void>;
  getTradesBySessionId(sessionId: string): Promise<TradeRow[]>;

  close(): Promise<void>;
}
