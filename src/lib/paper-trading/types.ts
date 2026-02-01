/**
 * Paper Trading Types
 * Types for the paper trading system that connects trained agents to live data
 */

import type { ExitAction, HybridPosition } from '../rl/types';
import type { KBContext } from '../rl/kb-integration/types';

// ============================================
// Binance WebSocket Types
// ============================================

/** Raw kline message from Binance WebSocket */
export interface BinanceKlineMessage {
  e: 'kline';           // Event type
  E: number;            // Event time
  s: string;            // Symbol
  k: {
    t: number;          // Kline start time
    T: number;          // Kline close time
    s: string;          // Symbol
    i: string;          // Interval
    f: number;          // First trade ID
    L: number;          // Last trade ID
    o: string;          // Open price
    c: string;          // Close price
    h: string;          // High price
    l: string;          // Low price
    v: string;          // Base asset volume
    n: number;          // Number of trades
    x: boolean;         // Is this kline closed?
    q: string;          // Quote asset volume
    V: string;          // Taker buy base asset volume
    Q: string;          // Taker buy quote asset volume
    B: string;          // Ignore
  };
}

/** WebSocket connection state */
export type WsConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

/** WebSocket client configuration */
export interface BinanceWsConfig {
  symbol: string;
  timeframe: string;
  baseUrl?: string;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
  reconnectBackoffMultiplier?: number;
  pingIntervalMs?: number;
}

/** Events emitted by BinanceWebSocket */
export interface BinanceWsEvents {
  connected: () => void;
  disconnected: (reason: string) => void;
  error: (error: Error) => void;
  candle: (candle: LiveCandle) => void;
  candleClosed: (candle: LiveCandle) => void;
  reconnecting: (attempt: number) => void;
}

// ============================================
// Candle Types
// ============================================

/** Live candle from WebSocket (may be incomplete) */
export interface LiveCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: boolean;
  trades: number;
}

/** Candle buffer configuration */
export interface CandleBufferConfig {
  symbol: string;
  timeframe: string;
  maxCandles: number;           // Max candles to keep in buffer
  historyDays: number;          // Days of history to fetch on init
  binanceApiUrl?: string;
}

// ============================================
// Paper Trading Types
// ============================================

/** Paper trade record (standalone interface with optional exit fields) */
export interface PaperTrade {
  id: string;
  sessionId: string;
  symbol: string;
  timeframe: string;

  // Position
  side: 'long' | 'short';
  status: 'open' | 'closed';
  entryPrice: number;
  exitPrice?: number;
  stopLoss: number;
  takeProfit: number;

  // Indices
  entryIndex: number;
  exitIndex: number;

  // Timing
  entryTime: Date;
  exitTime?: Date;
  barsHeld: number;
  holdingPeriod: number;

  // Performance
  pnl: number;
  pnlPercent: number;

  // Agent decision
  entryConfluence: number;
  exitAction?: ExitAction;
  exitReason?: 'agent' | 'stop_loss' | 'take_profit' | 'max_bars' | 'shutdown';

  // KB context
  kbPrimaryConcept?: string;
  kbAlignmentScore?: number;

  createdAt: Date;
}

/** Paper trading session */
export interface PaperSession {
  id: string;
  symbol: string;
  timeframe: string;
  modelPath: string;
  config: PaperTraderConfig;

  // Stats
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  totalPnlPercent: number;
  maxDrawdown: number;
  sharpe: number;

  // Timing
  startedAt: Date;
  endedAt?: Date;
  uptime: number;  // seconds
  isActive: boolean;

  // State
  currentPosition?: PaperPosition;
}

/** Extended position state for paper trading */
export interface PaperPosition extends HybridPosition {
  sessionId: string;
  openTime: Date;
  kbContext?: KBContext;
}

// ============================================
// Paper Trader Configuration
// ============================================

