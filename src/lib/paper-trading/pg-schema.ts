/**
 * PostgreSQL Table Definitions for Paper Trading
 *
 * Mirrors the SQLite paperSessions/paperTrades tables from schema.ts
 * but uses PG-native column types.
 */

import {
  pgTable,
  text,
  serial,
  doublePrecision,
  integer,
  boolean,
  timestamp,
} from 'drizzle-orm/pg-core';

export const pgPaperSessions = pgTable('paper_sessions', {
  id: text('id').primaryKey(),
  symbol: text('symbol').notNull(),
  timeframe: text('timeframe').notNull(),
  modelPath: text('model_path').notNull(),
  config: text('config').notNull(),

  totalTrades: integer('total_trades').default(0),
  wins: integer('wins').default(0),
  losses: integer('losses').default(0),
  totalPnl: doublePrecision('total_pnl').default(0),
  totalPnlPercent: doublePrecision('total_pnl_percent').default(0),
  maxDrawdown: doublePrecision('max_drawdown').default(0),
  sharpe: doublePrecision('sharpe').default(0),

  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  uptimeSeconds: integer('uptime_seconds').default(0),
  isActive: boolean('is_active').default(true),
});

export const pgPaperTrades = pgTable('paper_trades', {
  id: serial('id').primaryKey(),
  tradeId: text('trade_id').notNull().unique(),
  sessionId: text('session_id').notNull(),
  symbol: text('symbol').notNull(),
  timeframe: text('timeframe').notNull(),

  side: text('side').notNull(),
  status: text('status').notNull(),
  entryPrice: doublePrecision('entry_price').notNull(),
  exitPrice: doublePrecision('exit_price'),
  stopLoss: doublePrecision('stop_loss').notNull(),
  takeProfit: doublePrecision('take_profit').notNull(),

  entryTime: timestamp('entry_time', { withTimezone: true }).notNull(),
  exitTime: timestamp('exit_time', { withTimezone: true }),
  entryIndex: integer('entry_index').notNull(),
  exitIndex: integer('exit_index'),
  barsHeld: integer('bars_held'),

  entryConfluence: integer('entry_confluence'),
  entryFactors: text('entry_factors'),
  exitAction: text('exit_action'),
  exitReason: text('exit_reason'),

  pnl: doublePrecision('pnl'),
  pnlPercent: doublePrecision('pnl_percent'),

  kbPrimaryConcept: text('kb_primary_concept'),
  kbAlignmentScore: doublePrecision('kb_alignment_score'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

// Raw SQL for CREATE TABLE IF NOT EXISTS (used by ensureTables)
export const CREATE_SESSIONS_SQL = `
CREATE TABLE IF NOT EXISTS paper_sessions (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  model_path TEXT NOT NULL,
  config TEXT NOT NULL,
  total_trades INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  total_pnl DOUBLE PRECISION DEFAULT 0,
  total_pnl_percent DOUBLE PRECISION DEFAULT 0,
  max_drawdown DOUBLE PRECISION DEFAULT 0,
  sharpe DOUBLE PRECISION DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  uptime_seconds INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE
);
`;

export const CREATE_TRADES_SQL = `
CREATE TABLE IF NOT EXISTS paper_trades (
  id SERIAL PRIMARY KEY,
  trade_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  side TEXT NOT NULL,
  status TEXT NOT NULL,
  entry_price DOUBLE PRECISION NOT NULL,
  exit_price DOUBLE PRECISION,
  stop_loss DOUBLE PRECISION NOT NULL,
  take_profit DOUBLE PRECISION NOT NULL,
  entry_time TIMESTAMPTZ NOT NULL,
  exit_time TIMESTAMPTZ,
  entry_index INTEGER NOT NULL,
  exit_index INTEGER,
  bars_held INTEGER,
  entry_confluence INTEGER,
  entry_factors TEXT,
  exit_action TEXT,
  exit_reason TEXT,
  pnl DOUBLE PRECISION,
  pnl_percent DOUBLE PRECISION,
  kb_primary_concept TEXT,
  kb_alignment_score DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL
);
`;
