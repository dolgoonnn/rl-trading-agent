/**
 * Bot Types — Paper Trading & Live Trading
 *
 * Types for the trading bot infrastructure that wraps the
 * ICT confluence scorer for live market execution.
 */

import type { Candle } from './candle';

// ============================================
// Bot Configuration
// ============================================

/** Execution mode: paper simulates fills, live sends orders to exchange */
export type BotMode = 'paper' | 'live';

/** Supported exchanges */
export type Exchange = 'bybit';

/** Supported symbols for the bot */
export type BotSymbol = 'BTCUSDT' | 'ETHUSDT' | 'SOLUSDT' | 'XAUUSDT';

/** Bot-level configuration */
export interface BotConfig {
  /** Paper or live trading */
  mode: BotMode;
  /** Exchange to use */
  exchange: Exchange;
  /** Symbols to trade */
  symbols: BotSymbol[];
  /** Timeframe for candle polling */
  timeframe: '1h';
  /** Initial capital in USDT */
  initialCapital: number;
  /** Risk per trade as fraction of equity (0.003 = 0.3%) */
  riskPerTrade: number;
  /** Max concurrent positions (1 per symbol) */
  maxPositions: number;
  /** Polling delay after hour close in seconds */
  pollDelaySeconds: number;
  /** Paper trading slippage simulation (fraction, e.g. 0.001 = 0.1%) */
  paperSlippage: number;
  /** Commission per side as fraction (e.g. 0.00055 for taker) */
  commissionPerSide: number;
  /** Telegram bot token (optional) */
  telegramBotToken?: string;
  /** Telegram chat ID for alerts (optional) */
  telegramChatId?: string;
  /** Enable verbose logging */
  verbose: boolean;
}

// ============================================
// Strategy Configuration (Run 18 defaults)
// ============================================

/** Strategy names that can be active */
export type BotStrategyName = 'wait' | 'order_block' | 'fvg' | 'bos_continuation' | 'choch_reversal' | 'asian_range_gold';

/** Full strategy config — maps directly to confluence scorer + backtest params */
export interface StrategyConfig {
  /** Active strategies to evaluate */
  activeStrategies: BotStrategyName[];
  /** Confluence weights (keyed by factor name) */
  weights: Record<string, number>;
  /** Base threshold for signal acceptance */
  baseThreshold: number;
  /** Per-regime threshold overrides */
  regimeThresholds: Record<string, number>;
  /** Regimes to suppress (skip trading) */
  suppressedRegimes: string[];
  /** OB freshness half-life in bars */
  obHalfLife: number;
  /** ATR extension filter bands */
  atrExtensionBands: number;
  /** Cooldown bars between same-strategy signals */
  cooldownBars: number;
  /** Max bars to hold a position */
  maxBars: number;
  /** Exit mode */
  exitMode: 'simple' | 'breakeven' | 'partial_tp';
  /** Partial TP config (if exitMode is partial_tp) */
  partialTP: {
    fraction: number;
    triggerR: number;
    beBuffer: number;
  };
  /** Friction per side (commission + slippage combined) */
  frictionPerSide: number;
  /** Gold-specific config (for asian_range_gold strategy) */
  goldConfig?: {
    minRangePct: number;
    minSweepPct: number;
    longBiasMultiplier: number;
    goldVolScale: number;
    targetRR: number;
    displacementMultiple: number;
    sweepLookback: number;
    fvgSearchWindow: number;
    ceTolerance: number;
  };
}

// ============================================
// Position Types
// ============================================

/** State of a bot position */
export type PositionStatus = 'open' | 'closed';

/** Reason a position was closed */
export type ExitReason =
  | 'stop_loss'
  | 'take_profit'
  | 'partial_tp'
  | 'max_bars'
  | 'manual'
  | 'circuit_breaker'
  | 'shutdown'
  | 'ltf_timeout';

/** A live/paper position tracked by the bot */
export interface BotPosition {
  id: string;
  symbol: BotSymbol;
  direction: 'long' | 'short';
  status: PositionStatus;

  // Entry
  entryPrice: number;
  entryTimestamp: number;
  entryBarIndex: number;

  // Levels
  stopLoss: number;
  takeProfit: number;
  currentSL: number; // May be moved (breakeven, partial TP)

  // Sizing
  positionSizeUSDT: number;
  riskAmountUSDT: number;

  // Strategy metadata
  strategy: string;
  confluenceScore: number;
  factorBreakdown: Record<string, number>;
  regime: string;

  // Partial TP state
  partialTaken: boolean;
  partialPnlPercent: number;

  // LTF entry metadata (optional — only set when --ltf is active)
  ltfConfirmed?: boolean;
  ltfEntryDelay?: number; // bars waited for 5m confirmation
  originalHTFEntry?: number; // original 1H entry price before LTF refinement
  originalHTFStopLoss?: number; // original 1H SL before LTF tightening

  // Exit (filled when closed)
  exitPrice?: number;
  exitTimestamp?: number;
  exitReason?: ExitReason;
  barsHeld?: number;
  pnlPercent?: number;
  pnlUSDT?: number;
}

// ============================================
// Trade Record (persisted)
// ============================================