/** Paper trader configuration */
export interface PaperTraderConfig {
  // Data feed
  symbol: string;
  timeframe: string;

  // Model
  modelPath: string;

  // Environment settings (should match training)
  initialCapital: number;
  positionSize: number;
  maxHoldBars: number;
  slPercent: number;
  tpPercent: number;

  // Costs (should match backtest)
  spread: number;
  slippage: number;
  commission: number;

  // KB Integration
  kbEnabled: boolean;
  kbFeatures: boolean;
  kbRewards: boolean;

  // Persistence
  persistTrades: boolean;
  dbPath?: string;

  // Logging
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  consoleOutput: boolean;
}

export const DEFAULT_PAPER_TRADER_CONFIG: PaperTraderConfig = {
  symbol: 'BTCUSDT',
  timeframe: '1h',
  modelPath: './models/hybrid-kb-full.json',
  initialCapital: 10000,
  positionSize: 0.1,
  maxHoldBars: 50,
  slPercent: 0.02,
  tpPercent: 0.04,
  spread: 0.0001,
  slippage: 0.0005,
  commission: 0.001,
  kbEnabled: true,
  kbFeatures: true,
  kbRewards: false,  // Don't use reward shaping in live
  persistTrades: true,
  logLevel: 'info',
  consoleOutput: true,
};

// ============================================
// Performance Metrics
// ============================================

/** Real-time performance metrics */
export interface PerformanceMetrics {
  // Trade counts
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  wins: number;
  losses: number;

  // Win rate
  winRate: number;
  profitFactor: number;

  // PnL
  totalPnl: number;
  totalPnlPercent: number;
  unrealizedPnl: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;

  // Risk metrics
  maxDrawdown: number;
  maxDrawdownPercent: number;
  currentDrawdown: number;
  sharpe: number;
  sortino: number;

  // Timing
  avgHoldingBars: number;
  longestWinStreak: number;
  longestLoseStreak: number;
  currentStreak: number;

  // Comparison (if available)
  backtestSharpe?: number;
  sharpeDeviation?: number;
}

/** Performance snapshot at a point in time */
export interface PerformanceSnapshot {
  timestamp: Date;
  equity: number;
  drawdown: number;
  metrics: PerformanceMetrics;
}

// ============================================
// Trade Logger Types
// ============================================

/** Trade log entry */
export interface TradeLogEntry {
  timestamp: Date;
  type: 'entry' | 'exit' | 'update' | 'signal' | 'error';
  trade?: PaperTrade;
  message: string;
  details?: Record<string, unknown>;
}

// ============================================
// Events
// ============================================

/** Paper trader events */
export interface PaperTraderEvents {
  started: (session: PaperSession) => void;
  stopped: (session: PaperSession) => void;
  entry: (trade: PaperTrade, signal: { confluence: number; factors: string[] }) => void;
  exit: (trade: PaperTrade) => void;
  update: (position: PaperPosition, metrics: PerformanceMetrics) => void;
  error: (error: Error) => void;
  candleReceived: (candle: LiveCandle) => void;
}

// ============================================
// Comparison Types
// ============================================

/** Comparison between paper and backtest results */
export interface PaperBacktestComparison {
  sessionId: string;

  // Signal matching
  signalMatchRate: number;
  signalsMatched: number;
  signalsMissed: number;
  falseSignals: number;

  // Action matching
  actionMatchRate: number;
  actionsMatched: number;
  actionsMismatched: number;

  // Performance comparison
  paperSharpe: number;
  backtestSharpe: number;
  sharpeDeviation: number;

  paperWinRate: number;
  backtestWinRate: number;
  winRateDeviation: number;

  paperPnl: number;
  backtestPnl: number;
  pnlDeviation: number;

  // Pass/fail
  signalMatchPassed: boolean;     // > 95%
  actionMatchPassed: boolean;     // > 90%
  sharpeDeviationPassed: boolean; // < ±0.2
  overallPassed: boolean;
}
