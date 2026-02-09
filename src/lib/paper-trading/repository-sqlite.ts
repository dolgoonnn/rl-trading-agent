/**
 * SQLite Repository Implementation
 *
 * Uses the existing db + schema from @/lib/data/db for local development.
 */

import { db, schema } from '@/lib/data/db';
import { eq } from 'drizzle-orm';
import type {
  PaperTradingRepository,
  SessionRow,
  TradeRow,
  InsertSession,
  UpdateSession,
  InsertTrade,
  UpdateTrade,
} from './repository';

export class SqliteRepository implements PaperTradingRepository {
  async insertSession(session: InsertSession): Promise<void> {
    await db.insert(schema.paperSessions).values({
      id: session.id,
      symbol: session.symbol,
      timeframe: session.timeframe,
      modelPath: session.modelPath,
      config: session.config,
      totalTrades: session.totalTrades,
      wins: session.wins,
      losses: session.losses,
      totalPnl: session.totalPnl,
      totalPnlPercent: session.totalPnlPercent,
      maxDrawdown: session.maxDrawdown,
      sharpe: session.sharpe,
      startedAt: session.startedAt,
      isActive: session.isActive,
    });
  }

  async updateSession(id: string, data: UpdateSession): Promise<void> {
    await db
      .update(schema.paperSessions)
      .set(data)
      .where(eq(schema.paperSessions.id, id));
  }

  async getSessionById(id: string): Promise<SessionRow | null> {
    const rows = await db
      .select()
      .from(schema.paperSessions)
      .where(eq(schema.paperSessions.id, id));
    return (rows[0] as SessionRow | undefined) ?? null;
  }

  async getAllSessions(): Promise<SessionRow[]> {
    const rows = await db.select().from(schema.paperSessions);
    return rows as SessionRow[];
  }

  async insertTrade(trade: InsertTrade): Promise<void> {
    await db.insert(schema.paperTrades).values({
      tradeId: trade.tradeId,
      sessionId: trade.sessionId,
      symbol: trade.symbol,
      timeframe: trade.timeframe,
      side: trade.side,
      status: trade.status,
      entryPrice: trade.entryPrice,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
      entryTime: trade.entryTime,
      entryIndex: trade.entryIndex,
      entryConfluence: trade.entryConfluence,
      entryFactors: trade.entryFactors,
      kbPrimaryConcept: trade.kbPrimaryConcept,
      kbAlignmentScore: trade.kbAlignmentScore,
      createdAt: trade.createdAt,
    });
  }

  async updateTradeByTradeId(tradeId: string, data: UpdateTrade): Promise<void> {
    await db
      .update(schema.paperTrades)
      .set(data)
      .where(eq(schema.paperTrades.tradeId, tradeId));
  }

  async getTradesBySessionId(sessionId: string): Promise<TradeRow[]> {
    const rows = await db
      .select()
      .from(schema.paperTrades)
      .where(eq(schema.paperTrades.sessionId, sessionId));
    return rows as TradeRow[];
  }

  async close(): Promise<void> {
    // SQLite connection is managed by the singleton in db.ts — nothing to close
  }
}
