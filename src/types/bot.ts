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

/**
 * Execution mode.
 * - `paper`: simulates fills (default; backtest-dump scripts may run).
 * - `live`: sends real orders to the exchange (never used here — paper only).
 * - `paper-forward`: a forward paper run that accumulates a real-time track
 *   record. Like `paper` for fills, but the backtest-dump path is HARD-GATED
 *   off so a forward run can never re-pollute bot_trades.
 */
export type BotMode = 'paper' | 'live' | 'paper-forward';

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
// Pre-Trade Safety Gate (live-only)
// ============================================

/**
 * Configuration for the pre-trade safety gate (live/paper bot only).
 * Hard REJECTS, no clamping. Lives outside the backtest path.
 */
export interface SafetyGateConfig {
  /** Max position notional as a multiple of equity (e.g. 2.0 = 200% of equity) */
  maxNotionalPctEquity: number;
  /** Minimum stop distance as a fraction of entry price (floors riskDistance) */
  minStopPct: number;
  /** Max allowed |signalEntry - markPrice| deviation in basis points */
  maxDeviationBps: number;
  /** Max allowed age of the signal candle in milliseconds */
  maxCandleAgeMs: number;
}

/** Reason a pre-trade guard rejected an order */
export type RejectReason =
  | 'unbounded_size'
  | 'max_notional'
  | 'mark_deviation'
  | 'stale_candle'
  | 'crossed_candle'
  | 'l2_tradeability';

/**
 * Configuration for the L2 tradeability gate (live/paper bot only).
 *
 * Contract: an order is REJECTED when the order book is illiquid relative to
 * the intended position. `depthMultiple` is a multiple of intended notional —
 * we require `depthUsdt >= depthMultiple * intendedNotionalUsdt` of resting
 * liquidity on the side we'd cross (top-N levels). Defaults are tuned for
 * majors (BTC/ETH/SOL) where book depth is deep.
 */
export interface TradeabilityConfig {
  /** Max allowed spread in basis points (e.g. 5 = 0.05%). */
  maxSpreadBps: number;
  /** Required top-N depth as a multiple of intended notional (e.g. 2 = 2×). */
  depthMultiple: number;
}

/** An L2 order-book snapshot summarized for the tradeability gate. */
export interface OrderbookSnapshot {
  /** Best bid price. */
  bid: number;
  /** Best ask price. */
  ask: number;
  /** USDT depth resting on the bid side (sum of top-N levels × price). */
  bidDepthUsdt: number;
  /** USDT depth resting on the ask side (sum of top-N levels × price). */
  askDepthUsdt: number;
  /** (ask - bid) / mid * 1e4. */
  spreadBps: number;
}

/** Result of a sizing/guard computation — discriminated on `ok` */
export type GuardResult =
  | { ok: true; size: number; notionalUsdt: number }
  | { ok: false; reason: RejectReason };

// ============================================
// Retirement Kill-Switch (live/paper bot only)
// ============================================

/**
 * Frozen-at-deploy parameters for the retirement kill-switch and risk hardening.
 * The hard-kill drawdown is anchored to the chosen live volatility via E[MaxDD]
 * (NOT the raw in-sample 63.3%). All values are pre-committed at deploy.
 */
