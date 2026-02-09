/**
 * PostgreSQL Repository Implementation
 *
 * Uses node-postgres (pg) Pool + drizzle-orm for Railway deployment.
 * Runs CREATE TABLE IF NOT EXISTS on startup — no migration tooling needed.
 */

import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { pgPaperSessions, pgPaperTrades, CREATE_SESSIONS_SQL, CREATE_TRADES_SQL } from './pg-schema';
import type {
  PaperTradingRepository,
  SessionRow,
  TradeRow,
  InsertSession,
  UpdateSession,
  InsertTrade,
  UpdateTrade,
} from './repository';

export class PgRepository implements PaperTradingRepository {
  private pool: pg.Pool;
  private db: ReturnType<typeof drizzle>;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 5,
      ssl: databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1')
        ? false
        : { rejectUnauthorized: false },
    });

    this.db = drizzle(this.pool);
  }

  /** Create tables if they don't exist. Call once at startup. */
  async ensureTables(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(CREATE_SESSIONS_SQL);
      await client.query(CREATE_TRADES_SQL);
    } finally {
      client.release();
    }
  }

  async insertSession(session: InsertSession): Promise<void> {
    await this.db.insert(pgPaperSessions).values({
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
    await this.db
      .update(pgPaperSessions)
      .set(data)
      .where(eq(pgPaperSessions.id, id));
  }

  async getSessionById(id: string): Promise<SessionRow | null> {
    const rows = await this.db
      .select()
      .from(pgPaperSessions)
      .where(eq(pgPaperSessions.id, id));
    return (rows[0] as SessionRow | undefined) ?? null;
  }

  async getAllSessions(): Promise<SessionRow[]> {
    const rows = await this.db.select().from(pgPaperSessions);
    return rows as SessionRow[];
  }

  async insertTrade(trade: InsertTrade): Promise<void> {
    await this.db.insert(pgPaperTrades).values({
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
    await this.db
      .update(pgPaperTrades)
      .set(data)
      .where(eq(pgPaperTrades.tradeId, tradeId));
  }

  async getTradesBySessionId(sessionId: string): Promise<TradeRow[]> {
    const rows = await this.db
      .select()
      .from(pgPaperTrades)
      .where(eq(pgPaperTrades.sessionId, sessionId));
    return rows as TradeRow[];
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
