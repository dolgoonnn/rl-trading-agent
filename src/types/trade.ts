/**
 * Trade journal and position types
 */

import type { Bias } from './ict';

export type TradeDirection = 'long' | 'short';
export type TradeStatus = 'open' | 'closed' | 'cancelled';
export type TradeOutcome = 'win' | 'loss' | 'breakeven' | 'pending';

export interface Trade {
  id: string;
  symbol: string;
  timeframe: string;
  direction: TradeDirection;
  status: TradeStatus;
  outcome: TradeOutcome;

  // Timing
  entryTime: Date;
  exitTime?: Date;

  // Prices
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  exitPrice?: number;

  // Risk
  riskAmount: number; // In account currency
  riskPercent: number; // As % of account
  plannedRR: number;
  actualRR?: number;

  // P&L
  pnl?: number;
  pnlPercent?: number;

  // ICT context
  htfBias: Bias;
  setupType: string; // e.g., "Silver Bullet", "OTE + OB"
  killZone?: string;

  // Notes
  entryReason: string;
  exitReason?: string;
  notes?: string;
  screenshots?: string[];

  // Metadata
  createdAt: Date;
  updatedAt: Date;
}

export interface TradeStats {
  totalTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  expectancy: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  avgRR: number;
  bestTrade: number;
  worstTrade: number;
}

export interface TradeFilter {
  symbol?: string;
  direction?: TradeDirection;
  status?: TradeStatus;
  outcome?: TradeOutcome;
  dateFrom?: Date;
  dateTo?: Date;
  setupType?: string;
  killZone?: string;
}