export interface RetirementConfig {
  /** Annualized volatility target the equity curve is sized to. */
  sigmaAnnual: number;
  /** Expected Sharpe used in the E[MaxDD] formula. */
  sharpe: number;
  /** Horizon (years) for the E[MaxDD] √(2·ln(T·252)) term. */
  horizonYears: number;
  /** Bootstrap 5th-percentile drawdown — the empirical floor for hardKillDD. */
  bootstrapP5DD: number;
  /** Benchmark Sharpe `c` the deflated Sharpe must clear (NOT zero). */
  minAcceptableSharpe: number;
  /** PSR threshold (probability the true Sharpe beats the benchmark). */
  psr: number;
  /** Minimum live observations before the DSR layer may HARD-halt. */
  minTrackRecordLength: number;
  /**
   * Minimum realized TRADES before the DSR edge-decay layer may HARD-halt.
   * `minTrackRecordLength` counts hourly equity snapshots, which a FLAT, untraded
   * curve accrues without ever trading — yielding ~0 Sharpe and a spurious
   * "edge decay" retirement. A strategy with no trades has no edge to decay, so
   * the DSR hard-halt legs additionally require this many realized trades. The
   * absolute-drawdown hard stop is NEVER gated by this.
   */
  minTradesForHalt: number;
  /** Max NEW entries per symbol per 24h (independent of strategy cooldownBars). */
  maxEntriesPerDay: number;
  /** Consecutive losses per symbol that pause THAT symbol (not the whole book). */
  maxConsecutiveLossesPerSymbol: number;
  /** Heartbeat timeout (ms): stale feed beyond this latches a stale_feed HALT. */
  heartbeatTimeoutMs: number;
  /** Consecutive charter-p5 breaches that escalate yellow → red (hard halt). */
  charterBreachK: number;
  /**
   * Consecutive DSR-below-floor checks (with n >= MinTRL) that escalate the
   * deflated-Sharpe layer to a HARD halt even WITHOUT a corroborating regime
   * cause (mirrors the charter-path yellow→red escalation). A single sub-floor
   * DSR reading is noisy; `dsrBreachK` sustained breaches make it conclusive.
   */
  dsrBreachK: number;
  /**
   * Feature flag — is the regime/mechanism halt leg WIRED? Default FALSE.
   *
   * Gates BOTH the DSR-conclusive-WITH-regime-cause HARD halt and the standalone
   * regime de-risk in `checkRetirementHalt`. Today `run-bot.ts:consumeRegimeCause()`
   * returns a hardcoded `false`, so these legs can never fire — leaving the flag
   * false makes that INACTIVE state explicit (not dead code masquerading as live)
   * and provably skips the legs even if a stray/stale `regimeCause=true` is passed.
   *
   * TODO to enable: wire an EDGE-TRIGGERED regime-decay / mechanism-break detector
   * into the tick (fresh-transition event, not a latched level) feeding `regimeCause`,
   * then flip this to true.
   */
  regimeHaltEnabled: boolean;
  /**
   * Feature flag — is the charter-p5 cumulative-PnL path halt leg WIRED? Default FALSE.
   *
   * Gates BOTH the charter-p5 RED HARD halt and the YELLOW de-risk in
   * `checkRetirementHalt`. Today `run-bot.ts:charterBreachConsecutive` is declared
   * `=0` and never mutated, so these legs can never fire — leaving the flag false
   * makes that INACTIVE state explicit and provably skips the legs even if a nonzero
   * `charterBreachConsecutive` is passed.
   *
   * TODO to enable: wire a charter-p5 cumulative-PnL-vs-path probe that increments
   * `charterBreachConsecutive` when live cumulative PnL sits below the 5th-percentile
   * Monte-Carlo path, then flip this to true.
   */
  charterPathHaltEnabled: boolean;
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
  | 'ltf_timeout'
  | 'startup_reconcile';

/** A live/paper position tracked by the bot */
export interface BotPosition {
  id: string;
  symbol: BotSymbol;
  direction: 'long' | 'short';
  status: PositionStatus;

  // Entry
  entryPrice: number; // Friction-adjusted entry price (used for PnL, BE buffer)
  rawEntryPrice: number; // Raw signal price before friction (used for riskDistance, unrealizedR)
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

/** Drawdown tier — graduated position sizing based on drawdown depth */
export interface DrawdownTier {
  /** Drawdown threshold (fraction, e.g. 0.10 = 10%) */
  maxDrawdown: number;
  /** Position size multiplier (1.0 = full, 0.5 = half, 0 = halt) */
  sizeMultiplier: number;
  /** Human-readable label */
  label: string;
}

/** Risk management configuration */
export interface RiskConfig {
  /** Circuit breaker config */
  circuitBreakers: CircuitBreakerConfig;
  /** Drawdown tiers (must be sorted ascending by maxDrawdown) */
  drawdownTiers: DrawdownTier[];
  /** Max concurrent positions */
  maxPositions: number;
  /** Regime-based position size multipliers */
  regimeSizeMultipliers: Record<string, number>;
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
  | 'arb_daily_summary'
  | 'degradation_alert'
  | 'startup_reconcile';

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