/** A completed trade record for DB persistence */
export interface BotTradeRecord {
  id: string;
  symbol: BotSymbol;
  direction: 'long' | 'short';

  entryPrice: number;
  exitPrice: number;
  entryTimestamp: number;
  exitTimestamp: number;

  stopLoss: number;
  takeProfit: number;

  positionSizeUSDT: number;
  riskAmountUSDT: number;

  strategy: string;
  confluenceScore: number;
  factorBreakdown: string; // JSON
  regime: string;
  exitReason: ExitReason;

  barsHeld: number;
  pnlPercent: number;
  pnlUSDT: number;

  // Equity state at trade close
  equityAfter: number;
  drawdownFromPeak: number;
}

// ============================================
// Equity Snapshot
// ============================================

/** Periodic equity snapshot for tracking performance */
export interface EquitySnapshot {
  timestamp: number;
  equity: number;
  peakEquity: number;
  drawdown: number;
  openPositions: number;
  dailyPnl: number;
  cumulativePnl: number;
}

// ============================================
// Circuit Breaker State
// ============================================

/** Circuit breaker types */
export type CircuitBreakerType =
  | 'daily_loss'
  | 'weekly_loss'
  | 'max_drawdown'
  | 'consecutive_losses'
  | 'system_errors';

/** Circuit breaker configuration */
export interface CircuitBreakerConfig {
  /** Daily loss limit as fraction of capital */
  dailyLossLimit: number;
  /** Weekly loss limit as fraction of capital */
  weeklyLossLimit: number;
  /** Max drawdown from peak as fraction */
  maxDrawdown: number;
  /** Max consecutive losses before pause */
  maxConsecutiveLosses: number;
  /** Max system errors per hour before pause */
  maxSystemErrorsPerHour: number;
}

/** Active circuit breaker state */
export interface CircuitBreakerState {
  type: CircuitBreakerType;
  triggeredAt: number;
  resumeAt: number;
  reason: string;
}

// ============================================
// Alert Types
// ============================================

/** Alert severity levels */
export type AlertLevel = 'info' | 'warning' | 'error' | 'critical';

/** Alert event types */
export type AlertEvent =
  | 'signal_detected'
  | 'position_opened'
  | 'position_closed'
  | 'partial_tp_taken'
  | 'sl_moved'
  | 'circuit_breaker_triggered'
  | 'circuit_breaker_resumed'
  | 'daily_summary'
  | 'error'
  | 'bot_started'
  | 'bot_stopped'
  | 'ltf_setup_created'
  | 'ltf_confirmed'
  | 'ltf_expired'
  | 'arb_position_opened'
  | 'arb_position_closed'
  | 'funding_settlement'
  | 'arb_daily_summary';

/** An alert to be sent */
export interface BotAlert {
  level: AlertLevel;
  event: AlertEvent;
  message: string;
  details?: Record<string, unknown>;
  timestamp: number;
}

// ============================================
// Data Feed Types
// ============================================

/** Candle fetch result */
export interface CandleFetchResult {
  symbol: BotSymbol;
  candles: Candle[];
  latestTimestamp: number;
  isNewCandle: boolean;
}

// ============================================
// Bot State (persisted across restarts)
// ============================================

// ============================================
// LTF Entry Timing Configuration
// ============================================

/** LTF confirmation configuration for tighter entry timing */
export interface LTFConfig {
  /** Whether LTF entry timing is enabled */
  enabled: boolean;
  /** LTF candle interval (Bybit format: '5' for 5min) */
  ltfInterval: string;
  /** Max 5m bars to wait for price to enter OB zone */
  zoneTimeoutBars: number;
  /** Max 5m bars to wait for MSS confirmation after zone entry */
  confirmTimeoutBars: number;
  /** Require market structure shift on 5m */
  requireMSS: boolean;
  /** Require CVD alignment */
  requireCVD: boolean;
  /** Require volume spike above threshold */
  requireVolumeSpike: boolean;
  /** Volume spike threshold (multiple of 20-bar average) */
  volumeSpikeThreshold: number;
  /** CVD slope lookback bars */
  cvdLookback: number;
  /** What to do on timeout: skip the trade or fall back to 1H entry */
  onTimeout: 'skip' | 'fallback';
  /** Swing lookback for 5m structure detection */
  ltfSwingLookback: number;
}

/** Persistent bot state stored in DB */
export interface BotState {
  /** Currently open positions */
  openPositions: BotPosition[];
  /** Current equity */
  equity: number;
  /** Peak equity (for drawdown calculation) */
  peakEquity: number;
  /** Consecutive losses counter */
  consecutiveLosses: number;
  /** Active circuit breakers */
  circuitBreakers: CircuitBreakerState[];
  /** Last processed candle timestamp per symbol */
  lastProcessedTimestamp: Record<string, number>;
  /** Daily PnL tracking (reset at midnight UTC) */
  dailyPnl: number;
  /** Weekly PnL tracking (reset on Monday UTC) */
  weeklyPnl: number;
  /** System error count (rolling 1-hour window) */
  recentErrors: number[];
  /** Bot start timestamp */
  startedAt: number;
  /** Total trades since start */
  totalTrades: number;
}
